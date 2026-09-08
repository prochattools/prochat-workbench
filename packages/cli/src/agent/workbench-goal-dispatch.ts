import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendAgentEvent } from './agent-events'
import { createWorkbenchRun, getAgentJob, updateAgentJob, type AgentJob } from './agent-jobs'
import { scheduleWorkbenchPacket } from './workbench-packet-coordinator'
import { getWorkbenchPacketResult } from './workbench-packet-results'
import { preflightWorkbenchPacket, type WorkbenchGoalDispatch, type WorkbenchPacket, type WorkbenchPacketCommitPolicy, type WorkbenchPacketStep } from './workbench-packets'
import { reserveWorkbenchPacket } from './workbench-packet-store'

export const WORKBENCH_GOAL_DISPATCH_VERSION = 1 as const

export type WorkbenchGoalDispatchInput = WorkbenchGoalDispatch & {
  steps: WorkbenchPacketStep[]
  validation?: WorkbenchPacket['validation']
  commit?: WorkbenchPacketCommitPolicy & { authorized?: boolean }
  pushIntent?: 'not_requested' | 'explicitly_authorized'
}

export type WorkbenchGoalDispatchResult = {
  status: 'queued' | 'already_queued' | 'blocked'
  verified: boolean
  writesPerformed: false
  run: AgentJob
  packet?: {
    packetId: string
    taskId: string
    status: 'queued' | 'already_queued' | 'blocked'
    exactPaths: string[]
  }
  terminalResult?: Record<string, unknown>
  warnings?: string[]
  error?: { code: string; message: string }
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

function boundedList(value: unknown, limit: number, itemLimit = 240): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string').map(item => boundedText(item, itemLimit)).filter(Boolean))).slice(0, limit)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
}

function sha(value: unknown): string {
  return crypto.createHash('sha256').update(stable(value), 'utf8').digest('hex')
}

