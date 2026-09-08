import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'

export const WORKBENCH_SESSION_SCHEMA_VERSION = 1 as const
export const WORKBENCH_SESSION_STORE_VERSION = 1 as const

export type WorkbenchSessionStatus = 'active' | 'paused' | 'completed' | 'recovery_required'
export type WorkbenchSessionApprovalStatus = 'none' | 'required' | 'satisfied' | 'rejected' | 'expired'
export type WorkbenchSessionActionStatus = 'started' | 'completed' | 'failed' | 'blocked'

export type WorkbenchSessionApprovalState = {
  status: WorkbenchSessionApprovalStatus
  reasonCode?: string
  updatedAt: string
}

export type WorkbenchSessionLastAction = {
  kind: string
  status: WorkbenchSessionActionStatus
  at: string
  requestId?: string
}

export type WorkbenchSessionResourceCounters = {
  toolCalls: number
  actionRoundTrips: number
  packetsCompleted: number
  repairAttempts: number
  validationJobs: number
  bytesRead: number
  bytesWritten: number
}

export type WorkbenchSessionRecord = {
  schemaVersion: typeof WORKBENCH_SESSION_SCHEMA_VERSION
  sessionId: string
  revision: number
  status: WorkbenchSessionStatus
  lockedSourceIds: string[]
  activeRunId?: string
  activeTaskId?: string
  approval: WorkbenchSessionApprovalState
  lastAction?: WorkbenchSessionLastAction
  resources: WorkbenchSessionResourceCounters
  createdAt: string
  updatedAt: string
}

type WorkbenchSessionStore = {
  version: typeof WORKBENCH_SESSION_STORE_VERSION
  updatedAt: string
  sessions: WorkbenchSessionRecord[]
}

export type WorkbenchSessionStoreOptions = {
  rootDir?: string
  maxRecords?: number
  now?: () => Date
}

export type WorkbenchSessionStoreFailure = {
  ok: false
  code:
    | 'SESSION_STORE_BUSY'
    | 'SESSION_STORE_CORRUPT'
    | 'SESSION_NOT_FOUND'
    | 'SESSION_DUPLICATE_CONFLICT'
    | 'SESSION_REVISION_CONFLICT'
    | 'SESSION_SOURCE_DRIFT'
    | 'SESSION_INVALID_INPUT'
  message: string
}

function isStoreFailure(value: WorkbenchSessionStore | WorkbenchSessionStoreFailure): value is WorkbenchSessionStoreFailure {
  return 'ok' in value && value.ok === false
}

export type WorkbenchSessionPatch = {
  expectedRevision: number
  status?: WorkbenchSessionStatus
  activeRunId?: string | null
  activeTaskId?: string | null
  approval?: Omit<WorkbenchSessionApprovalState, 'updatedAt'>
  lastAction?: WorkbenchSessionLastAction | null
  resourceDelta?: Partial<WorkbenchSessionResourceCounters>
  now: string
}

const DEFAULT_MAX_RECORDS = 500
const MAX_IDENTIFIER = 200
const MAX_REASON = 120
const MAX_ACTION_KIND = 120
const MAX_COUNTER = Number.MAX_SAFE_INTEGER
const LOCK_WAIT_MS = 250
const LOCK_STALE_MS = 30_000
const COMPLETED_SESSION_RETENTION_MS = 2 * 60 * 60_000  // completed sessions older than this are pruned
export const WORKBENCH_NONTERMINAL_SESSION_RETENTION_MS = 7 * 24 * 60 * 60_000

function resolvedRoot(options?: WorkbenchSessionStoreOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function storePath(options?: WorkbenchSessionStoreOptions): string {
  return path.join(resolvedRoot(options), 'workbench-sessions.json')
}

function lockPath(options?: WorkbenchSessionStoreOptions): string {
  return `${storePath(options)}.lock`
}

function nowIso(options?: WorkbenchSessionStoreOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function emptyCounters(): WorkbenchSessionResourceCounters {
  return {
    toolCalls: 0,
    actionRoundTrips: 0,
    packetsCompleted: 0,
    repairAttempts: 0,
    validationJobs: 0,
    bytesRead: 0,
    bytesWritten: 0
  }
}

function emptyStore(): WorkbenchSessionStore {
  return { version: WORKBENCH_SESSION_STORE_VERSION, updatedAt: new Date(0).toISOString(), sessions: [] }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER
    && /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
}

function validOptionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max)
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validCounters(value: unknown): value is WorkbenchSessionResourceCounters {
  if (!value || typeof value !== 'object') return false
  const counters = value as Partial<WorkbenchSessionResourceCounters>
  return validCounter(counters.toolCalls)
    && validCounter(counters.actionRoundTrips)
    && validCounter(counters.packetsCompleted)
    && validCounter(counters.repairAttempts)
    && validCounter(counters.validationJobs)
    && validCounter(counters.bytesRead)
    && validCounter(counters.bytesWritten)
}

function validApproval(value: unknown): value is WorkbenchSessionApprovalState {
  if (!value || typeof value !== 'object') return false
  const approval = value as Partial<WorkbenchSessionApprovalState>
  return ['none', 'required', 'satisfied', 'rejected', 'expired'].includes(String(approval.status))
    && validOptionalText(approval.reasonCode, MAX_REASON)
    && validIso(approval.updatedAt)
}

function validLastAction(value: unknown): value is WorkbenchSessionLastAction | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const action = value as Partial<WorkbenchSessionLastAction>
  return typeof action.kind === 'string'
    && action.kind.length > 0
    && action.kind.length <= MAX_ACTION_KIND
    && ['started', 'completed', 'failed', 'blocked'].includes(String(action.status))
    && validIso(action.at)
    && validOptionalText(action.requestId, MAX_IDENTIFIER)
}

