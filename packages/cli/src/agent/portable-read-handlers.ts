import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { getActiveWorkbenchRun, listActiveWorkbenchRuns } from './agent-jobs'
import { appendAgentEvent, listWorkbenchActivity } from './agent-events'
import { ensureWorkbenchActionRun, type WorkbenchActionRunBinding, updateAgentJob } from './agent-jobs'
import { listWorkbenchPacketRecords } from './workbench-packet-store'
import { getActiveSourceContext, getSourceIndexState, getSourcesSafe, isSourcePathAvailable } from './config'
import { handleFocusedRead } from './focused-read'
import { handleGraphContextRouted } from './graph-context-router'
import { Indexer, getIndexedDocumentCountFromDisk } from './indexer'
import { prepareTaskContext, shouldPrepareStructuralContext, type KnowledgeContextPreparation, type StructuralContextPreparation } from './prepare-task-context'
import { VaultSearcher } from './search'
import { getResolvedActiveSources, redactSecrets, shouldIncludeEntry, truncateContent } from './safe-access'
import { readFile } from './vault'
import type { PortableExecutionContext, PortableOperationHandlers } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from './portable-operation-errors'
import { negotiateMcpContextClient, formatMcpContextWorkflowResponse, recordMcpContextWorkflowResult } from './mcp-context-workflow'
import { authorizeContextRead } from './context-broker'
import { consumePreparedMcpContext } from './mcp-context-bridge'
import { attachWorkbenchEvidence, deterministicWorkbenchEvidenceId } from './workbench-evidence-producers'
import type { WorkbenchEvidenceStoreOptions } from './workbench-evidence-store'
import { getWorkbenchReadResultRecovery, markWorkbenchReadResultReconciled, persistWorkbenchReadResult, type WorkbenchReadResultRecoveryIdentity, type WorkbenchReadResultRecoveryOptions } from './workbench-read-result-recovery'
import { projectActiveRunContinuity, resolveResumeNavigation, type ActiveRunContinuity } from '@workbench/shared'
import { getFocusedWorkspace } from './focused-workspace'
import { getSourceReconciliationReport } from './source-reconciliation'

const MAX_PATHS = 5
const MAX_FILE_BYTES = 4_000
const LARGE_FILE_BYTES = 100 * 1024

type Payload = Record<string, unknown>

export type PortableReadHandlerDependencies = {
  indexedFiles?: () => number
  indexingActive?: () => boolean
  indexingSourceIds?: () => string[]
  readResponseBudgetBytes?: number
  readMaxBytesPerFile?: number
  searcher?: (sourceIds?: string[]) => VaultSearcher
  knowledgeContextPreparer?: (input: { query: string; sessionId: string; sourceIds: string[]; limit: number; maxBytes: number }) => ReturnType<KnowledgeContextPreparation['prepare']>
  structuralContextResolver?: StructuralContextPreparation['resolve'] | null
  maintenanceSnapshot?: () => unknown
  evidenceStore?: WorkbenchEvidenceStoreOptions
  readResultRecovery?: WorkbenchReadResultRecoveryOptions
  requestSourceIndexRecovery?: (sourceIds: string[]) => Array<{ sourceId: string; status: 'queued' | 'already_ready' | 'already_queued' | 'unavailable' }>
}

export const MAX_ACTIVE_RUN_ACTIVITY_EVENTS = 40

export function projectPortableActiveRunsForStatus(
  sourceIds: string[],
  getRun: (sourceId: string) => unknown = getActiveWorkbenchRun
): ActiveRunContinuity[] {
  return sourceIds
    .filter((sourceId): sourceId is string => typeof sourceId === 'string' && sourceId.trim().length > 0)
    .slice(0, 4)
    .map(sourceId => projectActiveRunContinuity(getRun(sourceId)))
    .filter((run): run is ActiveRunContinuity => Boolean(run))
}

type ActivityListFn = (
  params: { runId?: string; sourceId?: string; limit?: number; afterEventId?: string }
) => ReturnType<typeof listWorkbenchActivity>

export function projectPortableActiveRunActivity(
  sourceId: string,
  runId: string,
  listActivity: ActivityListFn = listWorkbenchActivity
) {
  return listActivity({ runId, sourceId, limit: MAX_ACTIVE_RUN_ACTIVITY_EVENTS }).projection
}

export function maybeProjectPortableActiveRunActivity(
  sourceId: string,
  runId: string,
  includeActivity: unknown,
  listActivity: ActivityListFn = listWorkbenchActivity
) {
  return includeActivity === true
    ? projectPortableActiveRunActivity(sourceId, runId, listActivity)
    : undefined
}

