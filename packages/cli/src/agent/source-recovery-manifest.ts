import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  applyReconciliationApproval,
  resolveReconciliationOwnerAuthority,
  scanSourceReconciliation,
  type ReconciliationProposal,
  type ReconciliationRegistrationType,
  type SourceReconciliationReport,
  type ReconciliationSafety
} from './source-reconciliation'
import type { SourceReconciliationOptions } from './source-reconciliation'
import { getConfigDir } from '../utils/paths'

export const SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION = 1 as const
export const SOURCE_RECOVERY_MANIFEST_FILENAME = 'workbench-source-recovery-manifests.json' as const

export type SourceRecoveryManifestState =
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'RUNNING'
  | 'PARTIAL'
  | 'COMPLETE'
  | 'FAILED'
  | 'STALE'

export type SourceRecoveryItemState = 'pending' | 'running' | 'succeeded' | 'stale' | 'blocked' | 'failed' | 'skipped'

export type SourceRecoveryManifestSelection = {
  proposalId: string
  registrationId: string
  registrationType: ReconciliationRegistrationType
  canonicalPath: string
  action: 'disable' | 'remove'
  reviewed: true
}

export type SourceRecoveryManifestItem = {
  registrationId: string
  registrationType: ReconciliationRegistrationType
  proposalId: string
  canonicalPath: string
  action: 'disable' | 'remove'
  classification: string
  reasonCode: string
  reason: string
  observedPathState: string
  proposalDigest: string
  proposalSchemaVersion: number
  safety: ReconciliationSafety
  ownerDisposition?: string
  reviewedBy: string
  reviewedAt: string
  beforeState: Record<string, unknown>
  afterState?: Record<string, unknown>
  result: SourceRecoveryItemState
  resultCode?: string
  resultMessage?: string
  revalidation?: {
    checkedAt: string
    outcome: 'pass' | 'stale' | 'blocked'
    reason: string
  }
  startedAt?: string
  completedAt?: string
  mutated?: boolean
  attempts?: number
}

export type SourceRecoveryManifestSummary = {
  selected: number
  executed: number
  succeeded: number
  stale: number
  blocked: number
  failed: number
  skipped: number
}

export type SourceRecoveryManifest = {
  schemaVersion: typeof SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION
  manifestId: string
  ownerAuthority: string
  createdAt: string
  updatedAt: string
  digest: string
  state: SourceRecoveryManifestState
  items: SourceRecoveryManifestItem[]
  effects: string[]
  nonEffects: string[]
  confirmation?: {
    ownerAuthority: string
    confirmedAt: string
    digest: string
  }
  execution?: {
    startedAt?: string
    completedAt?: string
    order: string[]
    summary: SourceRecoveryManifestSummary
  }
}

export type SourceRecoveryManifestOptions = {
  storePath?: string
  now?: () => Date
  maxItems?: number
  reconciliation?: SourceReconciliationOptions
}

export type SourceRecoveryManifestFailureCode =
  | 'manifest_invalid'
  | 'manifest_not_found'
  | 'manifest_busy'
  | 'manifest_digest_mismatch'
  | 'manifest_state_invalid'
  | 'manifest_rejected'
  | 'manifest_store_unavailable'

export type SourceRecoveryManifestFailure = {
  ok: false
  code: SourceRecoveryManifestFailureCode
  message: string
  rejected?: Array<{ proposalId?: string; registrationId?: string; reason: string }>
}

export type SourceRecoveryManifestResult =
  | { ok: true; manifest: SourceRecoveryManifest }
  | SourceRecoveryManifestFailure

type ManifestStore = {
  version: typeof SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION
  updatedAt: string
  manifests: SourceRecoveryManifest[]
}

const MAX_MANIFESTS = 64
const MAX_ITEMS = 32
const MAX_STORE_BYTES = 2 * 1024 * 1024
const activeExecutions = new Set<string>()

function nowIso(options: SourceRecoveryManifestOptions): string {
  return (options.now?.() || new Date()).toISOString()
}

function storePath(options: SourceRecoveryManifestOptions): string {
  return options.storePath || path.join(getConfigDir(), SOURCE_RECOVERY_MANIFEST_FILENAME)
}