function normalizeLockedSources(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined
  if (!value.every(validIdentifier)) return undefined
  const unique = [...new Set(value)].sort()
  return unique.length === value.length ? unique : undefined
}

function validRecord(value: unknown): value is WorkbenchSessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<WorkbenchSessionRecord>
  return record.schemaVersion === WORKBENCH_SESSION_SCHEMA_VERSION
    && validIdentifier(record.sessionId)
    && Number.isSafeInteger(record.revision)
    && Number(record.revision) >= 0
    && ['active', 'paused', 'completed', 'recovery_required'].includes(String(record.status))
    && Boolean(normalizeLockedSources(record.lockedSourceIds))
    && validOptionalText(record.activeRunId, MAX_IDENTIFIER)
    && validOptionalText(record.activeTaskId, MAX_IDENTIFIER)
    && validApproval(record.approval)
    && validLastAction(record.lastAction)
    && validCounters(record.resources)
    && validIso(record.createdAt)
    && validIso(record.updatedAt)
}

function readStore(options?: WorkbenchSessionStoreOptions): WorkbenchSessionStore | WorkbenchSessionStoreFailure {
  try {
    const target = storePath(options)
    if (!fs.existsSync(target)) return emptyStore()
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<WorkbenchSessionStore>
    if (parsed.version !== WORKBENCH_SESSION_STORE_VERSION || !Array.isArray(parsed.sessions)) {
      return { ok: false, code: 'SESSION_STORE_CORRUPT', message: 'Session store has an unsupported or invalid shape.' }
    }
    if (!parsed.sessions.every(validRecord)) {
      return { ok: false, code: 'SESSION_STORE_CORRUPT', message: 'Session store contains an invalid record.' }
    }
    return {
      version: WORKBENCH_SESSION_STORE_VERSION,
      updatedAt: validIso(parsed.updatedAt) ? parsed.updatedAt : new Date(0).toISOString(),
      sessions: parsed.sessions.map(record => ({ ...record, lockedSourceIds: [...record.lockedSourceIds].sort() }))
    }
  } catch {
    return { ok: false, code: 'SESSION_STORE_CORRUPT', message: 'Session store could not be read safely.' }
  }
}

function persistStore(store: WorkbenchSessionStore, options?: WorkbenchSessionStoreOptions): void {
  const target = storePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const maxRecords = Math.max(10, Math.min(options?.maxRecords || DEFAULT_MAX_RECORDS, 2000))
  const sessions = retainBoundedSessions(store.sessions, options, maxRecords)
  const payload: WorkbenchSessionStore = {
    version: WORKBENCH_SESSION_STORE_VERSION,
    updatedAt: nowIso(options),
    sessions
  }
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function retainBoundedSessions(records: WorkbenchSessionRecord[], options: WorkbenchSessionStoreOptions | undefined, maxRecords: number): WorkbenchSessionRecord[] {
  const nowMs = Date.parse(nowIso(options))
  const completedCutoffMs = nowMs - COMPLETED_SESSION_RETENTION_MS
  const nonterminalCutoffMs = nowMs - WORKBENCH_NONTERMINAL_SESSION_RETENTION_MS
  const eligible = [...records].filter(session => {
    const updatedMs = Date.parse(session.updatedAt)
    if (session.status === 'active') return true
    if (session.status === 'completed') return updatedMs > completedCutoffMs
    return updatedMs > nonterminalCutoffMs
  })
  // Active sessions are retained ahead of historical records. In the
  // impossible-but-bounded case where more active sessions exist than the
  // configured capacity, keep the newest active bindings and never allow the
  // store to grow without bound.
  const active = eligible
    .filter(session => session.status === 'active')
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.sessionId.localeCompare(right.sessionId))
    .slice(-maxRecords)
  const inactive = eligible
    .filter(session => session.status !== 'active')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sessionId.localeCompare(right.sessionId))
  return active.length >= maxRecords
    ? active
    : [...active, ...inactive.slice(-(maxRecords - active.length))]
}

