import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { KnowledgeSource } from '@workbench/shared'
import { getSourcesSafe, loadConfig } from './config'
import { expandTilde, getConfigDir } from '../utils/paths'
import { getIndexRecord, type SourceIndexRecord } from './index-state'
import { listAgentJobs } from './agent-jobs'
import { removeSourceRegistration, setSourceEnabledSafe } from './source-management'
import {
  listProviderInventory,
  removeProviderInventory,
  transitionProviderRegistration,
  type ProviderInventoryRecord,
  type ProviderInventoryResult
} from '../../../mcp/dist/provider-inventory.js'
import { getProviderActivationDiagnostics } from '../../../mcp/dist/provider-activation.js'

export const SOURCE_RECONCILIATION_SCHEMA_VERSION = 1 as const
export const SOURCE_RECONCILIATION_FILENAME = 'workbench-source-reconciliation.json' as const

export type ReconciliationClassification = 'healthy' | 'stale' | 'missing' | 'disabled' | 'reconciling' | 'removed'
export type ReconciliationReasonCode =
  | 'missing_path'
  | 'source_unavailable'
  | 'index_stale'
  | 'revision_mismatch'
  | 'provenance_stale'
  | 'disabled'
  | 'identity_conflict'
  | 'active_reference'
  | 'dirty_worktree'
  | 'ambiguous_path'

export type ReconciliationAction = 'disable' | 'remove' | 'inspect'
export type ReconciliationRegistrationType = 'source' | 'provider'
export type ReconciliationProposalStatus = 'pending' | 'reconciling' | 'applied' | 'blocked' | 'invalidated' | 'denied'

export type ReconciliationSafety = {
  activeRuns: string[]
  dirtyWorktree: boolean
  identityConflict: boolean
  ambiguousPath: boolean
  blockers: string[]
}

export type ReconciliationProposal = {
  proposalId: string
  schemaVersion: typeof SOURCE_RECONCILIATION_SCHEMA_VERSION
  registrationId: string
  registrationType: ReconciliationRegistrationType
  canonicalPath: string
  classification: ReconciliationClassification
  reasonCode: ReconciliationReasonCode
  reason: string
  observedPathState: 'available' | 'missing' | 'not_directory'
  observedHead?: string
  indexedRevision?: string
  indexStatus?: string
  provenance: {
    sourcePathIdentity?: string
    indexedPathIdentity?: string
    sourceWorktreeIdentity?: string
    indexedWorktreeIdentity?: string
    repoRoot?: string
    repoGroupId?: string
  }
  safety: ReconciliationSafety
  requestedAction: ReconciliationAction
  allowedActions: ReconciliationAction[]
  confirmationRequired: true
  ownerAuthority: string
  effects: string[]
  nonEffects: string[]
  requestDigest: string
  status: ReconciliationProposalStatus
  beforeState: { enabled?: boolean; registrationState?: string; path: string }
  afterState?: { enabled?: boolean; registrationState?: string; registrationPresent: boolean }
  createdAt: string
  updatedAt: string
  decidedAt?: string
  completedAt?: string
}

export type ReconciliationDetail = {
  registrationId: string
  registrationType: ReconciliationRegistrationType
  label: string
  canonicalPath: string
  classification: ReconciliationClassification
  reasonCode: ReconciliationReasonCode
  reason: string
  active: boolean
  activeSelectionExcluded: boolean
  observedPathState: ReconciliationProposal['observedPathState']
  observedHead?: string
  indexedRevision?: string
  indexStatus?: string
  provenance: ReconciliationProposal['provenance']
  safety: ReconciliationSafety
  requestedAction: ReconciliationAction
  allowedActions: ReconciliationAction[]
  confirmationRequired: true
  proposalId?: string
  proposalStatus?: ReconciliationProposalStatus
  ownerAuthority: string
}

