import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { getConfigPath, expandTilde } from '../utils/paths'
import type { Workspace, KnowledgeSource, ActiveSourcesMode, WriteMode, DiscoveredRepository, SourceDiscoverySettings, SourceDiscoveryTelemetry } from '@workbench/shared'
import { getIndexRecord, upsertIndexState, type SourceIndexStatus } from './index-state'
import { INDEX_SCAN_EXCLUSION_VERSION, INDEX_SCAN_POLICY_ID, INDEX_SCAN_POLICY_VERSION, type IndexScanFailureCode } from './index-scan-policy'

export const DEFAULT_AUTO_INDEX_ENABLED = false
export const DEFAULT_AUTO_INDEX_INTERVAL_MINUTES = 5
export const MIN_AUTO_INDEX_INTERVAL_MINUTES = 1
export const MAX_AUTO_INDEX_INTERVAL_MINUTES = 60
export const DEFAULT_REPO_DISCOVERY_INTERVAL_MINUTES = 30
export const MIN_REPO_DISCOVERY_INTERVAL_MINUTES = 10
export const MAX_REPO_DISCOVERY_INTERVAL_MINUTES = 60
export const DEFAULT_REPO_DISCOVERY_IGNORE_PATTERNS = ['.git', '.obsidian', 'node_modules', '.next', '.build', 'dist', 'build', 'coverage', '.cache', '.turbo']
export const DEFAULT_REPO_DISCOVERY_TRUST_MODE = 'git_non_symlink' as const
export const MAX_REPO_DISCOVERY_DEPTH = 5
export const MAX_REPO_DISCOVERY_RESULTS = 200
export const MAX_REPO_DISCOVERY_ENTRIES_PER_DIRECTORY = 1000
const GIT_METADATA_TIMEOUT_MS = 1500
const GIT_METADATA_CACHE_TTL_MS = 5 * 60_000

const gitMetadataCache = new Map<string, { data: Partial<KnowledgeSource>; expiresAt: number }>()

export function clearGitMetadataCache(sourcePath?: string): void {
  if (sourcePath) {
    const expanded = expandTilde(sourcePath)
    gitMetadataCache.delete(expanded)
  } else {
    gitMetadataCache.clear()
  }
}

export function normalizeAutoIndexIntervalMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_AUTO_INDEX_INTERVAL_MINUTES
  return Math.min(MAX_AUTO_INDEX_INTERVAL_MINUTES, Math.max(MIN_AUTO_INDEX_INTERVAL_MINUTES, Math.round(numeric)))
}

export type SourceHydrationOptions = {
  refreshGitMetadata?: boolean
  /** Avoid derived index/Git metadata when a caller only needs source roots. */
  includeIndexState?: boolean
  /** Prevent read-only active-source reconciliation from rewriting config. */
  persist?: boolean
}

export function withSourceDefaults(source: KnowledgeSource, options: SourceHydrationOptions = {}): KnowledgeSource {
  const withDefaults = {
    ...source,
    autoIndexEnabled: typeof source.autoIndexEnabled === 'boolean' ? source.autoIndexEnabled : DEFAULT_AUTO_INDEX_ENABLED,
    autoIndexIntervalMinutes: normalizeAutoIndexIntervalMinutes(source.autoIndexIntervalMinutes)
  }
  return options.refreshGitMetadata === false ? withDefaults : withSourceGitMetadata(withDefaults)
}

export interface AgentConfig {
  userId: string
  deviceId: string
  deviceToken: string
  apiBaseUrl: string
  vaultPath?: string
  inboxSourceId?: string
  sources?: KnowledgeSource[]
  activeSourceIds?: string[]
  activeSourcesMode?: ActiveSourcesMode
  writeMode?: WriteMode
  localPort?: number
  sourceDiscovery?: SourceDiscoverySettings
  autoCommitSourceIds?: string[]
  controlledN8nWorkflowGrants?: unknown
  mode: 'read_create_append'
  allowedExtensions: string[]
  ignorePatterns: string[]
  workspaces?: Workspace[]
  autoIndexDefaultMigratedAt?: string
}

export function loadConfig(): AgentConfig | null {
  const configPath = getConfigPath()
  if (!fs.existsSync(configPath)) {
    return null
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const config = JSON.parse(content) as AgentConfig

    // One-time migration: disable auto-index for existing sources (prevent surprise background reindexing)
    // Only run if not already migrated (check for marker: autoIndexDefaultMigratedAt)
    if (config.sources && !config.autoIndexDefaultMigratedAt) {
      let changed = false
      config.sources = config.sources.map(source => {
        if (source.autoIndexEnabled === true) {
          changed = true
          return { ...source, autoIndexEnabled: false }
        }
        return source
      })
      if (changed) {
        console.log('[Config] One-time migration: disabling auto-index for existing sources')
        config.autoIndexDefaultMigratedAt = new Date().toISOString()
        saveConfig(config)
      } else if (config.sources.length > 0) {
        // Mark migration as done even if no changes (avoid repeated checks)
        config.autoIndexDefaultMigratedAt = new Date().toISOString()
        saveConfig(config)
      }
    }

    return config
  } catch (err) {
    return null
  }
}