export function projectPortableActivityDelta(
  sourceId: string,
  runId: string,
  afterEventId: string | undefined,
  listActivity: ActivityListFn = listWorkbenchActivity
) {
  return listActivity({ runId, sourceId, limit: MAX_ACTIVE_RUN_ACTIVITY_EVENTS, ...(afterEventId ? { afterEventId } : {}) })
}

export function formatPortableActiveRunResponse<T extends object, P, A = never>(
  sourceId: string,
  run: T | null | undefined,
  packets: P[],
  activity?: A
) {
  return {
    status: 'ok' as const,
    sourceId,
    activeRun: run ? { ...run, packets } : null,
    ...(run && activity !== undefined ? { activity } : {})
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sourceIds(payload: Payload, context?: PortableExecutionContext): string[] {
  if (context?.sourceId) return [context.sourceId]
  const many = Array.isArray(payload.sourceIds) ? payload.sourceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) : []
  if (many.length) return many
  const one = asString(payload.sourceId)
  return one ? [one] : getActiveSourceContext().activeSourceIds
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback
}

function actionRunSourceId(payload: Payload, context?: PortableExecutionContext): string | undefined {
  if (context?.sourceId) return context.sourceId
  const explicit = asString(payload.sourceId)
  if (explicit) return explicit
  const sourceIds = Array.isArray(payload.sourceIds)
    ? payload.sourceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  return sourceIds.length === 1 ? sourceIds[0] : undefined
}

function actionRunGoal(payload: Payload): string {
  const mode = asString(payload.mode) || 'repository operation'
  const subject = asString(payload.query) || asString(payload.path) || (Array.isArray(payload.paths) ? payload.paths.filter((value): value is string => typeof value === 'string').slice(0, 2).join(', ') : undefined)
  const safeSubject = subject ? redactSecrets(subject).slice(0, 180) : 'current task'
  return `External Workbench task: ${mode}${safeSubject ? ` · ${safeSubject}` : ''}`
}

function projectActionRunStart(binding: WorkbenchActionRunBinding, context?: PortableExecutionContext): void {
  appendAgentEvent({
    jobId: binding.runId,
    sourceId: binding.sourceId,
    type: 'preflight_started',
    activityKind: 'run_progress',
    message: 'Workbench is reading the selected repository for the current task.',
    requestId: context?.requestId,
    status: 'running'
  })
}

function projectContextRead(binding: WorkbenchActionRunBinding, payload: Payload, context?: PortableExecutionContext): void {
  const mode = asString(payload.mode) || 'context read'
  const paths = Array.isArray(payload.paths)
    ? payload.paths.filter((value): value is string => typeof value === 'string').slice(0, 24)
    : asString(payload.path) ? [asString(payload.path)!] : undefined
  appendAgentEvent({
    jobId: binding.runId,
    sourceId: binding.sourceId,
    type: 'file_read',
    activityKind: 'file_read',
    message: mode === 'search' || mode === 'search_and_read' ? 'Repository search completed.' : 'Repository context read completed.',
    requestId: context?.requestId,
    status: 'completed',
    ...(paths && paths.length > 0 ? { paths } : {})
  })
}

function projectResultPersisting(binding: WorkbenchActionRunBinding, context?: PortableExecutionContext): void {
  appendAgentEvent({
    jobId: binding.runId,
    sourceId: binding.sourceId,
    type: 'result_persisting',
    activityKind: 'run_progress',
    message: 'Workbench is persisting the completed repository result for recovery.',
    requestId: context?.requestId,
    status: 'running'
  })
}

function projectResponseCompleted(binding: WorkbenchActionRunBinding, context?: PortableExecutionContext, recovered = false): void {
  appendAgentEvent({
    jobId: binding.runId,
    sourceId: binding.sourceId,
    type: recovered ? 'read_recovered' : 'response_completed',
    activityKind: 'run_progress',
    message: recovered ? 'Workbench recovered the completed repository result without rereading.' : 'Workbench response completed with a persisted result reference.',
    requestId: context?.requestId,
    status: 'completed'
  })
}

function fail(code: 'invalid_request' | 'source_mismatch' | 'dependency_unavailable', message: string): never {
  throw new PortableOperationError(code, message)
}

export function isSourceSearchReady(state: { indexStatus?: string } | null | undefined): boolean {
  return state?.indexStatus === 'ready'
}

function requireSearchReady(sourceIds: string[], dependencies: PortableReadHandlerDependencies = {}): void {
  const blocked = sourceIds
    .map(sourceId => ({ sourceId, state: getSourceIndexState(sourceId) }))
    .filter(({ state }) => !isSourceSearchReady(state))
  if (!blocked.length) return
  const recovery = dependencies.requestSourceIndexRecovery?.(blocked.map(item => item.sourceId)) || []
  const details = blocked.map(item => ({
    sourceId: item.sourceId,
    indexStatus: item.state?.indexStatus || 'unknown',
    indexError: item.state?.indexError,
    indexedFileCount: item.state?.indexedFileCount,
    recoveryAction: recovery.find(candidate => candidate.sourceId === item.sourceId)?.status === 'unavailable'
      ? 'Choose a ready source'
      : recovery.find(candidate => candidate.sourceId === item.sourceId)?.status === 'already_ready'
        ? 'Retry the same bounded search'
        : 'Workbench queued source readiness automatically'
  }))
  const message = blocked.map(item => item.state?.indexStatus === 'pending'
    ? `${item.sourceId} is being prepared for search automatically.`
    : item.state?.indexStatus === 'indexing'
      ? `${item.sourceId} is being reindexed. Search will be available after the new index is ready.`
      : item.state?.indexStatus === 'failed'
        ? `${item.sourceId} failed to index: ${item.state.indexError || 'unknown error'}. Workbench queued an automatic recovery attempt.`
    : `${item.sourceId} is not ready for search; Workbench is preparing it automatically.`).join(' ')
  throw new PortableOperationError('dependency_unavailable', `Source(s) not ready for search: ${blocked.map(item => item.sourceId).join(', ')}`, { details: { readinessMessage: message, sources: details, recovery } })
}

function brokerReadMetadata(sourceId: string, executionContext?: PortableExecutionContext, payload?: Payload) {
  const confirmationState = executionContext?.sourceId
    ? 'execution-context' as const
    : asString(payload?.sourceId)
      ? 'explicit-source-id' as const
      : 'active-source-context' as const
  const contextSessionId = typeof payload?.contextIntelligenceSessionId === 'string' ? payload.contextIntelligenceSessionId : undefined
  const result = authorizeContextRead(sourceId, contextSessionId, confirmationState)
  if (!result.ok) fail('source_mismatch', 'message' in result ? result.message : 'Context Broker authorization failed.')
  return result.metadata
}

async function readPaths(payload: Payload, context?: PortableExecutionContext, dependencies: PortableReadHandlerDependencies = {}): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).slice(0, MAX_PATHS) : []
  if (!paths.length) fail('invalid_request', 'Paths required')
  const selected = sourceIds(payload, context)
  const targets = getResolvedActiveSources(selected.length ? selected : undefined)
  const contextMetadata = selected.length
    ? selected.map(sourceId => brokerReadMetadata(sourceId, context, payload))
    : []
  const maxBytes = bounded(payload.maxBytesPerFile, dependencies.readMaxBytesPerFile || 3_000, 1_000, MAX_FILE_BYTES)
  const budgetBytes = dependencies.readResponseBudgetBytes || 64 * 1024
  const files: Array<Record<string, unknown>> = []
  const skipped: Array<Record<string, unknown>> = []
  let returnedBytes = 0
  const responseBytes = (file: Record<string, unknown>) => Buffer.byteLength(JSON.stringify(file), 'utf8')
  for (const relPath of (Array.isArray(payload.paths) ? payload.paths : []).slice(MAX_PATHS)) {
    if (typeof relPath === 'string') skipped.push({ path: relPath, reason: 'max_paths_exceeded', suggestedMode: 'read_paths', suggestedNextAction: 'Split read_paths into at most 5 explicit paths.' })
  }
  for (const relPath of paths) {
    let candidate: Record<string, unknown> | undefined
    const errors: string[] = []
    for (const source of targets) {
      try {
        const fullPath = path.resolve(path.join(source.path, path.normalize(relPath)))
        if (!fullPath.startsWith(path.resolve(source.path))) throw new Error('Path escaped the source root')
        const stat = await fsp.stat(fullPath)
        if (!stat.isFile()) throw new Error('Not a file')
        if (stat.size > LARGE_FILE_BYTES) {
          candidate = { sourceId: source.id, path: relPath, contentReturned: false, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), reason: 'large_file_requires_focused_read', suggestedMode: 'grep_context' }
          skipped.push({ path: relPath, sourceId: source.id, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString(), reason: 'large_file_requires_focused_read', suggestedMode: 'grep_context', suggestedNextAction: 'Use grep_context with a specific pattern, then read_range around the matching line.', exampleNextCall: { mode: 'grep_context', sourceId: source.id, path: relPath, pattern: '<specific symbol or text>', before: 8, after: 12, maxMatches: 5 } })
          break
        }
        const result = await readFile(relPath, source.id)
        const content = truncateContent(redactSecrets(result.content), maxBytes)
        candidate = { sourceId: source.id, path: relPath, content: content.content, truncated: content.truncated, sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() }
        break
      } catch {
        // A path can legitimately resolve in a later explicitly selected source.
        errors.push(source.id)
      }
    }
    if (!candidate) {
      files.push({ path: relPath, error: 'File not found in active sources', sourceErrors: errors.length ? errors : undefined })
      continue
    }
    if (candidate.contentReturned === false) {
      files.push(candidate)
      continue
    }
    if (returnedBytes + responseBytes(candidate) > budgetBytes) {
      skipped.push({ path: relPath, sourceId: candidate.sourceId, sizeBytes: candidate.sizeBytes, reason: 'response_budget_exceeded', suggestedMode: 'read_range', suggestedNextAction: 'Use read_range or grep_context for this file.' })
      continue
    }
    files.push(candidate)
    returnedBytes += responseBytes(candidate)
  }
  const nextBatch = skipped.length ? {
    paths: skipped.map(item => item.path).filter((value): value is string => typeof value === 'string'),
    maxBytesPerFile: maxBytes,
    ...(selected.length ? { sourceIds: selected } : {})
  } : undefined
  return { files, ...(skipped.length ? { skipped } : {}), nextBatch, budgetBytes, returnedBytes, contextMetadata: contextMetadata.length === 1 ? contextMetadata[0] : contextMetadata, timings: { totalMs: Date.now() - startedAt, sourceCount: targets.length, requestedPathCount: paths.length, returnedFileCount: files.length, skippedFileCount: skipped.length } }
}

