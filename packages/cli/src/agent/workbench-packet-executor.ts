import crypto from 'crypto'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { finalizeWorkbenchPacketExecution, getWorkbenchPacketRecord } from './workbench-packet-store'
import { advanceWorkbenchRunAfterPacket, getAgentJob, updateAgentJob } from './agent-jobs'
import { workbenchSessionIdForRun } from './workbench-run-session'
import { loadConfig } from './config'
import { normalizeRepoRelativePath } from './safe-access'
import { runSafeCommand, type SafeCommandResult } from './command-runner'
import { appendAgentEvent, hasPacketValidationActivityEvent } from './agent-events'
import { startLocalServer, type LocalServerHandle, type LocalServerLifecycleEvent } from './local-server-lifecycle'
import { completeWorkbenchExecutionJournal, markWorkbenchExecutionJournalStep, prepareWorkbenchExecutionJournal, restoreWorkbenchExecutionJournal, type WorkbenchExecutionJournal } from './workbench-execution-journal'
import { planWorkbenchPacketExecution } from './workbench-packet-plan'
import { attachWorkbenchEvidence, type WorkbenchEvidenceUnavailable } from './workbench-evidence-producers'
import type { WorkbenchEvidenceMetadata, ValidationSelectionNode } from '@workbench/shared'
import type { WorkbenchGoalCommand, WorkbenchGoalRead } from './workbench-packets'
import {
  getCompactWorkbenchValidationJob,
  scheduleWorkbenchValidationJob,
  submitWorkbenchValidationJob
} from './workbench-validation-jobs'

export type WorkbenchPacketExecutionResult = {
  status: 'completed' | 'failed' | 'rejected' | 'paused' | 'cancelled'
  packetId: string
  writesPerformed: boolean
  rolledBack: boolean
  planHash?: string
  completedSteps: number
  changedPaths: string[]
  failedStep?: number
  validationResults?: Array<Pick<SafeCommandResult, 'commandKind' | 'status' | 'exitCode' | 'durationMs' | 'stdout' | 'stderr'> & { evidenceRefs?: WorkbenchEvidenceMetadata[]; evidenceUnavailable?: WorkbenchEvidenceUnavailable }>
  commitResult?: Pick<SafeCommandResult, 'status' | 'exitCode' | 'stdout' | 'stderr'>
  commitHash?: string
  readEvidence?: Array<{ mode: WorkbenchGoalRead['mode']; path: string; matches?: number; lines?: number }>
  commandEvidence?: Array<{ commandKind: WorkbenchGoalCommand['commandKind']; status: string; exitCode: number | null; durationMs: number }>
  errors: Array<{ code: string; message: string; path?: string }>
}

type FileSnapshot = {
  path: string
  existed: boolean
  content?: Buffer
  mode?: number
}

class PacketControlSignal extends Error {
  constructor(readonly action: 'pause' | 'cancel', message: string) {
    super(message)
  }
}

function assertPacketControlAllowsExecution(packetId: string): void {
  const current = getWorkbenchPacketRecord(packetId)
  if (!current) throw new Error('packet disappeared during execution')
  if (current.controlRequested === 'pause') {
    throw new PacketControlSignal('pause', current.controlReason || 'Packet execution paused by run control.')
  }
  if (current.controlRequested === 'cancel') {
    throw new PacketControlSignal('cancel', current.controlReason || 'Packet execution cancelled by run control.')
  }
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function snapshotFile(fullPath: string): FileSnapshot {
  if (!fs.existsSync(fullPath)) return { path: fullPath, existed: false }
  const stat = fs.lstatSync(fullPath)
  if (!stat.isFile()) throw new Error(`Only regular files are supported: ${fullPath}`)
  return { path: fullPath, existed: true, content: fs.readFileSync(fullPath), mode: stat.mode }
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed) {
      fs.mkdirSync(path.dirname(snapshot.path), { recursive: true })
      fs.writeFileSync(snapshot.path, snapshot.content || Buffer.alloc(0))
      if (typeof snapshot.mode === 'number') fs.chmodSync(snapshot.path, snapshot.mode)
    } else if (fs.existsSync(snapshot.path)) {
      const stat = fs.lstatSync(snapshot.path)
      if (stat.isFile()) fs.unlinkSync(snapshot.path)
      else throw new Error(`Rollback refused non-file path: ${snapshot.path}`)
    }
  }
}

function verifyFileHash(fullPath: string, expectedHash: string): void {
  if (!fs.existsSync(fullPath)) throw new Error(`Expected file to exist: ${fullPath}`)
  const actual = sha256Buffer(fs.readFileSync(fullPath))
  if (actual !== expectedHash) throw new Error(`Verification hash mismatch: ${fullPath}`)
}