function acquireManifestStoreLock(options: SourceRecoveryManifestOptions): (() => void) | SourceRecoveryManifestFailure {
  const target = `${storePath(options)}.lock`
  const directory = path.dirname(target)
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.chmodSync(directory, 0o700)
    let descriptor: number
    try {
      descriptor = fs.openSync(target, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const lock = JSON.parse(fs.readFileSync(target, 'utf8')) as { pid?: number }
        if (typeof lock.pid === 'number') {
          try { process.kill(lock.pid, 0); return failure('manifest_busy', 'Another owner-local manifest operation is in progress.') } catch { /* stale lock */ }
          fs.unlinkSync(target)
          descriptor = fs.openSync(target, 'wx', 0o600)
        } else {
          return failure('manifest_busy', 'Another owner-local manifest operation is in progress.')
        }
      } catch {
        return failure('manifest_busy', 'Another owner-local manifest operation is in progress.')
      }
    }
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: nowIso(options) }), { encoding: 'utf8' })
    fs.fchmodSync(descriptor, 0o600)
    return () => {
      try { fs.closeSync(descriptor) } catch { /* already closed */ }
      try { fs.unlinkSync(target) } catch { /* another cleanup path won */ }
    }
  } catch {
    return failure('manifest_store_unavailable', 'The reviewed-set manifest lock could not be acquired safely.')
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(object[key])}`).join(',')}}`
}

function digestForItems(items: SourceRecoveryManifestItem[]): string {
  return sha256(stableSerialize(items.map(item => ({
    registrationId: item.registrationId,
    registrationType: item.registrationType,
    proposalId: item.proposalId,
    canonicalPath: item.canonicalPath,
    action: item.action,
    classification: item.classification,
    reasonCode: item.reasonCode,
    reason: item.reason,
    observedPathState: item.observedPathState,
    proposalDigest: item.proposalDigest,
    proposalSchemaVersion: item.proposalSchemaVersion,
    safety: item.safety,
    ownerDisposition: item.ownerDisposition,
    beforeState: item.beforeState,
    reviewedBy: item.reviewedBy,
    reviewedAt: item.reviewedAt
  }))))
}

function emptyStore(options: SourceRecoveryManifestOptions): ManifestStore {
  return { version: SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION, updatedAt: nowIso(options), manifests: [] }
}

function readStore(options: SourceRecoveryManifestOptions): ManifestStore | SourceRecoveryManifestFailure {
  const target = storePath(options)
  try {
    if (!fs.existsSync(target)) return emptyStore(options)
    const directoryStat = fs.lstatSync(path.dirname(target))
    const stat = fs.lstatSync(target)
    const ownerUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid
    if (!directoryStat.isDirectory() || directoryStat.uid !== ownerUid || (directoryStat.mode & 0o077) !== 0
      || stat.isSymbolicLink() || !stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o077) !== 0) {
      return failure('manifest_store_unavailable', 'The reviewed-set manifest store failed owner-local safety checks.')
    }
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<ManifestStore>
    if (parsed.version !== SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION
      || typeof parsed.updatedAt !== 'string'
      || !Array.isArray(parsed.manifests)
      || parsed.manifests.length > MAX_MANIFESTS
      || parsed.manifests.some(item => !isManifest(item))) {
      return failure('manifest_invalid', 'The reviewed-set manifest store is invalid.')
    }
    if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_STORE_BYTES) {
      return failure('manifest_invalid', 'The reviewed-set manifest store exceeds its bounded size.')
    }
    return parsed as ManifestStore
  } catch {
    return failure('manifest_store_unavailable', 'The reviewed-set manifest store is unavailable.')
  }
}

function isManifest(value: unknown): value is SourceRecoveryManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<SourceRecoveryManifest>
  return item.schemaVersion === SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION
    && typeof item.manifestId === 'string'
    && typeof item.ownerAuthority === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string'
    && typeof item.digest === 'string'
    && typeof item.state === 'string'
    && Array.isArray(item.items)
    && Array.isArray(item.effects)
    && Array.isArray(item.nonEffects)
}