function acquireLock(options?: WorkbenchSessionStoreOptions): number | undefined {
  const target = lockPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  while (Date.now() <= deadline) {
    try {
      return fs.openSync(target, 'wx', 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(target)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(target, { force: true })
          continue
        }
      } catch {
        // Retry while the bounded lock window remains.
      }
    }
  }
  return undefined
}

function withLock<T>(options: WorkbenchSessionStoreOptions | undefined, callback: (store: WorkbenchSessionStore) => T): T | WorkbenchSessionStoreFailure {
  let descriptor: number | undefined
  try {
    descriptor = acquireLock(options)
    if (descriptor === undefined) return { ok: false, code: 'SESSION_STORE_BUSY', message: 'Session store is busy.' }
    const store = readStore(options)
    if (isStoreFailure(store)) return store
    return callback(store)
  } catch {
    return { ok: false, code: 'SESSION_STORE_CORRUPT', message: 'Session store operation failed safely.' }
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
      try { fs.rmSync(lockPath(options), { force: true }) } catch {}
    }
  }
}

function sameSources(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function addCounter(current: number, delta: number | undefined): number | undefined {
  if (delta === undefined) return current
  if (!validCounter(delta)) return undefined
  const next = current + delta
  return Number.isSafeInteger(next) && next <= MAX_COUNTER ? next : undefined
}

export function createWorkbenchSession(input: {
  sessionId?: string
  lockedSourceIds: string[]
  activeRunId?: string
  activeTaskId?: string
  now?: string
}, options?: WorkbenchSessionStoreOptions): { ok: true; created: boolean; session: WorkbenchSessionRecord } | WorkbenchSessionStoreFailure {
  const lockedSourceIds = normalizeLockedSources(input.lockedSourceIds)
  const sessionId = input.sessionId || `session-${crypto.randomUUID()}`
  const timestamp = input.now || nowIso(options)
  if (!validIdentifier(sessionId) || !lockedSourceIds || !validIso(timestamp)
    || !validOptionalText(input.activeRunId, MAX_IDENTIFIER)
    || !validOptionalText(input.activeTaskId, MAX_IDENTIFIER)) {
    return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session input is invalid or unbounded.' }
  }
  return withLock<{ ok: true; created: boolean; session: WorkbenchSessionRecord } | WorkbenchSessionStoreFailure>(options, store => {
    const existing = store.sessions.find(session => session.sessionId === sessionId)
    if (existing) {
      if (!sameSources(existing.lockedSourceIds, lockedSourceIds)) {
        return { ok: false, code: 'SESSION_SOURCE_DRIFT', message: 'Session source lock cannot change.' }
      }
      const sameBinding = existing.activeRunId === input.activeRunId && existing.activeTaskId === input.activeTaskId
      return sameBinding
        ? { ok: true, created: false, session: existing }
        : { ok: false, code: 'SESSION_DUPLICATE_CONFLICT', message: 'Session identity is already bound to different active work.' }
    }
    const session: WorkbenchSessionRecord = {
      schemaVersion: WORKBENCH_SESSION_SCHEMA_VERSION,
      sessionId,
      revision: 0,
      status: 'active',
      lockedSourceIds,
      activeRunId: input.activeRunId,
      activeTaskId: input.activeTaskId,
      approval: { status: 'none', updatedAt: timestamp },
      resources: emptyCounters(),
      createdAt: timestamp,
      updatedAt: timestamp
    }
    store.sessions.push(session)
    persistStore(store, options)
    return { ok: true, created: true, session }
  })
}

export function getWorkbenchSession(sessionId: string, options?: WorkbenchSessionStoreOptions): WorkbenchSessionRecord | WorkbenchSessionStoreFailure | undefined {
  if (!validIdentifier(sessionId)) return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session ID is invalid.' }
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  return store.sessions.find(session => session.sessionId === sessionId)
}

export function listWorkbenchSessions(query: { sourceId?: string; status?: WorkbenchSessionStatus } = {}, options?: WorkbenchSessionStoreOptions): WorkbenchSessionRecord[] | WorkbenchSessionStoreFailure {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  return store.sessions.filter(session => {
    if (query.sourceId && !session.lockedSourceIds.includes(query.sourceId)) return false
    if (query.status && session.status !== query.status) return false
    return true
  })
}

export function updateWorkbenchSession(sessionId: string, patch: WorkbenchSessionPatch, options?: WorkbenchSessionStoreOptions): { ok: true; session: WorkbenchSessionRecord } | WorkbenchSessionStoreFailure {
  if (!validIdentifier(sessionId) || !Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0 || !validIso(patch.now)) {
    return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session update input is invalid.' }
  }
  if (patch.approval && (!['none', 'required', 'satisfied', 'rejected', 'expired'].includes(patch.approval.status)
    || !validOptionalText(patch.approval.reasonCode, MAX_REASON))) {
    return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session approval state is invalid.' }
  }
  if (patch.lastAction !== undefined && patch.lastAction !== null && !validLastAction(patch.lastAction)) {
    return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session last action is invalid.' }
  }
  const result = withLock<{ ok: true; session: WorkbenchSessionRecord } | WorkbenchSessionStoreFailure>(options, store => {
    const index = store.sessions.findIndex(session => session.sessionId === sessionId)
    if (index < 0) return { ok: false, code: 'SESSION_NOT_FOUND', message: 'Session was not found.' }
    const current = store.sessions[index]
    if (current.revision !== patch.expectedRevision) {
      return { ok: false, code: 'SESSION_REVISION_CONFLICT', message: 'Session revision changed before update.' }
    }
    const activeRunId = patch.activeRunId === null ? undefined : patch.activeRunId ?? current.activeRunId
    const activeTaskId = patch.activeTaskId === null ? undefined : patch.activeTaskId ?? current.activeTaskId
    if (!validOptionalText(activeRunId, MAX_IDENTIFIER) || !validOptionalText(activeTaskId, MAX_IDENTIFIER)) {
      return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session run or task binding is invalid.' }
    }
    const resourceDelta = patch.resourceDelta || {}
    const resources: WorkbenchSessionResourceCounters = {
      toolCalls: addCounter(current.resources.toolCalls, resourceDelta.toolCalls) as number,
      actionRoundTrips: addCounter(current.resources.actionRoundTrips, resourceDelta.actionRoundTrips) as number,
      packetsCompleted: addCounter(current.resources.packetsCompleted, resourceDelta.packetsCompleted) as number,
      repairAttempts: addCounter(current.resources.repairAttempts, resourceDelta.repairAttempts) as number,
      validationJobs: addCounter(current.resources.validationJobs, resourceDelta.validationJobs) as number,
      bytesRead: addCounter(current.resources.bytesRead, resourceDelta.bytesRead) as number,
      bytesWritten: addCounter(current.resources.bytesWritten, resourceDelta.bytesWritten) as number
    }
    if (!validCounters(resources)) return { ok: false, code: 'SESSION_INVALID_INPUT', message: 'Session resource delta is invalid or overflows.' }
    const next: WorkbenchSessionRecord = {
      ...current,
      revision: current.revision + 1,
      status: patch.status || current.status,
      activeRunId,
      activeTaskId,
      approval: patch.approval ? { ...patch.approval, updatedAt: patch.now } : current.approval,
      lastAction: patch.lastAction === null ? undefined : patch.lastAction ?? current.lastAction,
      resources,
      updatedAt: patch.now
    }
    store.sessions[index] = next
    persistStore(store, options)
    return { ok: true, session: next }
  })
  if (result && 'ok' in result && result.ok && patch.status === 'completed') {
    expireSessionDependents(sessionId, options)
  }
  return result
}

export function expireSessionDependents(sessionId: string, options?: WorkbenchSessionStoreOptions): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { cancelSessionSchedulerRequests } = require('./workbench-repository-scheduler') as typeof import('./workbench-repository-scheduler')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { expireSessionBudgetLeases } = require('./workbench-global-budget-store') as typeof import('./workbench-global-budget-store')
  cancelSessionSchedulerRequests(sessionId, options)
  expireSessionBudgetLeases(sessionId, options)
}

export function recoverWorkbenchSessions(options?: WorkbenchSessionStoreOptions): { ok: true; sessions: WorkbenchSessionRecord[] } | WorkbenchSessionStoreFailure {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  return {
    ok: true,
    sessions: store.sessions.filter(session => session.status !== 'completed')
  }
}

export function pruneWorkbenchSessions(options?: WorkbenchSessionStoreOptions):
  | { ok: true; scanned: number; deleted: number; retainedActive: number }
  | WorkbenchSessionStoreFailure {
  const result = withLock(options, store => {
    const before = store.sessions.length
    const maxRecords = Math.max(10, Math.min(options?.maxRecords || DEFAULT_MAX_RECORDS, 2000))
    const retained = retainBoundedSessions(store.sessions, options, maxRecords)
    store.sessions = retained
    if (retained.length !== before) persistStore(store, options)
    return {
      ok: true as const,
      scanned: before,
      deleted: before - retained.length,
      retainedActive: retained.filter(session => session.status === 'active').length
    }
  })
  return result
}
