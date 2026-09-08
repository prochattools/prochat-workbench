import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'
import { redactSecrets } from './safe-access'
import {
  WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES,
  WorkbenchEvidenceRecordSchema,
  WorkbenchEvidenceOwnerSchema,
  type WorkbenchEvidenceOwner,
  type WorkbenchEvidenceRecord
} from '@workbench/shared'
import { getWorkbenchSession, type WorkbenchSessionStoreOptions } from './workbench-session-store'

export const WORKBENCH_READ_RESULT_RECOVERY_VERSION = 1 as const
const DEFAULT_MAX_RECORDS = 128
const DEFAULT_MAX_STORE_BYTES = 1024 * 1024
const DEFAULT_STORE_PATH = path.join(getConfigDir(), 'workbench-read-results.json')
const RECONCILED_RETENTION_MS = 24 * 60 * 60_000
const TERMINAL_PENDING_RETENTION_MS = 24 * 60 * 60_000
const PAUSED_PENDING_RETENTION_MS = 7 * 24 * 60 * 60_000

export type WorkbenchReadResultRecoveryOptions = {
  storePath?: string
  now?: () => Date
  maxRecords?: number
  maxStoreBytes?: number
  sessionStore?: WorkbenchSessionStoreOptions
}

export type WorkbenchReadResultRecoveryIdentity = {
  sourceId: string
  sessionId: string
  runId: string
  requestId?: string
  mode: string
  paths?: string[]
  path?: string
  query?: string
}

export type WorkbenchReadResultRecoveryRecord = {
  version: typeof WORKBENCH_READ_RESULT_RECOVERY_VERSION
  recoveryId: string
  evidenceId: string
  identityDigest: string
  sourceId: string
  owner: WorkbenchEvidenceOwner
  mode: string
  paths?: string[]
  path?: string
  query?: string
  resultDigest: string
  content: string
  status: 'pending' | 'reconciled'
  createdAt: string
  updatedAt: string
}

type Store = {
  version: typeof WORKBENCH_READ_RESULT_RECOVERY_VERSION
  updatedAt: string
  records: WorkbenchReadResultRecoveryRecord[]
}

export type PersistWorkbenchReadResult = {
  identity: WorkbenchReadResultRecoveryIdentity
  owner: WorkbenchEvidenceOwner
  evidenceId: string
  content: string
}

export type ReadResultRecoveryFailure = {
  ok: false
  code: 'READ_RESULT_RECOVERY_BUSY' | 'READ_RESULT_RECOVERY_UNAVAILABLE' | 'READ_RESULT_RECOVERY_FULL' | 'READ_RESULT_RECOVERY_INVALID'
  message: string
}

export type PersistReadResultRecoveryResult =
  | { ok: true; record: WorkbenchReadResultRecoveryRecord; reused: boolean }
  | ReadResultRecoveryFailure

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableSerialize(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function nowIso(options: WorkbenchReadResultRecoveryOptions = {}): string {
  return (options.now?.() || new Date()).toISOString()
}

function target(options: WorkbenchReadResultRecoveryOptions = {}): string {
  return path.resolve(options.storePath || DEFAULT_STORE_PATH)
}

function lockTarget(options: WorkbenchReadResultRecoveryOptions = {}): string {
  return `${target(options)}.lock`
}

function limits(options: WorkbenchReadResultRecoveryOptions = {}): { maxRecords: number; maxStoreBytes: number } {
  return {
    maxRecords: Math.max(1, Math.min(DEFAULT_MAX_RECORDS, Math.trunc(options.maxRecords || DEFAULT_MAX_RECORDS))),
    maxStoreBytes: Math.max(1024, Math.min(DEFAULT_MAX_STORE_BYTES, Math.trunc(options.maxStoreBytes || DEFAULT_MAX_STORE_BYTES)))
  }
}

function emptyStore(options: WorkbenchReadResultRecoveryOptions = {}): Store {
  return { version: WORKBENCH_READ_RESULT_RECOVERY_VERSION, updatedAt: nowIso(options), records: [] }
}

function isRecoveryFailure(value: unknown): value is ReadResultRecoveryFailure {
  return Boolean(value && typeof value === 'object' && (value as { ok?: unknown }).ok === false)
}

function validRecord(value: unknown): value is WorkbenchReadResultRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<WorkbenchReadResultRecoveryRecord>
  return record.version === WORKBENCH_READ_RESULT_RECOVERY_VERSION
    && typeof record.recoveryId === 'string'
    && /^rrr-[a-f0-9]{64}$/.test(record.recoveryId)
    && typeof record.evidenceId === 'string'
    && /^evd-[a-f0-9]{64}$/.test(record.evidenceId)
    && typeof record.identityDigest === 'string'
    && /^[a-f0-9]{64}$/.test(record.identityDigest)
    && typeof record.sourceId === 'string'
    && WorkbenchEvidenceOwnerSchema.safeParse(record.owner).success
    && typeof record.mode === 'string'
    && typeof record.resultDigest === 'string'
    && /^[a-f0-9]{64}$/.test(record.resultDigest)
    && typeof record.content === 'string'
    && Buffer.byteLength(record.content, 'utf8') <= WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES
    && (record.status === 'pending' || record.status === 'reconciled')
    && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
}