function persistStore(store: ManifestStore, options: SourceRecoveryManifestOptions): void {
  const target = storePath(options)
  const directory = path.dirname(target)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  const payload: ManifestStore = {
    version: SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION,
    updatedAt: nowIso(options),
    manifests: store.manifests.slice(-MAX_MANIFESTS)
  }
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_STORE_BYTES) {
    throw new Error('manifest store exceeds bounded size')
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, target)
    fs.chmodSync(target, 0o600)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* atomic rename already completed */ }
  }
}

function failure(code: SourceRecoveryManifestFailureCode, message: string, rejected?: SourceRecoveryManifestFailure['rejected']): SourceRecoveryManifestFailure {
  return { ok: false, code, message, ...(rejected && rejected.length > 0 ? { rejected } : {}) }
}

function ownerMatches(manifest: SourceRecoveryManifest, actorId: string): boolean {
  return manifest.ownerAuthority === actorId
}

function findManifest(store: ManifestStore, manifestId: string): SourceRecoveryManifest | undefined {
  return store.manifests.find(item => item.manifestId === manifestId)
}

function replaceManifest(store: ManifestStore, manifest: SourceRecoveryManifest): void {
  const index = store.manifests.findIndex(item => item.manifestId === manifest.manifestId)
  if (index < 0) throw new Error('manifest not found while updating')
  store.manifests[index] = manifest
}

function currentProposal(report: SourceReconciliationReport, proposalId: string): ReconciliationProposal | undefined {
  return report.proposals.find(item => item.proposalId === proposalId)
}

function normalizedSelection(value: unknown): SourceRecoveryManifestSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.proposalId !== 'string' || typeof item.registrationId !== 'string'
    || (item.registrationType !== 'source' && item.registrationType !== 'provider')
    || typeof item.canonicalPath !== 'string'
    || (item.action !== 'disable' && item.action !== 'remove')
    || item.reviewed !== true) return undefined
  return {
    proposalId: item.proposalId,
    registrationId: item.registrationId,
    registrationType: item.registrationType,
    canonicalPath: item.canonicalPath,
    action: item.action,
    reviewed: true
  }
}

function exactItemFromProposal(proposal: ReconciliationProposal, selection: SourceRecoveryManifestSelection, actorId: string, reviewedAt: string): SourceRecoveryManifestItem {
  return {
    registrationId: proposal.registrationId,
    registrationType: proposal.registrationType,
    proposalId: proposal.proposalId,
    canonicalPath: proposal.canonicalPath,
    action: selection.action,
    classification: proposal.classification,
    reasonCode: proposal.reasonCode,
    reason: proposal.reason,
    observedPathState: proposal.observedPathState,
    proposalDigest: proposal.requestDigest,
    proposalSchemaVersion: proposal.schemaVersion,
    safety: proposal.safety,
    ...(proposal.ownerDisposition ? { ownerDisposition: proposal.ownerDisposition } : {}),
    reviewedBy: actorId,
    reviewedAt,
    beforeState: proposal.beforeState,
    result: 'pending'
  }
}

function summaryFor(manifest: SourceRecoveryManifest): SourceRecoveryManifestSummary {
  const terminal = manifest.items.filter(item => item.result !== 'pending' && item.result !== 'running')
  return {
    selected: manifest.items.length,
    executed: terminal.length,
    succeeded: manifest.items.filter(item => item.result === 'succeeded').length,
    stale: manifest.items.filter(item => item.result === 'stale').length,
    blocked: manifest.items.filter(item => item.result === 'blocked').length,
    failed: manifest.items.filter(item => item.result === 'failed').length,
    skipped: manifest.items.filter(item => item.result === 'skipped').length
  }
}

function ensureDigest(manifest: SourceRecoveryManifest): boolean {
  return manifest.digest === digestForItems(manifest.items)
}