function gitLines(sourceRoot: string, args: string[]): string[] {
  const output = execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function assertCleanPacketPaths(sourceRoot: string, exactPaths: string[], requireEmptyIndex: boolean): void {
  const dirtyPacketPaths = gitLines(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...exactPaths])
  if (dirtyPacketPaths.length > 0) throw new Error(`Packet paths already contain staged or unstaged changes: ${dirtyPacketPaths.join(', ')}`)
  if (requireEmptyIndex) {
    const stagedPaths = gitLines(sourceRoot, ['diff', '--cached', '--name-only'])
    if (stagedPaths.length > 0) throw new Error(`Git index already contains unrelated staged changes: ${stagedPaths.join(', ')}`)
  }
}

function normalizeStatusPath(value: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return unquoted.replace(/\\/g, '/').trim()
}

function gitStatusSnapshot(sourceRoot: string): Map<string, string> {
  const output = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: sourceRoot,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const snapshot = new Map<string, string>()
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const status = line.slice(0, 2)
    const value = line.slice(3)
    const rename = /^(.*) -> (.*)$/.exec(value)
    if (rename) {
      snapshot.set(normalizeStatusPath(rename[1]!), status)
      snapshot.set(normalizeStatusPath(rename[2]!), status)
    } else {
      snapshot.set(normalizeStatusPath(value), status)
    }
  }
  snapshot.delete('')
  return snapshot
}

function changedPathsSince(before: Map<string, string>, after: Map<string, string>): string[] {
  return sortedUnique([...new Set([...before.keys(), ...after.keys()])]
    .filter(relativePath => before.get(relativePath) !== after.get(relativePath)))
}

function assertChangedPathsWithinAuthorization(
  before: Map<string, string>,
  sourceRoot: string,
  authorizedPaths: readonly string[]
): string[] {
  const changedPaths = changedPathsSince(before, gitStatusSnapshot(sourceRoot))
  const allowed = new Set(authorizedPaths.map(normalizeStatusPath))
  const unexpected = changedPaths.filter(relativePath => !allowed.has(relativePath))
  if (unexpected.length > 0) {
    throw new Error(`UNEXPECTED_CHANGED_PATH: actual changed paths are outside the authorized packet scope: ${unexpected.join(', ')}`)
  }
  return changedPaths
}

function verifyExactPathSet(actual: string[], expected: string[], label: string): void {
  const actualSorted = sortedUnique(actual)
  const expectedSorted = sortedUnique(expected)
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    throw new Error(`${label} paths differ from packet exact paths; actual=${actualSorted.join(',')} expected=${expectedSorted.join(',')}`)
  }
}

function boundedGoalNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback
}