function readStore(options: WorkbenchReadResultRecoveryOptions = {}): Store | ReadResultRecoveryFailure {
  const file = target(options)
  if (!fs.existsSync(file)) return emptyStore(options)
  try {
    if (!fs.statSync(file).isFile()) return { ok: false, code: 'READ_RESULT_RECOVERY_UNAVAILABLE', message: 'The read-result recovery store is unavailable.' }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Store>
    const configured = limits(options)
    if (parsed.version !== WORKBENCH_READ_RESULT_RECOVERY_VERSION
      || typeof parsed.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(parsed.updatedAt))
      || !Array.isArray(parsed.records)
      || parsed.records.length > DEFAULT_MAX_RECORDS * 4
      || parsed.records.some(record => !validRecord(record))
      || new Set(parsed.records.map(record => (record as WorkbenchReadResultRecoveryRecord).recoveryId)).size !== parsed.records.length) {
      return { ok: false, code: 'READ_RESULT_RECOVERY_UNAVAILABLE', message: 'The read-result recovery store is invalid.' }
    }
    // An oversized but structurally valid store is still recoverable: the
    // bounded writer below evicts only reconciled records before publishing a
    // new version. Rejecting it here makes that existing compaction path
    // unreachable and strands otherwise recoverable reads at the capacity
    // boundary. Pending records remain protected by persistStore's eviction
    // rule.
    return parsed as Store
  } catch {
    return { ok: false, code: 'READ_RESULT_RECOVERY_UNAVAILABLE', message: 'The read-result recovery store is unavailable.' }
  }
}

function ageMs(value: string, nowMs: number): number {
  const createdMs = Date.parse(value)
  return Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : Number.POSITIVE_INFINITY
}

function pendingRecordIsAbandoned(record: WorkbenchReadResultRecoveryRecord, nowMs: number, options: WorkbenchReadResultRecoveryOptions): boolean {
  if (record.status !== 'pending') return false
  const sessionId = record.owner.sessionId || record.identityDigest
  const session = record.owner.sessionId ? getWorkbenchSession(record.owner.sessionId, options.sessionStore) : undefined
  if (!session || 'ok' in session) return false
  if (session.status === 'active') return false
  const sessionAge = ageMs(session.updatedAt, nowMs)
  const recordAge = ageMs(record.updatedAt, nowMs)
  const retention = session.status === 'paused' ? PAUSED_PENDING_RETENTION_MS : TERMINAL_PENDING_RETENTION_MS
  return sessionId.length > 0 && sessionAge >= retention && recordAge >= retention
}

function recordIsExpiredOrAbandoned(record: WorkbenchReadResultRecoveryRecord, nowMs: number, options: WorkbenchReadResultRecoveryOptions): boolean {
  if (record.status === 'reconciled') return ageMs(record.updatedAt, nowMs) >= RECONCILED_RETENTION_MS
  return pendingRecordIsAbandoned(record, nowMs, options)
}