export type SourceReconciliationReport = {
  schemaVersion: typeof SOURCE_RECONCILIATION_SCHEMA_VERSION
  generatedAt: string
  bounded: { maxDetails: number; maxProposals: number; fullIndexingTriggered: false }
  summary: {
    total: number
    healthy: number
    stale: number
    missing: number
    disabled: number
    reconciling: number
    removed: number
    actionable: number
    blocked: number
    pendingProposals: number
  }
  reasonCounts: Partial<Record<ReconciliationReasonCode, number>>
  details: ReconciliationDetail[]
  proposals: ReconciliationProposal[]
  timing: { durationMs: number; gitChecks: number; pathChecks: number; providerChecks: number }
}

export type SourceReconciliationOptions = {
  sources?: KnowledgeSource[]
  sourceLoader?: () => KnowledgeSource[]
  activeSourceIds?: string[]
  indexRecordLoader?: (sourceId: string) => SourceIndexRecord | undefined
  activeRunLoader?: () => Array<{ id?: string; sourceId: string; status: string }>
  providers?: ProviderInventoryRecord[]
  providerLoader?: () => ProviderInventoryRecord[]
  activeProviderLoader?: () => string[]
  providerRootDir?: string
  storePath?: string
  now?: () => Date
  maxDetails?: number
  maxProposals?: number
  persist?: boolean
}

export type ReconciliationApproval = {
  proposalId: string
  action: Exclude<ReconciliationAction, 'inspect'>
  actorId: string
  registrationId: string
  registrationType: ReconciliationRegistrationType
  canonicalPath: string
  classification: ReconciliationClassification
  reasonCode: ReconciliationReasonCode
  ownerConfirmed: true
}

export type ReconciliationApplyResult = {
  ok: boolean
  code: 'applied' | 'already_reconciled' | 'approval_mismatch' | 'blocked' | 'not_found' | 'mutation_failed' | 'invalid_proposal'
  message: string
  proposal?: ReconciliationProposal
  mutated: boolean
}

type ReconciliationStore = {
  version: typeof SOURCE_RECONCILIATION_SCHEMA_VERSION
  updatedAt: string
  proposals: ReconciliationProposal[]
}

type Observation = Omit<ReconciliationDetail, 'proposalId' | 'proposalStatus'> & {
  beforeState: ReconciliationProposal['beforeState']
}

const MAX_STORE_PROPOSALS = 500
const MAX_STORE_BYTES = 2 * 1024 * 1024
const GIT_TIMEOUT_MS = 1500
const GIT_BIN = '/usr/bin/git'
const ACTIVE_STATUSES = new Set(['queued', 'running', 'needs_confirmation', 'blocked'])

function nowDate(options: SourceReconciliationOptions): Date { return options.now ? options.now() : new Date() }
function ownerAuthority(): string { return `os-user:${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username}` }
export function resolveReconciliationOwnerAuthority(): string { return ownerAuthority() }
function storePath(options: SourceReconciliationOptions): string { return options.storePath || path.join(getConfigDir(), SOURCE_RECONCILIATION_FILENAME) }
function sha(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex') }
function repoGroupId(commonDir: string): string { return `git:${crypto.createHash('sha1').update(commonDir, 'utf8').digest('hex').slice(0, 16)}` }
function canonicalPath(value: string): string {
  const expanded = expandTilde(value)
  try { return fs.realpathSync(expanded) } catch { return path.resolve(expanded) }
}
function pathState(value: string): ReconciliationProposal['observedPathState'] {
  try { return fs.statSync(expandTilde(value)).isDirectory() ? 'available' : 'not_directory' } catch { return 'missing' }
}
function hashPath(value: string): string { return sha(canonicalPath(value)).slice(0, 32) }
function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync(GIT_BIN, ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
  } catch { return undefined }
}
function currentGit(cwd: string): { head?: string; repoRoot?: string; repoGroupId?: string; dirty: boolean; worktreeIdentity?: string } {
  const head = runGit(cwd, ['rev-parse', 'HEAD'])
  const repoRoot = runGit(cwd, ['rev-parse', '--show-toplevel'])
  const commonDir = runGit(cwd, ['rev-parse', '--git-common-dir'])
  const status = runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])
  const normalizedRoot = repoRoot ? canonicalPath(repoRoot) : undefined
  const normalizedCommon = commonDir ? canonicalPath(path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)) : undefined
  return {
    head,
    repoRoot: normalizedRoot,
    repoGroupId: normalizedCommon ? repoGroupId(normalizedCommon) : undefined,
    dirty: Boolean(status),
    worktreeIdentity: head && normalizedRoot ? sha(`${normalizedRoot}\n${head}\n${status || ''}`).slice(0, 32) : undefined
  }
}