export function saveConfig(config: AgentConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

function ensureSources(config: AgentConfig, options: SourceHydrationOptions = {}): KnowledgeSource[] {
  if (config.sources !== undefined) {
    return config.sources.map(source => withSourceDefaults(source, options))
  }

  if (config.vaultPath) {
    return [
      withSourceDefaults({
        id: 'vault',
        label: 'Vault',
        path: config.vaultPath,
        enabled: true
      }, options)
    ]
  }

  return []
}

function persistSources(config: AgentConfig, sources: KnowledgeSource[]): void {
  config.sources = sources.map(source => withSourceDefaults(source))
  saveConfig(config)
}

function persistConfig(config: AgentConfig): void {
  saveConfig(config)
}

function getAllConfiguredSources(config: AgentConfig, options: SourceHydrationOptions = {}): KnowledgeSource[] {
  return ensureSources(config, options).map(source => ({
    ...source,
    path: expandTilde(source.path)
  }))
}

/**
 * Cheap fail-closed source availability check used by execution selection.
 * This deliberately does not inspect Git or index state; callers that need
 * those observations must use the bounded source/index health paths.
 */
export function isSourcePathAvailable(sourcePath: string): boolean {
  try {
    return fs.statSync(expandTilde(sourcePath)).isDirectory()
  } catch {
    return false
  }
}

function runGit(sourcePath: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', sourcePath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_METADATA_TIMEOUT_MS
    }).trim()
  } catch {
    return undefined
  }
}

export type SourceIndexBinding = {
  sourceRevision?: string
  sourcePathIdentity?: string
  sourceWorktreeIdentity?: string
  indexPolicyVersion: string
  indexExclusionVersion: string
  indexPolicyIdentity: string
}

function hashSourceIdentity(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/** Bind an index to the canonical source path, Git HEAD/worktree state, and scan policy. */
export function getSourceIndexBinding(sourceId: string): SourceIndexBinding | undefined {
  const config = loadConfig()
  // Binding one source must not hydrate Git metadata for every configured
  // source. This function is used by readiness projection and startup
  // reconciliation, where an N-source metadata sweep can starve native IPC.
  const source = config
    ? getAllConfiguredSources(config, { refreshGitMetadata: false }).find(item => item.id === sourceId)
    : undefined
  if (!source) return undefined
  let canonicalPath = expandTilde(source.path)
  try { canonicalPath = fs.realpathSync(canonicalPath) } catch { /* the scanner will report the precise I/O failure */ }
  const sourceRevision = runGit(source.path, ['rev-parse', 'HEAD'])
  const worktreeStatus = runGit(source.path, ['status', '--porcelain=v1', '--untracked-files=all'])
  return {
    sourceRevision,
    sourcePathIdentity: hashSourceIdentity(canonicalPath),
    sourceWorktreeIdentity: worktreeStatus === undefined ? undefined : hashSourceIdentity(`${canonicalPath}\n${sourceRevision || ''}\n${worktreeStatus}`),
    indexPolicyVersion: INDEX_SCAN_POLICY_VERSION,
    indexExclusionVersion: INDEX_SCAN_EXCLUSION_VERSION,
    indexPolicyIdentity: INDEX_SCAN_POLICY_ID
  }
}

function resolveGitPath(sourcePath: string, gitPath: string | undefined): string | undefined {
  if (!gitPath) return undefined
  const resolved = path.isAbsolute(gitPath) ? gitPath : path.resolve(sourcePath, gitPath)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return path.resolve(resolved)
  }
}

function hashRepoGroupId(commonDir: string): string {
  return `git:${crypto.createHash('sha1').update(commonDir).digest('hex').slice(0, 16)}`
}