async function listFiles(payload: Payload, context?: PortableExecutionContext): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  const relPath = asString(payload.path) || ''
  const depth = bounded(payload.depth, 3, 1, 6)
  const limit = bounded(payload.limit, 100, 1, 100)
  const entries: Array<Record<string, unknown>> = []
  const targets = getResolvedActiveSources(sourceIds(payload, context))
  for (const source of targets) {
    const root = path.resolve(path.join(source.path, path.normalize(relPath)))
    if (!root.startsWith(path.resolve(source.path))) continue
    try {
      if (!(await fsp.stat(root)).isDirectory()) continue
      const walk = async (dir: string, current: string, currentDepth: number): Promise<void> => {
        if (entries.length >= limit || currentDepth >= depth) return
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
          if (entries.length >= limit) return
          if (!shouldIncludeEntry(entry.name)) continue
          const next = current ? `${current}/${entry.name}` : entry.name
          const stat = await fsp.stat(path.join(dir, entry.name))
          entries.push({ sourceId: source.id, path: next, type: entry.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() })
          if (entry.isDirectory()) await walk(path.join(dir, entry.name), next, currentDepth + 1)
        }
      }
      await walk(root, relPath, 0)
    } catch { /* preserve the HTTP endpoint's skip-on-unreadable-source behaviour */ }
  }
  return { sourceId: targets[0]?.id, path: relPath, entries, nextCursor: undefined, cursor: payload.cursor, timings: { totalMs: Date.now() - startedAt, sourceCount: targets.length, entryCount: entries.length, depth, limit } }
}