function readStore(options: SourceReconciliationOptions): ReconciliationStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(options), 'utf8')) as ReconciliationStore
    if (parsed.version === SOURCE_RECONCILIATION_SCHEMA_VERSION && Array.isArray(parsed.proposals)) return parsed
  } catch {}
  return { version: SOURCE_RECONCILIATION_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), proposals: [] }
}
function writeStore(options: SourceReconciliationOptions, store: ReconciliationStore, timestamp: string): void {
  const target = storePath(options)
  const encoded = JSON.stringify({ version: SOURCE_RECONCILIATION_SCHEMA_VERSION, updatedAt: timestamp, proposals: store.proposals.slice(-MAX_STORE_PROPOSALS) })
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) throw new Error('source reconciliation store exceeds bounded size')
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(target), 0o700)
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, encoded, { encoding: 'utf8', mode: 0o600 })
  fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

function defaultSources(options: SourceReconciliationOptions): KnowledgeSource[] {
  if (options.sources) return [...options.sources]
  if (options.sourceLoader) return [...options.sourceLoader()]
  return getSourcesSafe({ refreshGitMetadata: false, includeIndexState: false })
}
function configuredActiveSourceIds(sources: KnowledgeSource[], options: SourceReconciliationOptions): Set<string> {
  if (options.activeSourceIds) return new Set(options.activeSourceIds)
  const config = loadConfig()
  if (config?.activeSourcesMode === 'single' || config?.activeSourcesMode === 'multi') return new Set(config.activeSourceIds || [])
  return new Set(sources.filter(source => source.enabled && pathState(source.path) === 'available').map(source => source.id))
}
function activeRuns(options: SourceReconciliationOptions): Array<{ id?: string; sourceId: string; status: string }> {
  if (options.activeRunLoader) return options.activeRunLoader().filter(run => ACTIVE_STATUSES.has(run.status))
  return listAgentJobs().filter(job => ACTIVE_STATUSES.has(job.status)).map(job => ({ id: job.id, sourceId: job.sourceId, status: job.status }))
}
function providerRecords(options: SourceReconciliationOptions): ProviderInventoryRecord[] {
  if (options.providers) return [...options.providers]
  if (options.providerLoader) return [...options.providerLoader()]
  const result = listProviderInventory({ rootDir: options.providerRootDir || process.env.WORKBENCH_PROVIDER_STATE_DIR })
  return result.ok ? result.value : []
}
function activeProviders(options: SourceReconciliationOptions): Set<string> {
  if (options.activeProviderLoader) return new Set(options.activeProviderLoader())
  try {
    const rootDir = options.providerRootDir || process.env.WORKBENCH_PROVIDER_STATE_DIR
    return new Set(getProviderActivationDiagnostics({ rootDir, knowledgeRootDir: rootDir, recordSelection: false }).activeProviderIds)
  } catch { return new Set() }
}

