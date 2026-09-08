import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES,
  WORKBENCH_EVIDENCE_MAX_RECORDS,
  WORKBENCH_EVIDENCE_MAX_STORE_BYTES,
  WORKBENCH_EVIDENCE_RETENTION_POLICY_MS,
  WORKBENCH_EVIDENCE_SCHEMA_VERSION,
  WorkbenchEvidenceMetadataSchema,
  WorkbenchEvidenceOwnerSchema,
  WorkbenchEvidenceRecordSchema,
  type WorkbenchEvidenceKind,
  type WorkbenchEvidenceMetadata,
  type WorkbenchEvidenceRecord,
  type WorkbenchEvidenceRetentionClass,
  type WorkbenchEvidenceOwner
} from '@workbench/shared'
import { getConfigDir } from '../utils/paths'
import { redactSecrets } from './safe-access'
import { getWorkbenchSession, type WorkbenchSessionStoreOptions } from './workbench-session-store'

export const WORKBENCH_EVIDENCE_STORE_VERSION = 1 as const

export type WorkbenchEvidenceStoreOptions = {
  storePath?: string
  now?: () => Date
  maxRecords?: number
  maxStoreBytes?: number
  evidenceId?: () => string
  sessionStore?: WorkbenchSessionStoreOptions
}

export type WorkbenchEvidenceStoreFailureCode =
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_CONTENT_TOO_LARGE'
  | 'EVIDENCE_REDACTION_FAILED'
  | 'EVIDENCE_STORE_BUSY'
  | 'EVIDENCE_STORE_CORRUPT'
  | 'EVIDENCE_STORE_UNAVAILABLE'
  | 'EVIDENCE_DUPLICATE'
  | 'EVIDENCE_STORE_FULL'
  | 'EVIDENCE_STORE_WRITE_FAILED'

export type WorkbenchEvidenceStoreFailure = {
  ok: false
  code: WorkbenchEvidenceStoreFailureCode
  message: string
}

export type AppendWorkbenchEvidenceResult =
  | { ok: true; record: WorkbenchEvidenceRecord }
  | WorkbenchEvidenceStoreFailure

export type ReadWorkbenchEvidenceResult =
  | { ok: true; record?: WorkbenchEvidenceRecord }
  | WorkbenchEvidenceStoreFailure

export type ListWorkbenchEvidenceResult =
  | {
      ok: true
      records: WorkbenchEvidenceMetadata[]
      totalAvailable: number
      truncated: boolean
    }
  | WorkbenchEvidenceStoreFailure

export type PruneWorkbenchEvidenceResult =
  | {
      ok: true
      scanned: number
      deleted: number
      retainedActive: number
      retainedRecent: number
      truncated: boolean
    }
  | WorkbenchEvidenceStoreFailure

type WorkbenchEvidenceStore = {
  version: typeof WORKBENCH_EVIDENCE_STORE_VERSION
  updatedAt: string
  records: WorkbenchEvidenceRecord[]
}

const DEFAULT_STORE_PATH = path.join(getConfigDir(), 'workbench-evidence.json')
const MAX_LIST_RECORDS = 100
const MAX_CAPACITY_RECLAIM_RECORDS_PER_APPEND = 100
const ABANDONED_READ_RESULT_GRACE_MS = 2 * 60 * 60_000
const ABANDONED_PAUSED_READ_RESULT_GRACE_MS = 7 * 24 * 60 * 60_000

function storePath(options: WorkbenchEvidenceStoreOptions = {}): string {
  return options.storePath || DEFAULT_STORE_PATH
}

function lockPath(options: WorkbenchEvidenceStoreOptions = {}): string {
  return `${storePath(options)}.lock`
}

function nowIso(options: WorkbenchEvidenceStoreOptions = {}): string {
  return (options.now?.() || new Date()).toISOString()
}

function retentionExpiryMs(record: WorkbenchEvidenceRecord): number {
  return WORKBENCH_EVIDENCE_RETENTION_POLICY_MS[record.retentionClass]
}

type SessionLookup = ReturnType<typeof getWorkbenchSession>

function lookupSession(sessionId: string, options: WorkbenchEvidenceStoreOptions, cache?: Map<string, SessionLookup>): SessionLookup {
  const cached = cache?.get(sessionId)
  if (cached !== undefined) return cached
  const session = getWorkbenchSession(sessionId, options.sessionStore)
  cache?.set(sessionId, session)
  return session
}