function revalidateItem(item: SourceRecoveryManifestItem, options: SourceRecoveryManifestOptions): { outcome: 'pass' | 'stale' | 'blocked'; reason: string } {
  const report = scanSourceReconciliation({ ...(options.reconciliation || {}), persist: false, maxDetails: 256, maxProposals: 256 })
  const proposal = currentProposal(report, item.proposalId)
  if (!proposal) {
    const sameRegistration = report.proposals.find(candidate => candidate.registrationId === item.registrationId
      && candidate.registrationType === item.registrationType
      && candidate.canonicalPath === item.canonicalPath)
    if (sameRegistration?.safety.blockers.length) return { outcome: 'blocked', reason: `Safety blockers appeared: ${sameRegistration.safety.blockers.join(', ')}.` }
    return { outcome: 'stale', reason: 'The exact proposal is no longer present.' }
  }
  if (proposal.registrationId !== item.registrationId || proposal.registrationType !== item.registrationType) return { outcome: 'stale', reason: 'Registration identity changed since manifest approval.' }
  if (proposal.canonicalPath !== item.canonicalPath) return { outcome: 'stale', reason: 'Canonical path changed since manifest approval.' }
  if (proposal.safety.blockers.length > 0) return { outcome: 'blocked', reason: `Safety blockers appeared: ${proposal.safety.blockers.join(', ')}.` }
  if (proposal.requestDigest !== item.proposalDigest || proposal.schemaVersion !== item.proposalSchemaVersion) return { outcome: 'stale', reason: 'Proposal digest or version changed since manifest approval.' }
  if (proposal.classification !== item.classification || proposal.reasonCode !== item.reasonCode) return { outcome: 'stale', reason: 'Diagnostic state changed since manifest approval.' }
  if (proposal.requestedAction !== item.action || !proposal.allowedActions.includes(item.action)) return { outcome: 'stale', reason: 'Requested action changed or is no longer allowed.' }
  if (proposal.status !== 'pending') return { outcome: 'stale', reason: `Proposal is ${proposal.status}, not pending.` }
  return { outcome: 'pass', reason: 'Exact registration, proposal, path, diagnostic state, action, and safety evidence still match.' }
}

export function createSourceRecoveryManifest(
  input: { selections: unknown[]; actorId?: string },
  options: SourceRecoveryManifestOptions = {}
): SourceRecoveryManifestResult {
  const actorId = input.actorId || resolveReconciliationOwnerAuthority()
  const selections = input.selections.map(normalizedSelection)
  const rejected: NonNullable<SourceRecoveryManifestFailure['rejected']> = []
  if (selections.length === 0 || selections.length > Math.min(MAX_ITEMS, options.maxItems || MAX_ITEMS)) {
    return failure('manifest_rejected', `A reviewed-set manifest must contain between 1 and ${Math.min(MAX_ITEMS, options.maxItems || MAX_ITEMS)} exact items.`)
  }
  const validSelections = selections.filter((item): item is SourceRecoveryManifestSelection => {
    if (item) return true
    rejected.push({ reason: 'Each selection must include exact proposalId, registrationId, registrationType, canonicalPath, and action.' })
    return false
  })
  const proposalIds = new Set<string>()
  const registrationIds = new Set<string>()
  for (const item of validSelections) {
    if (proposalIds.has(item.proposalId)) rejected.push({ proposalId: item.proposalId, registrationId: item.registrationId, reason: 'Duplicate proposal identity.' })
    if (registrationIds.has(`${item.registrationType}:${item.registrationId}`)) rejected.push({ proposalId: item.proposalId, registrationId: item.registrationId, reason: 'Duplicate registration identity.' })
    proposalIds.add(item.proposalId)
    registrationIds.add(`${item.registrationType}:${item.registrationId}`)
  }
  if (rejected.length > 0) return failure('manifest_rejected', 'The exact reviewed-set selection was rejected before confirmation.', rejected)

  const report = scanSourceReconciliation({ ...(options.reconciliation || {}), persist: false, maxDetails: 256, maxProposals: 256 })
  const items: SourceRecoveryManifestItem[] = []
  const reviewedAt = nowIso(options)
  for (const selection of validSelections) {
    const proposal = currentProposal(report, selection.proposalId)
    if (!proposal) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: 'Exact proposal was not found in the current canonical report.' })
      continue
    }
    const mismatch = proposal.registrationId !== selection.registrationId
      || proposal.registrationType !== selection.registrationType
      || proposal.canonicalPath !== selection.canonicalPath
    if (mismatch) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: 'Proposal identity or canonical path did not exactly match the current report.' })
      continue
    }
    if (!['missing', 'stale'].includes(proposal.classification)) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: 'Only missing or stale proposals may enter a recovery manifest.' })
      continue
    }
    if (proposal.status !== 'pending') {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: `Proposal is ${proposal.status}, not pending.` })
      continue
    }
    if (proposal.ownerDisposition) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: `Proposal has owner disposition ${proposal.ownerDisposition}; retain/defer stays in triage.` })
      continue
    }
    if (proposal.safety.blockers.length > 0 || !proposal.allowedActions.includes(selection.action)) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: proposal.safety.blockers.length > 0 ? `Proposal is blocked: ${proposal.safety.blockers.join(', ')}.` : 'Requested action is not currently allowed.' })
      continue
    }
    if (proposal.requestedAction !== selection.action) {
      rejected.push({ proposalId: selection.proposalId, registrationId: selection.registrationId, reason: 'Requested action does not match the canonical proposal.' })
      continue
    }
    items.push(exactItemFromProposal(proposal, selection, actorId, reviewedAt))
  }
  if (rejected.length > 0) return failure('manifest_rejected', 'One or more exact selections were unsafe or changed; no manifest was created.', rejected)

  items.sort((a, b) => `${a.registrationType}:${a.registrationId}`.localeCompare(`${b.registrationType}:${b.registrationId}`))
  const timestamp = nowIso(options)
  const digest = digestForItems(items)
  const manifest: SourceRecoveryManifest = {
    schemaVersion: SOURCE_RECOVERY_MANIFEST_SCHEMA_VERSION,
    manifestId: `recovery-manifest-${crypto.randomUUID()}`,
    ownerAuthority: actorId,
    createdAt: timestamp,
    updatedAt: timestamp,
    digest,
    state: 'READY_FOR_REVIEW',
    items,
    effects: ['Disable or remove only the exact registration entries listed in this manifest.', 'Process entries sequentially with independent policy and revalidation.'],
    nonEffects: ['No repository folder, worktree, branch, Git history, run history, audit record, or evidence file is deleted.', 'No registration outside this immutable manifest is changed.', 'No wildcard, filter, future proposal, or dynamic set expansion is authorized.']
  }
  const lock = acquireManifestStoreLock(options)
  if (typeof lock !== 'function') return lock
  try {
    const store = readStore(options)
    if ('ok' in store && store.ok === false) return store
    ;(store as ManifestStore).manifests.push(manifest)
    persistStore(store as ManifestStore, options)
    return { ok: true, manifest }
  } catch {
    return failure('manifest_store_unavailable', 'The reviewed-set manifest could not be persisted safely.')
  } finally {
    lock()
  }
}