function getGitSourceMetadata(sourcePath: string): Pick<KnowledgeSource, 'repoGroupId' | 'repoRoot' | 'branchName' | 'availableBranches' | 'isGitWorktree'> {
  const expanded = expandTilde(sourcePath)
  if (!expanded) return {}

  const now = Date.now()
  const cached = gitMetadataCache.get(expanded)
  if (cached && now < cached.expiresAt) {
    return cached.data
  }

  if (!fs.existsSync(expanded)) return {}
  try {
    if (!fs.statSync(expanded).isDirectory()) return {}
  } catch {
    return {}
  }

  const insideWorkTree = runGit(expanded, ['rev-parse', '--is-inside-work-tree'])
  if (insideWorkTree !== 'true') {
    gitMetadataCache.set(expanded, { data: {}, expiresAt: now + GIT_METADATA_CACHE_TTL_MS })
    return {}
  }

  const gitDir = resolveGitPath(expanded, runGit(expanded, ['rev-parse', '--git-dir']))
  const commonDir = resolveGitPath(expanded, runGit(expanded, ['rev-parse', '--git-common-dir']))
  const repoRoot = resolveGitPath(expanded, runGit(expanded, ['rev-parse', '--show-toplevel']))
  if (!commonDir || !repoRoot) {
    gitMetadataCache.set(expanded, { data: {}, expiresAt: now + GIT_METADATA_CACHE_TTL_MS })
    return {}
  }

  const branchName = runGit(expanded, ['branch', '--show-current']) || runGit(expanded, ['rev-parse', '--short', 'HEAD'])
  const branchesOutput = runGit(expanded, ['branch', '--format=%(refname:short)'])
  const availableBranches = branchesOutput
    ? Array.from(new Set(branchesOutput.split('\n').map(item => item.trim()).filter(Boolean))).slice(0, 200)
    : undefined

  const result = {
    repoGroupId: hashRepoGroupId(commonDir),
    repoRoot,
    ...(branchName ? { branchName } : {}),
    ...(availableBranches && availableBranches.length > 0 ? { availableBranches } : {}),
    isGitWorktree: Boolean(gitDir && path.resolve(gitDir) !== path.resolve(commonDir))
  }

  gitMetadataCache.set(expanded, { data: result, expiresAt: now + GIT_METADATA_CACHE_TTL_MS })
  return result
}

function withSourceGitMetadata(source: KnowledgeSource): KnowledgeSource {
  return {
    ...source,
    ...getGitSourceMetadata(source.path)
  }
}

function sourceGroupIdsForSelection(sources: KnowledgeSource[], selectedIds: string[]): Set<string> {
  const selected = new Set(selectedIds)
  const selectedGroupIds = new Set<string>()
  for (const source of sources) {
    if (!selected.has(source.id)) continue
    if (source.repoGroupId) selectedGroupIds.add(source.repoGroupId)
  }
  return selectedGroupIds
}

function expandSourceIdsToBranchGroups(sources: KnowledgeSource[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds)
  const selectedGroupIds = sourceGroupIdsForSelection(sources, selectedIds)
  const expanded: string[] = []
  for (const source of sources) {
    if (selected.has(source.id) || (source.repoGroupId && selectedGroupIds.has(source.repoGroupId))) {
      expanded.push(source.id)
    }
  }
  return Array.from(new Set(expanded))
}

function getRepoGroupSourceIds(sources: KnowledgeSource[], sourceId: string): string[] {
  const source = sources.find(item => item.id === sourceId)
  if (!source) return []
  if (!source.repoGroupId) return [source.id]
  return sources.filter(item => item.repoGroupId === source.repoGroupId).map(item => item.id)
}

function getSourceIndexStatus(source: KnowledgeSource): {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  indexProgressCompleted?: number
  indexProgressTotal?: number
  lastIndexedAt?: string
  discoveredAt?: string
  queuedAt?: string
  indexingAt?: string
  readyAt?: string
  indexError?: string
  indexFailureCode?: IndexScanFailureCode
  sourceRevision?: string
  sourcePathIdentity?: string
  sourceWorktreeIdentity?: string
  indexPolicyVersion?: string
  indexExclusionVersion?: string
  indexPolicyIdentity?: string
} {
  const record = getIndexRecord(source.id)
  if (source.enabled === false) {
    return {
      indexed: false,
      indexStatus: 'disabled',
      indexedFileCount: record?.indexedFileCount,
      lastIndexedAt: record?.lastIndexedAt,
      indexError: record?.indexError,
      indexFailureCode: record?.indexFailureCode
    }
  }
  if (record) {
    if (record.indexStatus === 'disabled') {
      return {
        indexed: false,
        indexStatus: 'pending',
        indexedFileCount: 0,
        indexError: undefined,
        sourceRevision: undefined
      }
    }
    const policyBindingMissing = record.indexPolicyVersion !== INDEX_SCAN_POLICY_VERSION
      || record.indexExclusionVersion !== INDEX_SCAN_EXCLUSION_VERSION
      || record.indexPolicyIdentity !== INDEX_SCAN_POLICY_ID
      || !record.sourcePathIdentity
    if (record.indexStatus === 'ready') {
      if (!record.lastIndexedAt) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexError: 'Index completion timestamp is missing; rebuild the source index.'
        }
      }

      const currentBinding = getSourceIndexBinding(source.id)
      const currentRevision = currentBinding?.sourceRevision
      const looksLikeGitSource = Boolean(currentRevision || source.repoRoot || source.branchName || source.isGitWorktree)
      if (looksLikeGitSource && !currentRevision) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexFailureCode: 'FAILED_IO',
          indexError: 'Unable to verify source HEAD; rebuild after Git becomes available.'
        }
      }
      if (currentRevision && !record.sourceRevision) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexFailureCode: 'RECONCILIATION_REQUIRED',
          indexError: 'Indexed source revision is missing; rebuild the source index.'
        }
      }
      if (currentBinding?.sourcePathIdentity && record.sourcePathIdentity !== currentBinding.sourcePathIdentity) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexFailureCode: 'RECONCILIATION_REQUIRED',
          indexError: 'Canonical source path changed after the last completed index.'
        }
      }
      if (record.sourceRevision && currentRevision && record.sourceRevision !== currentRevision) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexFailureCode: 'RECONCILIATION_REQUIRED',
          indexError: 'Source HEAD changed after the last completed index.'
        }
      }
      if (currentBinding?.sourceWorktreeIdentity && record.sourceWorktreeIdentity !== currentBinding.sourceWorktreeIdentity) {
        return {
          ...record,
          indexed: false,
          indexStatus: 'pending',
          indexFailureCode: 'RECONCILIATION_REQUIRED',
          indexError: 'Source worktree changed after the last completed index.'
        }
      }
    }
    if (policyBindingMissing && record.indexStatus !== 'indexing') {
      return {
        ...record,
        indexed: false,
        indexStatus: 'pending',
        indexFailureCode: 'STALE_POLICY',
        indexError: 'Index policy changed; automatic source reconciliation is scheduled.'
      }
    }
    return record
  }
  return {
    indexed: false,
    indexStatus: 'unknown'
  }
}