function classifySource(source: KnowledgeSource, allSources: KnowledgeSource[], activeIds: Set<string>, runs: Array<{ id?: string; sourceId: string; status: string }>, options: SourceReconciliationOptions): Observation {
  const state = pathState(source.path)
  const canonical = canonicalPath(source.path)
  const samePath = allSources.filter(candidate => canonicalPath(candidate.path) === canonical && candidate.id !== source.id)
  const record = (options.indexRecordLoader || getIndexRecord)(source.id)
  const git: ReturnType<typeof currentGit> = state === 'available' ? currentGit(expandTilde(source.path)) : { dirty: false }
  const activeRunsForSource = runs.filter(run => run.sourceId === source.id).map(run => run.id || `${source.id}:${run.status}`)
  const blockers: string[] = []
  let classification: ReconciliationClassification = 'healthy'
  let reasonCode: ReconciliationReasonCode = 'source_unavailable'
  let reason = 'Source registration is healthy and available.'
  const active = activeIds.has(source.id)
  const provenance = {
    sourcePathIdentity: git.repoRoot ? hashPath(git.repoRoot) : hashPath(source.path),
    indexedPathIdentity: record?.sourcePathIdentity,
    sourceWorktreeIdentity: git.worktreeIdentity,
    indexedWorktreeIdentity: record?.sourceWorktreeIdentity,
    repoRoot: git.repoRoot || source.repoRoot,
    repoGroupId: git.repoGroupId || source.repoGroupId
  }

  if (!source.enabled) {
    classification = 'disabled'; reasonCode = 'disabled'; reason = 'Source registration is explicitly disabled.'
  } else if (state !== 'available') {
    classification = 'missing'; reasonCode = state === 'not_directory' ? 'source_unavailable' : 'missing_path'; reason = state === 'not_directory' ? 'Configured source path is not a directory.' : 'Configured source path is missing.'
  } else if (samePath.length > 0) {
    classification = 'stale'; reasonCode = 'ambiguous_path'; reason = `Canonical path is also registered as ${samePath.map(item => item.id).join(', ')}.`
    blockers.push('ambiguous_path')
  } else if ((source.repoRoot && git.repoRoot && canonicalPath(source.repoRoot) !== canonicalPath(git.repoRoot)) || (source.repoGroupId && git.repoGroupId && source.repoGroupId !== git.repoGroupId)) {
    classification = 'stale'; reasonCode = 'identity_conflict'; reason = 'Configured Git identity does not match the observed repository.'
    blockers.push('identity_conflict')
  } else if (!record || record.indexStatus !== 'ready' || record.indexed !== true) {
    classification = 'stale'; reasonCode = 'index_stale'; reason = 'Source index is missing or not ready.'
  } else if (record.sourceRevision && git.head && record.sourceRevision !== git.head) {
    classification = 'stale'; reasonCode = 'revision_mismatch'; reason = 'Source HEAD differs from the indexed revision.'
  } else if (record.sourcePathIdentity && record.sourcePathIdentity !== provenance.sourcePathIdentity) {
    classification = 'stale'; reasonCode = 'provenance_stale'; reason = 'Canonical source path differs from indexed provenance.'
  } else if (git.dirty) {
    classification = 'stale'; reasonCode = 'dirty_worktree'; reason = 'Source worktree has uncommitted changes.'
    blockers.push('dirty_worktree')
  }

  if (activeRunsForSource.length > 0) {
    blockers.push('active_reference')
    if (classification === 'missing' || classification === 'stale') reasonCode = 'active_reference'
  }
  const allowedActions: ReconciliationAction[] = classification === 'missing' && blockers.length === 0 ? ['disable', 'remove'] : []
  const requestedAction: ReconciliationAction = allowedActions[0] || 'inspect'
  return {
    registrationId: source.id,
    registrationType: 'source',
    label: source.label,
    canonicalPath: canonical,
    classification,
    reasonCode,
    reason,
    active,
    activeSelectionExcluded: !active || classification !== 'healthy',
    observedPathState: state,
    observedHead: git.head,
    indexedRevision: record?.sourceRevision,
    indexStatus: record?.indexStatus,
    provenance,
    safety: { activeRuns: activeRunsForSource, dirtyWorktree: git.dirty || false, identityConflict: blockers.includes('identity_conflict'), ambiguousPath: blockers.includes('ambiguous_path'), blockers },
    requestedAction,
    allowedActions,
    confirmationRequired: true,
    ownerAuthority: ownerAuthority(),
    beforeState: { enabled: source.enabled, path: source.path }
  }
}