function goalFilePath(sourceRoot: string, requestedPath: string): string {
  const normalized = normalizeRepoRelativePath(requestedPath)
  if (!normalized || normalized === '.') throw new Error(`Goal read path is invalid: ${requestedPath}`)
  const resolved = path.resolve(sourceRoot, normalized)
  const relative = path.relative(sourceRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Goal read path escaped the source root: ${requestedPath}`)
  return resolved
}

function executeGoalRead(sourceRoot: string, read: WorkbenchGoalRead): { mode: WorkbenchGoalRead['mode']; path: string; matches?: number; lines?: number } {
  const fullPath = goalFilePath(sourceRoot, read.path)
  const content = fs.readFileSync(fullPath, 'utf8')
  const lines = content.split(/\r?\n/)
  if (read.mode === 'read_range') {
    const start = boundedGoalNumber(read.startLine, 1, 1, Math.max(1, lines.length))
    const end = boundedGoalNumber(read.endLine, Math.min(lines.length, start + 249), start, Math.min(lines.length, start + 249))
    return { mode: read.mode, path: normalizeRepoRelativePath(read.path)!, lines: Math.max(0, end - start + 1) }
  }
  if (read.mode === 'read_symbol') {
    const symbol = String(read.symbol || '').trim()
    const matches = lines.filter(line => line.includes(symbol)).length
    return { mode: read.mode, path: normalizeRepoRelativePath(read.path)!, matches, lines: matches > 0 ? 1 : 0 }
  }
  const pattern = String(read.pattern || '')
  const matcher = read.regex === true ? new RegExp(pattern, 'g') : undefined
  let matches = 0
  for (const line of lines) {
    if (matcher) {
      matcher.lastIndex = 0
      if (matcher.test(line)) matches += 1
    } else if (line.includes(pattern)) {
      matches += 1
    }
    if (matches >= boundedGoalNumber(read.maxMatches, 5, 1, 10)) break
  }
  return { mode: read.mode, path: normalizeRepoRelativePath(read.path)!, matches }
}

async function executeGoalCommand(params: { sourceId: string; sourceRoot: string; command: WorkbenchGoalCommand }): Promise<{ commandKind: WorkbenchGoalCommand['commandKind']; status: string; exitCode: number | null; durationMs: number }> {
  const result = await runSafeCommand({
    sourceId: params.sourceId,
    sourceRoot: params.sourceRoot,
    commandKind: params.command.commandKind,
    executable: params.command.executable,
    args: params.command.args,
    timeoutMs: params.command.timeoutMs,
    networkAccess: false,
    paths: []
  })
  if (result.status !== 'completed') throw new Error(`Goal command ${params.command.commandKind} failed: ${result.reason || result.stderr || result.stdout}`)
  if (result.filesChanged === true || (result.changedPaths && result.changedPaths.length > 0)) throw new Error(`Goal command ${params.command.commandKind} changed repository files`)
  return { commandKind: params.command.commandKind, status: result.status, exitCode: result.exitCode, durationMs: result.durationMs }
}

function syncRunOutcome(runId: string, packetId: string, status: 'completed' | 'failed', summary: string, commitHash?: string): void {
  const run = getAgentJob(runId)
  if (!run) return
  const completedPacketIds = status === 'completed'
    ? Array.from(new Set([...run.completedPacketIds, packetId]))
    : run.completedPacketIds
  updateAgentJob(runId, {
    completedPacketIds,
    currentCommit: commitHash || run.currentCommit,
    metrics: {
      ...run.metrics,
      completedPackets: completedPacketIds.length,
      failedPackets: run.metrics.failedPackets + (status === 'failed' ? 1 : 0)
    },
    summary
  })
}

function packetValidationEvidence(params: {
  sourceId: string
  runId: string
  packetId: string
  taskId: string
  index: number
  result: SafeCommandResult
}): { evidenceRefs?: WorkbenchEvidenceMetadata[]; evidenceUnavailable?: WorkbenchEvidenceUnavailable } {
  const evidence = attachWorkbenchEvidence({
    entries: [{
      kind: 'validation_result',
      owner: {
        sourceId: params.sourceId,
        runId: params.runId,
        taskId: params.taskId,
        packetId: params.packetId,
        operationId: `packet-validation:${params.packetId}:${params.index}`
      },
      retentionClass: 'active_run',
      content: JSON.stringify({
        packetId: params.packetId,
        validationIndex: params.index,
        commandKind: params.result.commandKind,
        status: params.result.status,
        exitCode: params.result.exitCode,
        durationMs: params.result.durationMs,
        stdout: params.result.stdout.slice(0, 8_000),
        stderr: params.result.stderr.slice(0, 8_000),
        outputTruncated: params.result.outputTruncated
      })
    }]
  })
  return evidence
}

function resultFromPersistedValidationJob(job: NonNullable<ReturnType<typeof getCompactWorkbenchValidationJob>>, sourceRoot: string): SafeCommandResult {
  const status: SafeCommandResult['status'] = job.status === 'completed'
    ? 'completed'
    : job.status === 'timed_out'
      ? 'timed_out'
      : job.status === 'cancelled'
        ? 'blocked'
        : 'failed'
  return {
    status,
    commandKind: job.commandKind,
    command: ['buildflow', job.commandKind],
    cwd: path.resolve(sourceRoot),
    packageDir: job.packageDir,
    requiredBranch: job.requiredBranch,
    exitCode: job.exitCode ?? (status === 'completed' ? 0 : 1),
    signal: job.signal ?? null,
    stdout: job.stdout || job.stdoutTail || '',
    stderr: job.stderr || job.stderrTail || '',
    outputTruncated: job.outputTruncated === true,
    durationMs: job.durationMs || 0,
    changedPaths: job.changedPaths || [],
    protectedPathsChanged: job.protectedPathsChanged || [],
    reason: job.reason,
    details: job.details,
    runtime: job.runtime
  }
}

async function runPersistedPacketValidation(params: {
  sourceId: string
  sourceRoot: string
  runId: string
  packetId: string
  taskId: string
  selection: { selectionId: string; node: ValidationSelectionNode }
}): Promise<SafeCommandResult> {
  const node = params.selection.node
  const command = node.command
  const submitted = submitWorkbenchValidationJob({
    sourceId: params.sourceId,
    runId: params.runId,
    packetId: params.packetId,
    taskId: params.taskId,
    idempotencyKey: `r19.4:${params.selection.selectionId}:${node.nodeId}`,
    commandKind: command.commandKind,
    timeoutMs: node.timeoutMs,
    ...(command.commandKind === 'git_diff_check' || command.commandKind === 'validate_json_files' || command.commandKind === 'security_scan_paths' ? { paths: command.paths } : {}),
    ...(command.commandKind === 'security_scan_paths' ? { patternSet: command.patternSet } : {}),
    ...(command.commandKind === 'run_package_script' ? { packageDir: command.packageDir, scriptName: command.scriptName } : {}),
    ...(command.commandKind === 'run_package_test' ? { packageDir: command.packageDir } : {}),
    ...(command.commandKind === 'run_package_test_marker' ? { packageDir: command.packageDir, marker: command.marker } : {}),
    networkAccess: false
  })
  if (submitted.ok === false) throw new Error(`Validation job submission failed: ${submitted.message}`)
  let job = submitted.job
  if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) {
    const scheduled = scheduleWorkbenchValidationJob({
      jobId: job.jobId,
      sourceId: params.sourceId,
      sourceRoot: params.sourceRoot,
      leaseMs: Math.max(30_000, Math.min(node.timeoutMs + 30_000, 960_000))
    })
    if (scheduled.status === 'rejected') throw new Error(`Validation job scheduling failed: ${scheduled.reason || 'unknown scheduler failure'}`)
    const deadline = Date.now() + node.timeoutMs + 30_000
    while (Date.now() < deadline) {
      assertPacketControlAllowsExecution(params.packetId)
      const latest = getCompactWorkbenchValidationJob(job.jobId, params.sourceId)
      if (!latest) throw new Error(`Validation job ${job.jobId} disappeared before completion.`)
      job = latest
      if (['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    if (!['completed', 'failed', 'timed_out', 'cancelled'].includes(job.status)) throw new Error(`Validation job ${job.jobId} exceeded its bounded wait.`)
  }
  return resultFromPersistedValidationJob(job, params.sourceRoot)
}

export async function executeWorkbenchPacket(params: {
  packetId: string
  leaseToken: string
  sourceId: string
  sourceRoot: string
}): Promise<WorkbenchPacketExecutionResult> {
  const planResult = planWorkbenchPacketExecution(params)
  if (!planResult.ready) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      completedSteps: 0,
      changedPaths: [],
      errors: planResult.errors
    }
  }

  const record = getWorkbenchPacketRecord(params.packetId)
  if (!record) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      completedSteps: 0,
      changedPaths: [],
      errors: [{ code: 'PACKET_NOT_FOUND', message: 'packet disappeared after planning' }]
    }
  }

  const validationEvidenceRef = (index: number) => `${record.packet.packetId}:validation:${index}`
  const projectValidationStarted = (index: number, commandKind: string): void => {
    const evidenceRef = validationEvidenceRef(index)
    if (hasPacketValidationActivityEvent({
      jobId: record.packet.runId,
      sourceId: params.sourceId,
      packetId: record.packet.packetId,
      evidenceRef,
      kind: 'validation_started'
    })) return
    appendAgentEvent({
      jobId: record.packet.runId,
      sourceId: params.sourceId,
      type: 'validation_started',
      activityKind: 'validation_started',
      packetId: record.packet.packetId,
      taskId: record.packet.taskId,
      commandKind,
      status: 'running',
      evidenceRefs: [{ kind: 'validation', ref: evidenceRef }],
      message: `Packet validation ${commandKind} started`
    })
  }

  const run = getAgentJob(record.packet.runId)
  const config = loadConfig()
  const sourceAllowsAutoCommit = (config?.autoCommitSourceIds || []).includes(params.sourceId)
  const automaticCommit = run?.autoCommit === true && sourceAllowsAutoCommit
  const explicitCommit = record.packet.commit?.enabled === true
  const shouldCommit = explicitCommit || automaticCommit
  const task = run?.roadmapPhases
    .flatMap(phase => phase.tasks)
    .find(candidate => candidate.id === record.packet.taskId)

  try {
    assertCleanPacketPaths(params.sourceRoot, record.exactPaths, shouldCommit)
  } catch (error) {
    return {
      status: 'rejected',
      packetId: params.packetId,
      writesPerformed: false,
      rolledBack: false,
      planHash: planResult.plan.planHash,
      completedSteps: 0,
      changedPaths: [],
      errors: [{ code: 'PACKET_GIT_STATE_NOT_ISOLATED', message: error instanceof Error ? error.message : String(error) }]
    }
  }

  const snapshots: FileSnapshot[] = []
  const snapshotPaths = Array.from(new Set(planResult.plan.exactPaths.map(relative => path.resolve(params.sourceRoot, relative))))
  let journal: WorkbenchExecutionJournal | undefined
  let completedSteps = 0
  let writesPerformed = false
  let changedPaths: string[] = []
  const validationResults: NonNullable<WorkbenchPacketExecutionResult['validationResults']> = []
  const readEvidence: NonNullable<WorkbenchPacketExecutionResult['readEvidence']> = []
  const commandEvidence: NonNullable<WorkbenchPacketExecutionResult['commandEvidence']> = []
  let commitResult: WorkbenchPacketExecutionResult['commitResult']
  let commitHash: string | undefined
  let localServer: LocalServerHandle | undefined
  const baselineStatus = gitStatusSnapshot(params.sourceRoot)

  const projectLocalServerEvent = (event: LocalServerLifecycleEvent): void => {
    const eventType = `server_${event.phase}` as Parameters<typeof appendAgentEvent>[0]['type']
    appendAgentEvent({
      jobId: record.packet.runId,
      sourceId: params.sourceId,
      type: eventType,
      activityKind: 'packet_status',
      packetId: record.packet.packetId,
      taskId: record.packet.taskId,
      status: event.record.status,
      evidenceRefs: event.evidenceRefs.map(ref => ({ kind: 'artifact', ref: ref.evidenceId })),
      telemetry: {
        ...(event.record.metrics.requestToReadyMs !== undefined ? { durationMs: event.record.metrics.requestToReadyMs } : {})
      },
      message: `Local server ${event.record.serverId} ${event.phase} on port ${event.record.port}.`
    })
  }

  const assertLocalServerReady = (): void => {
    if (!localServer) return
    const state = localServer.status()
    if (!state || state.status !== 'READY') throw new Error(`Local server is not ready: ${state?.status || 'state_unavailable'}`)
  }

  try {
    for (const fullPath of snapshotPaths) snapshots.push(snapshotFile(fullPath))
    journal = prepareWorkbenchExecutionJournal({
      record,
      sourceRoot: params.sourceRoot,
      planHash: planResult.plan.planHash
    })

    for (const read of record.packet.goalDispatch?.reads || []) {
      assertPacketControlAllowsExecution(params.packetId)
      const evidence = executeGoalRead(params.sourceRoot, read)
      readEvidence.push(evidence)
      appendAgentEvent({
        jobId: record.packet.runId,
        sourceId: params.sourceId,
        type: 'file_read',
        activityKind: 'file_read',
        packetId: record.packet.packetId,
        taskId: record.packet.taskId,
        paths: [evidence.path],
        status: 'completed',
        message: `Goal dispatch read ${evidence.path}.`
      })
    }

    for (const command of record.packet.goalDispatch?.commands || []) {
      assertPacketControlAllowsExecution(params.packetId)
      const evidence = await executeGoalCommand({ sourceId: params.sourceId, sourceRoot: params.sourceRoot, command })
      commandEvidence.push(evidence)
      appendAgentEvent({
        jobId: record.packet.runId,
        sourceId: params.sourceId,
        type: 'command_completed',
        activityKind: 'executor_completed',
        packetId: record.packet.packetId,
        taskId: record.packet.taskId,
        commandKind: command.commandKind,
        status: evidence.status,
        telemetry: { durationMs: evidence.durationMs },
        message: `Goal dispatch command ${command.commandKind} completed.`
      })
    }

    for (const [index, step] of record.packet.steps.entries()) {
      assertPacketControlAllowsExecution(params.packetId)
      const fullPath = path.resolve(params.sourceRoot, step.path)
      const targetPath = step.to ? path.resolve(params.sourceRoot, step.to) : undefined

      switch (step.type) {
        case 'create': {
          if (fs.existsSync(fullPath)) throw new Error(`Create target already exists: ${step.path}`)
          fs.mkdirSync(path.dirname(fullPath), { recursive: true })
          fs.writeFileSync(fullPath, step.content || '', 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(step.content || '', 'utf8')))
          break
        }
        case 'overwrite': {
          if (!fs.existsSync(fullPath)) throw new Error(`Overwrite target does not exist: ${step.path}`)
          fs.writeFileSync(fullPath, step.content || '', 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(step.content || '', 'utf8')))
          break
        }
        case 'append': {
          if (!fs.existsSync(fullPath)) throw new Error(`Append target does not exist: ${step.path}`)
          const before = fs.readFileSync(fullPath)
          const appended = Buffer.from(step.content || '', 'utf8')
          fs.appendFileSync(fullPath, appended)
          verifyFileHash(fullPath, sha256Buffer(Buffer.concat([before, appended])))
          break
        }
        case 'patch': {
          if (!fs.existsSync(fullPath)) throw new Error(`Patch target does not exist: ${step.path}`)
          const original = fs.readFileSync(fullPath, 'utf8')
          const find = step.find || ''
          if (!find) throw new Error(`Patch find text is required: ${step.path}`)
          const matches = original.split(find).length - 1
          if (matches !== 1) throw new Error(`Patch must match exactly once (${matches} matches): ${step.path}`)
          const updated = original.replace(find, step.replace || '')
          fs.writeFileSync(fullPath, updated, 'utf8')
          verifyFileHash(fullPath, sha256Buffer(Buffer.from(updated, 'utf8')))
          break
        }
        case 'delete_file': {
          if (!fs.existsSync(fullPath)) throw new Error(`Delete target does not exist: ${step.path}`)
          fs.unlinkSync(fullPath)
          if (fs.existsSync(fullPath)) throw new Error(`Delete verification failed: ${step.path}`)
          break
        }
        case 'move': {
          if (!targetPath) throw new Error(`Move target is required: ${step.path}`)
          if (!fs.existsSync(fullPath)) throw new Error(`Move source does not exist: ${step.path}`)
          if (fs.existsSync(targetPath)) throw new Error(`Move target already exists: ${step.to}`)
          const sourceHash = sha256Buffer(fs.readFileSync(fullPath))
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.renameSync(fullPath, targetPath)
          if (fs.existsSync(fullPath)) throw new Error(`Move source still exists: ${step.path}`)
          verifyFileHash(targetPath, sourceHash)
          break
        }
      }

      writesPerformed = true
      completedSteps = index + 1
      changedPaths = assertChangedPathsWithinAuthorization(baselineStatus, params.sourceRoot, record.exactPaths)
      markWorkbenchExecutionJournalStep(params.packetId, completedSteps)
    }

    if (record.packet.localServer) {
      const started = await startLocalServer({
        sourceRoot: params.sourceRoot,
        sourceId: params.sourceId,
        runId: record.packet.runId,
        sessionId: workbenchSessionIdForRun(record.packet.runId),
        taskId: record.packet.taskId,
        packetId: record.packet.packetId,
        declaration: record.packet.localServer,
        allowRecovery: true
      }, { onEvent: projectLocalServerEvent })
      if (started.ok === false) throw new Error(`${started.code}: ${started.message}`)
      localServer = started.handle
      assertLocalServerReady()
    }

    for (const [validationIndex, validation] of (record.packet.validation || []).entries()) {
      assertPacketControlAllowsExecution(params.packetId)
      assertLocalServerReady()
      projectValidationStarted(validationIndex, validation.commandKind)
      const selectedNode = record.packet.validationSelection?.selected[validationIndex]
      const result = selectedNode
        ? await runPersistedPacketValidation({
            sourceId: params.sourceId,
            sourceRoot: params.sourceRoot,
            runId: record.packet.runId,
            packetId: record.packet.packetId,
            taskId: record.packet.taskId,
            selection: { selectionId: record.packet.validationSelection.selectionId, node: selectedNode }
          })
        : await runSafeCommand({
            sourceId: params.sourceId,
            sourceRoot: params.sourceRoot,
            commandKind: validation.commandKind,
            timeoutMs: validation.timeoutMs,
            paths: validation.paths,
            packageDir: validation.packageDir,
            scriptName: validation.scriptName,
            marker: validation.marker,
            patternSet: validation.patternSet
          })
      const validationEvidence = packetValidationEvidence({
        sourceId: params.sourceId,
        runId: record.packet.runId,
        packetId: record.packet.packetId,
        taskId: record.packet.taskId,
        index: validationIndex,
        result
      })
      validationResults.push({
        commandKind: result.commandKind,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout.slice(0, 2000),
        stderr: result.stderr.slice(0, 1000),
        ...validationEvidence
      })
      if (result.status !== 'completed') throw new Error(`Validation ${result.commandKind} failed`)
      changedPaths = assertChangedPathsWithinAuthorization(baselineStatus, params.sourceRoot, record.exactPaths)
      assertLocalServerReady()
      assertPacketControlAllowsExecution(params.packetId)
    }

    if (shouldCommit) {
      assertPacketControlAllowsExecution(params.packetId)
      if (automaticCommit && (record.packet.validation || []).length === 0) {
        throw new Error('Automatic commit requires at least one targeted validation.')
      }
      if (automaticCommit && validationResults.some(result => result.status !== 'completed')) {
        throw new Error('Automatic commit requires all targeted validations to pass.')
      }

      const selectedSecurity = record.packet.validationSelection?.selected.some(node => {
        if (node.command.commandKind !== 'security_scan_paths') return false
        return JSON.stringify(sortedUnique(node.command.paths)) === JSON.stringify(sortedUnique(record.exactPaths))
      }) === true
      if (!selectedSecurity) {
        projectValidationStarted(validationResults.length, 'security_scan_paths')
        const securityScan = await runSafeCommand({
          sourceId: params.sourceId,
          sourceRoot: params.sourceRoot,
          commandKind: 'security_scan_paths',
          paths: record.exactPaths,
          patternSet: 'forbidden_secret_material'
        })
        const securityEvidence = packetValidationEvidence({
          sourceId: params.sourceId,
          runId: record.packet.runId,
          packetId: record.packet.packetId,
          taskId: record.packet.taskId,
          index: validationResults.length,
          result: securityScan
        })
        validationResults.push({
          commandKind: securityScan.commandKind,
          status: securityScan.status,
          exitCode: securityScan.exitCode,
          durationMs: securityScan.durationMs,
          stdout: securityScan.stdout.slice(0, 2000),
          stderr: securityScan.stderr.slice(0, 1000),
          ...securityEvidence
        })
        if (securityScan.status !== 'completed') throw new Error(`Exact-path secret scan failed: ${securityScan.stderr || securityScan.stdout}`)
        changedPaths = assertChangedPathsWithinAuthorization(baselineStatus, params.sourceRoot, record.exactPaths)
        assertPacketControlAllowsExecution(params.packetId)
      }

      const staged = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: 'git_add_paths',
        paths: record.exactPaths
      })
      if (staged.status !== 'completed') throw new Error(`Exact-path staging failed: ${staged.stderr || staged.stdout}`)
      verifyExactPathSet(
        gitLines(params.sourceRoot, ['diff', '--cached', '--name-only']),
        record.exactPaths,
        'Staged'
      )

      const derivedTitle = String(task?.title || record.packet.goalSummary || 'complete packet')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180)
      const commitMessage = record.packet.commit?.message?.trim() || `workbench: ${derivedTitle}`
      const existingBody = record.packet.commit?.body?.trim()
      const trailer = `Workbench-Run: ${record.packet.runId}\nWorkbench-Packet: ${record.packet.packetId}`
      const commitBody = existingBody ? `${existingBody}\n\n${trailer}` : trailer
      const committed = await runSafeCommand({
        sourceId: params.sourceId,
        sourceRoot: params.sourceRoot,
        commandKind: 'git_commit',
        message: commitMessage,
        body: commitBody
      })
      commitResult = {
        status: committed.status,
        exitCode: committed.exitCode,
        stdout: committed.stdout.slice(0, 2000),
        stderr: committed.stderr.slice(0, 1000)
      }
      if (committed.status !== 'completed') throw new Error(`Packet commit failed: ${committed.stderr || committed.stdout}`)
      commitHash = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
      if (!commitHash) throw new Error('Packet commit hash could not be resolved')
      verifyExactPathSet(
        gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']),
        record.exactPaths,
        'Committed'
      )
      assertChangedPathsWithinAuthorization(baselineStatus, params.sourceRoot, record.exactPaths)
    }

    if (localServer) {
      const stopped = await localServer.stop('packet execution completed')
      if (stopped.ok === false) throw new Error(`${stopped.code}: ${stopped.message}`)
      localServer = undefined
    }

    assertPacketControlAllowsExecution(params.packetId)
    assertChangedPathsWithinAuthorization(baselineStatus, params.sourceRoot, record.exactPaths)
    const finalized = finalizeWorkbenchPacketExecution({
      packetId: params.packetId,
      leaseToken: params.leaseToken,
      status: 'completed',
      commitHash
    })
    if (finalized.ok === false) throw new Error(`Packet finalization failed: ${finalized.message}`)
    completeWorkbenchExecutionJournal(params.packetId)
    advanceWorkbenchRunAfterPacket({
      runId: record.packet.runId,
      taskId: record.packet.taskId,
      packetId: params.packetId,
      commitHash
    })

    return {
      status: 'completed',
      packetId: params.packetId,
      writesPerformed,
      rolledBack: false,
      planHash: planResult.plan.planHash,
      completedSteps,
      changedPaths,
      validationResults,
      commitResult,
      commitHash,
      readEvidence,
      commandEvidence,
      errors: []
    }
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error)
    const controlAction = error instanceof PacketControlSignal ? error.action : undefined
    if (localServer) {
      const stopped = await localServer.stop('packet execution rollback')
      localServer = undefined
      if (stopped.ok === false) message = `${message}; local server shutdown failed: ${stopped.code}: ${stopped.message}`
    }
    let rolledBack = false
    try {
      if (journal) restoreWorkbenchExecutionJournal({ journal, sourceRoot: params.sourceRoot })
      else restoreSnapshots(snapshots)
      if (shouldCommit) {
        execFileSync('git', ['reset', '--quiet', '--', ...record.exactPaths], {
          cwd: params.sourceRoot,
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      }
      rolledBack = true
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
      finalizeWorkbenchPacketExecution({
        packetId: params.packetId,
        leaseToken: params.leaseToken,
        status: 'failed',
        failureReason: `${message}; rollback failed: ${rollbackMessage}`
      })
      syncRunOutcome(record.packet.runId, params.packetId, 'failed', `Packet ${params.packetId} failed and rollback also failed.`)
      return {
        status: 'failed',
        packetId: params.packetId,
        writesPerformed,
        rolledBack: false,
        planHash: planResult.plan.planHash,
        completedSteps,
        changedPaths: changedPathsSince(baselineStatus, gitStatusSnapshot(params.sourceRoot)),
        failedStep: completedSteps,
        validationResults,
        errors: [
          { code: message.startsWith('UNEXPECTED_CHANGED_PATH:') ? 'UNEXPECTED_CHANGED_PATH' : 'PACKET_EXECUTION_FAILED', message },
          { code: 'ROLLBACK_FAILED', message: rollbackMessage }
        ]
      }
    }

    if (controlAction) {
      const controlledStatus = controlAction === 'pause' ? 'paused' : 'cancelled'
      finalizeWorkbenchPacketExecution({
        packetId: params.packetId,
        leaseToken: params.leaseToken,
        status: controlledStatus
      })
      if (journal) completeWorkbenchExecutionJournal(params.packetId)
      changedPaths = changedPathsSince(baselineStatus, gitStatusSnapshot(params.sourceRoot))
      return {
        status: controlledStatus,
        packetId: params.packetId,
        writesPerformed,
        rolledBack,
        planHash: planResult.plan.planHash,
        completedSteps,
        changedPaths,
        validationResults,
        readEvidence,
        commandEvidence,
        errors: [{ code: controlAction === 'pause' ? 'PACKET_PAUSED' : 'PACKET_CANCELLED', message }]
      }
    }

    finalizeWorkbenchPacketExecution({
      packetId: params.packetId,
      leaseToken: params.leaseToken,
      status: 'failed',
      failureReason: message
    })
    if (journal) completeWorkbenchExecutionJournal(params.packetId)
    changedPaths = changedPathsSince(baselineStatus, gitStatusSnapshot(params.sourceRoot))
    syncRunOutcome(record.packet.runId, params.packetId, 'failed', `Packet ${params.packetId} failed and was rolled back.`)
    return {
      status: 'failed',
      packetId: params.packetId,
      writesPerformed,
      rolledBack,
      planHash: planResult.plan.planHash,
      completedSteps,
      changedPaths,
      failedStep: completedSteps,
      validationResults,
      readEvidence,
      commandEvidence,
      errors: [{ code: message.startsWith('UNEXPECTED_CHANGED_PATH:') ? 'UNEXPECTED_CHANGED_PATH' : 'PACKET_EXECUTION_FAILED', message }]
    }
  }
}

/** Public packet acknowledgements expose validation metadata, never raw log bodies. */
export function compactWorkbenchPacketExecutionResult(result: WorkbenchPacketExecutionResult): Record<string, unknown> {
  return {
    ...result,
    validationResults: result.validationResults?.map(validation => {
      const { stdout: _stdout, stderr: _stderr, ...compact } = validation
      return compact
    }),
    commitResult: result.commitResult
      ? (({ stdout: _stdout, stderr: _stderr, ...compact }) => compact)(result.commitResult)
      : undefined
  }
}




export type WorkbenchPacketCommitUndoResult = {
  status: 'reverted' | 'rejected'
  packetId: string
  originalCommitHash?: string
  revertCommitHash?: string
  exactPaths: string[]
  errors: Array<{ code: string; message: string }>
}

export function undoWorkbenchPacketCommit(params: {
  packetId: string
  sourceId: string
  sourceRoot: string
}): WorkbenchPacketCommitUndoResult {
  const record = getWorkbenchPacketRecord(params.packetId)
  const reject = (code: string, message: string): WorkbenchPacketCommitUndoResult => ({
    status: 'rejected',
    packetId: params.packetId,
    originalCommitHash: record?.commitHash,
    exactPaths: record?.exactPaths || [],
    errors: [{ code, message }]
  })

  if (!record || record.packet.sourceId !== params.sourceId) {
    return reject('UNDO_PACKET_NOT_FOUND', 'Packet was not found for the selected source.')
  }
  if (!record.commitHash) {
    return reject('UNDO_COMMIT_MISSING', 'Packet does not have a persisted commit hash.')
  }

  const head = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
  if (head !== record.commitHash) {
    return reject('UNDO_HEAD_MISMATCH', 'Safe undo requires the Workbench-created commit to be the current HEAD.')
  }

  const commitMessage = execFileSync('git', ['show', '-s', '--format=%B', head], {
    cwd: params.sourceRoot,
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (!commitMessage.includes(`Workbench-Run: ${record.packet.runId}`)
    || !commitMessage.includes(`Workbench-Packet: ${record.packet.packetId}`)) {
    return reject('UNDO_TRAILER_MISMATCH', 'Current HEAD is missing the expected Workbench commit trailers.')
  }

  try {
    verifyExactPathSet(
      gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', head]),
      record.exactPaths,
      'Undo target'
    )
  } catch (error) {
    return reject('UNDO_PATH_MISMATCH', error instanceof Error ? error.message : String(error))
  }

  if (gitLines(params.sourceRoot, ['diff', '--cached', '--name-only']).length > 0) {
    return reject('UNDO_INDEX_NOT_CLEAN', 'Safe undo requires an empty Git index.')
  }
  if (gitLines(params.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...record.exactPaths]).length > 0) {
    return reject('UNDO_PACKET_PATHS_DIRTY', 'Safe undo requires the committed packet paths to be clean.')
  }

  try {
    execFileSync('git', ['revert', '--no-edit', head], {
      cwd: params.sourceRoot,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const revertCommitHash = gitLines(params.sourceRoot, ['rev-parse', 'HEAD'])[0]
    if (!revertCommitHash || revertCommitHash === head) {
      return reject('UNDO_REVERT_HASH_MISSING', 'Safe undo did not produce a new revert commit.')
    }
    verifyExactPathSet(
      gitLines(params.sourceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', revertCommitHash]),
      record.exactPaths,
      'Undo commit'
    )
    return {
      status: 'reverted',
      packetId: params.packetId,
      originalCommitHash: head,
      revertCommitHash,
      exactPaths: record.exactPaths,
      errors: []
    }
  } catch (error) {
    return reject('UNDO_REVERT_FAILED', error instanceof Error ? error.message : String(error))
  }
}