export function withSourceIndexState(source: KnowledgeSource): KnowledgeSource & {
  indexed?: boolean
  indexStatus: SourceIndexStatus
  indexedFileCount?: number
  indexProgressCompleted?: number
  indexProgressTotal?: number
  lastIndexedAt?: string
  discoveredAt?: string
  queuedAt?: string
  indexingAt?: string
  readyAt?: string
  indexError?: string
  indexFailureCode?: IndexScanFailureCode
  sourceRevision?: string
  sourcePathIdentity?: string
  sourceWorktreeIdentity?: string
  indexPolicyVersion?: string
  indexExclusionVersion?: string
  indexPolicyIdentity?: string
} {
  return { ...source, ...getSourceIndexStatus(source) }
}

export function getSourceIndexState(sourceId: string): ReturnType<typeof getSourceIndexStatus> | null {
  const sources = getAllConfiguredSources(loadConfig() ?? ({} as AgentConfig))
  const source = sources.find(item => item.id === sourceId)
  if (!source) return null
  return getSourceIndexStatus(source)
}

export function reconcileActiveSources(config: AgentConfig, options: SourceHydrationOptions = {}): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const allSources = getAllConfiguredSources(config, options)
  const enabledSources = allSources.filter(source => source.enabled && isSourcePathAvailable(source.path))
  const enabledIds = new Set(enabledSources.map(source => source.id))
  const currentMode = config.activeSourcesMode || 'all'
  const currentActiveIds = Array.from(new Set((config.activeSourceIds || []).filter(id => typeof id === 'string' && id.length > 0)))
  const filteredActiveIds = currentActiveIds.filter(id => enabledIds.has(id))

  let nextMode: ActiveSourcesMode = currentMode
  let nextActiveIds: string[] = []

  if (enabledSources.length === 0) {
    nextMode = 'all'
    nextActiveIds = []
  } else if (currentMode === 'all') {
    nextActiveIds = enabledSources.map(source => source.id)
  } else if (currentMode === 'single') {
    nextActiveIds = filteredActiveIds.slice(0, 1)
    if (nextActiveIds.length === 0) {
      nextActiveIds = [enabledSources[0].id]
    }
    nextActiveIds = expandSourceIdsToBranchGroups(enabledSources, nextActiveIds)
    if (nextActiveIds.length > 1) {
      nextMode = 'multi'
    }
  } else {
    nextActiveIds = expandSourceIdsToBranchGroups(enabledSources, filteredActiveIds)
    if (nextActiveIds.length === 0) {
      nextMode = 'all'
      nextActiveIds = enabledSources.map(source => source.id)
    }
  }

  config.activeSourcesMode = nextMode
  config.activeSourceIds = nextActiveIds
  if (options.persist !== false) persistConfig(config)

  const activeIds = new Set(nextActiveIds)
  const hydrated = allSources.map(source => ({ ...withSourceIndexState(source), active: source.enabled && isSourcePathAvailable(source.path) && activeIds.has(source.id) } as KnowledgeSource & { active?: boolean }))
  return { mode: nextMode, activeSourceIds: nextActiveIds, sources: hydrated }
}