function compactRecords(store: Store, options: WorkbenchReadResultRecoveryOptions): void {
  const configured = limits(options)
  const nowMs = Date.parse(nowIso(options))
  let retained = store.records.filter(record => !recordIsExpiredOrAbandoned(record, nowMs, options))
  const serializedSize = (records: WorkbenchReadResultRecoveryRecord[]) => Buffer.byteLength(JSON.stringify({ version: WORKBENCH_READ_RESULT_RECOVERY_VERSION, updatedAt: nowIso(options), records }), 'utf8')
  const evictable = () => retained
    .map((record, index) => ({ record, index }))
    .filter(item => item.record.status === 'reconciled' || pendingRecordIsAbandoned(item.record, nowMs, options))
    .sort((left, right) => Date.parse(left.record.updatedAt) - Date.parse(right.record.updatedAt) || left.record.recoveryId.localeCompare(right.record.recoveryId))

  while (retained.length > configured.maxRecords || serializedSize(retained) > configured.maxStoreBytes) {
    const next = evictable()[0]
    if (!next) throw new Error('recovery store size limit exceeded')
    retained.splice(next.index, 1)
  }
  store.records = retained
}

function persistStore(store: Store, options: WorkbenchReadResultRecoveryOptions): void {
  const file = target(options)
  const configured = limits(options)
  compactRecords(store, options)
  const next: Store = { version: WORKBENCH_READ_RESULT_RECOVERY_VERSION, updatedAt: nowIso(options), records: [...store.records].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.recoveryId.localeCompare(b.recoveryId)) }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* atomic rename already committed */ }
  }
}

function withLock<T>(options: WorkbenchReadResultRecoveryOptions, callback: (store: Store) => T | ReadResultRecoveryFailure): T | ReadResultRecoveryFailure {
  let descriptor: number | undefined
  try {
    const file = target(options)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    descriptor = fs.openSync(lockTarget(options), 'wx', 0o600)
    const current = readStore(options)
    if (isRecoveryFailure(current)) return current
    const result = callback(current)
    if (isRecoveryFailure(result)) return result
    persistStore(current, options)
    return result
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'EEXIST') return { ok: false, code: 'READ_RESULT_RECOVERY_BUSY', message: 'The read-result recovery store is busy.' }
    if (String(error).includes('size limit')) return { ok: false, code: 'READ_RESULT_RECOVERY_FULL', message: 'The read-result recovery store reached its bounded capacity.' }
    return { ok: false, code: 'READ_RESULT_RECOVERY_UNAVAILABLE', message: 'The read-result recovery store could not be written safely.' }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (descriptor !== undefined) {
      try { fs.unlinkSync(lockTarget(options)) } catch { /* preserve unknown lock state */ }
    }
  }
}

export function workbenchReadResultIdentityDigest(identity: WorkbenchReadResultRecoveryIdentity): string {
  return sha256(stableSerialize(identity))
}

export function workbenchReadResultRecoveryId(identity: WorkbenchReadResultRecoveryIdentity): string {
  return `rrr-${workbenchReadResultIdentityDigest(identity)}`
}