function classifyProvider(provider: ProviderInventoryRecord, activeIds: Set<string>, options: SourceReconciliationOptions): Observation {
  const isLocal = provider.location.kind === 'local-path'
  const state = isLocal ? pathState(provider.location.value) : 'available'
  const canonical = isLocal ? canonicalPath(provider.location.value) : provider.location.value
  let classification: ReconciliationClassification = 'healthy'
  let reasonCode: ReconciliationReasonCode = 'source_unavailable'
  let reason = 'Provider registration is healthy and available.'
  if (!provider.enabled || provider.registrationState === 'disabled') {
    classification = 'disabled'; reasonCode = 'disabled'; reason = 'Provider registration is explicitly disabled.'
  } else if (state !== 'available') {
    classification = 'missing'; reasonCode = 'missing_path'; reason = 'Provider local path is missing or unavailable.'
  } else if (provider.registrationState !== 'enabled' || provider.health !== 'healthy') {
    classification = 'stale'; reasonCode = 'source_unavailable'; reason = provider.registrationState !== 'enabled' ? 'Provider registration is not enabled.' : `Provider health is ${provider.health}.`
  }
  const active = activeIds.has(provider.providerId)
  const blockers = active ? ['active_reference'] : []
  if (active && classification === 'missing') { reasonCode = 'active_reference'; reason = 'Provider is active while its local path is unavailable.' }
  const allowedActions: ReconciliationAction[] = classification === 'missing' && blockers.length === 0 ? ['disable', 'remove'] : []
  return {
    registrationId: provider.providerId,
    registrationType: 'provider',
    label: provider.displayName,
    canonicalPath: canonical,
    classification,
    reasonCode,
    reason,
    active,
    activeSelectionExcluded: !active || classification !== 'healthy',
    observedPathState: state,
    provenance: { indexedPathIdentity: undefined },
    safety: { activeRuns: [], dirtyWorktree: false, identityConflict: false, ambiguousPath: false, blockers },
    requestedAction: allowedActions[0] || 'inspect',
    allowedActions,
    confirmationRequired: true,
    ownerAuthority: ownerAuthority(),
    beforeState: { enabled: provider.enabled, registrationState: provider.registrationState, path: provider.location.value }
  }
}

