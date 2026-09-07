import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getConfigPath, expandTilde } from '../utils/paths'
import { getSourceIndexBinding, loadConfig, saveConfig, withSourceDefaults, withSourceIndexState, generateSourceIdFromPath, clearGitMetadataCache, setSourceIndexStatus, isSourcePathAvailable, type AgentConfig } from './config'
import { getIndexRecord, upsertIndexState } from './index-state'
import { IndexScanError, Indexer } from './indexer'
import { INDEX_SCAN_EXCLUSION_VERSION, INDEX_SCAN_POLICY_ID, INDEX_SCAN_POLICY_VERSION } from './index-scan-policy'
import type { KnowledgeSource } from '@workbench/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RepositoryInspection = {
  path: string
  label: string
  repoGroupId: string
  repoRoot: string
  branchName: string | undefined
  availableBranches: string[]
  isGitWorktree: boolean
  alreadyRegistered: boolean
  registeredSourceId: string | undefined
}

export type SourceDetails = KnowledgeSource & {
  isManaged: boolean
  managedWorktreeDir: string | undefined
}

export type AddRepositoryResult = { sources: SourceDetails[] }
export type RemoveSourceResult = { sources: SourceDetails[] }
export type SetSourceEnabledResult = { sources: SourceDetails[] }
export type ReindexSourceResult = { source: SourceDetails; status: 'indexing' | 'ready' | 'failed' }
export type RefreshSourceMetadataResult = { source: SourceDetails }
export type AddBranchSourceResult = { sources: SourceDetails[] }
export type RemoveBranchSourceResult = {
  sources: SourceDetails[]
  registrationRemoved: boolean
  worktreeRemoved: boolean
  cleanupRequired: boolean
  warning?: string
}
export type RegisterWorktreeResult = { sources: SourceDetails[] }

export class SourceManagementError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'SourceManagementError'
  }
}

// Extended source type that tracks managed worktree marker
type KnowledgeSourceExt = KnowledgeSource & { isManagedWorktree?: boolean }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 2000
const activeReindexes = new Set<string>()
const indexRetryAttempts = new Map<string, number>()
export const MANAGED_WORKTREES_BASE = path.join(os.homedir(), '.buildflow', 'worktrees')

// Fixed Git executable — no PATH resolution
const GIT_EXECUTABLE = '/usr/bin/git'