function isProvenProtectedRun(record: WorkbenchEvidenceRecord, options: WorkbenchEvidenceStoreOptions, cache?: Map<string, SessionLookup>): boolean {
  if (record.retentionClass !== 'active_run') return false
  const runId = record.owner.runId
  const sessionId = record.owner.sessionId || (runId ? `session-${runId}` : undefined)
  if (!sessionId) return false
  const session = lookupSession(sessionId, options, cache)
  if (!session || 'ok' in session) return false
  if (!['active', 'recovery_required'].includes(session.status)) return false
  if (runId && session.activeRunId !== runId) return false
  return !record.owner.sessionId || record.owner.sessionId === session.sessionId
}

function isExpendableReadResult(record: WorkbenchEvidenceRecord): boolean {
  return record.kind === 'capability_result'
    && (record.owner.operationId === 'readWorkbenchContext' || record.owner.operationId === 'getWorkbenchStatus')
}

function isAbandonedReadResult(record: WorkbenchEvidenceRecord, options: WorkbenchEvidenceStoreOptions, currentMs: number, cache?: Map<string, SessionLookup>): boolean {
  if (!isExpendableReadResult(record) || !record.owner.sessionId) return false
  const session = lookupSession(record.owner.sessionId, options, cache)
  if (!session || 'ok' in session || session.status === 'active') return false
  const sessionAge = currentMs - Date.parse(session.updatedAt)
  const recordAge = currentMs - Date.parse(record.createdAt)
  const grace = session.status === 'paused' ? ABANDONED_PAUSED_READ_RESULT_GRACE_MS : ABANDONED_READ_RESULT_GRACE_MS
  return sessionAge >= grace && recordAge >= grace
}

function failure(code: WorkbenchEvidenceStoreFailureCode, message: string): WorkbenchEvidenceStoreFailure {
  return { ok: false, code, message }
}

function isStoreFailure(value: unknown): value is WorkbenchEvidenceStoreFailure {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false)
}

function emptyStore(options: WorkbenchEvidenceStoreOptions = {}): WorkbenchEvidenceStore {
  return {
    version: WORKBENCH_EVIDENCE_STORE_VERSION,
    updatedAt: nowIso(options),
    records: []
  }
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function integritySha256(record: Omit<WorkbenchEvidenceRecord, 'integritySha256'>): string {
  return sha256(stableSerialize(record))
}

function isStoredRecord(value: unknown): value is WorkbenchEvidenceRecord {
  const parsed = WorkbenchEvidenceRecordSchema.safeParse(value)
  if (!parsed.success) return false
  const record = parsed.data
  const { integritySha256: _integritySha256, ...integrityPayload } = record
  return Buffer.byteLength(record.content, 'utf8') === record.byteLength
    && sha256(record.content) === record.sha256
    && integritySha256(integrityPayload) === record.integritySha256
}

function hasDuplicateEvidenceIds(records: unknown[]): boolean {
  const ids = records
    .filter(isStoredRecord)
    .map(record => record.evidenceId)
  return ids.length !== new Set(ids).size
}

function readStore(options: WorkbenchEvidenceStoreOptions = {}): WorkbenchEvidenceStore | WorkbenchEvidenceStoreFailure {
  const target = storePath(options)
  try {
    if (!fs.existsSync(target)) return emptyStore(options)
    if (!fs.statSync(target).isFile()) return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is unavailable.')
  } catch {
    return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is unavailable.')
  }

  let parsed: Partial<WorkbenchEvidenceStore>
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<WorkbenchEvidenceStore>
  } catch {
    try {
      fs.accessSync(target, fs.constants.R_OK)
    } catch {
      return failure('EVIDENCE_STORE_UNAVAILABLE', 'The evidence store is unavailable.')
    }
    return failure('EVIDENCE_STORE_CORRUPT', 'The evidence store is corrupt and requires recovery.')
  }

  const maxRecords = Math.min(WORKBENCH_EVIDENCE_MAX_RECORDS, Math.max(1, Math.trunc(options.maxRecords || WORKBENCH_EVIDENCE_MAX_RECORDS)))
  const maxStoreBytes = Math.min(WORKBENCH_EVIDENCE_MAX_STORE_BYTES, Math.max(1, Math.trunc(options.maxStoreBytes || WORKBENCH_EVIDENCE_MAX_STORE_BYTES)))
  if (parsed.version !== WORKBENCH_EVIDENCE_STORE_VERSION
    || typeof parsed.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.updatedAt))
    || !Array.isArray(parsed.records)
    || parsed.records.length > maxRecords
    || Object.keys(parsed).some(key => !['version', 'updatedAt', 'records'].includes(key))
    || parsed.records.some(record => !isStoredRecord(record))
    || hasDuplicateEvidenceIds(parsed.records)) {
    return failure('EVIDENCE_STORE_CORRUPT', 'The evidence store is corrupt and requires recovery.')
  }

  const store: WorkbenchEvidenceStore = {
    version: WORKBENCH_EVIDENCE_STORE_VERSION,
    updatedAt: parsed.updatedAt,
    records: parsed.records as WorkbenchEvidenceRecord[]
  }
  if (serializedStoreBytes(store) > maxStoreBytes) return failure('EVIDENCE_STORE_CORRUPT', 'The evidence store is corrupt and requires recovery.')
  return store
}