export function generateSourceIdFromPath(sourcePath: string): string {
  return path.basename(sourcePath).toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

function normalizeDiscoveryIntervalMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_REPO_DISCOVERY_INTERVAL_MINUTES
  return Math.min(MAX_REPO_DISCOVERY_INTERVAL_MINUTES, Math.max(MIN_REPO_DISCOVERY_INTERVAL_MINUTES, Math.round(numeric)))
}

function normalizeDiscoveryPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_REPO_DISCOVERY_IGNORE_PATTERNS]
  return Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim()).slice(0, 50)))
}

function normalizeDiscoveryNamingPattern(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid discovery namingPattern')
  try { new RegExp(value) } catch { throw new Error('Invalid discovery namingPattern') }
  return value
}

function canonicalDiscoveryDirectory(input: string, label: string): string {
  const expanded = expandTilde(input.trim())
  if (!expanded || expanded.includes('\0')) throw new Error(`Invalid discovery ${label}`)
  const stat = fs.lstatSync(expanded)
  if (stat.isSymbolicLink()) throw new Error(`Discovery ${label} must not be a symlink`)
  if (!stat.isDirectory()) throw new Error(`Discovery ${label} is not a directory`)
  fs.accessSync(expanded, fs.constants.R_OK)
  return fs.realpathSync(expanded)
}

function isWithinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function canonicalConfiguredSourcePath(sourcePath: string): string {
  const expanded = expandTilde(sourcePath)
  try { return fs.realpathSync(expanded) } catch { return path.resolve(expanded) }
}

function normalizeDiscoveryAllowedRoots(value: unknown, fallbackRoot?: string): string[] {
  const raw = Array.isArray(value) ? value : (fallbackRoot ? [fallbackRoot] : [])
  return Array.from(new Set(raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => canonicalDiscoveryDirectory(item, 'allowed root')))).slice(0, 20)
}