function requireGitExecutable(): string {
  try {
    const stat = fs.statSync(GIT_EXECUTABLE)
    if (!stat.isFile()) throw new Error('not a file')
    // Must be owned by root (uid 0) or current user, not group/world writable
    if ((stat.mode & 0o022) !== 0) throw new Error('Git executable is group/world writable — unsafe')
    return GIT_EXECUTABLE
  } catch (err) {
    throw new SourceManagementError('git_unavailable', `Git executable unavailable at ${GIT_EXECUTABLE}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Git helpers — fixed argument arrays only, no user-interpolated shell strings
// ---------------------------------------------------------------------------

function runGitFixed(cwd: string, args: string[]): string | undefined {
  const gitBin = requireGitExecutable()
  try {
    return execFileSync(gitBin, ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }).trim()
  } catch {
    return undefined
  }
}

function resolveGitPath(cwd: string, rel: string | undefined): string | undefined {
  if (!rel) return undefined
  const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel)
  try { return fs.realpathSync(abs) } catch { return path.resolve(abs) }
}

function hashGroupId(commonDir: string): string {
  return `git:${crypto.createHash('sha1').update(commonDir).digest('hex').slice(0, 16)}`
}

export type GitRepMeta = {
  repoGroupId: string
  repoRoot: string
  branchName: string | undefined
  availableBranches: string[]
  isGitWorktree: boolean
}

export function requireGitRepo(dirPath: string): GitRepMeta {
  const inside = runGitFixed(dirPath, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') throw new SourceManagementError('not_a_git_repo', `Not a Git repository: ${dirPath}`)

  const gitDir = resolveGitPath(dirPath, runGitFixed(dirPath, ['rev-parse', '--git-dir']))
  const commonDir = resolveGitPath(dirPath, runGitFixed(dirPath, ['rev-parse', '--git-common-dir']))
  const repoRoot = resolveGitPath(dirPath, runGitFixed(dirPath, ['rev-parse', '--show-toplevel']))
  if (!commonDir || !repoRoot) throw new SourceManagementError('git_metadata_unavailable', 'Could not read Git metadata')

  const branchName = runGitFixed(dirPath, ['branch', '--show-current']) || undefined
  const branchesOut = runGitFixed(dirPath, ['branch', '--format=%(refname:short)'])
  const availableBranches = branchesOut
    ? Array.from(new Set(branchesOut.split('\n').map(b => b.trim()).filter(Boolean))).slice(0, 200)
    : []

  return {
    repoGroupId: hashGroupId(commonDir),
    repoRoot,
    branchName,
    availableBranches,
    isGitWorktree: Boolean(gitDir && path.resolve(gitDir) !== path.resolve(commonDir))
  }
}

// ---------------------------------------------------------------------------
// Config helpers — atomic write with strict mode enforcement, no ignored failures
// ---------------------------------------------------------------------------

function atomicSaveConfig(config: AgentConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  // Enforce directory permissions — fail if chmod fails
  fs.chmodSync(dir, 0o700)
  const dirStat = fs.statSync(dir)
  if ((dirStat.mode & 0o777) !== 0o700) {
    throw new SourceManagementError('permission_error', `Config directory ${dir} has unexpected permissions: ${(dirStat.mode & 0o777).toString(8)}`)
  }

  const json = JSON.stringify(config, null, 2)
  const tmp = `${configPath}.${process.pid}.tmp`

  // Always clean up tmp on any failure path
  let tmpCreated = false
  try {
    fs.writeFileSync(tmp, json, { mode: 0o600 })
    tmpCreated = true

    // Enforce tmp file permissions — fail if they're wrong
    fs.chmodSync(tmp, 0o600)
    const tmpStat = fs.statSync(tmp)
    if ((tmpStat.mode & 0o777) !== 0o600) {
      throw new SourceManagementError('permission_error', `Temporary config file has unexpected permissions: ${(tmpStat.mode & 0o777).toString(8)}`)
    }

    fs.renameSync(tmp, configPath)
    tmpCreated = false // rename succeeded — tmp no longer exists as tmp

    // Enforce final file permissions — fail if they're wrong
    fs.chmodSync(configPath, 0o600)
    const finalStat = fs.statSync(configPath)
    if ((finalStat.mode & 0o777) !== 0o600) {
      throw new SourceManagementError('permission_error', `Config file has unexpected permissions after write: ${(finalStat.mode & 0o777).toString(8)}`)
    }
  } catch (err) {
    if (tmpCreated) {
      try { fs.unlinkSync(tmp) } catch { /* best-effort cleanup */ }
    }
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to write config: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function loadConfigRequired(): AgentConfig {
  const config = loadConfig()
  if (!config) throw new SourceManagementError('not_initialized', 'Workbench is not initialized. Run: buildflow init')
  return config
}

function getCurrentSources(config: AgentConfig): KnowledgeSourceExt[] {
  return ((config.sources ?? []) as KnowledgeSourceExt[]).map(s => ({
    ...s,
    path: expandTilde(s.path)
  }))
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/

export function validateSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) throw new SourceManagementError('invalid_source_id', `Invalid source ID: "${id}"`)
}

export function requireReadableDirectory(dirPath: string): string {
  if (!fs.existsSync(dirPath)) throw new SourceManagementError('not_found', `Path not found: ${dirPath}`)
  if (!fs.statSync(dirPath).isDirectory()) throw new SourceManagementError('not_a_directory', `Not a directory: ${dirPath}`)
  fs.accessSync(dirPath, fs.constants.R_OK)
  return dirPath
}

export function resolveCanonical(dirPath: string): string {
  try { return fs.realpathSync(dirPath) } catch { return path.resolve(dirPath) }
}

function rejectDuplicatePath(sources: KnowledgeSourceExt[], canonicalPath: string): void {
  const dup = sources.find(s => resolveCanonical(s.path) === canonicalPath)
  if (dup) throw new SourceManagementError('duplicate_path', `A source with path "${canonicalPath}" is already registered (id: ${dup.id})`)
}

function rejectDuplicateId(sources: KnowledgeSourceExt[], id: string): void {
  if (sources.some(s => s.id === id)) throw new SourceManagementError('duplicate_id', `A source with ID "${id}" already exists`)
}

function rejectPathTraversal(input: string): void {
  if (input.includes('..') || input.includes('\0')) throw new SourceManagementError('path_traversal', 'Path contains unsafe sequences')
}

export function safeBranchToDir(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)
  if (!safe || safe === '.' || safe === '..') throw new SourceManagementError('unsafe_branch_name', `Branch name cannot be used as a directory component: "${branch}"`)
  return safe
}

function getManagedWorktreePath(s: KnowledgeSourceExt): string | undefined {
  if (!s.repoGroupId || !s.branchName) return undefined
  const repoDir = s.repoGroupId.replace(/[^a-z0-9]/gi, '_').slice(0, 40)
  try { const d = safeBranchToDir(s.branchName); return path.join(MANAGED_WORKTREES_BASE, repoDir, d) } catch { return undefined }
}

/**
 * Validate that an existing directory is a genuine linked Git worktree
 * belonging to the expected repo group on the expected branch.
 * Rejects stale dirs, wrong repo, wrong branch, plain dirs, and symlink escapes.
 */
function validatePreExistingManagedPath(
  worktreePath: string,
  expectedRepoGroupId: string,
  expectedBranch: string,
  repoRoot: string
): void {
  // Must be a readable directory
  requireReadableDirectory(worktreePath)

  // Must not be a symlink that escapes the managed base
  try {
    const real = fs.realpathSync(worktreePath)
    if (!real.startsWith(MANAGED_WORKTREES_BASE + path.sep) && real !== MANAGED_WORKTREES_BASE) {
      throw new SourceManagementError('path_traversal', `Managed worktree path resolves outside managed base: ${real}`)
    }
  } catch (err) {
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('path_traversal', `Could not resolve managed worktree path: ${worktreePath}`)
  }

  // Must be a valid linked Git worktree — not just any directory
  let meta: GitRepMeta
  try { meta = requireGitRepo(worktreePath) } catch {
    throw new SourceManagementError('not_a_git_repo', `Pre-existing managed path is not a valid Git repository: ${worktreePath}`)
  }
  if (!meta.isGitWorktree) {
    throw new SourceManagementError('not_a_worktree', `Pre-existing managed path is not a linked Git worktree: ${worktreePath}`)
  }

  // Must belong to the expected repo group
  if (meta.repoGroupId !== expectedRepoGroupId) {
    throw new SourceManagementError('repo_group_mismatch', `Pre-existing managed path belongs to a different repository (expected ${expectedRepoGroupId}, got ${meta.repoGroupId})`)
  }

  // Must be on the requested branch
  if (meta.branchName !== expectedBranch) {
    throw new SourceManagementError('branch_mismatch', `Pre-existing managed path is on branch "${meta.branchName}", expected "${expectedBranch}"`)
  }
}

// ---------------------------------------------------------------------------
// Phase 1: inspect repository (read-only)
// ---------------------------------------------------------------------------

export function inspectRepository(inputPath: string): RepositoryInspection {
  rejectPathTraversal(inputPath)
  const expanded = expandTilde(inputPath)
  requireReadableDirectory(expanded)
  const canonical = resolveCanonical(expanded)

  const meta = requireGitRepo(canonical)

  const config = loadConfig()
  const sources = getCurrentSources(config ?? ({} as AgentConfig))
  const existingByPath = sources.find(s => resolveCanonical(s.path) === canonical)

  return {
    path: canonical,
    label: path.basename(meta.repoRoot || canonical),
    ...meta,
    alreadyRegistered: !!existingByPath,
    registeredSourceId: existingByPath?.id
  }
}

// ---------------------------------------------------------------------------
// Phase 1: list source details
// ---------------------------------------------------------------------------

export function listSourceDetails(): SourceDetails[] {
  const config = loadConfig()
  const sources = getCurrentSources(config ?? ({} as AgentConfig))
  return sources.map(s => ({
    ...withSourceIndexState(s),
    isManaged: !!s.isManagedWorktree,
    managedWorktreeDir: s.isManagedWorktree ? getManagedWorktreePath(s) : undefined
  }))
}

// ---------------------------------------------------------------------------
// Phase 2: add repository (hardened with atomic write and rollback)
// ---------------------------------------------------------------------------

export function addRepository(inputPath: string, label?: string, id?: string): AddRepositoryResult {
  rejectPathTraversal(inputPath)
  const config = loadConfigRequired()
  const expanded = expandTilde(inputPath)
  requireReadableDirectory(expanded)
  const canonical = resolveCanonical(expanded)

  const meta = requireGitRepo(canonical)

  const sources = getCurrentSources(config)
  rejectDuplicatePath(sources, canonical)

  const sourceId = id || generateSourceIdFromPath(canonical)
  validateSourceId(sourceId)
  rejectDuplicateId(sources, sourceId)

  const newSource = withSourceDefaults({
    id: sourceId,
    label: label || path.basename(meta.repoRoot || canonical),
    path: canonical,
    enabled: true,
    type: 'repository',
    repoGroupId: meta.repoGroupId,
    repoRoot: meta.repoRoot,
    branchName: meta.branchName,
    availableBranches: meta.availableBranches,
    isGitWorktree: meta.isGitWorktree
  } as KnowledgeSource)

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = [...sources, newSource]
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!config.vaultPath) {
    config.vaultPath = canonical
    atomicSaveConfig(config)
  }

  clearGitMetadataCache(canonical)
  return { sources: listSourceDetails() }
}

// ---------------------------------------------------------------------------
// Phase 2: remove source registration (never deletes repository files)
// ---------------------------------------------------------------------------

export function removeSourceRegistration(sourceId: string): RemoveSourceResult {
  const config = loadConfigRequired()
  const sources = getCurrentSources(config)
  const target = sources.find(s => s.id === sourceId)
  if (!target) throw new SourceManagementError('not_found', `Source not found: ${sourceId}`)

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = sources.filter(s => s.id !== sourceId)
    config.activeSourceIds = (config.activeSourceIds ?? []).filter(id => id !== sourceId)
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  clearGitMetadataCache(target.path)
  return { sources: listSourceDetails() }
}

// ---------------------------------------------------------------------------
// Phase 2: enable / disable source
// ---------------------------------------------------------------------------

export function setSourceEnabledSafe(sourceId: string, enabled: boolean): SetSourceEnabledResult {
  const config = loadConfigRequired()
  const sources = getCurrentSources(config)
  const target = sources.find(s => s.id === sourceId)
  if (!target) throw new SourceManagementError('not_found', `Source not found: ${sourceId}`)

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = sources.map(s => s.id === sourceId ? withSourceDefaults({ ...s, enabled }) : s)
    if (!enabled) config.activeSourceIds = (config.activeSourceIds ?? []).filter(id => id !== sourceId)
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  clearGitMetadataCache(target.path)
  upsertIndexState(sourceId, enabled
    ? { indexed: false, indexStatus: 'pending', indexedFileCount: 0, indexError: undefined, sourceRevision: undefined }
    : { indexed: false, indexStatus: 'disabled', indexError: undefined })
  if (enabled) startSourceReindex(sourceId)
  return { sources: listSourceDetails() }
}

/**
 * Rebuild one enabled source in the native portable host. The operation is
 * intentionally fire-and-observe: XPC must return quickly while the indexer
 * updates the durable index state consumed by the UI and read handlers.
 */
export function startSourceReindex(sourceId: string): ReindexSourceResult {
  const target = getCurrentSources(loadConfigRequired()).find(source => source.id === sourceId)
  if (!target) throw new SourceManagementError('not_found', `Source not found: ${sourceId}`)
  if (!target.enabled) throw new SourceManagementError('invalid_state', `Source is disabled: ${sourceId}`)
  if (!isSourcePathAvailable(target.path)) {
    upsertIndexState(sourceId, { indexed: false, indexStatus: 'failed', indexFailureCode: 'FAILED_IO', indexError: 'source_missing_or_renamed' })
    return { source: { ...withSourceIndexState(target), isManaged: !!target.isManagedWorktree, managedWorktreeDir: target.isManagedWorktree ? getManagedWorktreePath(target) : undefined }, status: 'failed' }
  }

  if (!activeReindexes.has(sourceId)) {
    activeReindexes.add(sourceId)
    upsertIndexState(sourceId, {
      indexed: false,
      indexStatus: 'indexing',
      indexError: undefined,
      indexProgressCompleted: 0,
      indexProgressTotal: 0
    })
    void (async () => {
      try {
        const indexedFileCount = await new Indexer([sourceId], {
          onProgress: progress => setSourceIndexStatus(sourceId, {
            indexed: false,
            indexStatus: 'indexing',
            indexedFileCount: progress.indexed,
            indexProgressCompleted: progress.completed,
            indexProgressTotal: progress.total,
            indexError: undefined
          })
        }).buildIndexForSource(sourceId, target.path)
        setSourceIndexStatus(sourceId, {
          indexed: true,
          indexStatus: 'ready',
          indexedFileCount,
          indexProgressCompleted: indexedFileCount,
          indexProgressTotal: indexedFileCount,
          lastIndexedAt: new Date().toISOString(),
          indexError: undefined
        })
        indexRetryAttempts.delete(sourceId)
      } catch (error) {
        const missing = !fs.existsSync(target.path)
        const attempt = indexRetryAttempts.get(sourceId) ?? 0
        const retryDelayMs = 2 ** attempt * 1000
        const retryScheduled = !missing && attempt < 3
        const indexFailureCode = missing
          ? 'FAILED_IO' as const
          : error instanceof IndexScanError ? error.failureCode : 'FAILED_IO' as const
        setSourceIndexStatus(sourceId, {
          indexed: false,
          indexStatus: 'failed',
          indexFailureCode,
          indexError: missing
            ? 'source_missing_or_renamed'
            : String(error instanceof Error ? error.message : error) + (retryScheduled ? '. Retrying automatically in ' + Math.ceil(retryDelayMs / 1000) + 's.' : '')
        })
        if (retryScheduled) {
          indexRetryAttempts.set(sourceId, attempt + 1)
          setTimeout(() => {
            try {
              if (getCurrentSources(loadConfigRequired()).some(source => source.id === sourceId && source.enabled && isSourcePathAvailable(source.path))) startSourceReindex(sourceId)
            } catch { /* the next discovery/reconciliation will surface the source state */ }
          }, retryDelayMs)
        } else {
          indexRetryAttempts.delete(sourceId)
        }
      } finally {
        activeReindexes.delete(sourceId)
      }
    })()
  }

  // Do not hydrate every configured source here. Full source hydration checks
  // Git HEAD/worktree identity for ready records and can take several seconds
  // when a user has many sources. Reindex admission must return promptly so
  // native status/XPC startup remains responsive.
  const source = {
    ...withSourceIndexState(target),
    isManaged: !!target.isManagedWorktree,
    managedWorktreeDir: target.isManagedWorktree ? getManagedWorktreePath(target) : undefined
  }
  return { source, status: activeReindexes.has(sourceId) ? 'indexing' : (source.indexStatus === 'ready' ? 'ready' : 'failed') }
}

function requiresStartupReconciliation(sourceId: string): boolean {
  const record = getIndexRecord(sourceId)
  if (!record || record.indexStatus !== 'ready' || record.indexed !== true) return true
  if (!record.lastIndexedAt
    || record.indexPolicyVersion !== INDEX_SCAN_POLICY_VERSION
    || record.indexExclusionVersion !== INDEX_SCAN_EXCLUSION_VERSION
    || record.indexPolicyIdentity !== INDEX_SCAN_POLICY_ID
    || !record.sourcePathIdentity) return true

  const current = getSourceIndexBinding(sourceId)
  return !current
    || current.sourcePathIdentity !== record.sourcePathIdentity
    || current.sourceRevision !== record.sourceRevision
    || current.sourceWorktreeIdentity !== record.sourceWorktreeIdentity
}

/** Repair enabled sources whose durable index is pending or stale after host startup. */
export function startPendingSourceReindexes(): void {
  // Startup must use only the persisted source/index records. Calling
  // listSourceDetails() here performs Git identity checks for every ready
  // source, which can starve the native ingress before its first status probe.
  const pending = getCurrentSources(loadConfigRequired())
  void (async () => {
    for (const source of pending) {
      // Yield before each source's binding check and reindex admission. A
      // large configured source set must never monopolize the host event loop
      // immediately after native ingress announces readiness.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (!source.enabled || !requiresStartupReconciliation(source.id)) continue
      if (activeReindexes.has(source.id)) continue
      try {
        startSourceReindex(source.id)
        while (activeReindexes.has(source.id)) await new Promise(resolve => setTimeout(resolve, 50))
      } catch {
        // startSourceReindex records failures in the durable index state; one
        // broken source must not prevent later sources from being repaired.
      }
    }
  })()
}

// ---------------------------------------------------------------------------
// Phase 2: refresh source metadata
// ---------------------------------------------------------------------------

export function refreshSourceMetadata(sourceId: string): RefreshSourceMetadataResult {
  const config = loadConfigRequired()
  const sources = getCurrentSources(config)
  const target = sources.find(s => s.id === sourceId)
  if (!target) throw new SourceManagementError('not_found', `Source not found: ${sourceId}`)

  clearGitMetadataCache(target.path)

  let meta: Partial<GitRepMeta> = {}
  try { meta = requireGitRepo(target.path) } catch { /* non-git source — keep existing metadata */ }
  const metadataChanged = Object.keys(meta).length > 0 && (
    target.repoGroupId !== meta.repoGroupId || target.repoRoot !== meta.repoRoot || target.branchName !== meta.branchName
  )

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = sources.map(s => s.id === sourceId ? withSourceDefaults({ ...s, ...meta }) : s)
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  const updated = listSourceDetails().find(s => s.id === sourceId)
  if (metadataChanged && updated?.enabled) startSourceReindex(sourceId)
  if (!updated) throw new SourceManagementError('internal', `Source disappeared after refresh: ${sourceId}`)
  return { source: updated }
}

// ---------------------------------------------------------------------------
// Phase 3: create Workbench-managed branch worktree and register it
// ---------------------------------------------------------------------------

export function addBranchSource(parentSourceId: string, branchName: string): AddBranchSourceResult {
  if (!branchName || branchName.includes('\0') || branchName.includes('..') || branchName.startsWith('-')) {
    throw new SourceManagementError('invalid_branch_name', `Invalid branch name: "${branchName}"`)
  }
  const config = loadConfigRequired()
  const sources = getCurrentSources(config)
  const parent = sources.find(s => s.id === parentSourceId)
  if (!parent) throw new SourceManagementError('not_found', `Parent source not found: ${parentSourceId}`)
  if (!parent.repoGroupId || !parent.repoRoot) throw new SourceManagementError('not_a_git_repo', 'Parent source is not a Git repository with group metadata')

  // Validate branch against enumerated local branches — no remote, no fetch
  const localBranches = parent.availableBranches ?? []
  if (!localBranches.includes(branchName)) throw new SourceManagementError('unknown_branch', `Branch "${branchName}" is not in the repository's local branch list`)

  // Check for duplicate branch source
  const alreadyExists = sources.find(s => s.repoGroupId === parent.repoGroupId && s.branchName === branchName)
  if (alreadyExists) throw new SourceManagementError('duplicate_branch_source', `A source for branch "${branchName}" already exists (id: ${alreadyExists.id})`)

  // Construct managed worktree path — validate it stays within base dir
  const repoGroupDir = parent.repoGroupId.replace(/[^a-z0-9]/gi, '_').slice(0, 40)
  const branchDir = safeBranchToDir(branchName)
  const worktreePath = path.resolve(path.join(MANAGED_WORKTREES_BASE, repoGroupDir, branchDir))
  if (!worktreePath.startsWith(MANAGED_WORKTREES_BASE + path.sep)) {
    throw new SourceManagementError('path_traversal', 'Constructed worktree path escaped the managed worktrees base')
  }

  // Create parent directories
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true, mode: 0o700 })

  let worktreeCreatedByUs = false
  if (fs.existsSync(worktreePath)) {
    // Pre-existing path: validate it rigorously before reusing
    validatePreExistingManagedPath(worktreePath, parent.repoGroupId, branchName, parent.repoRoot)
  } else {
    // Add worktree using fixed arg array — no --force, no user-controlled shell injection
    const result = runGitFixed(parent.repoRoot, ['worktree', 'add', worktreePath, branchName])
    if (result === undefined && !fs.existsSync(path.join(worktreePath, '.git'))) {
      throw new SourceManagementError('worktree_creation_failed', `Failed to create worktree at ${worktreePath} for branch "${branchName}"`)
    }
    worktreeCreatedByUs = true
  }

  const canonicalWorktree = resolveCanonical(worktreePath)
  rejectDuplicatePath(sources, canonicalWorktree)

  const rawSourceId = `${parentSourceId}-${branchDir}`.slice(0, 64)
  const sourceId = rawSourceId.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  validateSourceId(sourceId)
  rejectDuplicateId(sources, sourceId)

  const branchMeta = (() => { try { return requireGitRepo(canonicalWorktree) } catch { return null } })()

  const newSource: KnowledgeSourceExt = {
    ...withSourceDefaults({
      id: sourceId,
      label: `${parent.label} (${branchName})`,
      path: canonicalWorktree,
      enabled: true,
      type: 'repository',
      repoGroupId: parent.repoGroupId,
      repoRoot: branchMeta?.repoRoot ?? parent.repoRoot,
      branchName,
      availableBranches: branchMeta?.availableBranches ?? localBranches,
      isGitWorktree: true
    } as KnowledgeSource),
    isManagedWorktree: true
  }

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = [...sources, newSource]
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    // Roll back worktree on config write failure — only if we created it, no --force
    if (worktreeCreatedByUs && fs.existsSync(worktreePath)) {
      const rollbackResult = runGitFixed(parent.repoRoot, ['worktree', 'remove', worktreePath])
      if (rollbackResult === undefined && fs.existsSync(worktreePath)) {
        // Cannot cleanly remove — surface structured cleanup-required evidence
        const writeMsg = err instanceof Error ? err.message : String(err)
        throw new SourceManagementError('cleanup_required',
          `Config write failed and worktree rollback failed. Manual cleanup required: ${worktreePath}. Original error: ${writeMsg}`)
      }
    }
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  clearGitMetadataCache(canonicalWorktree)
  return { sources: listSourceDetails() }
}

