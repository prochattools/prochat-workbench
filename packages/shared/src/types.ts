export type SearchResult = {
  sourceId: string
  path: string
  title: string
  score: number
  snippet: string
  modifiedAt: string
  sizeBytes?: number
}

export type FileContent = {
  sourceId?: string
  path: string
  content: string
  truncated?: boolean
  sizeBytes?: number
  modifiedAt?: string
  error?: string
}

export type FileCreated = {
  sourceId?: string
  path: string
  created: boolean
  verified: boolean
  verifiedAt: string
  bytesOnDisk: number
  contentHash: string
  contentPreview: string
}

export type FileAppended = {
  sourceId?: string
  path: string
  appended: boolean
  verified: boolean
  verifiedAt: string
  bytesOnDisk: number
  contentHash: string
  contentPreview: string
}

export type IndexedDoc = {
  sourceId: string
  id: string
  path: string
  title: string
  extension: string
  modifiedAt: string
  size: number
  tags: string[]
  contentPreview: string
  content: string
}

export type KnowledgeSource = {
  id: string
  label: string
  path: string
  enabled: boolean
  type?: string
  repoGroupId?: string
  repoRoot?: string
  branchName?: string
  availableBranches?: string[]
  isGitWorktree?: boolean
  isManagedWorktree?: boolean
  active?: boolean
  indexed?: boolean
  indexStatus?: 'ready' | 'pending' | 'indexing' | 'failed' | 'disabled' | 'unknown'
  indexedFileCount?: number
  indexProgressCompleted?: number
  indexProgressTotal?: number
  lastIndexedAt?: string
  indexError?: string
  indexFailureCode?: 'FAILED_DEPTH' | 'FAILED_BUDGET' | 'FAILED_IO' | 'STALE_POLICY' | 'RECONCILIATION_REQUIRED'
  autoIndexEnabled?: boolean
  autoIndexIntervalMinutes?: number
  lastAutoIndexedAt?: string
  writePolicy?: Record<string, unknown>
}

export type DiscoveredRepository = {
  path: string
  label: string
  id: string
  account: string
  relativePath: string
  repoGroupId?: string
  repoRoot?: string
  branchName?: string
  availableBranches?: string[]
  isGitWorktree?: boolean
  alreadyAdded?: boolean
  sourceId?: string
  enabled?: boolean
  trustStatus?: 'trusted'
}

export type SourceDiscoverySettings = {
  rootPath?: string
  allowedRoots?: string[]
  ignorePatterns?: string[]
  namingPattern?: string
  trustMode?: 'git_non_symlink'
  intervalMinutes: number
  lastScannedAt?: string
}

export type SourceDiscoveryTelemetry = {
  entriesExamined: number
  maxDepth: number
  resultsEmitted: number
  terminationReason: 'completed' | 'depth_limit' | 'entries_limit' | 'result_limit'
}

export type ActiveSourcesMode = 'single' | 'multi' | 'all'
export type WriteMode = 'readOnly' | 'artifactsOnly' | 'safeWrites'

export type ToolCallMessage = {
  id: string
  tool: string
  input: Record<string, unknown>
}

export type ToolResponseMessage = {
  id: string
  status: 'success' | 'error'
  result?: Record<string, unknown>
  error?: string
}

export type Device = {
  id: string
  userId: string
  name: string
  deviceToken: string
  status: 'online' | 'offline'
  lastSeenAt?: string
  createdAt: string
}

export type User = {
  id: string
  email: string
  apiKey: string
  createdAt: string
}

export type Workspace = {
  name: string
  root: string
  mode: 'read_only' | 'default'
  includePatterns?: string[]
  excludePatterns?: string[]
}

export type WorkspaceConfiguration = {
  schemaVersion: 1
  workspaces: WorkspaceConfigurationEntry[]
  knowledgeProviders: ConfiguredProvider[]
  capabilityProviders: ConfiguredProvider[]
}

export type WorkspaceConfigurationEntry = Workspace & {
  workspaceId: string
  enabled: boolean
}

export type ConfiguredProvider = {
  providerId: string
  manifestPath: string
  enabled: boolean
  ownerType: 'user' | 'workspace' | 'organization'
  ownerId: string
}

export type TreeNode = {
  name: string
  type: 'file' | 'directory'
  path: string
  size?: number
  modifiedAt?: string
}

export type GrepMatch = {
  file: string
  line: number
  content: string
  context?: string
}

export type ContextAssembly = {
  workspace: string
  summary: string
  tree: TreeNode[]
  docs: SearchResult[]
  entrypoints: string[]
  keyFiles: FileContent[]
}