function serializedStoreBytes(store: WorkbenchEvidenceStore): number {
  return Buffer.byteLength(JSON.stringify(store), 'utf8')
}

function reclaimExpiredRecordsForCapacity(
  store: WorkbenchEvidenceStore,
  candidate: WorkbenchEvidenceRecord,
  options: WorkbenchEvidenceStoreOptions,
  maxRecords: number,
  maxStoreBytes: number
): void {
  const currentMs = Date.parse(nowIso(options))
  if (!Number.isFinite(currentMs)) return
  const sessionCache = new Map<string, SessionLookup>()

  const reclaimable = store.records
    .filter(record => {
      if (isProvenProtectedRun(record, options, sessionCache) && !isAbandonedReadResult(record, options, currentMs, sessionCache)) return false
      const ageMs = currentMs - Date.parse(record.createdAt)
      return ageMs >= retentionExpiryMs(record) || isAbandonedReadResult(record, options, currentMs, sessionCache)
    })
    .sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt)
      return byTime !== 0 ? byTime : a.evidenceId.localeCompare(b.evidenceId)
    })

  let reclaimed = 0
  while (
    (store.records.length >= maxRecords
      || serializedStoreBytes({ ...store, records: [...store.records, candidate] }) > maxStoreBytes)
    && reclaimed < MAX_CAPACITY_RECLAIM_RECORDS_PER_APPEND
  ) {
    const next = reclaimable[reclaimed]
    if (!next) break
    store.records = store.records.filter(record => record.evidenceId !== next.evidenceId)
    reclaimed += 1
  }
}

function persistStore(store: WorkbenchEvidenceStore, options: WorkbenchEvidenceStoreOptions = {}): void {
  const target = storePath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const payload: WorkbenchEvidenceStore = {
    version: WORKBENCH_EVIDENCE_STORE_VERSION,
    updatedAt: nowIso(options),
    records: [...store.records].sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt)
      return byTime !== 0 ? byTime : a.evidenceId.localeCompare(b.evidenceId)
    })
  }
  const maxStoreBytes = Math.min(WORKBENCH_EVIDENCE_MAX_STORE_BYTES, Math.max(1, Math.trunc(options.maxStoreBytes || WORKBENCH_EVIDENCE_MAX_STORE_BYTES)))
  if (serializedStoreBytes(payload) > maxStoreBytes) throw new Error('evidence store size limit exceeded')
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, target)
    fs.chmodSync(target, 0o600)
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    } catch {
      // A successful rename has already committed the complete atomic payload.
    }
  }
}