function currentHead(sourceRoot: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function compactTerminalResult(run: AgentJob, packetId: string, sourceId: string, sourceRoot: string): Record<string, unknown> | undefined {
  const result = getWorkbenchPacketResult(packetId)
  if (!result) return undefined
  const changedFiles = result.changedPaths.slice(0, 12)
  const validation = result.validation.slice(0, 5).map(item => ({ commandKind: item.commandKind, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs }))
  const commit = result.commitHash ? { hash: result.commitHash } : undefined
  const warnings = result.errors.map(error => `${error.code}: ${error.message}`).slice(0, 5)
  return {
    status: result.status,
    summary: run.summary,
    sourceId,
    changedFiles,
    reads: (result.readEvidence || []).slice(0, 5),
    commands: (result.commandEvidence || []).slice(0, 3),
    validation,
    ...(commit ? { commit } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    localExecutionMs: result.validation.reduce((total, item) => total + Math.max(0, item.durationMs || 0), 0)
  }
}

function normalizeDispatch(input: WorkbenchGoalDispatchInput): WorkbenchGoalDispatchInput {
  if (!input || input.version !== WORKBENCH_GOAL_DISPATCH_VERSION) throw new Error('goalDispatch.version must be 1')
  const expectedOutcome = boundedText(input.expectedOutcome, 500)
  if (!expectedOutcome) throw new Error('goalDispatch.expectedOutcome is required')
  if (!Array.isArray(input.steps) || input.steps.length > 5) throw new Error('goalDispatch.steps must contain at most 5 bounded steps')
  if (input.commit?.enabled && input.commit.authorized !== true) throw new Error('goalDispatch commit requires explicit authorization')
  if (input.confirmationPolicy === 'single_exact' && input.confirmedByUser !== true) throw new Error('goalDispatch requires the exact confirmation before execution')
  return {
    ...input,
    expectedOutcome,
    scope: boundedList(input.scope, 20, 240),
    knownFiles: boundedList(input.knownFiles, 20, 240),
    knownSymbols: boundedList(input.knownSymbols, 20, 180),
    constraints: boundedList(input.constraints, 12),
    nonGoals: boundedList(input.nonGoals, 12),
    stopConditions: boundedList(input.stopConditions, 8),
    steps: input.steps.slice(0, 5),
    reads: input.reads?.slice(0, 5),
    commands: input.commands?.slice(0, 3),
    terminalResult: {
      style: 'natural_language',
      include: Array.from(new Set(input.terminalResult?.include || ['summary', 'changed_files', 'validation', 'commit', 'warnings', 'blocker'])).slice(0, 6) as WorkbenchGoalDispatch['terminalResult']['include']
    }
  }
}

export function dispatchWorkbenchGoal(params: {
  sourceId: string
  sourceRoot: string
  goal: string
  requestId?: string
  documentationPath?: string
  maxIterations?: number
  dispatch: WorkbenchGoalDispatchInput
}): WorkbenchGoalDispatchResult {
  const dispatch = normalizeDispatch(params.dispatch)
  const goal = boundedText(params.goal, 4_000)
  if (!goal) throw new Error('goal is required')
  const commit = dispatch.commit?.enabled ? dispatch.commit : undefined
  const created = createWorkbenchRun({
    sourceId: params.sourceId,
    goal,
    requestId: params.requestId,
    documentationPath: params.documentationPath,
    maxIterations: params.maxIterations,
    autoCommit: Boolean(commit?.enabled),
    autoPush: false,
    autonomyLevel: 'hands_off_safe'
  })
  const run = created.run
  const taskId = run.activeTaskId || `task-${sha({ runId: run.id, goal }).slice(0, 24)}`
  const head = currentHead(params.sourceRoot)
  const packetId = `goal-${sha({ runId: run.id, goal, dispatch, head }).slice(0, 32)}`
  const packet: WorkbenchPacket = {
    version: 1,
    runId: run.id,
    packetId,
    idempotencyKey: `${run.id}:${packetId}`,
    sourceId: params.sourceId,
    taskId,
    goalSummary: dispatch.expectedOutcome,
    expectedHead: head,
    goalDispatch: dispatch,
    steps: dispatch.steps,
    ...(dispatch.validation && dispatch.validation.length > 0 ? { validation: dispatch.validation } : {}),
    ...(commit ? { commit } : {}),
    createdAt: new Date().toISOString()
  }
  const preflight = preflightWorkbenchPacket({ packet, sourceRoot: params.sourceRoot })
  if (!preflight.accepted) {
    const blocked = updateAgentJob(run.id, {
      status: 'blocked',
      blockedReason: preflight.errors[0]?.message || 'Goal dispatch packet was rejected during preflight.',
      summary: 'Workbench rejected the durable goal packet before any local write.'
    })
    return {
      status: 'blocked',
      verified: false,
      writesPerformed: false,
      run: blocked,
      packet: { packetId, taskId, status: 'blocked', exactPaths: preflight.exactPaths || [] },
      error: { code: preflight.errors[0]?.code || 'GOAL_PACKET_PREFLIGHT_FAILED', message: preflight.errors[0]?.message || 'Goal packet preflight failed.' }
    }
  }
  const reservation = reserveWorkbenchPacket({ packet, exactPaths: preflight.exactPaths || [] })
  if (reservation.ok === false) {
    const blocked = updateAgentJob(run.id, { status: 'blocked', blockedReason: reservation.message, summary: 'Workbench could not reserve the durable goal packet.' })
    return {
      status: 'blocked', verified: false, writesPerformed: false, run: blocked,
      packet: { packetId, taskId, status: 'blocked', exactPaths: preflight.exactPaths || [] },
      error: { code: reservation.code, message: reservation.message }
    }
  }
  const bound = updateAgentJob(run.id, {
    activePacketId: packetId,
    summary: 'Workbench dispatched the bounded goal locally; no further Action is required for internal execution.',
    nextActions: ['Wait for the durable packet to reach a terminal result.', 'Retrieve the compact terminal result once if needed.']
  })
  const scheduled = scheduleWorkbenchPacket({
    packetId,
    sourceId: params.sourceId,
    sourceRootFor: sourceId => sourceId === params.sourceId ? params.sourceRoot : undefined
  })
  appendAgentEvent({
    jobId: run.id,
    sourceId: params.sourceId,
    type: 'preflight_started',
    activityKind: 'run_progress',
    requestId: params.requestId,
    status: 'queued',
    message: 'One durable Workbench goal dispatch was accepted for local execution.'
  })
  const terminalResult = compactTerminalResult(bound, packetId, params.sourceId, params.sourceRoot)
  return {
    status: scheduled.status === 'already_scheduled' ? 'already_queued' : 'queued',
    verified: true,
    writesPerformed: false,
    run: bound,
    packet: { packetId, taskId, status: scheduled.status === 'already_scheduled' ? 'already_queued' : 'queued', exactPaths: preflight.exactPaths || [] },
    ...(terminalResult ? { terminalResult } : {}),
    warnings: dispatch.pushIntent === 'explicitly_authorized' ? ['Push/release intent was recorded but is not executed by the local goal packet. Use the supported release controller after reviewing the terminal result.'] : undefined
  }
}

export function getWorkbenchGoalTerminalResult(params: { runId: string; sourceId: string; sourceRoot?: string }): Record<string, unknown> | undefined {
  const run = getAgentJob(params.runId)
  if (!run || run.sourceId !== params.sourceId) return undefined
  const packetIds = [
    ...(run.activePacketId ? [run.activePacketId] : []),
    ...[...run.completedPacketIds].reverse()
  ]
  for (const packetId of packetIds) {
    const result = getWorkbenchPacketResult(packetId)
    if (result?.runId !== run.id || result.sourceId !== params.sourceId) continue
    return compactTerminalResult(run, packetId, params.sourceId, params.sourceRoot || '')
  }
  return undefined
}