export function getSourceRecoveryManifest(manifestId: string, options: SourceRecoveryManifestOptions = {}): SourceRecoveryManifestResult {
  if (!manifestId || manifestId.length > 200) return failure('manifest_invalid', 'Manifest ID is invalid.')
  const store = readStore(options)
  if ('ok' in store && store.ok === false) return store
  const manifest = findManifest(store as ManifestStore, manifestId)
  return manifest ? { ok: true, manifest } : failure('manifest_not_found', 'The reviewed-set manifest was not found.')
}

export function approveSourceRecoveryManifest(input: { manifestId: string; digest: string; actorId?: string; ownerConfirmed: boolean }, options: SourceRecoveryManifestOptions = {}): SourceRecoveryManifestResult {
  const actorId = input.actorId || resolveReconciliationOwnerAuthority()
  if (!input.ownerConfirmed) return failure('manifest_rejected', 'Explicit owner confirmation is required.')
  const lock = acquireManifestStoreLock(options)
  if (typeof lock !== 'function') return lock
  try {
    const store = readStore(options)
    if ('ok' in store && store.ok === false) return store
    const manifest = findManifest(store as ManifestStore, input.manifestId)
    if (!manifest) return failure('manifest_not_found', 'The reviewed-set manifest was not found.')
    if (!ownerMatches(manifest, actorId)) return failure('manifest_rejected', 'Owner authority does not match the manifest owner.')
    if (!ensureDigest(manifest) || input.digest !== manifest.digest) return failure('manifest_digest_mismatch', 'Manifest digest does not match the immutable reviewed set.')
    if (manifest.state === 'APPROVED' || manifest.state === 'RUNNING' || manifest.state === 'PARTIAL' || manifest.state === 'COMPLETE' || manifest.state === 'FAILED' || manifest.state === 'STALE') return { ok: true, manifest }
    if (manifest.state !== 'READY_FOR_REVIEW') return failure('manifest_state_invalid', `Manifest is ${manifest.state}, not ready for review.`)
    const checkedAt = nowIso(options)
    const validations = manifest.items.map(item => ({ item, validation: revalidateItem(item, options) }))
    const invalid = validations.filter(({ validation }) => validation.outcome !== 'pass')
    if (invalid.length > 0) {
      const stale = {
        ...manifest,
        state: 'STALE' as const,
        updatedAt: checkedAt,
        items: validations.map(({ item, validation }) => validation.outcome === 'pass'
          ? item
          : {
              ...item,
              result: validation.outcome === 'blocked' ? 'blocked' as const : 'stale' as const,
              revalidation: { checkedAt, outcome: validation.outcome, reason: validation.reason },
              resultCode: validation.outcome.toUpperCase(),
              resultMessage: validation.reason,
              completedAt: checkedAt,
              mutated: false
            })
      }
      try {
        replaceManifest(store as ManifestStore, stale)
        persistStore(store as ManifestStore, options)
      } catch {
        return failure('manifest_store_unavailable', 'The changed reviewed-set manifest could not be invalidated safely.')
      }
      return failure('manifest_rejected', 'The reviewed set changed before owner confirmation; the draft was invalidated.', invalid.map(({ item, validation }) => ({ proposalId: item.proposalId, registrationId: item.registrationId, reason: validation.reason })))
    }
    const timestamp = checkedAt
    const approved = { ...manifest, state: 'APPROVED' as const, updatedAt: timestamp, confirmation: { ownerAuthority: actorId, confirmedAt: timestamp, digest: manifest.digest } }
    replaceManifest(store as ManifestStore, approved)
    persistStore(store as ManifestStore, options)
    return { ok: true, manifest: approved }
  } catch {
    return failure('manifest_store_unavailable', 'The reviewed-set manifest approval could not be persisted safely.')
  } finally {
    lock()
  }
}