function withExclusiveStoreLock<T>(
  options: WorkbenchEvidenceStoreOptions | undefined,
  callback: (store: WorkbenchEvidenceStore) => T | WorkbenchEvidenceStoreFailure
): T | WorkbenchEvidenceStoreFailure {
  const resolvedOptions = options || {}
  const target = storePath(resolvedOptions)
  const lock = lockPath(resolvedOptions)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600)
    const current = readStore(resolvedOptions)
    if (isStoreFailure(current)) return current
    const result = callback(current)
    if (isStoreFailure(result)) return result
    persistStore(current, resolvedOptions)
    return result
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'EEXIST') {
      return failure('EVIDENCE_STORE_BUSY', 'The evidence store is busy.')
    }
    return failure('EVIDENCE_STORE_WRITE_FAILED', 'The evidence store could not be written safely.')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (descriptor !== undefined) {
      try {
        fs.unlinkSync(lock)
      } catch {
        // Preserve unknown lock state for explicit operator recovery.
      }
    }
  }
}

export function appendWorkbenchEvidence(params: {
  kind: WorkbenchEvidenceKind
  owner: WorkbenchEvidenceOwner
  content: string
  retentionClass: WorkbenchEvidenceRetentionClass
  evidenceId?: string
}, options: WorkbenchEvidenceStoreOptions = {}): AppendWorkbenchEvidenceResult {
  if (typeof params.content !== 'string') return failure('EVIDENCE_INVALID', 'Evidence content must be UTF-8 text.')
  const owner = WorkbenchEvidenceOwnerSchema.safeParse(params.owner)
  if (!owner.success) return failure('EVIDENCE_INVALID', 'Evidence owner IDs are invalid.')

  if (Buffer.byteLength(params.content, 'utf8') > WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES) {
    return failure('EVIDENCE_CONTENT_TOO_LARGE', 'Evidence content exceeds the bounded storage limit.')
  }
  let content: string
  try {
    content = redactSecrets(params.content)
  } catch {
    return failure('EVIDENCE_REDACTION_FAILED', 'Evidence redaction failed closed.')
  }
  const byteLength = Buffer.byteLength(content, 'utf8')
  if (byteLength > WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES) {
    return failure('EVIDENCE_CONTENT_TOO_LARGE', 'Evidence content exceeds the bounded storage limit.')
  }

  const evidenceId = params.evidenceId || `evd-${options.evidenceId?.() || crypto.randomUUID()}`
  const createdAt = nowIso(options)
  const baseRecord: Omit<WorkbenchEvidenceRecord, 'integritySha256'> = {
    schemaVersion: WORKBENCH_EVIDENCE_SCHEMA_VERSION,
    evidenceId,
    kind: params.kind,
    owner: owner.data,
    contentEncoding: 'utf8',
    byteLength,
    sha256: sha256(content),
    retentionClass: params.retentionClass,
    redactionState: content === params.content ? 'not_required' : 'redacted',
    createdAt,
    content
  }
  const candidate = WorkbenchEvidenceRecordSchema.safeParse({
    ...baseRecord,
    integritySha256: integritySha256(baseRecord)
  })
  if (!candidate.success) return failure('EVIDENCE_INVALID', 'Evidence metadata is invalid.')

  const result = withExclusiveStoreLock(options, store => {
    if (store.records.some(record => record.evidenceId === candidate.data.evidenceId)) {
      return failure('EVIDENCE_DUPLICATE', 'An evidence record with this ID already exists.')
    }
    const maxRecords = Math.min(WORKBENCH_EVIDENCE_MAX_RECORDS, Math.max(1, Math.trunc(options.maxRecords || WORKBENCH_EVIDENCE_MAX_RECORDS)))
    const maxStoreBytes = Math.min(WORKBENCH_EVIDENCE_MAX_STORE_BYTES, Math.max(1, Math.trunc(options.maxStoreBytes || WORKBENCH_EVIDENCE_MAX_STORE_BYTES)))
    reclaimExpiredRecordsForCapacity(store, candidate.data, options, maxRecords, maxStoreBytes)
    if (store.records.length >= maxRecords) return failure('EVIDENCE_STORE_FULL', 'The evidence store reached its bounded capacity.')
    const next = { ...store, records: [...store.records, candidate.data] }
    if (serializedStoreBytes(next) > maxStoreBytes) return failure('EVIDENCE_STORE_FULL', 'The evidence store reached its bounded capacity.')
    store.records.push(candidate.data)
    return candidate.data
  })
  return isStoreFailure(result) ? result : { ok: true, record: result }
}

export function readWorkbenchEvidence(
  evidenceId: string,
  options: WorkbenchEvidenceStoreOptions = {}
): ReadWorkbenchEvidenceResult {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  return { ok: true, record: store.records.find(record => record.evidenceId === evidenceId) }
}