export function persistWorkbenchReadResult(params: PersistWorkbenchReadResult, options: WorkbenchReadResultRecoveryOptions = {}): PersistReadResultRecoveryResult {
  const owner = WorkbenchEvidenceOwnerSchema.safeParse(params.owner)
  if (!owner.success || typeof params.content !== 'string' || Buffer.byteLength(params.content, 'utf8') > WORKBENCH_EVIDENCE_MAX_CONTENT_BYTES) return { ok: false, code: 'READ_RESULT_RECOVERY_INVALID', message: 'The completed read result is not valid for bounded recovery.' }
  const identityDigest = workbenchReadResultIdentityDigest(params.identity)
  const recoveryId = `rrr-${identityDigest}`
  const content = redactSecrets(params.content)
  const resultDigest = sha256(content)
  const createdAt = nowIso(options)
  const result = withLock<{ record: WorkbenchReadResultRecoveryRecord; reused: boolean }>(options, store => {
    const existing = store.records.find(record => record.recoveryId === recoveryId)
    if (existing) {
      if (existing.evidenceId !== params.evidenceId || existing.resultDigest !== resultDigest || stableSerialize(existing.owner) !== stableSerialize(owner.data)) return { ok: false, code: 'READ_RESULT_RECOVERY_INVALID', message: 'Recovery identity is already bound to a different result.' }
      return { record: existing, reused: true }
    }
    const record: WorkbenchReadResultRecoveryRecord = {
      version: WORKBENCH_READ_RESULT_RECOVERY_VERSION,
      recoveryId,
      evidenceId: params.evidenceId,
      identityDigest,
      sourceId: params.identity.sourceId,
      owner: owner.data,
      mode: params.identity.mode,
      ...(params.identity.paths ? { paths: params.identity.paths.slice(0, 5) } : {}),
      ...(params.identity.path ? { path: params.identity.path } : {}),
      ...(params.identity.query ? { query: params.identity.query.slice(0, 240) } : {}),
      resultDigest,
      content,
      status: 'pending',
      createdAt,
      updatedAt: createdAt
    }
    store.records.push(record)
    return { record, reused: false }
  })
  if (isRecoveryFailure(result)) return result
  return { ok: true, record: result.record, reused: result.reused }
}

export function getWorkbenchReadResultRecovery(identity: WorkbenchReadResultRecoveryIdentity, options: WorkbenchReadResultRecoveryOptions = {}): WorkbenchReadResultRecoveryRecord | undefined {
  const store = readStore(options)
  if (isRecoveryFailure(store)) return undefined
  return store.records.find(record => record.recoveryId === workbenchReadResultRecoveryId(identity))
}

export function markWorkbenchReadResultReconciled(recoveryId: string, evidenceId: string, options: WorkbenchReadResultRecoveryOptions = {}): boolean {
  const result = withLock(options, store => {
    const record = store.records.find(item => item.recoveryId === recoveryId)
    if (!record || record.evidenceId !== evidenceId) return { ok: false, code: 'READ_RESULT_RECOVERY_INVALID', message: 'Recovery record was not found for reconciliation.' }
    record.status = 'reconciled'
    record.updatedAt = nowIso(options)
    return true
  })
  return result === true
}

export function readWorkbenchReadResultAsEvidence(evidenceId: string, options: WorkbenchReadResultRecoveryOptions = {}): WorkbenchEvidenceRecord | undefined {
  const store = readStore(options)
  if (isRecoveryFailure(store)) return undefined
  const recovery = store.records.find(record => record.evidenceId === evidenceId)
  if (!recovery) return undefined
  const base = {
    schemaVersion: 1 as const,
    evidenceId: recovery.evidenceId,
    kind: 'capability_result' as const,
    owner: recovery.owner,
    contentEncoding: 'utf8' as const,
    byteLength: Buffer.byteLength(recovery.content, 'utf8'),
    sha256: sha256(recovery.content),
    retentionClass: 'active_run' as const,
    redactionState: 'not_required' as const,
    createdAt: recovery.createdAt,
    content: recovery.content
  }
  const withoutIntegrity = base
  const record = WorkbenchEvidenceRecordSchema.safeParse({ ...withoutIntegrity, integritySha256: sha256(stableSerialize(withoutIntegrity)) })
  return record.success ? record.data : undefined
}

export function pruneWorkbenchReadResultRecovery(options: WorkbenchReadResultRecoveryOptions = {}):
  | { ok: true; scanned: number; deleted: number; pending: number; reconciled: number }
  | ReadResultRecoveryFailure {
  const result = withLock(options, store => {
    const before = store.records.length
    compactRecords(store, options)
    return {
      ok: true as const,
      scanned: before,
      deleted: before - store.records.length,
      pending: store.records.filter(record => record.status === 'pending').length,
      reconciled: store.records.filter(record => record.status === 'reconciled').length
    }
  })
  return result
}