export async function executeSourceRecoveryManifest(input: { manifestId: string; digest: string; actorId?: string }, options: SourceRecoveryManifestOptions = {}): Promise<SourceRecoveryManifestResult> {
  const actorId = input.actorId || resolveReconciliationOwnerAuthority()
  const initial = getSourceRecoveryManifest(input.manifestId, options)
  if (!initial.ok) return initial
  let manifest = initial.manifest
  if (!ownerMatches(manifest, actorId)) return failure('manifest_rejected', 'Owner authority does not match the manifest owner.')
  if (!ensureDigest(manifest) || input.digest !== manifest.digest) return failure('manifest_digest_mismatch', 'Manifest digest does not match the immutable reviewed set.')
  if (manifest.state === 'READY_FOR_REVIEW') return failure('manifest_state_invalid', 'Manifest requires explicit owner approval before execution.')
  if (manifest.state === 'COMPLETE' || manifest.state === 'FAILED' || manifest.state === 'STALE') return { ok: true, manifest }
  if (activeExecutions.has(manifest.manifestId)) return { ok: true, manifest }
  activeExecutions.add(manifest.manifestId)
  let releaseLock: (() => void) | undefined
  try {
    const lock = acquireManifestStoreLock(options)
    if (typeof lock !== 'function') return lock
    releaseLock = lock
    const store = readStore(options)
    if ('ok' in store && store.ok === false) return store
    const stored = findManifest(store as ManifestStore, manifest.manifestId)
    if (!stored) return failure('manifest_not_found', 'The reviewed-set manifest was not found.')
    manifest = stored
    const startedAt = manifest.execution?.startedAt || nowIso(options)
    const started = { ...manifest, state: 'RUNNING' as const, updatedAt: nowIso(options), execution: { order: manifest.items.map(item => item.registrationId), summary: summaryFor(manifest), ...(manifest.execution || {}), startedAt } }
    replaceManifest(store as ManifestStore, started)
    persistStore(store as ManifestStore, options)
    manifest = started

    for (const currentItem of [...manifest.items]) {
      if (currentItem.result === 'succeeded' || currentItem.result === 'stale' || currentItem.result === 'blocked' || currentItem.result === 'failed' || currentItem.result === 'skipped') continue
      const item = { ...currentItem, result: 'running' as const, startedAt: currentItem.startedAt || nowIso(options), resultMessage: undefined, resultCode: undefined }
      manifest = { ...manifest, updatedAt: nowIso(options), items: manifest.items.map(candidate => candidate.proposalId === item.proposalId ? item : candidate) }
      const runningStore = readStore(options)
      if ('ok' in runningStore && runningStore.ok === false) return runningStore
      replaceManifest(runningStore as ManifestStore, manifest)
      persistStore(runningStore as ManifestStore, options)

      const validation = revalidateItem(item, options)
      const checkedAt = nowIso(options)
      if (validation.outcome !== 'pass') {
        const terminal: SourceRecoveryManifestItem = { ...item, result: validation.outcome === 'blocked' ? 'blocked' : 'stale', revalidation: { checkedAt, outcome: validation.outcome, reason: validation.reason }, resultCode: validation.outcome.toUpperCase(), resultMessage: validation.reason, completedAt: checkedAt, mutated: false }
        manifest = { ...manifest, updatedAt: checkedAt, items: manifest.items.map(candidate => candidate.proposalId === item.proposalId ? terminal : candidate) }
        const changedStore = readStore(options)
        if ('ok' in changedStore && changedStore.ok === false) return changedStore
        replaceManifest(changedStore as ManifestStore, manifest)
        persistStore(changedStore as ManifestStore, options)
        continue
      }
      const applied = applyReconciliationApproval({
        proposalId: item.proposalId,
        action: item.action,
        actorId,
        registrationId: item.registrationId,
        registrationType: item.registrationType,
        canonicalPath: item.canonicalPath,
        classification: item.classification as 'missing' | 'stale',
        reasonCode: item.reasonCode as never,
        ownerConfirmed: true
      }, options.reconciliation)
      const completedAt = nowIso(options)
      const success = applied.ok && (applied.code === 'applied' || applied.code === 'already_reconciled')
      const terminal: SourceRecoveryManifestItem = {
        ...item,
        result: success ? 'succeeded' : applied.code === 'blocked' || applied.code === 'approval_mismatch' || applied.code === 'invalid_proposal' ? 'stale' : 'failed',
        revalidation: { checkedAt, outcome: 'pass', reason: validation.reason },
        resultCode: applied.code,
        resultMessage: applied.message,
        completedAt,
        mutated: applied.mutated,
        ...(applied.proposal?.afterState ? { afterState: applied.proposal.afterState } : {}),
        attempts: (item.attempts || 0) + 1
      }
      manifest = { ...manifest, updatedAt: completedAt, items: manifest.items.map(candidate => candidate.proposalId === item.proposalId ? terminal : candidate) }
      const completedStore = readStore(options)
      if ('ok' in completedStore && completedStore.ok === false) return completedStore
      replaceManifest(completedStore as ManifestStore, manifest)
      persistStore(completedStore as ManifestStore, options)
    }
    const finishedAt = nowIso(options)
    const summary = summaryFor(manifest)
    const hasFailures = summary.stale + summary.blocked + summary.failed > 0
    const finalState: SourceRecoveryManifestState = hasFailures ? (summary.succeeded > 0 ? 'PARTIAL' : summary.stale === summary.selected ? 'STALE' : 'FAILED') : 'COMPLETE'
    const finished = { ...manifest, state: finalState, updatedAt: finishedAt, execution: { ...(manifest.execution || { order: manifest.items.map(item => item.registrationId) }), completedAt: finishedAt, summary } }
    const finalStore = readStore(options)
    if ('ok' in finalStore && finalStore.ok === false) return finalStore
    replaceManifest(finalStore as ManifestStore, finished)
    persistStore(finalStore as ManifestStore, options)
    return { ok: true, manifest: finished }
  } catch (error) {
    return failure('manifest_store_unavailable', error instanceof Error ? error.message : 'Manifest execution failed safely.')
  } finally {
    releaseLock?.()
    activeExecutions.delete(manifest.manifestId)
  }
}

export function summarizeSourceRecoveryManifest(manifest: SourceRecoveryManifest): SourceRecoveryManifestSummary {
  return summaryFor(manifest)
}