// ---------------------------------------------------------------------------
// Phase 3: register existing local worktree
// ---------------------------------------------------------------------------

export function registerExistingWorktree(inputPath: string, parentSourceId: string, label?: string): RegisterWorktreeResult {
  rejectPathTraversal(inputPath)
  const config = loadConfigRequired()
  const expanded = expandTilde(inputPath)
  requireReadableDirectory(expanded)
  const canonical = resolveCanonical(expanded)

  const meta = requireGitRepo(canonical)
  if (!meta.isGitWorktree) throw new SourceManagementError('not_a_worktree', `"${canonical}" is not a linked Git worktree`)

  const sources = getCurrentSources(config)
  const parent = sources.find(s => s.id === parentSourceId)
  if (!parent) throw new SourceManagementError('not_found', `Parent source not found: ${parentSourceId}`)
  if (!parent.repoGroupId) throw new SourceManagementError('not_a_git_repo', 'Parent source has no repo group ID')

  if (meta.repoGroupId !== parent.repoGroupId) {
    throw new SourceManagementError('repo_group_mismatch', `The worktree at "${canonical}" belongs to a different repository than "${parentSourceId}"`)
  }

  rejectDuplicatePath(sources, canonical)

  const sourceId = generateSourceIdFromPath(canonical)
  rejectDuplicateId(sources, sourceId)

  const newSource: KnowledgeSourceExt = {
    ...withSourceDefaults({
      id: sourceId,
      label: label || `${parent.label} (${meta.branchName ?? path.basename(canonical)})`,
      path: canonical,
      enabled: true,
      type: 'repository',
      repoGroupId: meta.repoGroupId,
      repoRoot: meta.repoRoot,
      branchName: meta.branchName,
      availableBranches: meta.availableBranches,
      isGitWorktree: true
    } as KnowledgeSource),
    isManagedWorktree: false
  }

  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = [...sources, newSource]
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  clearGitMetadataCache(canonical)
  return { sources: listSourceDetails() }
}