function proposalFor(observation: Observation, timestamp: string, existing: ReconciliationProposal[]): ReconciliationProposal | undefined {
  if (!['missing', 'stale'].includes(observation.classification)) return undefined
  const identity = { registrationId: observation.registrationId, registrationType: observation.registrationType, canonicalPath: observation.canonicalPath, classification: observation.classification, reasonCode: observation.reasonCode, requestedAction: observation.requestedAction, beforeState: observation.beforeState }
  const digest = sha(JSON.stringify(identity))
  const old = existing.find(item => item.requestDigest === digest)
  if (old) return { ...old, ...(observation.allowedActions.length > 0 && (old.status === 'blocked' || old.status === 'invalidated' || old.status === 'denied') ? { status: 'pending' as const, decidedAt: undefined, completedAt: undefined } : {}), updatedAt: timestamp, safety: observation.safety, reason: observation.reason, observedHead: observation.observedHead, indexedRevision: observation.indexedRevision, indexStatus: observation.indexStatus, provenance: observation.provenance }
  return {
    proposalId: `reconciliation-${digest.slice(0, 24)}`,
    schemaVersion: SOURCE_RECONCILIATION_SCHEMA_VERSION,
    registrationId: observation.registrationId,
    registrationType: observation.registrationType,
    canonicalPath: observation.canonicalPath,
    classification: observation.classification,
    reasonCode: observation.reasonCode,
    reason: observation.reason,
    observedPathState: observation.observedPathState,
    ...(observation.observedHead ? { observedHead: observation.observedHead } : {}),
    ...(observation.indexedRevision ? { indexedRevision: observation.indexedRevision } : {}),
    ...(observation.indexStatus ? { indexStatus: observation.indexStatus } : {}),
    provenance: observation.provenance,
    safety: observation.safety,
    requestedAction: observation.requestedAction,
    allowedActions: observation.allowedActions,
    confirmationRequired: true,
    ownerAuthority: observation.ownerAuthority,
    effects: observation.registrationType === 'source'
      ? ['Disable or remove only this exact source registration.', 'Exclude this registration from active execution selection.']
      : ['Disable or remove only this exact provider registration.', 'Exclude this provider from active activation selection.'],
    nonEffects: ['No repository folder, worktree, branch, Git history, audit record, or evidence file is deleted.', 'No provider operation is invoked and no unrelated registration is changed.'],
    requestDigest: digest,
    status: observation.allowedActions.length > 0 ? 'pending' : 'blocked',
    beforeState: observation.beforeState,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

export function scanSourceReconciliation(options: SourceReconciliationOptions = {}): SourceReconciliationReport {
  const started = Date.now()
  const timestamp = nowDate(options).toISOString()
  const maxDetails = Math.max(1, Math.min(options.maxDetails || 64, 256))
  const maxProposals = Math.max(1, Math.min(options.maxProposals || 64, 128))
  const sources = defaultSources(options)
  const sourceActiveIds = configuredActiveSourceIds(sources, options)
  const runs = activeRuns(options)
  const providers = providerRecords(options)
  const providerActiveIds = activeProviders(options)
  const store = readStore(options)
  const observations = [
    ...sources.map(source => classifySource(source, sources, sourceActiveIds, runs, options)),
    ...providers.map(provider => classifyProvider(provider, providerActiveIds, options))
  ].sort((a, b) => `${a.registrationType}:${a.registrationId}`.localeCompare(`${b.registrationType}:${b.registrationId}`))
  const proposals = observations.map(observation => proposalFor(observation, timestamp, store.proposals)).filter((item): item is ReconciliationProposal => Boolean(item)).slice(0, maxProposals)
  const proposalById = new Map(proposals.map(proposal => [proposal.proposalId, proposal]))
  const details = observations.slice(0, maxDetails).map(observation => {
    const proposal = proposalById.get(proposalFor(observation, timestamp, store.proposals)?.proposalId || '')
    return { ...observation, ...(proposal ? { proposalId: proposal.proposalId, proposalStatus: proposal.status } : {}) }
  })
  if (options.persist !== false && proposals.length > 0) {
    const proposalIds = new Set(proposals.map(proposal => proposal.proposalId))
    const retained = store.proposals.filter(proposal => !proposalIds.has(proposal.proposalId))
    writeStore(options, { version: SOURCE_RECONCILIATION_SCHEMA_VERSION, updatedAt: timestamp, proposals: [...retained, ...proposals] }, timestamp)
  }
  const summary = observations.reduce<SourceReconciliationReport['summary']>((acc, observation) => {
    acc.total += 1; acc[observation.classification] += 1
    if (observation.allowedActions.length > 0) acc.actionable += 1
    if (observation.safety.blockers.length > 0) acc.blocked += 1
    return acc
  }, { total: 0, healthy: 0, stale: 0, missing: 0, disabled: 0, reconciling: 0, removed: 0, actionable: 0, blocked: 0, pendingProposals: 0 })
  summary.pendingProposals = Array.from(new Map([...store.proposals, ...proposals].map(proposal => [proposal.proposalId, proposal])).values()).filter(proposal => proposal.status === 'pending').length
  const reasonCounts: Partial<Record<ReconciliationReasonCode, number>> = {}
  for (const observation of observations) reasonCounts[observation.reasonCode] = (reasonCounts[observation.reasonCode] || 0) + 1
  return {
    schemaVersion: SOURCE_RECONCILIATION_SCHEMA_VERSION,
    generatedAt: timestamp,
    bounded: { maxDetails, maxProposals, fullIndexingTriggered: false },
    summary, reasonCounts,
    details, proposals,
    timing: { durationMs: Date.now() - started, gitChecks: sources.filter(source => source.enabled && pathState(source.path) === 'available').length, pathChecks: sources.length + providers.filter(provider => provider.location.kind === 'local-path').length, providerChecks: providers.length }
  }
}

export function getSourceReconciliationReport(options: SourceReconciliationOptions = {}): SourceReconciliationReport { return scanSourceReconciliation(options) }

function updateProposal(options: SourceReconciliationOptions, proposal: ReconciliationProposal, timestamp: string): ReconciliationProposal {
  const store = readStore(options)
  const proposals = store.proposals.filter(item => item.proposalId !== proposal.proposalId)
  const updated = { ...proposal, updatedAt: timestamp }
  writeStore(options, { version: SOURCE_RECONCILIATION_SCHEMA_VERSION, updatedAt: timestamp, proposals: [...proposals, updated] }, timestamp)
  return updated
}

export function applyReconciliationApproval(approval: ReconciliationApproval, options: SourceReconciliationOptions = {}): ReconciliationApplyResult {
  if (!approval.ownerConfirmed || approval.actorId !== ownerAuthority()) return { ok: false, code: 'approval_mismatch', message: 'Owner authority does not match this local user.', mutated: false }
  const store = readStore(options)
  const proposal = store.proposals.find(item => item.proposalId === approval.proposalId)
  if (!proposal) return { ok: false, code: 'not_found', message: 'Reconciliation proposal was not found.', mutated: false }
  if (proposal.status === 'applied') return { ok: true, code: 'already_reconciled', message: 'Reconciliation was already applied; no mutation was repeated.', proposal, mutated: false }
  if (proposal.status !== 'pending') return { ok: false, code: 'invalid_proposal', message: `Reconciliation proposal is ${proposal.status}, not pending.`, proposal, mutated: false }
  if (approval.action !== proposal.requestedAction || approval.registrationId !== proposal.registrationId || approval.registrationType !== proposal.registrationType || canonicalPath(approval.canonicalPath) !== proposal.canonicalPath || approval.classification !== proposal.classification || approval.reasonCode !== proposal.reasonCode || !proposal.allowedActions.includes(approval.action)) {
    const invalidated = updateProposal(options, { ...proposal, status: 'invalidated', decidedAt: nowDate(options).toISOString() }, nowDate(options).toISOString())
    return { ok: false, code: 'approval_mismatch', message: 'Approval did not exactly match the stored registration, path, classification, reason, or action.', proposal: invalidated, mutated: false }
  }
  const current = scanSourceReconciliation({ ...options, persist: false, maxDetails: 256, maxProposals: 256 })
  const detail = current.details.find(item => item.registrationType === proposal.registrationType && item.registrationId === proposal.registrationId)
  if (!detail || detail.canonicalPath !== proposal.canonicalPath || detail.classification !== proposal.classification || detail.reasonCode !== proposal.reasonCode || detail.safety.blockers.length > 0 || !detail.allowedActions.includes(approval.action)) {
    const blocked = updateProposal(options, { ...proposal, status: 'blocked', decidedAt: nowDate(options).toISOString(), reason: detail?.safety.blockers.join(', ') || 'Registration changed since proposal creation.' }, nowDate(options).toISOString())
    return { ok: false, code: 'blocked', message: blocked.reason, proposal: blocked, mutated: false }
  }
  const reconciling = updateProposal(options, { ...proposal, status: 'reconciling', decidedAt: nowDate(options).toISOString() }, nowDate(options).toISOString())
  try {
    if (proposal.registrationType === 'source') {
      if (approval.action === 'disable') setSourceEnabledSafe(proposal.registrationId, false)
      else removeSourceRegistration(proposal.registrationId)
    } else {
      if (approval.action === 'disable') {
        const result = transitionProviderRegistration(proposal.registrationId, 'disabled', { rootDir: options.providerRootDir || process.env.WORKBENCH_PROVIDER_STATE_DIR })
        if ('message' in result) throw new Error(result.message)
      } else {
        const result: ProviderInventoryResult<boolean> = removeProviderInventory(proposal.registrationId, { rootDir: options.providerRootDir || process.env.WORKBENCH_PROVIDER_STATE_DIR })
        if ('message' in result) throw new Error(result.message)
      }
    }
    const completed = updateProposal(options, { ...reconciling, status: 'applied', completedAt: nowDate(options).toISOString(), afterState: { enabled: approval.action === 'disable' ? false : undefined, registrationState: approval.action === 'disable' ? 'disabled' : 'removed', registrationPresent: approval.action === 'disable' } }, nowDate(options).toISOString())
    return { ok: true, code: 'applied', message: `Applied exact owner-approved ${approval.action} for ${proposal.registrationType} ${proposal.registrationId}.`, proposal: completed, mutated: true }
  } catch (error) {
    const failed = updateProposal(options, { ...reconciling, status: 'blocked', reason: error instanceof Error ? error.message : String(error) }, nowDate(options).toISOString())
    return { ok: false, code: 'mutation_failed', message: failed.reason, proposal: failed, mutated: false }
  }
}