function makeSearcher(sourceIds?: string[]): VaultSearcher {
  return new VaultSearcher(new Indexer(sourceIds).getDocs())
}

async function readContext(payload: Payload, executionContext?: PortableExecutionContext, dependencies: PortableReadHandlerDependencies = {}): Promise<Record<string, unknown>> {
  const mode = asString(payload.mode)
  if (!mode) fail('invalid_request', 'mode is required')
  if (mode === 'read_paths') return readPaths(payload, executionContext)
  if (mode === 'list_files') return listFiles(payload, executionContext)
  if (mode === 'search_and_read' && !asString(payload.path)) {
    const query = asString(payload.query)
    const selected = sourceIds(payload, executionContext)
    if (!query || !selected.length) fail('invalid_request', 'query and sourceId or sourceIds are required')
    requireSearchReady(selected, dependencies)
    const search = (dependencies.searcher ? dependencies.searcher(selected) : makeSearcher(selected)).searchBounded(query, bounded(payload.limit, 5, 1, MAX_PATHS), selected, { startedAt: Date.now(), deadlineMs: 1200, maxDocsPerSource: 1500, maxContentDocsPerSource: 350 })
    const matches = search.results.slice(0, MAX_PATHS)
    if (!matches.length) return { mode, results: [], noMatches: true, query, ...(search.sourceWarnings.length ? { sourceWarnings: search.sourceWarnings } : {}) }
    const matchedSourceIds = Array.from(new Set(matches.map(match => typeof match.sourceId === 'string' ? match.sourceId : '').filter(Boolean)))
    const read = await readPaths({ paths: matches.map(match => match.path), sourceIds: matchedSourceIds.length ? matchedSourceIds : selected, maxBytesPerFile: payload.maxBytesPerFile }, undefined)
    return { mode, results: matches.map(match => ({ sourceId: match.sourceId, path: match.path, title: match.title, snippet: match.snippet })), ...read }
  }
  if (mode === 'grep_context' || mode === 'read_range' || mode === 'read_symbol' || mode === 'search_and_read') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    const filePath = asString(payload.path)
    if (!sourceId || !filePath) fail('invalid_request', 'sourceId and path are required')
    const contextMetadata = brokerReadMetadata(sourceId, executionContext, payload)
    const result = await handleFocusedRead({ ...payload, sourceId, path: filePath, mode } as Parameters<typeof handleFocusedRead>[0])
    if (result.statusCode >= 400) fail(result.statusCode === 404 ? 'source_mismatch' : 'invalid_request', String(result.payload.error || 'Focused read failed'))
    return { ...result.payload, contextMetadata }
  }
  if (mode === 'graph_context') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    if (!sourceId) fail('invalid_request', 'sourceId is required')
    const contextMetadata = brokerReadMetadata(sourceId, executionContext, payload)
    const result = await handleGraphContextRouted({ sourceId, query: asString(payload.query), limit: bounded(payload.limit, 8, 1, 10) }, {
      sourceResolver: getSourcesSafe,
      telemetryRecorder: () => undefined
    })
    if (result.statusCode >= 400) fail(result.statusCode === 404 ? 'source_mismatch' : 'invalid_request', String(result.payload.error || 'Graph context failed'))
    return { ...result.payload, contextMetadata }
  }
  if (mode === 'active_run') {
    const sourceId = executionContext?.sourceId || asString(payload.sourceId)
    if (!sourceId) fail('invalid_request', 'sourceId is required')
    const source = getSourcesSafe().find(item => item.id === sourceId && item.enabled && isSourcePathAvailable(item.path))
    if (!source) fail('source_mismatch', `Source not found or disabled: ${sourceId}`)
    const run = getActiveWorkbenchRun(sourceId)
    const requestedRunId = asString(payload.runId)
    if (payload.activityDelta === true && requestedRunId) {
      if (!run || run.id !== requestedRunId) {
        return {
          status: 'ok' as const,
          sourceId,
          runId: String(run?.id || requestedRunId),
          activity: undefined,
          cursorFound: false,
          fullRefreshRequired: true
        }
      }
      const delta = projectPortableActivityDelta(sourceId, requestedRunId, asString(payload.activitySinceEventId))
      return {
        status: 'ok' as const,
        sourceId,
        runId: requestedRunId,
        activity: delta.projection,
        cursorFound: delta.cursorFound,
        fullRefreshRequired: !delta.cursorFound
      }
    }
    const packets = run && typeof run.id === 'string'
      ? listWorkbenchPacketRecords({ runId: run.id, limit: 10 }).map(record => ({
          ...(payload.includePacket === true ? { packet: record.packet } : { packetId: record.packet.packetId, taskId: record.packet.taskId }),
          status: record.status,
          exactPaths: record.exactPaths,
          reservedAt: record.reservedAt,
          updatedAt: record.updatedAt
        }))
      : []
    const activity = run && typeof run.id === 'string'
      ? maybeProjectPortableActiveRunActivity(sourceId, run.id, payload.includeActivity)
      : undefined
    return formatPortableActiveRunResponse(sourceId, run, packets, activity)
  }
  if (mode === 'search' || mode === 'search_and_read' || mode === 'prepare_task_context') {
    const query = asString(payload.query)
    const selected = sourceIds(payload, executionContext)
    if (!query || !selected.length) fail('invalid_request', 'query and sourceId or sourceIds are required')
    requireSearchReady(selected, dependencies)
    if (mode === 'prepare_task_context' && selected.length !== 1) {
      fail('dependency_unavailable', 'Context Broker requires one authorized source for task context preparation.')
    }
    const preparation = mode === 'prepare_task_context'
      ? authorizeContextRead(selected[0], typeof payload.contextIntelligenceSessionId === 'string' ? payload.contextIntelligenceSessionId : undefined, executionContext?.sourceId ? 'execution-context' : asString(payload.sourceId) ? 'explicit-source-id' : 'active-source-context')
      : undefined
    if (preparation && !preparation.ok) fail('dependency_unavailable', 'message' in preparation ? preparation.message : 'Context preparation failed.')
    const searcher = dependencies.searcher ? dependencies.searcher(selected) : makeSearcher(selected)
    if (mode === 'prepare_task_context') {
      const workflowStartedAt = Date.now()
      if (payload.contextWorkflow === true) {
        const negotiation = negotiateMcpContextClient(payload.clientCapabilities as any)
        if (!negotiation.supported) { recordMcpContextWorkflowResult({ clientId: negotiation.clientId, ok: false, latencyMs: Date.now() - workflowStartedAt, failureCode: negotiation.reason || 'unsupported_client' }); fail('dependency_unavailable', `MCP client does not support the Workbench context workflow (${negotiation.reason || 'unsupported_client'}).`) }
      }
      const sessionId = typeof payload.contextIntelligenceSessionId === 'string' ? payload.contextIntelligenceSessionId : undefined
      const knowledgeContext = sessionId && dependencies.knowledgeContextPreparer
        ? { sessionId, sourceIds: selected, prepare: dependencies.knowledgeContextPreparer }
        : undefined
      const structuralContext = dependencies.structuralContextResolver === null
        ? undefined
        : {
            resolve: dependencies.structuralContextResolver || (async (input: Parameters<StructuralContextPreparation['resolve']>[0]) => {
              const result = await handleGraphContextRouted(input, {
                sourceResolver: getSourcesSafe,
                telemetryRecorder: () => undefined
              })
              if (result.statusCode >= 400) throw new Error(String(result.payload.error || 'Structural navigation failed'))
              return result.payload
            })
          }
      let prepared
      try {
        const paths = Array.isArray(payload.paths) ? payload.paths.filter((value): value is string => typeof value === 'string').slice(0, MAX_PATHS) : undefined
        prepared = await prepareTaskContext({
          query,
          sourceIds: selected,
          searcher,
          limit: bounded(payload.limit, 5, 1, 5),
          paths,
          maxBytesPerFile: bounded(payload.maxBytesPerFile, 3_000, 1_000, MAX_FILE_BYTES),
          knowledgeContext,
          structuralContext: shouldPrepareStructuralContext(query, paths) ? structuralContext : undefined
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Context package preparation failed.'
        fail('dependency_unavailable', message)
      }
      const withMetadata = { ...prepared, contextMetadata: preparation && preparation.ok ? preparation.metadata : undefined }
      if (sessionId) {
        const consumed = consumePreparedMcpContext(withMetadata, sessionId, {}, asString(payload.requestId))
        if (!consumed.ok) { recordMcpContextWorkflowResult({ clientId: typeof (payload.clientCapabilities as any)?.clientId === 'string' ? (payload.clientCapabilities as any).clientId : undefined, ok: false, latencyMs: Date.now() - workflowStartedAt, failureCode: 'code' in consumed ? consumed.code : 'context_rejected' }); fail('dependency_unavailable', 'message' in consumed ? consumed.message : 'MCP context could not be consumed.') }
        if (payload.contextWorkflow === true) recordMcpContextWorkflowResult({ clientId: typeof (payload.clientCapabilities as any)?.clientId === 'string' ? (payload.clientCapabilities as any).clientId : undefined, ok: true, latencyMs: Date.now() - workflowStartedAt, packageBytes: withMetadata.knowledgeContext?.bytes })
        return { ...withMetadata, mcpContext: consumed.context, ...(payload.contextWorkflow === true ? { contextWorkflow: formatMcpContextWorkflowResponse(withMetadata, sessionId) } : {}) }
      }
      return withMetadata
    }
    const startedAt = Date.now()
    const effectiveQuery = mode === 'search' && !/^(?:content|full):/i.test(query)
      ? `content:${query}`
      : query
    const search = searcher.searchBounded(effectiveQuery, bounded(payload.limit, 5, 1, 10), selected, { startedAt, deadlineMs: 1200, maxDocsPerSource: 1500, maxContentDocsPerSource: 350 })
    return { status: search.results.length === 0 && search.sourceWarnings.length ? 'needs_narrower_scope' : search.partial ? 'partial' : 'ok', results: search.results, ...(search.sourceWarnings.length ? { sourceWarnings: search.sourceWarnings, suggestedNarrowerMode: search.mode === 'content' ? 'grep_context' : 'graph_context', suggestedNextAction: 'Use graph_context for map-level discovery, then grep_context/read_range/read_paths on exact files or paths.' } : {}), timings: { totalMs: Date.now() - startedAt, sourceCount: selected.length, searchedSourceCount: search.searchedSourceCount, searchedDocCount: search.searchedDocCount, totalDocCount: search.totalDocCount, resultCount: search.results.length } }
  }
  fail('invalid_request', `Unsupported read mode: ${mode}`)
}

export function createPortableReadHandlers(dependencies: PortableReadHandlerDependencies = {}): PortableOperationHandlers {
  return {
    getSourceHealth: payload => {
      const request = payload as Payload
      const maxDetails = bounded(request.maxDetails, 256, 1, 256)
      const maxProposals = bounded(request.maxProposals, 256, 1, 256)
      // This is the canonical owner-local projection. It performs bounded
      // path/Git/index/provider checks only; the reconciliation authority
      // never triggers semantic indexing or invokes a provider.
      return getSourceReconciliationReport({ maxDetails, maxProposals })
    },
    getWorkbenchStatus: payload => {
      const include = asString((payload as Payload).include)
      const fullSources = include === 'sources' || include === 'all'
      const sources = getSourcesSafe(fullSources ? {} : { refreshGitMetadata: false, includeIndexState: false })
      const active = getActiveSourceContext(fullSources ? {} : { refreshGitMetadata: false, includeIndexState: false })
      const focusedWorkspace = getFocusedWorkspace()
      const activeRuns = listActiveWorkbenchRuns()
      const resume = resolveResumeNavigation({ sources, focusedWorkspace, activeRuns })
      const focusedWorkspaceProjection = focusedWorkspace ? {
        version: focusedWorkspace.version,
        sourceId: focusedWorkspace.sourceId,
        ...(focusedWorkspace.repoGroupId ? { repoGroupId: focusedWorkspace.repoGroupId } : {}),
        ...(focusedWorkspace.branchName ? { branchName: focusedWorkspace.branchName } : {}),
        ...(focusedWorkspace.isGitWorktree !== undefined ? { isGitWorktree: focusedWorkspace.isGitWorktree } : {}),
        updatedAt: focusedWorkspace.updatedAt
      } : undefined
      return {
        connected: true,
        sourceCount: sources.length,
        sourcesAvailable: sources.length > 0,
        indexedFiles: dependencies.indexedFiles ? dependencies.indexedFiles() : getIndexedDocumentCountFromDisk(),
        ...(dependencies.indexingActive ? { indexingActive: dependencies.indexingActive() } : {}),
        ...(dependencies.indexingSourceIds ? { indexingSourceIds: dependencies.indexingSourceIds() } : {}),
        ...(dependencies.maintenanceSnapshot ? { maintenance: dependencies.maintenanceSnapshot() } : {}),
        ...(include === 'sources' || include === 'all' ? { sources } : {}),
        ...(include === 'active' || include === 'all' ? {
          activeSourceIds: active.activeSourceIds,
          contextMode: active.mode,
          resume,
          ...(focusedWorkspaceProjection ? { focusedWorkspace: focusedWorkspaceProjection } : {}),
          activeRuns: resume.status === 'ACTIVE_RUN' || resume.status === 'BLOCKED_RUN' ? [resume.activeRun] : []
        } : {})
      }
    },
    readWorkbenchContext: (payload, context) => contextReadWithDependencies(payload as Payload, context, dependencies)
  }
}

async function contextReadWithDependencies(payload: Payload, context: PortableExecutionContext, dependencies: PortableReadHandlerDependencies): Promise<Record<string, unknown>> {
  if (asString(payload.mode) === 'active_run') return readContext(payload, context, dependencies)

  const sourceId = actionRunSourceId(payload, context)
  const binding = sourceId
    ? ensureWorkbenchActionRun({ sourceId, goal: actionRunGoal(payload), requestId: context.requestId })
    : undefined
  if (binding) projectActionRunStart(binding, context)

  try {
    const recoveryIdentity: WorkbenchReadResultRecoveryIdentity | undefined = binding
      ? {
          sourceId: binding.sourceId,
          sessionId: binding.sessionId,
          runId: binding.runId,
          ...(context.requestId ? { requestId: context.requestId } : {}),
          mode: asString(payload.mode) || 'repository operation',
          ...(Array.isArray(payload.paths) ? { paths: payload.paths.filter((value): value is string => typeof value === 'string').slice(0, MAX_PATHS) } : {}),
          ...(asString(payload.path) ? { path: asString(payload.path) } : {}),
          ...(asString(payload.query) ? { query: asString(payload.query) } : {})
        }
      : undefined
    const recovered = recoveryIdentity ? getWorkbenchReadResultRecovery(recoveryIdentity, dependencies.readResultRecovery) : undefined
    if (recovered) {
      let recoveredResult: Record<string, unknown>
      try {
        const parsed = JSON.parse(recovered.content)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('recovery payload is not an object')
        recoveredResult = parsed as Record<string, unknown>
      } catch {
        throw new PortableOperationError('dependency_unavailable', 'The completed Workbench result could not be decoded for recovery.', { details: { recoveryId: recovered.recoveryId } })
      }
      if (binding) {
        appendAgentEvent({
          jobId: binding.runId,
          sourceId: binding.sourceId,
          type: 'read_recovered',
          activityKind: 'run_progress',
          message: 'Workbench recovered the completed repository result without rereading.',
          requestId: context.requestId,
          status: 'completed'
        })
      }
      const evidence = attachWorkbenchEvidence({
        entries: [{
          kind: 'capability_result',
          owner: recovered.owner,
          retentionClass: 'active_run',
          content: recovered.content
        }]
      }, dependencies.evidenceStore)
      if (evidence.evidenceRefs?.length) {
        markWorkbenchReadResultReconciled(recovered.recoveryId, evidence.evidenceRefs[0].evidenceId, dependencies.readResultRecovery)
        if (binding) projectResponseCompleted(binding, context, true)
        return { ...recoveredResult, resultRef: evidence.evidenceRefs[0].evidenceId }
      }
      if (binding) projectResponseCompleted(binding, context, true)
      return {
        ...recoveredResult,
        resultRef: recovered.evidenceId,
        resultPersistence: { status: 'recovery_pending', authoritative: false },
        evidenceUnavailable: evidence.evidenceUnavailable
      }
    }
    const result = asString(payload.mode) === 'read_paths'
      ? await readPaths(payload, context, dependencies)
      : await readContext(payload, context, dependencies)
    if (binding) {
      projectContextRead(binding, payload, context)
      result.workbenchRun = binding
    }
    if (!binding) return { ...result, ...(context.requestId ? { requestId: context.requestId } : {}) }

    const durableResult = {
      ...result,
      ...(context.requestId ? { requestId: context.requestId } : {})
    }
    const owner = {
      sourceId: binding.sourceId,
      sessionId: binding.sessionId,
      runId: binding.runId,
      operationId: 'readWorkbenchContext',
      ...(context.requestId ? { requestId: context.requestId } : {})
    }
    const content = redactSecrets(JSON.stringify(durableResult))
    const resultRef = deterministicWorkbenchEvidenceId({ kind: 'capability_result', owner, retentionClass: 'active_run', content })
    projectResultPersisting(binding, context)
    const recovery = recoveryIdentity
      ? persistWorkbenchReadResult({ identity: recoveryIdentity, owner, evidenceId: resultRef, content })
      : undefined
    if (recovery && !recovery.ok) {
      throw new PortableOperationError('dependency_unavailable', 'Workbench completed the read but could not persist its bounded recovery result.', { details: recovery })
    }
    let evidence = attachWorkbenchEvidence({ entries: [{ kind: 'capability_result', owner, retentionClass: 'active_run', content }] }, dependencies.evidenceStore)
    // A lock collision is transient. Retry the persistence operation once, without rerunning the repository read.
    if (!evidence.evidenceRefs?.length && evidence.evidenceUnavailable?.code === 'EVIDENCE_STORE_BUSY') {
      evidence = attachWorkbenchEvidence({ entries: [{ kind: 'capability_result', owner, retentionClass: 'active_run', content }] }, dependencies.evidenceStore)
    }
    if (!evidence.evidenceRefs?.length) {
      if (binding) projectResponseCompleted(binding, context)
      return {
        ...durableResult,
        resultRef,
        resultPersistence: { status: 'recovery_pending', authoritative: false, ...(recovery && recovery.ok ? { recoveryId: recovery.record.recoveryId } : {}) },
        evidenceUnavailable: evidence.evidenceUnavailable
      }
    }
    const authoritativeRef = evidence.evidenceRefs[0].evidenceId
    if (recovery?.ok) markWorkbenchReadResultReconciled(recovery.record.recoveryId, authoritativeRef, dependencies.readResultRecovery)
    if (binding) projectResponseCompleted(binding, context)
    return {
      ...durableResult,
      resultRef: authoritativeRef
    }
  } catch (error) {
    if (binding) {
      updateAgentJob(binding.runId, {
        status: 'failed',
        blockedReason: 'context_read_failed',
        summary: 'The external Workbench context operation failed before the task could continue.'
      })
      appendAgentEvent({
        jobId: binding.runId,
        sourceId: binding.sourceId,
        type: 'job_failed',
        activityKind: 'run_failed',
        message: 'Repository context operation failed.',
        requestId: context.requestId,
        status: 'failed'
      })
    }
    throw error
  }
}