// ---------------------------------------------------------------------------
// Phase 3: remove branch source — transactional, no --force
// ---------------------------------------------------------------------------

export function removeBranchSource(sourceId: string): RemoveBranchSourceResult {
  const config = loadConfigRequired()
  const sources = getCurrentSources(config)
  const target = sources.find(s => s.id === sourceId)
  if (!target) throw new SourceManagementError('not_found', `Source not found: ${sourceId}`)
  if (!target.isGitWorktree) throw new SourceManagementError('not_a_branch_source', `Source "${sourceId}" is not a branch/worktree source`)

  const isManaged = !!target.isManagedWorktree
  const worktreeDir = isManaged ? getManagedWorktreePath(target) : undefined
  const repoRoot = target.repoRoot

  // For managed worktrees: remove worktree first, then atomically remove registration.
  // If worktree removal fails, we never remove registration — no partial state.
  if (isManaged && worktreeDir && fs.existsSync(worktreeDir) && repoRoot) {
    // Attempt worktree removal without --force
    const worktreeRemoveResult = runGitFixed(repoRoot, ['worktree', 'remove', worktreeDir])
    if (fs.existsSync(worktreeDir)) {
      // Worktree still on disk — do NOT remove registration, do NOT force-delete
      return {
        sources: listSourceDetails(),
        registrationRemoved: false,
        worktreeRemoved: false,
        cleanupRequired: true,
        warning: `Worktree removal failed for ${worktreeDir}. Registration preserved. Manual cleanup may be required.`
      }
    }
    // Worktree successfully removed — now atomically remove registration
    const backupSources = config.sources ? [...config.sources] : undefined
    try {
      config.sources = sources.filter(s => s.id !== sourceId)
      config.activeSourceIds = (config.activeSourceIds ?? []).filter(id => id !== sourceId)
      atomicSaveConfig(config)
    } catch (err) {
      config.sources = backupSources
      // Worktree is gone but registration write failed — surface cleanup_required
      if (err instanceof SourceManagementError) throw err
      throw new SourceManagementError('cleanup_required',
        `Worktree removed but registration write failed: ${err instanceof Error ? err.message : String(err)}. Source may need manual deregistration.`)
    }

    // Clean up empty parent dir
    try {
      const parentDir = path.dirname(worktreeDir)
      if (parentDir !== MANAGED_WORKTREES_BASE && fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir)
      }
    } catch { /* best-effort cleanup of empty dirs */ }

    clearGitMetadataCache(target.path)
    return {
      sources: listSourceDetails(),
      registrationRemoved: true,
      worktreeRemoved: true,
      cleanupRequired: false
    }
  }

  // External worktree or no worktree on disk — remove registration only, never delete files
  const backupSources = config.sources ? [...config.sources] : undefined
  try {
    config.sources = sources.filter(s => s.id !== sourceId)
    config.activeSourceIds = (config.activeSourceIds ?? []).filter(id => id !== sourceId)
    atomicSaveConfig(config)
  } catch (err) {
    config.sources = backupSources
    if (err instanceof SourceManagementError) throw err
    throw new SourceManagementError('write_failed', `Failed to save configuration: ${err instanceof Error ? err.message : String(err)}`)
  }

  clearGitMetadataCache(target.path)
  return {
    sources: listSourceDetails(),
    registrationRemoved: true,
    worktreeRemoved: false,
    cleanupRequired: false
  }
}