export function listWorkbenchEvidence(params: {
  sourceId?: string
  runId?: string
  kind?: WorkbenchEvidenceKind
  limit?: number
} = {}, options: WorkbenchEvidenceStoreOptions = {}): ListWorkbenchEvidenceResult {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  const scoped = store.records.filter(record =>
    (!params.sourceId || record.owner.sourceId === params.sourceId)
    && (!params.runId || record.owner.runId === params.runId)
    && (!params.kind || record.kind === params.kind))
  const maxRecords = Math.min(MAX_LIST_RECORDS, Math.max(1, Math.trunc(params.limit || 25)))
  const records = [...scoped]
    .sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt)
      return byTime !== 0 ? byTime : b.evidenceId.localeCompare(a.evidenceId)
    })
    .slice(0, maxRecords)
    .map(({ content: _content, ...metadata }) => WorkbenchEvidenceMetadataSchema.parse(metadata))
  return {
    ok: true,
    records,
    totalAvailable: scoped.length,
    truncated: scoped.length > records.length
  }
}

export function pruneWorkbenchEvidence(params: {
  sourceId?: string
  runId?: string
  taskId?: string
  packetId?: string
  batchSize?: number
} = {}, options: WorkbenchEvidenceStoreOptions = {}): PruneWorkbenchEvidenceResult {
  const batchSize = Math.min(100, Math.max(1, Math.trunc(params.batchSize || 25)))
  const currentMs = Date.parse(nowIso(options))
  if (!Number.isFinite(currentMs)) return failure('EVIDENCE_INVALID', 'The retention clock is invalid.')
  const result = withExclusiveStoreLock(options, store => {
    const sessionCache = new Map<string, SessionLookup>()
    const candidates = store.records
      .filter(record =>
        (!params.sourceId || record.owner.sourceId === params.sourceId)
        && (!params.runId || record.owner.runId === params.runId)
        && (!params.taskId || record.owner.taskId === params.taskId)
        && (!params.packetId || record.owner.packetId === params.packetId))
      .sort((a, b) => {
        const byTime = a.createdAt.localeCompare(b.createdAt)
        return byTime !== 0 ? byTime : a.evidenceId.localeCompare(b.evidenceId)
      })
    const expired = candidates.filter(record => {
      if (isProvenProtectedRun(record, options, sessionCache) && !isAbandonedReadResult(record, options, currentMs, sessionCache)) return false
      const ageMs = currentMs - Date.parse(record.createdAt)
      return ageMs >= retentionExpiryMs(record) || isAbandonedReadResult(record, options, currentMs, sessionCache)
    })
    const selected = expired.slice(0, batchSize)
    const selectedIds = new Set(selected.map(record => record.evidenceId))
    store.records = store.records.filter(record => !selectedIds.has(record.evidenceId))
    return {
      scanned: Math.min(candidates.length, batchSize),
      deleted: selected.length,
      retainedActive: candidates.filter(record => isProvenProtectedRun(record, options, sessionCache)).length,
      retainedRecent: candidates.filter(record => !selectedIds.has(record.evidenceId) && !isProvenProtectedRun(record, options, sessionCache)).length,
      truncated: expired.length > selected.length
    }
  })
  return isStoreFailure(result) ? result : { ok: true, ...result }
}

export function inspectWorkbenchEvidenceStore(options: WorkbenchEvidenceStoreOptions = {}):
  | { ok: true; version: typeof WORKBENCH_EVIDENCE_STORE_VERSION; recordCount: number; storeBytes: number; kinds: Record<WorkbenchEvidenceKind, number> }
  | WorkbenchEvidenceStoreFailure {
  const store = readStore(options)
  if (isStoreFailure(store)) return store
  const kinds: Record<WorkbenchEvidenceKind, number> = {
    raw_log: 0,
    diff: 0,
    validation_result: 0,
    capability_result: 0
  }
  for (const record of store.records) kinds[record.kind] += 1
  return {
    ok: true,
    version: WORKBENCH_EVIDENCE_STORE_VERSION,
    recordCount: store.records.length,
    storeBytes: serializedStoreBytes(store),
    kinds
  }
}