function matchesDiscoveryPattern(value: string, pattern: string): boolean {
  const normalizedValue = value.split(path.sep).join('/')
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/\/\*\*?$/, '').replace(/^\.\//, '')
  const regex = new RegExp(`^${normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return regex.test(normalizedValue) || regex.test(path.basename(normalizedValue))
}

function isIgnoredDiscoveryPath(root: string, candidate: string, patterns: string[]): boolean {
  const relative = path.relative(root, candidate)
  return relative.split(path.sep).some(segment => patterns.some(pattern => matchesDiscoveryPattern(segment, pattern))) || patterns.some(pattern => matchesDiscoveryPattern(relative, pattern))
}

function prettifyRepoLabel(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase()) || name
}

export function getSourceDiscoverySettings(): SourceDiscoverySettings {
  const config = loadConfig()
  const configuredRoot = config?.sourceDiscovery?.rootPath
  const allowedRoots = normalizeDiscoveryAllowedRoots(config?.sourceDiscovery?.allowedRoots, configuredRoot)
  return {
    rootPath: configuredRoot ? canonicalDiscoveryDirectory(configuredRoot, 'root') : undefined,
    ...(allowedRoots.length ? { allowedRoots } : {}),
    ignorePatterns: normalizeDiscoveryPatterns(config?.sourceDiscovery?.ignorePatterns),
    ...(normalizeDiscoveryNamingPattern(config?.sourceDiscovery?.namingPattern) ? { namingPattern: normalizeDiscoveryNamingPattern(config?.sourceDiscovery?.namingPattern) } : {}),
    trustMode: DEFAULT_REPO_DISCOVERY_TRUST_MODE,
    intervalMinutes: normalizeDiscoveryIntervalMinutes(config?.sourceDiscovery?.intervalMinutes),
    lastScannedAt: config?.sourceDiscovery?.lastScannedAt
  }
}

export function setSourceDiscoverySettings(settings: { rootPath?: string; allowedRoots?: string[]; ignorePatterns?: string[]; namingPattern?: string; intervalMinutes?: number; lastScannedAt?: string }): SourceDiscoverySettings {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  const current = getSourceDiscoverySettings()
  const rootPath = settings.rootPath !== undefined ? canonicalDiscoveryDirectory(settings.rootPath, 'root') : current.rootPath
  const requestedRootReplacesAllowlist = settings.rootPath !== undefined && settings.allowedRoots === undefined
  const allowedRoots = normalizeDiscoveryAllowedRoots(requestedRootReplacesAllowlist ? [rootPath] : (settings.allowedRoots ?? current.allowedRoots), rootPath)
  if (rootPath && !allowedRoots.some(allowedRoot => isWithinDirectory(rootPath, allowedRoot))) throw new Error('Discovery root must be within an allowed root')
  config.sourceDiscovery = {
    ...(rootPath ? { rootPath } : {}),
    ...(allowedRoots.length ? { allowedRoots } : {}),
    ignorePatterns: normalizeDiscoveryPatterns(settings.ignorePatterns ?? current.ignorePatterns),
    ...(normalizeDiscoveryNamingPattern(settings.namingPattern ?? current.namingPattern) ? { namingPattern: normalizeDiscoveryNamingPattern(settings.namingPattern ?? current.namingPattern) } : {}),
    trustMode: DEFAULT_REPO_DISCOVERY_TRUST_MODE,
    intervalMinutes: normalizeDiscoveryIntervalMinutes(settings.intervalMinutes ?? current.intervalMinutes),
    ...(settings.lastScannedAt || current.lastScannedAt ? { lastScannedAt: settings.lastScannedAt ?? current.lastScannedAt } : {})
  }
  saveConfig(config)
  return getSourceDiscoverySettings()
}

export function discoverRepositories(rootPathInput?: string): { settings: SourceDiscoverySettings; repositories: DiscoveredRepository[]; telemetry: SourceDiscoveryTelemetry } {
  const settings = rootPathInput ? setSourceDiscoverySettings({ rootPath: rootPathInput }) : getSourceDiscoverySettings()
  if (!settings.rootPath) return { settings, repositories: [], telemetry: { entriesExamined: 0, maxDepth: 0, resultsEmitted: 0, terminationReason: 'completed' } }
  const rootPath = expandTilde(settings.rootPath)
  const displayRootPath = rootPathInput ? path.resolve(expandTilde(rootPathInput.trim())) : rootPath
  const allowedRoots = settings.allowedRoots ?? [rootPath]
  if (!allowedRoots.some(allowedRoot => isWithinDirectory(rootPath, allowedRoot))) throw new Error('Discovery root is outside the allowed roots')
  const configured = getSourcesSafe()
  const configuredByPath = new Map(configured.map(source => [canonicalConfiguredSourcePath(source.path), source]))
  const repositories: DiscoveredRepository[] = []
  const seen = new Set<string>()
  const namingPattern = settings.namingPattern ? new RegExp(settings.namingPattern) : undefined
  let entriesExamined = 0
  let maxDepth = 0
  let terminationReason: SourceDiscoveryTelemetry['terminationReason'] = 'completed'

  const walk = (current: string, depth: number) => {
    maxDepth = Math.max(maxDepth, depth)
    if (depth > MAX_REPO_DISCOVERY_DEPTH || repositories.length >= MAX_REPO_DISCOVERY_RESULTS) return
    if (isIgnoredDiscoveryPath(rootPath, current, settings.ignorePatterns ?? DEFAULT_REPO_DISCOVERY_IGNORE_PATTERNS)) return
    let entries: fs.Dirent[] = []
    try {
      const directory = fs.opendirSync(current)
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        entriesExamined += 1
        entries.push(entry)
        if (entries.length > MAX_REPO_DISCOVERY_ENTRIES_PER_DIRECTORY) {
          terminationReason = 'entries_limit'
          break
        }
      }
      directory.closeSync()
      entries.sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    let gitEntry: fs.Dirent | undefined
    try {
      const gitStat = fs.lstatSync(path.join(current, '.git'))
      if (gitStat.isDirectory() || gitStat.isFile()) gitEntry = { name: '.git', isDirectory: () => gitStat.isDirectory(), isFile: () => gitStat.isFile(), isSymbolicLink: () => false } as fs.Dirent
    } catch { /* not a repository */ }
    if (gitEntry) {
      const resolved = fs.realpathSync(current)
      if (namingPattern && !namingPattern.test(path.basename(resolved))) return
      if (!seen.has(resolved)) {
        seen.add(resolved)
        const relativePath = path.relative(rootPath, resolved) || path.basename(resolved)
        const [account = 'Root'] = relativePath.split(path.sep)
        const existing = configuredByPath.get(resolved)
        const gitMetadata = getGitSourceMetadata(resolved)
        repositories.push({
          path: resolved,
          label: prettifyRepoLabel(path.basename(resolved)),
          id: `${generateSourceIdFromPath(account)}-${generateSourceIdFromPath(resolved)}`,
          account,
          relativePath,
          ...gitMetadata,
          alreadyAdded: !!existing,
          sourceId: existing?.id,
          ...(existing ? { enabled: existing.enabled } : {}),
          trustStatus: 'trusted'
        })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      walk(path.join(current, entry.name), depth + 1)
    }
  }

  walk(rootPath, 0)
  const nextSettings = setSourceDiscoverySettings({ rootPath, intervalMinutes: settings.intervalMinutes, lastScannedAt: new Date().toISOString() })
  return {
    settings: nextSettings,
    repositories: repositories.sort((a, b) => `${a.account}/${a.label}`.localeCompare(`${b.account}/${b.label}`)),
    telemetry: { entriesExamined, maxDepth, resultsEmitted: repositories.length, terminationReason: repositories.length >= MAX_REPO_DISCOVERY_RESULTS ? 'result_limit' : terminationReason }
  }
}

export function getSources(): KnowledgeSource[] {
  const config = loadConfig()
  const sources = ensureSources(config ?? ({} as AgentConfig))
  if (sources.length === 0 && !(config && config.sources !== undefined)) {
    throw new Error('No knowledge sources configured. Run: buildflow connect <folder>')
  }

  return sources.map(s => withSourceIndexState({
    ...s,
    path: expandTilde(s.path)
  }))
}

export function getSourcesSafe(options: SourceHydrationOptions = {}): KnowledgeSource[] {
  const config = loadConfig()
  const sources = ensureSources(config ?? ({} as AgentConfig), options)

  return sources.map(s => {
    const hydrated = { ...s, path: expandTilde(s.path) }
    return options.includeIndexState === false ? hydrated : withSourceIndexState(hydrated)
  })
}

export function getEnabledSources(options: SourceHydrationOptions = {}): KnowledgeSource[] {
  if (options.includeIndexState === false) {
    const config = loadConfig()
    return ensureSources(config ?? ({} as AgentConfig), options).filter(source => isSourcePathAvailable(source.path))
      .map(source => ({ ...source, path: expandTilde(source.path) }))
      .filter(s => s.enabled)
  }
  return getSources().filter(s => s.enabled && isSourcePathAvailable(s.path))
}

export function getActiveSourceContext(options: SourceHydrationOptions = {}): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const config = loadConfig()
  if (!config) {
    return { mode: 'all', activeSourceIds: [], sources: [] }
  }

  return reconcileActiveSources(config, { ...options, persist: false })
}

export function setActiveSourceContext(mode: ActiveSourcesMode, activeSourceIds: string[] = []): { mode: ActiveSourcesMode; activeSourceIds: string[]; sources: KnowledgeSource[] } {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  const sources = getEnabledSources()
  const ids = new Set(sources.map(s => s.id))
  const uniqueIds = Array.from(new Set(activeSourceIds.filter(id => typeof id === 'string' && id.length > 0)))
  const invalidIds = uniqueIds.filter(id => !ids.has(id))
  if (invalidIds.length > 0) {
    throw new Error(`Unknown or disabled sourceId(s): ${invalidIds.join(', ')}`)
  }
  if (mode === 'single' && uniqueIds.length !== 1) throw new Error('single mode requires exactly one activeSourceId')
  if (mode === 'multi' && uniqueIds.length === 0) throw new Error('multi mode requires one or more activeSourceIds')
  const expandedIds = mode === 'all' ? sources.map(s => s.id) : expandSourceIdsToBranchGroups(sources, uniqueIds)
  const nextMode = mode === 'single' && expandedIds.length > 1 ? 'multi' : mode
  config.activeSourcesMode = nextMode
  config.activeSourceIds = nextMode === 'all' ? sources.map(s => s.id) : expandedIds
  persistConfig(config)
  return reconcileActiveSources(config)
}

export function getWriteMode(): WriteMode {
  const config = loadConfig()
  return config?.writeMode || 'safeWrites'
}

export function setWriteMode(writeMode: WriteMode): WriteMode {
  const config = loadConfig()
  if (!config) throw new Error('Please run: buildflow init')
  config.writeMode = writeMode
  persistConfig(config)
  return getWriteMode()
}

export function addSource(pathInput: string, label?: string, id?: string): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  if (!pathInput) {
    throw new Error('Knowledge source path required')
  }

  const expanded = expandTilde(pathInput)
  if (!fs.existsSync(expanded)) {
    throw new Error(`Knowledge source folder not found: ${expanded}`)
  }
  if (!fs.statSync(expanded).isDirectory()) {
    throw new Error(`Not a directory: ${expanded}`)
  }
  fs.accessSync(expanded, fs.constants.R_OK)

  const sources = ensureSources(config)
  const sourceId = id || generateSourceIdFromPath(expanded)
  if (sources.some(source => source.id === sourceId)) {
    throw new Error(`Knowledge source with ID "${sourceId}" already exists`)
  }

  sources.push(withSourceDefaults({
    id: sourceId,
    label: label || path.basename(expanded),
    path: expanded,
    enabled: true,
    type: 'unknown'
  }))

  persistSources(config, sources)
  upsertIndexState(sourceId, { indexed: false, indexStatus: 'pending', discoveredAt: new Date().toISOString() })
  if (!config.vaultPath) {
    config.vaultPath = expanded
  }
  saveConfig(config)

  return getSources()
}

export function removeSource(sourceId: string): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  const nextSources = sources.filter(source => source.id !== sourceId)
  if (nextSources.length === sources.length) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  return getSources()
}

export function setSourceEnabled(sourceId: string, enabled: boolean): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  const sourceIdsToToggle = getRepoGroupSourceIds(sources, sourceId)
  const sourceIdSet = new Set(sourceIdsToToggle)
  const nextSources = sources.map(source => {
    if (!sourceIdSet.has(source.id)) {
      return source
    }

    return withSourceDefaults({ ...source, enabled })
  })

  if (sourceIdsToToggle.length === 0) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  for (const toggledSourceId of sourceIdsToToggle) {
    if (enabled) {
      upsertIndexState(toggledSourceId, {
        indexed: false,
        indexStatus: 'pending',
        indexedFileCount: 0,
        indexError: undefined
      })
    } else {
      upsertIndexState(toggledSourceId, {
        indexed: false,
        indexStatus: 'disabled',
        indexError: undefined
      })
    }
  }
  return reconcileActiveSources(config).sources
}

export function setSourceAutoIndex(sourceId: string, settings: { enabled?: boolean; intervalMinutes?: number }): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  let found = false
  const nextSources = sources.map(source => {
    if (source.id !== sourceId) return source
    found = true
    return withSourceDefaults({
      ...source,
      autoIndexEnabled: typeof settings.enabled === 'boolean' ? settings.enabled : source.autoIndexEnabled,
      autoIndexIntervalMinutes: settings.intervalMinutes === undefined ? source.autoIndexIntervalMinutes : normalizeAutoIndexIntervalMinutes(settings.intervalMinutes)
    })
  })

  if (!found) {
    throw new Error(`Knowledge source not found: ${sourceId}`)
  }

  persistSources(config, nextSources)
  return reconcileActiveSources(config).sources
}

export function markSourceAutoIndexed(sourceId: string, timestamp = new Date().toISOString()): KnowledgeSource[] {
  const config = loadConfig()
  if (!config) {
    throw new Error('Please run: buildflow init')
  }

  const sources = ensureSources(config)
  let changed = false
  const nextSources = sources.map(source => {
    if (source.id !== sourceId) return source
    changed = true
    return withSourceDefaults({ ...source, lastAutoIndexedAt: timestamp })
  })

  if (changed) {
    persistSources(config, nextSources)
  }

  return getSourcesSafe()
}

export function setSourceIndexStatus(
  sourceId: string,
  record: {
    indexed?: boolean
    indexStatus: SourceIndexStatus
    indexedFileCount?: number
    indexProgressCompleted?: number
    indexProgressTotal?: number
    lastIndexedAt?: string
    indexError?: string
    indexFailureCode?: IndexScanFailureCode
    sourceRevision?: string
    sourcePathIdentity?: string
    sourceWorktreeIdentity?: string
    indexPolicyVersion?: string
    indexExclusionVersion?: string
    indexPolicyIdentity?: string
    discoveredAt?: string
    queuedAt?: string
    indexingAt?: string
    readyAt?: string
  }
): void {
  // Binding is needed at completion (and at a terminal failure), not for each
  // progress tick. Avoiding Git status work on every 25-file callback keeps
  // foreground indexing responsive.
  const binding = record.indexStatus === 'ready' || record.indexStatus === 'failed'
    ? getSourceIndexBinding(sourceId)
    : undefined
  upsertIndexState(sourceId, {
    ...record,
    ...(binding || {}),
    ...(record.indexStatus === 'ready' && record.lastIndexedAt ? { sourceRevision: binding?.sourceRevision } : {})
  })
}

export function markSourceIndexPending(sourceId: string): void {
  upsertIndexState(sourceId, {
    indexed: false,
    indexStatus: 'pending',
    indexedFileCount: 0,
    indexError: undefined,
    queuedAt: new Date().toISOString()
  })
}

export function getVaultPath(): string {
  const config = loadConfig()
  if (!config?.vaultPath) {
    throw new Error('No vault path configured. Run: buildflow connect <folder>')
  }

  return expandTilde(config.vaultPath)
}

export function getInboxSourceId(): string {
  const config = loadConfig()
  return config?.inboxSourceId || 'mind'
}

export function getLocalPort(): number {
  const config = loadConfig()
  return config?.localPort ?? 3052
}

export function getWorkspaces(): Workspace[] {
  const config = loadConfig()
  if (config?.workspaces && config.workspaces.length > 0) {
    return config.workspaces
  }

  if (config?.vaultPath) {
    return [
      {
        name: 'vault',
        root: config.vaultPath,
        mode: 'default'
      }
    ]
  }

  return []
}

export function getWorkspace(name: string): Workspace | null {
  const workspaces = getWorkspaces()
  return workspaces.find(ws => ws.name === name) ?? null
}
