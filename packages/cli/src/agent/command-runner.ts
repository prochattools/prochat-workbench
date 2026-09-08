import fs from 'fs'
import { createHash } from 'crypto'
import { execFileSync, spawn } from 'child_process'
import path from 'path'
import { buildWriteConfirmationToken, isWithinOrdinaryWriteRoots, normalizeRepoRelativePath, validateWriteTarget } from './safe-access'
import { runN8nWorkflowExportCapability } from './n8n-workflow-export'

const MAX_OUTPUT_BYTES = 60_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 300_000
const TEXT_SCAN_MAX_BYTES = 1_000_000
const MACOS_GUI_COMMAND_PATHS = ['/opt/homebrew/bin', '/usr/local/bin']

function getGuardedCommandPath(): string {
  const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const additional = process.platform === 'darwin'
    ? MACOS_GUI_COMMAND_PATHS.filter(candidate => fs.existsSync(candidate) && !existing.includes(candidate))
    : []
  return [...additional, ...existing].join(path.delimiter)
}

export type SafeCommandKind =
  | 'git_status_short'
  | 'git_diff_stat'
  | 'git_diff_name_only'
  | 'git_diff'
  | 'git_diff_check'
  | 'git_log_latest'
  | 'git_branch_current'
  | 'verify_public_scope'
  | 'type_check_web'
  | 'type_check_cli'
  | 'verify_write_policy'
  | 'verify_source_reindex_resilience'
  | 'git_diff_cached_stat'
  | 'git_diff_cached_name_only'
  | 'git_add_paths'
  | 'git_commit'
  | 'git_push'
  | 'validate_json_files'
  | 'run_package_script'
  | 'run_package_test'
  | 'run_package_test_marker'
  | 'security_scan_paths'
  | 'diagnose_performance'
  | 'local_cli_github_auth_status'
  | 'local_cli_github_repo_view'
  | 'run_exact_command'
  | 'run_repo_shell'
  | 'n8n_workflow_export'

export type ExactCommandExecutable = 'node' | 'pnpm' | 'rg'

export type ExactCommandPolicy = {
  denyDatabaseCommands?: boolean
  denyMigrationCommands?: boolean
  denyDeploymentCommands?: boolean
  denyNetworkCommands?: boolean
}

export type ExactCommandRuntimeEvidence = {
  requestedNodeVersion?: '20'
  nodeExecutable?: string
  nodeVersion?: string
  nodeMajorVersion?: number
  pnpmVersion?: string
  rgVersion?: string
}

export type LocalCliCapabilityProfile = {
  name: 'github'
  executable: 'gh'
  allowedCommands: string[][]
  requireConfirmationFor: string[][]
}

export const LOCAL_CLI_CAPABILITY_PROFILES: Record<'github', LocalCliCapabilityProfile> = {
  github: {
    name: 'github',
    executable: 'gh',
    allowedCommands: [
      ['auth', 'status'],
      ['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef']
    ],
    requireConfirmationFor: []
  }
}

export type SecurityPatternSet =
  | 'forbidden_runtime_execution'
  | 'forbidden_secret_material'
  | 'forbidden_upload_network'
  | 'forbidden_all_high_risk'

export type SafeCommandRequest = {
  commandKind: SafeCommandKind
  sourceId: string
  sourceRoot: string
  timeoutMs?: number
  paths?: string[]
  packageDir?: string
  scriptName?: string
  marker?: string
  message?: string
  body?: string
  remote?: string
  branch?: string
  patternSet?: SecurityPatternSet
  executable?: ExactCommandExecutable
  args?: string[]
  commandText?: string
  nodeVersion?: '20'
  policy?: ExactCommandPolicy
  protectedPaths?: string[]
  requiredBranch?: string
  networkAccess?: boolean
  workflowId?: string
  outputPath?: string
  persistedValidation?: boolean
  confirmedByUser?: boolean
  confirmationToken?: string
  /** Internal portable-host cancellation only; never accepted from a public payload. */
  signal?: AbortSignal
}

export type SafeCommandResult = {
  status: 'completed' | 'failed' | 'timed_out' | 'needs_confirmation' | 'blocked'
  commandKind: SafeCommandKind
  command: string[]
  cwd: string
  executable?: string
  args?: string[]
  shell?: boolean
  matchStatus?: 'matches_found' | 'no_matches' | 'execution_error'
  resolvedRepositoryRoot?: string
  filesChanged?: boolean
  artifactPath?: string
  artifactSha256?: string
  workflowId?: string
  workflowVersion?: string | number
  workflowUpdatedAt?: string
  networkWriteRequested?: false
  packageDir?: string
  requiredBranch?: string
  actualBranch?: string
  runtime?: ExactCommandRuntimeEvidence
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  durationMs: number
  changedPaths?: string[]
  protectedPathsChanged?: string[]
  riskLevel?: 'medium' | 'high'
  confirmationToken?: string
  requiresConfirmation?: boolean
  reason?: string
  details?: unknown
}

const STATIC_COMMANDS: Partial<Record<SafeCommandKind, string[]>> = {
  git_status_short: ['git', 'status', '--short'],
  git_diff_stat: ['git', 'diff', '--stat'],
  git_diff_name_only: ['git', 'diff', '--name-only'],
  git_diff: ['git', 'diff'],
  git_log_latest: ['git', 'log', '-1', '--oneline'],
  git_branch_current: ['git', 'branch', '--show-current'],
  verify_public_scope: ['pnpm', 'verify:public-scope'],
  type_check_web: ['pnpm', '--dir', 'apps/web', 'type-check'],
  type_check_cli: ['pnpm', '--dir', 'packages/cli', 'type-check'],
  git_diff_cached_stat: ['git', 'diff', '--cached', '--stat'],
  git_diff_cached_name_only: ['git', 'diff', '--cached', '--name-only']
}

const secretPatternSources = [
  'g' + 'hp_[A-Za-z0-9_]+',
  'github_' + 'pat_[A-Za-z0-9_]+',
  's' + 'k_live_[A-Za-z0-9_]+',
  'r' + 'k_live_[A-Za-z0-9_]+',
  'xox' + 'b-[A-Za-z0-9-]+',
  'A' + 'KIA[0-9A-Z]{16}',
  'A' + 'Iza[0-9A-Za-z_-]+',
  'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY[\\s\\S]*?END \\1 PRIVATE KEY'
]

const SECRET_PATTERNS = secretPatternSources.map(source => new RegExp(source, 'g'))
const SECRET_ASSIGNMENT_PATTERN = /\b(DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN)\s*[:=]\s*([^\s'\"`]+)/gi
const AUTHENTICATED_URL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s\/@:]+):([^\s\/@]+)@/gi
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/
const SAFE_MARKER = /^[A-Za-z0-9 _:\-()|]+$/
const SAFE_REMOTE = /^[A-Za-z0-9._-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/
const BLOCKED_PATH_PARTS = new Set(['.git', 'node_modules', 'vendor', '.next', 'dist', 'build', 'coverage', 'generated', 'runtime', 'logs', '.cache', '.turbo', '.vercel', '.npm', '.yarn', '.pnpm-store'])
const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.development.example', '.env.production.example'])
const BLOCKED_FILENAMES = new Set(['.env'])
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.mp4', '.mov', '.avi', '.woff', '.woff2', '.ttf', '.otf'])
const STATIC_STAGE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.avif', '.mp4', '.mov', '.avi', '.webm', '.mkv', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.gz', '.tar', '.tgz'])
const TEXT_LIKE_STATIC_STAGE_EXTENSIONS = new Set(['.svg'])
const STATIC_STAGE_ROOT_PATTERNS = ['public/**', 'assets/**', 'static/**', 'docs/assets/**', 'docs/images/**', 'docs/media/**']
const STATIC_STAGE_MAX_BYTES = 5000000

const SECURITY_PATTERNS: Record<Exclude<SecurityPatternSet, 'forbidden_all_high_risk'>, Array<{ name: string; pattern: RegExp }>> = {
  forbidden_runtime_execution: [
    { name: 'shell_exec', pattern: /\b(exec|spawn|execSync|spawnSync)\s*\(/i },
    { name: 'dynamic_eval', pattern: /\b(eval|Function)\s*\(/i },
    { name: 'dangerous_child_process', pattern: /child_process/i }
  ],
  forbidden_secret_material: [
    { name: 'private_key', pattern: /BEGIN (RSA|OPENSSH|EC) PRIVATE KEY/i },
    ...secretPatternSources.map((source, index) => ({
      name: `secret_pattern_${index + 1}`,
      pattern: new RegExp(source, 'i')
    })),
    { name: 'secret_assignment', pattern: /\b(secret|token|password|credential|api[_-]?key)\b\s*[:=]/i }
  ],
  forbidden_upload_network: [
    { name: 'network_fetch', pattern: /\b(fetch|axios|XMLHttpRequest)\b/i },
    { name: 'curl_or_wget', pattern: /\b(curl|wget)\b/i },
    { name: 'upload_keyword', pattern: /\b(upload|multipart|formData)\b/i }
  ]
}

function registeredSecretValues(): string[] {
  const secretName = /(DATABASE_URL|API_KEY|ACCESS_TOKEN|AUTH_TOKEN|BEARER_TOKEN|CLIENT_SECRET|PRIVATE_KEY|PASSWORD|PASSWD|SECRET|TOKEN)/i
  return Object.entries(process.env)
    .filter(([key, value]) => secretName.test(key) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length)
}

function redactOutput(value: string): string {
  let current = SECRET_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), value)
  current = current.replace(SECRET_ASSIGNMENT_PATTERN, (_match, name: string) => `${name}=[REDACTED]`)
  current = current.replace(AUTHENTICATED_URL_PATTERN, (_match, scheme: string) => `${scheme}[REDACTED]@`)
  current = current.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
  for (const secret of registeredSecretValues()) current = current.split(secret).join('[REDACTED]')
  return current
}

function normalizeRepoPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

function assertSafeRepoPath(input: string, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} must be a string`)
  if (path.isAbsolute(input) || input.startsWith('/')) throw new Error(`${label} must be source-relative`)
  const normalized = normalizeRepoPath(input)
  if (!normalized || normalized === '.' || normalized === '-A' || normalized === '--all') throw new Error(`${label} must be an explicit source-relative path`)
  if (/[\0\r\n\t]/.test(normalized)) throw new Error(`${label} must not contain control characters`)
  if (normalized.startsWith('-')) throw new Error(`${label} must not be an option`)
  if (normalized.split('/').includes('..')) throw new Error(`${label} must not contain path traversal`)
  const basename = path.basename(normalized)
  if (!ENV_TEMPLATE_FILES.has(basename) && (BLOCKED_FILENAMES.has(basename) || /^\.env\./.test(basename))) throw new Error(`${label} points to a blocked env path`)
  if (normalized.split('/').some(part => BLOCKED_PATH_PARTS.has(part))) throw new Error(`${label} points to a blocked runtime/generated path`)
  return normalized
}

function resolveSafePath(sourceRoot: string, relativePath: string): string {
  const fullPath = path.resolve(path.join(sourceRoot, relativePath))
  if (!fullPath.startsWith(path.resolve(sourceRoot))) throw new Error('Path escaped the source root')
  return fullPath
}

function assertTextFilePath(relativePath: string): void {
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) throw new Error('Binary path is blocked: ' + relativePath)
}

function escapeForCommandGlob(value: string): string {
  const specialChars = '\\^.*+?()[]{}|' + String.fromCharCode(36)
  return value.split('').map(char => specialChars.includes(char) ? '\\' + char : char).join('')
}

function matchesCommandGlob(pattern: string, value: string): boolean {
  const escapedChars = escapeForCommandGlob(pattern)
  const escaped = escapedChars.split('\\*\\*').join('::DOUBLESTAR::').split('\\*').join('[^/]*').split('::DOUBLESTAR::').join('.*')
  return new RegExp('^' + escaped + String.fromCharCode(36), 'i').test(value)
}

function isStaticStageRootPath(relativePath: string): boolean {
  return STATIC_STAGE_ROOT_PATTERNS.some(pattern => matchesCommandGlob(pattern, relativePath))
}

function isStaticStagePath(relativePath: string): boolean {
  const ext = path.extname(relativePath).toLowerCase()
  return STATIC_STAGE_EXTENSIONS.has(ext) && isStaticStageRootPath(relativePath)
}

function isTextLikeStaticStagePath(relativePath: string): boolean {
  return TEXT_LIKE_STATIC_STAGE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
}

function isExplicitRequestedPath(request: SafeCommandRequest, relativePath: string): boolean {
  return (request.paths || []).some(requested => !requested.includes('*') && normalizeRepoPath(requested) === relativePath)
}

function isTrackedTextSourceUnderStaticRoot(request: SafeCommandRequest, sourceRoot: string, relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase()
  return isExplicitRequestedPath(request, relativePath)
    && isStaticStageRootPath(relativePath)
    && hasTrackedIndexEntry(sourceRoot, relativePath)
    && !STATIC_STAGE_EXTENSIONS.has(extension)
    && !BINARY_EXTENSIONS.has(extension)
}

function hasTrackedIndexEntry(sourceRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: sourceRoot, stdio: 'ignore', env: gitLiteralEnv() })
    return true
  } catch {
    return false
  }
}

type GitApprovalRequirement = {
  reason: string
  paths: string[]
  confirmationToken: string
  satisfied: boolean
}

function staticStageApprovalRequirement(request: SafeCommandRequest, relativePath: string): GitApprovalRequirement {
  const reason = 'stage_existing_static_asset'
  return {
    reason,
    paths: [relativePath],
    confirmationToken: commandConfirmationToken(request, reason),
    satisfied: hasCommandConfirmation(request, reason)
  }
}

function staticAssetMetadata(sourceRoot: string, relativePath: string): { path: string; bytes: number; sha256: string; textLike: boolean; validation: string } {
  const fullPath = path.resolve(sourceRoot, relativePath)
  const stat = fs.statSync(fs.realpathSync(fullPath))
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > STATIC_STAGE_MAX_BYTES) throw new Error('Static asset is too large to stage safely: ' + relativePath)
  const buffer = fs.readFileSync(fullPath)
  const textLike = isTextLikeStaticStagePath(relativePath)
  if (textLike) {
    const text = buffer.toString('utf8')
    if (text.includes('\u0000')) throw new Error('Text-like static asset contains binary content: ' + relativePath)
    assertNoSecretLikeText(text, relativePath)
  }
  return {
    path: relativePath,
    bytes: stat.size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    textLike,
    validation: textLike ? 'text_secret_scan_passed' : 'binary_content_scan_not_applicable_path_size_hash_checked'
  }
}

function assertStaticStageAllowed(request: SafeCommandRequest, sourceRoot: string, relativePath: string, status?: string): GitApprovalRequirement {
  if (!isStaticStagePath(relativePath)) throw new Error('Static asset type or root is unsupported: ' + relativePath)
  const requirement = staticStageApprovalRequirement(request, relativePath)
  const trackedInIndex = hasTrackedIndexEntry(sourceRoot, relativePath)
  const stagedAddition = Boolean(status && status.startsWith('A'))
  const untrackedExisting = !trackedInIndex && fs.existsSync(path.resolve(sourceRoot, relativePath))
  const textLike = isTextLikeStaticStagePath(relativePath)
  if (!untrackedExisting && !stagedAddition && !textLike) throw new Error('Static asset modification is blocked: ' + relativePath)
  staticAssetMetadata(sourceRoot, relativePath)
  return requirement
}

function buildStaticAssetMetadata(sourceRoot: string, paths: string[]): Array<{ path: string; bytes: number; sha256: string; textLike: boolean; validation: string }> {
  return paths
    .filter(relativePath => isStaticStagePath(relativePath) && fs.existsSync(path.resolve(sourceRoot, relativePath)))
    .map(relativePath => staticAssetMetadata(sourceRoot, relativePath))
}

function assertWriteAllowed(sourceId: string, sourceRoot: string, relativePath: string, changeType: 'patch' | 'delete_file' = 'patch', confirmedByUser?: boolean, confirmationToken?: string): { needsConfirmation: boolean; reason?: string } {
  const validation = validateWriteTarget({ sourceId, requestedPath: relativePath, changeType, sourceRoot, confirmedByUser, confirmationToken })
  if (validation.ok === true) return { needsConfirmation: false }
  const blocked = validation as Extract<typeof validation, { ok: false }>
  if (blocked.error.code === 'REQUIRES_EXPLICIT_CONFIRMATION') return { needsConfirmation: true, reason: blocked.error.reason }
  throw new Error(`${relativePath} is blocked by write policy: ${blocked.error.code}`)
}

function gitLiteralEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
}

function isStagedDeletion(sourceRoot: string, relativePath: string): boolean {
  if (fs.existsSync(path.resolve(sourceRoot, relativePath))) return false
  try {
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=D', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8', env: gitLiteralEnv() }).trim()
    return staged.split('\n').map(item => normalizeRepoRelativePath(item)).includes(relativePath)
  } catch {
    return false
  }
}

function isTrackedDeletionInWorktree(sourceRoot: string, relativePath: string): boolean {
  try {
    const unstaged = execFileSync('git', ['ls-files', '--deleted', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8', env: gitLiteralEnv() }).trim()
    if (unstaged.split('\n').map(item => normalizeRepoRelativePath(item)).includes(relativePath)) return true
  } catch { /* fall through to cached deletion check */ }

  return isStagedDeletion(sourceRoot, relativePath)
}

function isTrackedInIndexOrHead(sourceRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: sourceRoot, stdio: 'pipe', env: gitLiteralEnv() })
    return true
  } catch {
    try {
      const output = execFileSync('git', ['ls-tree', '-z', 'HEAD', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitLiteralEnv() })
      return output.length > 0
    } catch {
      return false
    }
  }
}

function isWithinRealSourceRoot(sourceRootReal: string, candidateReal: string): boolean {
  return candidateReal === sourceRootReal || candidateReal.startsWith(`${sourceRootReal}${path.sep}`)
}

function assertGitFilesystemPathAllowed(sourceRoot: string, relativePath: string, allowMissingTrackedDeletion: boolean): void {
  const sourceRootReal = fs.realpathSync(sourceRoot)
  const fullPath = path.resolve(sourceRootReal, relativePath)
  if (!isWithinRealSourceRoot(sourceRootReal, fullPath)) throw new Error(`${relativePath} is blocked by Git path policy: PATH_NOT_ALLOWED`)

  let existingAncestor = fullPath
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const ancestorReal = fs.realpathSync(existingAncestor)
  if (!isWithinRealSourceRoot(sourceRootReal, ancestorReal)) throw new Error(`${relativePath} resolves through a symlink outside the source root: PATH_NOT_ALLOWED`)

  if (!fs.existsSync(fullPath)) {
    if (allowMissingTrackedDeletion) return
    throw new Error(`${relativePath} must be an existing file or a tracked deletion: PATH_NOT_ALLOWED`)
  }

  const stat = fs.statSync(fs.realpathSync(fullPath))
  const targetReal = fs.realpathSync(fullPath)
  if (!isWithinRealSourceRoot(sourceRootReal, targetReal)) throw new Error(`${relativePath} resolves through a symlink outside the source root: PATH_NOT_ALLOWED`)
  if (!stat.isFile()) throw new Error(`${relativePath} must be an explicit file path: PATH_NOT_ALLOWED`)
}

function resolveExtensionlessBlobId(sourceRoot: string, relativePath: string): string | undefined {
  try {
    const indexEntry = execFileSync('git', ['ls-files', '--stage', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitLiteralEnv() })
    const match = indexEntry.match(/^\d+\s+([0-9a-f]{40,64})\s+0\t/)
    if (match) return match[1]
  } catch { /* not in index */ }
  try {
    const treeEntry = execFileSync('git', ['ls-tree', '-z', 'HEAD', '--', relativePath], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitLiteralEnv() })
    const match = treeEntry.match(/^\d+\s+blob\s+([0-9a-f]{40,64})\t/)
    if (match) return match[1]
  } catch { /* not in HEAD tree */ }
  return undefined
}

const EXTENSIONLESS_MAX_VALIDATE_BYTES = 1_000_000

function assertExtensionlessGitTextPath(sourceRoot: string, relativePath: string): void {
  if (path.extname(relativePath)) return

  let sample: Buffer
  const fullPath = path.resolve(sourceRoot, relativePath)
  if (fs.existsSync(fullPath)) {
    const targetReal = fs.realpathSync(fullPath)
    const size = fs.statSync(targetReal).size
    if (!Number.isSafeInteger(size) || size < 0 || size > EXTENSIONLESS_MAX_VALIDATE_BYTES) throw new Error(`Extensionless tracked file is too large to validate safely: ${relativePath}`)
    const descriptor = fs.openSync(targetReal, 'r')
    try {
      const buffer = Buffer.alloc(8_192)
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0)
      sample = buffer.subarray(0, bytesRead)
    } finally {
      fs.closeSync(descriptor)
    }
  } else {
    const blobId = resolveExtensionlessBlobId(sourceRoot, relativePath)
    if (!blobId) throw new Error(`Extensionless deleted file has no recoverable blob: ${relativePath}`)
    const sizeText = execFileSync('git', ['cat-file', '-s', blobId], { cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0 || size > EXTENSIONLESS_MAX_VALIDATE_BYTES) throw new Error(`Extensionless tracked file is too large to validate safely: ${relativePath}`)
    const blob = execFileSync('git', ['cat-file', 'blob', blobId], { cwd: sourceRoot, maxBuffer: Math.max(1_024, size + 1), stdio: ['ignore', 'pipe', 'pipe'] })
    sample = blob.subarray(0, 8_192)
  }

  if (sample.includes(0)) throw new Error(`Binary path is blocked: ${relativePath}`)
}

function assertGitWriteAllowed(request: SafeCommandRequest, sourceRoot: string, relativePath: string, changeType: 'patch' | 'delete_file'): GitApprovalRequirement | undefined {
  const validate = (confirmedByUser?: boolean, confirmationToken?: string) => validateWriteTarget({
    sourceId: request.sourceId,
    sourceRoot,
    requestedPath: relativePath,
    changeType,
    confirmedByUser,
    confirmationToken
  })
  const validation = validate(request.confirmedByUser, request.confirmationToken)
  if (validation.ok === true) {
    const unconfirmed = validate(false, undefined)
    if (unconfirmed.ok === true) return undefined
    const unconfirmedBlocked = unconfirmed as Extract<typeof unconfirmed, { ok: false }>
    const confirmedProbe = validate(true, undefined)
    if (confirmedProbe.ok !== true) return undefined
    return {
      reason: unconfirmedBlocked.error.reason,
      paths: [relativePath],
      confirmationToken: buildWriteConfirmationToken(request.sourceId, changeType, relativePath),
      satisfied: true
    }
  }
  const blocked = validation as Extract<typeof validation, { ok: false }>
  if (blocked.error.code === 'PATH_NOT_ALLOWED' && !path.extname(relativePath) && isTrackedInIndexOrHead(sourceRoot, relativePath)) return undefined
  const confirmedProbe = validate(true, undefined)
  if (blocked.error.code === 'REQUIRES_EXPLICIT_CONFIRMATION' || confirmedProbe.ok === true) {
    return {
      reason: blocked.error.reason,
      paths: [relativePath],
      confirmationToken: buildWriteConfirmationToken(request.sourceId, changeType, relativePath),
      satisfied: false
    }
  }
  throw new Error(`${relativePath} is blocked by write policy: ${blocked.error.code}`)
}

function getStagedPathStatuses(sourceRoot: string): Array<{ status: string; path: string }> {
  const output = fs.existsSync(path.join(sourceRoot, '.git'))
    ? execFileSync('git', ['diff', '--cached', '--name-status'], { cwd: sourceRoot, encoding: 'utf8' })
    : ''
  return output.split('\n').map(item => item.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\t+/)
    const status = parts[0] || ''
    const relPath = parts.length > 2 ? parts[2] : parts[1]
    return { status, path: normalizeRepoRelativePath(relPath || '') }
  }).filter(item => item.path)
}

function assertStagePathAllowed(request: SafeCommandRequest, sourceRoot: string, relativePath: string): GitApprovalRequirement | undefined {
  const trackedDeletion = isTrackedDeletionInWorktree(sourceRoot, relativePath)
  assertGitFilesystemPathAllowed(sourceRoot, relativePath, trackedDeletion)
  if (trackedDeletion) {
    assertExtensionlessGitTextPath(sourceRoot, relativePath)
    return assertGitWriteAllowed(request, sourceRoot, relativePath, 'delete_file')
  }
  if (isStaticStagePath(relativePath)) {
    return assertStaticStageAllowed(request, sourceRoot, relativePath)
  }
  if (isStaticStageRootPath(relativePath) && !isTrackedTextSourceUnderStaticRoot(request, sourceRoot, relativePath)) {
    throw new Error('Static asset type or root is unsupported: ' + relativePath)
  }
  if (BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase())) throw new Error('Binary path is blocked: ' + relativePath)
  assertExtensionlessGitTextPath(sourceRoot, relativePath)
  if (!isTrackedInIndexOrHead(sourceRoot, relativePath) && !isWithinOrdinaryWriteRoots(relativePath)) {
    throw new Error(`${relativePath} is outside ordinary write roots: PATH_NOT_ALLOWED`)
  }
  return assertGitWriteAllowed(request, sourceRoot, relativePath, 'patch')
}

function assertCommitPathAllowed(request: SafeCommandRequest, sourceRoot: string, item: { status: string; path: string }): GitApprovalRequirement | undefined {
  const deletion = item.status.startsWith('D')
  assertGitFilesystemPathAllowed(sourceRoot, item.path, deletion && isTrackedInIndexOrHead(sourceRoot, item.path))
  if (deletion) {
    assertExtensionlessGitTextPath(sourceRoot, item.path)
    return assertGitWriteAllowed(request, sourceRoot, item.path, 'delete_file')
  }
  if (isStaticStagePath(item.path)) {
    return assertStaticStageAllowed(request, sourceRoot, item.path, item.status)
  }
  if (isStaticStageRootPath(item.path) && !isTrackedTextSourceUnderStaticRoot(request, sourceRoot, item.path)) {
    throw new Error('Static asset type or root is unsupported: ' + item.path)
  }
  if (BINARY_EXTENSIONS.has(path.extname(item.path).toLowerCase())) throw new Error('Binary path is blocked: ' + item.path)
  assertExtensionlessGitTextPath(sourceRoot, item.path)
  return assertGitWriteAllowed(request, sourceRoot, item.path, 'patch')
}

function commandConfirmationToken(request: SafeCommandRequest, reason: string): string {
  const parts = [request.sourceId, request.commandKind, reason, ...(request.paths || []), request.message || '', request.remote || '', request.branch || '', request.workflowId || '', request.outputPath || '', String(request.networkAccess ?? '')]
  return `confirm-command:${Buffer.from(parts.join('|')).toString('base64url')}`
}

function hasCommandConfirmation(request: SafeCommandRequest, reason: string): boolean {
  return request.confirmedByUser === true || request.confirmationToken === commandConfirmationToken(request, reason)
}

function approvalRequirementMetadata(requirements: GitApprovalRequirement[]): Array<{ reason: string; paths: string[] }> {
  return requirements.map(requirement => ({ reason: requirement.reason, paths: [...requirement.paths] }))
}

function withApprovalRequirementDetails(result: SafeCommandResult, requirements: GitApprovalRequirement[]): SafeCommandResult {
  if (requirements.length === 0) return result
  const existingDetails = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
    ? result.details as Record<string, unknown>
    : {}
  return {
    ...result,
    reason: result.reason || requirements[0]?.reason,
    details: {
      ...existingDetails,
      approvalRequirements: approvalRequirementMetadata(requirements)
    }
  }
}

function needsConfirmationResult(request: SafeCommandRequest, reason: string, options: { confirmationToken?: string; paths?: string[] } = {}): SafeCommandResult {
  const result: SafeCommandResult = {
    status: 'needs_confirmation',
    commandKind: request.commandKind,
    command: ['buildflow', request.commandKind],
    cwd: path.resolve(request.sourceRoot),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    requiresConfirmation: true,
    confirmationToken: options.confirmationToken || commandConfirmationToken(request, reason),
    reason
  }
  return options.paths && options.paths.length > 0
    ? { ...result, details: { approvalRequirements: [{ reason, paths: [...options.paths] }] } }
    : result
}

function appendLimited(current: string, chunk: Buffer, state: { bytes: number; truncated: boolean }): string {
  if (state.bytes >= MAX_OUTPUT_BYTES) {
    state.truncated = true
    return current
  }
  const text = redactOutput(chunk.toString('utf8'))
  const remaining = MAX_OUTPUT_BYTES - state.bytes
  const sliced = Buffer.byteLength(text, 'utf8') > remaining ? text.slice(0, remaining) : text
  state.bytes += Buffer.byteLength(sliced, 'utf8')
  if (sliced.length < text.length) state.truncated = true
  return current + sliced
}

async function runProcess(request: SafeCommandRequest, command: string[], cwd: string): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)
  const resolvedCwd = path.resolve(cwd)
  if (!resolvedCwd.startsWith(sourceRoot)) throw new Error('Command cwd escaped the source root')
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1_000, request.timeoutMs || DEFAULT_TIMEOUT_MS))
  const startedAt = Date.now()
  const outputState = { bytes: 0, truncated: false }

  return await new Promise<SafeCommandResult>((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: resolvedCwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: {
        PATH: getGuardedCommandPath(),
        HOME: process.env.HOME || '',
        CI: '1',
        NO_COLOR: '1',
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LITERAL_PATHSPECS: '1'
      }
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let killTimer: NodeJS.Timeout | undefined
    const signalProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // Fall back to direct child signaling below.
        }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          signalProcess('SIGKILL')
        }
      }, 500)
    }, timeoutMs)

    const cancel = () => {
      cancelled = true
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => {
        if (!child.killed || child.exitCode === null) signalProcess('SIGKILL')
      }, 500)
    }
    if (request.signal?.aborted) cancel()
    else request.signal?.addEventListener('abort', cancel, { once: true })

    const clearTimers = () => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      request.signal?.removeEventListener('abort', cancel)
    }

    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)), outputState)
    })
    child.on('error', err => {
      clearTimers()
      reject(err)
    })
    child.on('close', (exitCode, signal) => {
      clearTimers()
      resolve({
        status: timedOut ? 'timed_out' : exitCode === 0 && !cancelled ? 'completed' : 'failed',
        commandKind: request.commandKind,
        command,
        cwd: resolvedCwd,
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
        ...(cancelled ? { reason: 'cancelled' } : {})
      })
    })
  })
}

async function runAndAppendGitLog(request: SafeCommandRequest, command: string[], cwd: string): Promise<SafeCommandResult> {
  const result = await runProcess(request, command, cwd)
  if (result.status !== 'completed') return result
  const log = await runProcess({ ...request, commandKind: 'git_log_latest' }, ['git', 'log', '-1', '--oneline'], cwd)
  return { ...result, stdout: `${result.stdout}${result.stdout ? '\n' : ''}${log.stdout}`.trim(), outputTruncated: result.outputTruncated || log.outputTruncated }
}

function assertExplicitPaths(paths?: string[], options: { allowBinaryPaths?: boolean } = {}): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty explicit file list')
  if (paths.some(item => item === '.' || item === '-A' || item === '--all')) throw new Error('paths must not include git add shortcuts')
  const normalizedPaths = paths.map(item => {
    const normalized = assertSafeRepoPath(item, 'path')
    if (options.allowBinaryPaths !== true) assertTextFilePath(normalized)
    return normalized
  })
  return [...new Set(normalizedPaths)]
}

function getStagedPaths(sourceRoot: string): string[] {
  return getStagedPathStatuses(sourceRoot).map(item => item.path)
}

function buildExactStagingEvidence(requestedPaths: string[], stagedStatuses: Array<{ status: string; path: string }>) {
  const stagedPaths = stagedStatuses.map(item => item.path)
  const requestedSet = new Set(requestedPaths)
  const stagedSet = new Set(stagedPaths)
  const unrelatedStagedPaths = stagedPaths.filter(item => !requestedSet.has(item))
  const missingStagedPaths = requestedPaths.filter(item => !stagedSet.has(item))
  return {
    requestedPaths,
    stagedPaths,
    stagedStatuses,
    unrelatedStagedPaths,
    missingStagedPaths,
    exactMatch: unrelatedStagedPaths.length === 0 && missingStagedPaths.length === 0 && stagedPaths.length === requestedPaths.length
  }
}

type ExpandedPathScope = { input: string; directory: string; files: string[] }

function hasPathGlob(value: string): boolean {
  return value.includes('*')
}

function assertSupportedPathGlob(input: string): { directory: string; pattern: string } {
  if (input.includes('**')) throw new Error('Only directory scopes ending in /** may use **: ' + input)
  const normalized = assertSafeRepoPath(input, 'path scope')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) throw new Error('Path glob is too broad: ' + input)
  const directory = normalized.slice(0, lastSlash)
  const pattern = normalized.slice(lastSlash + 1)
  if (!pattern || pattern === '*' || !pattern.includes('*')) throw new Error('Path glob must target explicit files: ' + input)
  if (directory.split('/').filter(Boolean).length < 2) throw new Error('Path glob directory is too broad: ' + input)
  return { directory, pattern: normalized }
}

function walkRepoFiles(root: string, directory: string): string[] {
  const fullDirectory = path.resolve(root, directory)
  if (!fs.existsSync(fullDirectory)) return []
  const stat = fs.statSync(fs.realpathSync(fullDirectory))
  if (!stat.isDirectory()) throw new Error('Directory scope must point to a directory: ' + directory)
  const out: string[] = []
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      const relPath = normalizeRepoRelativePath(path.relative(root, fullPath))
      if (relPath.split('/').some(part => BLOCKED_PATH_PARTS.has(part))) continue
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) out.push(relPath)
    }
  }
  visit(fullDirectory)
  return out
}

function changedGitPathsUnder(sourceRoot: string, directory: string): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '-uall', '--', directory], { cwd: sourceRoot, encoding: 'utf8', env: gitLiteralEnv() })
    const tokens = output.split('\u0000').filter(Boolean)
    const paths: string[] = []
    for (let index = 0; index < tokens.length; index += 1) {
      const statusEntry = tokens[index]
      const status = statusEntry.slice(0, 2)
      const relPath = normalizeRepoRelativePath(statusEntry.slice(3))
      if (status.startsWith('R') || status.startsWith('C')) {
        const renamedPath = normalizeRepoRelativePath(tokens[index + 1] || relPath)
        if (renamedPath) paths.push(renamedPath)
        index += 1
      } else if (relPath) {
        paths.push(relPath)
      }
    }
    return paths
  } catch {
    return []
  }
}

function expandApprovedPathScopes(sourceRoot: string, requestedPaths: string[]): { paths: string[]; expandedPathScopes: ExpandedPathScope[] } {
  const expandedPathScopes: ExpandedPathScope[] = []
  const expanded = requestedPaths.flatMap(item => {
    if (item.endsWith('/**')) {
      const directory = item.slice(0, -3).replace(/\/+$/, '')
      const segments = directory.split('/').filter(Boolean)
      if (segments.length < 2) throw new Error('Directory scope is too broad: ' + item)
      const normalizedDirectory = assertSafeRepoPath(directory, 'directory scope')
      const files = [...new Set(changedGitPathsUnder(sourceRoot, normalizedDirectory))].sort()
      if (files.length === 0) throw new Error('Directory scope did not expand to any files: ' + item)
      expandedPathScopes.push({ input: item, directory: normalizedDirectory, files })
      return files
    }

    if (hasPathGlob(item)) {
      if (fs.existsSync(path.resolve(sourceRoot, item))) return [item]
      const { directory, pattern } = assertSupportedPathGlob(item)
      const files = [...new Set(changedGitPathsUnder(sourceRoot, directory).filter(candidate => matchesCommandGlob(pattern, candidate)))].sort()
      if (files.length === 0) throw new Error('Path glob did not expand to any files: ' + item)
      expandedPathScopes.push({ input: item, directory, files })
      return files
    }

    return [item]
  })
  return { paths: [...new Set(expanded)], expandedPathScopes }
}

function assertNoSecretLikeText(text: string, label: string): void {
  if (SECRET_PATTERNS.some(pattern => pattern.test(text))) throw new Error(`${label} contains secret-looking content`)
}

function assertPackageDir(sourceRoot: string, packageDir: string | undefined): string {
  if (!packageDir) throw new Error('packageDir is required')
  const raw = String(packageDir).trim()
  const cwd = raw === '.' ? path.resolve(sourceRoot) : resolveSafePath(sourceRoot, assertSafeRepoPath(raw, 'packageDir'))
  if (!fs.existsSync(path.join(cwd, 'package.json'))) throw new Error('packageDir must contain package.json')
  return cwd
}

function structuredLocalResult(request: SafeCommandRequest, status: SafeCommandResult['status'], command: string[], stdout: unknown, stderr = '', exitCode: number | null = 0): SafeCommandResult {
  return {
    status,
    commandKind: request.commandKind,
    command,
    cwd: path.resolve(request.sourceRoot),
    exitCode,
    signal: null,
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout, null, 2),
    stderr,
    outputTruncated: false,
    durationMs: 0,
    details: typeof stdout === 'string' ? undefined : stdout
  }
}

async function runRepoLocalTsxScript(request: SafeCommandRequest, scriptPath: string): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)
  const normalizedScript = assertSafeRepoPath(scriptPath, 'scriptPath')
  const fullScriptPath = resolveSafePath(sourceRoot, normalizedScript)
  if (!fs.existsSync(fullScriptPath)) {
    return structuredLocalResult(request, 'completed', ['buildflow', request.commandKind, 'skipped'], {
      skipped: true,
      reason: 'script_not_found_in_selected_source',
      scriptPath: normalizedScript,
      message: `${request.commandKind} is only run when the selected source contains ${normalizedScript}.`
    })
  }
  if (!fs.existsSync(path.join(sourceRoot, 'package.json'))) {
    return structuredLocalResult(request, 'failed', ['buildflow', request.commandKind], {
      skipped: false,
      reason: 'package_json_missing',
      scriptPath: normalizedScript,
      message: `${request.commandKind} requires package.json in the selected source root.`
    }, '', 1)
  }
  return runProcess(request, ['pnpm', '--dir', 'packages/cli', 'exec', 'tsx', fullScriptPath], sourceRoot)
}

function currentBranch(sourceRoot: string): string {
  const output = execFileSync('git', ['branch', '--show-current'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
  return output || 'main'
}

function getGitOutput(sourceRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: sourceRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: getGuardedCommandPath(),
      GIT_TERMINAL_PROMPT: '0',
      GH_PROMPT_DISABLED: '1'
    }
  }).trim()
}

function getGithubRepoSlug(sourceRoot: string, remote: string): string {
  try {
    const output = execFileSync('gh', ['repo', 'view', remote, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      cwd: sourceRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: getGuardedCommandPath(),
        GH_PROMPT_DISABLED: '1'
      }
    }).trim()
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(output)) return output
  } catch {
    // Fall back to parsing the configured remote URL.
  }

  const remoteUrl = getGitOutput(sourceRoot, ['remote', 'get-url', remote])
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/)
  if (sshMatch) return sshMatch[1]
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/)
  if (httpsMatch) return httpsMatch[1]
  throw new Error(`git_push only supports GitHub remotes; ${remote} points to ${remoteUrl}`)
}

async function runGithubCliBackedPush(request: SafeCommandRequest, remote: string, branch: string, sourceRoot: string): Promise<SafeCommandResult> {
  const auth = await runProcess(request, ['gh', 'auth', 'status'], sourceRoot)
  if (auth.status !== 'completed') {
    return {
      ...auth,
      commandKind: 'git_push',
      command: ['gh', 'auth', 'status'],
      stderr: `${auth.stderr}${auth.stderr ? '\n' : ''}GitHub CLI authentication is required before BuildFlow can push. Run: gh auth login`
    }
  }

  const repoSlug = getGithubRepoSlug(sourceRoot, remote)
  const httpsUrl = `https://github.com/${repoSlug}.git`
  const currentUrl = getGitOutput(sourceRoot, ['remote', 'get-url', remote])
  if (currentUrl !== httpsUrl) {
    const setUrl = await runProcess(request, ['git', 'remote', 'set-url', remote, httpsUrl], sourceRoot)
    if (setUrl.status !== 'completed') return setUrl
  }

  const setup = await runProcess(request, ['gh', 'auth', 'setup-git'], sourceRoot)
  if (setup.status !== 'completed') return setup

  const push = await runProcess(request, ['git', 'push', remote, branch], sourceRoot)
  return {
    ...push,
    command: ['gh', 'auth', 'setup-git', '&&', 'git', 'push', remote, branch],
    stdout: [
      currentUrl !== httpsUrl ? `remote ${remote} normalized to ${httpsUrl}` : `remote ${remote} already uses HTTPS`,
      setup.stdout.trim(),
      push.stdout.trim()
    ].filter(Boolean).join('\n'),
    stderr: push.stderr
  }
}

type SecurityFinding = {
  id: string
  ruleId: string
  path: string
  line: number
  pattern: string
  syntaxCategory: 'CallExpression' | 'ImportDeclaration' | 'LexicalFallback'
  confidence: 'high' | 'medium'
  executable: boolean
  snippet: string
}

type JavaScriptLiteral = {
  start: number
  end: number
  value: string
}

const JAVASCRIPT_SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'])
const NETWORK_PATTERN_NAMES = new Set(SECURITY_PATTERNS.forbidden_upload_network.map(entry => entry.name))

function patternList(patternSet: SecurityPatternSet): Array<{ name: string; pattern: RegExp }> {
  if (patternSet === 'forbidden_all_high_risk') return Object.values(SECURITY_PATTERNS).flat()
  const selected = SECURITY_PATTERNS[patternSet]
  if (!selected) throw new Error('patternSet must be one of the named security scan sets')
  return selected
}

function maskJavaScriptInertText(content: string): { masked: string; literals: JavaScriptLiteral[] } {
  const masked = [...content]
  const literals: JavaScriptLiteral[] = []
  const maskAt = (index: number) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' '
  }
  let index = 0
  let templateExpressionDepth = 0
  let mode: 'code' | 'single' | 'double' | 'line_comment' | 'block_comment' | 'template' = 'code'
  let literalStart = -1

  while (index < content.length) {
    const current = content[index]
    const next = content[index + 1]

    if (mode === 'line_comment') {
      if (current === '\n') mode = 'code'
      else maskAt(index)
      index += 1
      continue
    }
    if (mode === 'block_comment') {
      maskAt(index)
      if (current === '*' && next === '/') {
        maskAt(index + 1)
        index += 2
        mode = 'code'
      } else index += 1
      continue
    }
    if (mode === 'single' || mode === 'double') {
      const quote = mode === 'single' ? "'" : '"'
      maskAt(index)
      if (current === '\\' && next !== undefined) {
        maskAt(index + 1)
        index += 2
        continue
      }
      if (current === quote) {
        literals.push({ start: literalStart, end: index + 1, value: content.slice(literalStart + 1, index) })
        literalStart = -1
        mode = 'code'
      }
      index += 1
      continue
    }
    if (mode === 'template') {
      maskAt(index)
      if (current === '\\' && next !== undefined) {
        maskAt(index + 1)
        index += 2
        continue
      }
      if (current === '\`') {
        mode = 'code'
        index += 1
        continue
      }
      if (current === '$' && next === '{') {
        maskAt(index + 1)
        templateExpressionDepth = 1
        mode = 'code'
        index += 2
        continue
      }
      index += 1
      continue
    }

    if (current === '/' && next === '/') {
      maskAt(index)
      maskAt(index + 1)
      mode = 'line_comment'
      index += 2
      continue
    }
    if (current === '/' && next === '*') {
      maskAt(index)
      maskAt(index + 1)
      mode = 'block_comment'
      index += 2
      continue
    }
    if (current === "'") {
      literalStart = index
      maskAt(index)
      mode = 'single'
      index += 1
      continue
    }
    if (current === '"') {
      literalStart = index
      maskAt(index)
      mode = 'double'
      index += 1
      continue
    }
    if (current === '\`') {
      maskAt(index)
      mode = 'template'
      index += 1
      continue
    }
    if (templateExpressionDepth > 0) {
      if (current === '{') templateExpressionDepth += 1
      if (current === '}') {
        templateExpressionDepth -= 1
        if (templateExpressionDepth === 0) {
          maskAt(index)
          mode = 'template'
        }
      }
    }
    index += 1
  }

  return { masked: masked.join(''), literals }
}

async function validateJsonFiles(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const paths = assertExplicitPaths(request.paths)
  const results: Array<{ path: string; ok: boolean; error?: string }> = []
  for (const relPath of paths) {
    if (!relPath.endsWith('.json')) throw new Error('validate_json_files only accepts .json paths')
    const result = await runProcess(request, ['python3', '-m', 'json.tool', relPath], path.resolve(request.sourceRoot))
    results.push({ path: relPath, ok: result.status === 'completed', error: result.status === 'completed' ? undefined : redactOutput(result.stderr || result.stdout).slice(0, 400) })
  }
  const failed = results.filter(item => !item.ok)
  return {
    status: failed.length === 0 ? 'completed' : 'failed',
    commandKind: request.commandKind,
    command: ['python3', '-m', 'json.tool', '<paths>'],
    cwd: path.resolve(request.sourceRoot),
    exitCode: failed.length === 0 ? 0 : 1,
    signal: null,
    stdout: JSON.stringify({ results }, null, 2),
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    details: { results }
  }
}

export function getAllowedCommandKinds(): SafeCommandKind[] {
  return [
    'git_status_short',
    'git_diff_stat',
    'git_diff_name_only',
    'git_diff',
    'git_diff_check',
    'git_log_latest',
    'git_branch_current',
    'verify_public_scope',
    'type_check_web',
    'type_check_cli',
    'verify_write_policy',
    'verify_source_reindex_resilience',
    'git_diff_cached_stat',
    'git_diff_cached_name_only',
    'git_add_paths',
    'git_commit',
    'git_push',
    'validate_json_files',
    'run_package_script',
    'run_package_test',
    'run_package_test_marker',
    'security_scan_paths',
    'diagnose_performance',
    'local_cli_github_auth_status',
    'local_cli_github_repo_view',
    'run_exact_command',
    'run_repo_shell',
    'n8n_workflow_export'
  ]
}

function exactBlockedResult(request: SafeCommandRequest, reason: string, actualBranch?: string): SafeCommandResult {
  return {
    status: 'blocked',
    commandKind: request.commandKind,
    command: ['buildflow', 'run_exact_command'],
    cwd: path.resolve(request.sourceRoot),
    executable: request.executable,
    args: request.args,
    packageDir: request.packageDir || '.',
    requiredBranch: request.requiredBranch,
    actualBranch,
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    changedPaths: [],
    protectedPathsChanged: [],
    riskLevel: 'medium',
    requiresConfirmation: false,
    reason
  }
}

const REPO_SHELL_MAX_CHARS = 4_000
const REPO_SHELL_DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:sudo|su|doas)\b/i, 'privilege escalation is not allowed'],
  [/\b(?:diskutil|mkfs|fdisk|mount|umount|shutdown|reboot|launchctl)\b/i, 'system administration commands are not allowed'],
  [/\bgit\s+(?:reset\s+--hard|clean\b|push\b[^\n]*--force(?:-with-lease)?|branch\s+-D)\b/i, 'destructive Git commands are not allowed'],
  [/(?:^|[;&|])\s*rm\s+(?:-[^\n]*r|--recursive)\b/i, 'recursive deletion is not allowed'],
  [/\b(?:eval|exec)\s*(?:\(|\s)/i, 'dynamic shell execution is not allowed'],
  [/`|\$\(/, 'command substitution is not allowed'],
  [/(?:BEGIN\s+(?:RSA|OPENSSH|EC)\s+PRIVATE\s+KEY|\.env(?:\.[A-Za-z0-9._-]+)?(?:\b|\/)|\.(?:pem|key|p12|pfx)(?:\b|\/))/i, 'secret material paths are not allowed']
]
const REPO_SHELL_NETWORK_PATTERN = /\b(?:curl|wget|ssh|scp|rsync|nc|netcat|ftp|git\s+(?:clone|fetch|pull|push)|npm\s+(?:install|publish)|pnpm\s+(?:install|add|publish)|yarn\s+(?:install|add|publish))\b/i

function repoShellRedirectTargets(commandText: string): string[] {
  const targets: string[] = []
  const pattern = /(?:^|\s)(?:\d?>|\d?>>|&>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g
  for (const match of commandText.matchAll(pattern)) targets.push(match[1] || match[2] || match[3] || '')
  return targets
}

function assertRepoShellPathContainment(sourceRoot: string, cwd: string, value: string, label: string): void {
  if (!value || value === '/dev/null') return
  if (/\0|[\r\n]/.test(value)) throw new Error(`${label} contains control characters`)
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value)
  const rootReal = fs.realpathSync(sourceRoot)
  const tempRoot = process.env.TMPDIR ? path.resolve(process.env.TMPDIR) : '/tmp'
  const insideRoot = candidate === rootReal || candidate.startsWith(`${rootReal}${path.sep}`)
  const insideTemp = candidate === tempRoot || candidate.startsWith(`${tempRoot}${path.sep}`)
  if (!insideRoot && !insideTemp) throw new Error(`${label} escaped the source root or authorized temporary directory`)
}

function validateRepoShellCommand(sourceRoot: string, cwd: string, commandText: string, networkAccess: boolean): void {
  if (typeof commandText !== 'string' || commandText.trim().length === 0) throw new Error('command is required')
  if (commandText.length > REPO_SHELL_MAX_CHARS) throw new Error(`command exceeds ${REPO_SHELL_MAX_CHARS} characters`)
  if (/\0|[\r\n]/.test(commandText)) throw new Error('command contains prohibited control characters')
  for (const [pattern, reason] of REPO_SHELL_DENY_PATTERNS) if (pattern.test(commandText)) throw new Error(`repository shell command blocked: ${reason}`)
  if (!networkAccess && REPO_SHELL_NETWORK_PATTERN.test(commandText)) throw new Error('repository shell network access requires networkAccess: true')
  const absolutePathPattern = /(?:^|[\s=(])\/(?!\/)(?:[^\s;&|"'`]+)?/g
  for (const match of commandText.matchAll(absolutePathPattern)) {
    const candidate = match[0].trim().replace(/^[=(]/, '')
    if (candidate === '/dev/null') continue
    assertRepoShellPathContainment(sourceRoot, cwd, candidate, 'absolute command path')
  }
  for (const target of repoShellRedirectTargets(commandText)) {
    assertRepoShellPathContainment(sourceRoot, cwd, target, 'redirect target')
    if (exactIsProtectedFile(normalizeRepoPath(target))) throw new Error('redirect target is a protected path')
  }
}

async function runRepoShellCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = fs.realpathSync(path.resolve(request.sourceRoot))
  const cwd = request.packageDir === '.' || !request.packageDir ? sourceRoot : assertPackageDir(sourceRoot, request.packageDir)
  exactRealpathWithin(sourceRoot, cwd, 'packageDir')
  const commandText = request.commandText || ''
  validateRepoShellCommand(sourceRoot, cwd, commandText, request.networkAccess === true)
  const before = exactGitSnapshot(sourceRoot)
  const mandatoryProtectedBefore = exactProtectedFilesystemSnapshot(sourceRoot)
  const result = await runProcess(request, ['/bin/sh', '-c', commandText], cwd)
  const after = exactGitSnapshot(sourceRoot)
  const mandatoryProtectedAfter = exactProtectedFilesystemSnapshot(sourceRoot)
  const changedPaths = exactChangedPaths(before, after)
  const protectedPathsChanged = exactProtectedChanges(mandatoryProtectedBefore, mandatoryProtectedAfter)
  if (protectedPathsChanged.length > 0) {
    result.status = 'blocked'
    result.reason = 'mandatory_protected_path_changed'
  }
  return {
    ...result,
    commandKind: 'run_repo_shell',
    command: ['/bin/sh', '-c', commandText],
    shell: true,
    executable: '/bin/sh',
    args: ['-c', commandText],
    resolvedRepositoryRoot: sourceRoot,
    filesChanged: changedPaths.length > 0,
    changedPaths,
    protectedPathsChanged,
    details: { shell: true, networkAccess: request.networkAccess === true }
  }
}

function exactRealpathWithin(sourceRoot: string, candidate: string, label: string): string {
  const rootReal = fs.realpathSync(sourceRoot)
  const candidateReal = fs.realpathSync(candidate)
  if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) throw new Error(`${label} escaped the source root through a symlink`)
  return candidateReal
}

const INLINE_NODE_MAX_SOURCE_CHARS = 12_000
const INLINE_NODE_MAX_FILES = 5_000
const INLINE_NODE_MAX_FILE_BYTES = 1_000_000
const INLINE_NODE_MAX_TOTAL_BYTES = 20_000_000

function validateInlineNodeSource(source: string): void {
  if (source.length > INLINE_NODE_MAX_SOURCE_CHARS) throw new Error(`inline Node source exceeds ${INLINE_NODE_MAX_SOURCE_CHARS} characters`)
  const blocked: Array<[RegExp, string]> = [
    [/\bimport\s*(?:\(|[^('"`])|\bexport\s+/m, 'dynamic or static imports are not allowed'],
    [/\b(?:eval|Function)\s*\(/, 'dynamic code generation is not allowed'],
    [/\bprocess\s*\.\s*(?:binding|dlopen|env)\b/, 'unsafe process access is not allowed'],
    [/\b(?:constructor|__proto__|prototype)\b/, 'prototype or constructor access is not allowed'],
    [/\brequire\s*\(\s*[^'"`]/, 'require must use a literal module name'],
    [/\brequire\s*\(\s*`[^`]*\$\{/, 'interpolated module names are not allowed']
  ]
  for (const [pattern, reason] of blocked) if (pattern.test(source)) throw new Error(`inline Node source rejected: ${reason}`)
}

function buildInlineNodeValidationSource(sourceRoot: string, cwd: string, userSource: string): string {
  validateInlineNodeSource(userSource)
  const rootReal = fs.realpathSync(sourceRoot)
  const cwdReal = exactRealpathWithin(rootReal, cwd, 'packageDir')
  return String.raw`
'use strict';
(async () => {
  const vm = require('node:vm');
  const realFs = require('node:fs');
  const realFsp = require('node:fs/promises');
  const path = require('node:path');
  const url = require('node:url');
  const realProcess = require('node:process');
  const ROOT = ${JSON.stringify(rootReal)};
  const CWD = ${JSON.stringify(cwdReal)};
  const USER_SOURCE = ${JSON.stringify(userSource)};
  const MAX_FILES = ${INLINE_NODE_MAX_FILES};
  const MAX_FILE_BYTES = ${INLINE_NODE_MAX_FILE_BYTES};
  const MAX_TOTAL_BYTES = ${INLINE_NODE_MAX_TOTAL_BYTES};
  let scannedFiles = 0;
  let totalBytes = 0;

  const fail = message => { throw new Error('inline validation blocked: ' + message); };
  const withinRoot = candidate => candidate === ROOT || candidate.startsWith(ROOT + path.sep);
  const inputText = value => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (value instanceof URL && value.protocol === 'file:') return url.fileURLToPath(value);
    fail('filesystem paths must be strings, Buffers, or file URLs');
  };
  const classify = value => {
    const raw = inputText(value);
    if (raw.includes('\0')) fail('NUL paths are not allowed');
    if (path.isAbsolute(raw)) fail('absolute paths are not allowed');
    const normalized = path.normalize(raw || '.');
    if (normalized === '..' || normalized.startsWith('..' + path.sep)) fail('path traversal outside the repository is not allowed');
    const target = path.resolve(ROOT, normalized);
    if (!withinRoot(target)) fail('path escaped the repository root');
    const relative = path.relative(ROOT, target);
    const parts = relative.split(path.sep).filter(Boolean);
    const base = path.basename(relative).toLowerCase();
    if (parts.includes('.git')) fail('.git access is not allowed');
    if (base === '.env' || base.startsWith('.env.') || ['.npmrc', '.yarnrc', '.yarnrc.yml', 'id_rsa', 'id_ed25519'].includes(base) || /\.(?:pem|key|p12|pfx)$/i.test(base)) fail('secret or private-key paths are not allowed');
    return { target, relative, parts };
  };
  const existing = (value, options = {}) => {
    const info = classify(value);
    if (options.directoryScan && info.parts[0] === 'node_modules') fail('recursive node_modules scans are not allowed');
    const real = realFs.realpathSync(info.target);
    if (!withinRoot(real)) fail('symlink resolves outside the repository root');
    return { ...info, real };
  };
  const countEntries = entries => {
    scannedFiles += entries.length;
    if (scannedFiles > MAX_FILES) fail('file scan limit exceeded');
    return entries;
  };
  const accountRead = info => {
    const stat = realFs.statSync(info.real);
    if (!stat.isFile()) fail('readFile requires a regular file');
    if (stat.size > MAX_FILE_BYTES) fail('per-file read limit exceeded');
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) fail('total read limit exceeded');
  };
  const safeReadFileSync = (value, options) => {
    const info = existing(value);
    accountRead(info);
    return realFs.readFileSync(info.real, options);
  };
  const safeReaddirSync = (value, options) => {
    if (options && typeof options === 'object' && options.recursive === true) fail('recursive readdir is not allowed; walk directories explicitly so limits and exclusions are enforced');
    const info = existing(value, { directoryScan: true });
    return countEntries(realFs.readdirSync(info.real, options));
  };
  const safeStatSync = value => realFs.statSync(existing(value).real);
  const safeLstatSync = value => realFs.lstatSync(classify(value).target);
  const safeRealpathSync = value => existing(value).real;
  const safeReadlinkSync = (value, options) => {
    existing(value);
    return realFs.readlinkSync(classify(value).target, options);
  };
  const safeExistsSync = value => {
    try { existing(value); return true; } catch { return false; }
  };
  const safeAccessSync = (value, mode) => realFs.accessSync(existing(value).real, mode);
  const safePromises = Object.freeze({
    readFile: async (value, options) => safeReadFileSync(value, options),
    readdir: async (value, options) => safeReaddirSync(value, options),
    stat: async value => safeStatSync(value),
    lstat: async value => safeLstatSync(value),
    realpath: async value => safeRealpathSync(value),
    readlink: async (value, options) => safeReadlinkSync(value, options),
    access: async (value, mode) => safeAccessSync(value, mode)
  });
  const safeFs = new Proxy(Object.freeze({
    constants: realFs.constants,
    promises: safePromises,
    readFileSync: safeReadFileSync,
    readdirSync: safeReaddirSync,
    statSync: safeStatSync,
    lstatSync: safeLstatSync,
    realpathSync: safeRealpathSync,
    readlinkSync: safeReadlinkSync,
    existsSync: safeExistsSync,
    accessSync: safeAccessSync
  }), {
    get(target, property) {
      if (property in target) return target[property];
      fail('filesystem API ' + String(property) + ' is not allowed in read-only validation mode');
    }
  });

  const safeProcess = Object.freeze({
    argv: Object.freeze(['node', '<inline-validation>']),
    arch: realProcess.arch,
    platform: realProcess.platform,
    version: realProcess.version,
    versions: Object.freeze({ ...realProcess.versions }),
    env: Object.freeze({}),
    cwd: () => CWD,
    stdout: Object.freeze({ write: chunk => realProcess.stdout.write(String(chunk)) }),
    stderr: Object.freeze({ write: chunk => realProcess.stderr.write(String(chunk)) })
  });
  const safeRequire = moduleId => {
    if (typeof moduleId !== 'string') fail('module name must be a string');
    const id = moduleId.startsWith('node:') ? moduleId.slice(5) : moduleId;
    if (id === 'fs') return safeFs;
    if (id === 'fs/promises') return safePromises;
    if (id === 'path') return path;
    if (id === 'url') return url;
    if (id === 'process') return safeProcess;
    fail('module ' + moduleId + ' is not allowlisted');
  };
  const sandbox = Object.create(null);
  Object.assign(sandbox, {
    console,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    require: safeRequire,
    process: safeProcess,
    __dirname: ROOT,
    __filename: path.join(ROOT, '<inline-validation>'),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script(USER_SOURCE, { filename: '<inline-validation>' });
  const value = script.runInContext(context, { timeout: 11_500, breakOnSigint: true });
  if (value && typeof value.then === 'function') await value;
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
`
}

const EXACT_STANDALONE_SHELL_CONTROL_TOKENS = new Set([
  '|', '||', '&&', ';', '>', '>>', '<', '<<', '1>', '1>>', '2>', '2>>', '&>'
])

const RIPGREP_BOOLEAN_FLAGS = new Set([
  '-n', '--line-number', '-i', '--ignore-case', '-F', '--fixed-strings', '--hidden'
])

const RIPGREP_VALUE_FLAGS = new Set(['-e', '--regexp', '-g', '--glob'])
const RIPGREP_BOUNDED_VALUE_FLAGS = new Set(['-m', '--max-count', '--max-columns'])
const RIPGREP_PROHIBITED_PATH_PARTS = new Set([
  '.git', 'node_modules', 'vendor', '.next', '.turbo', 'dist', 'build', 'coverage', 'out', '.buildflow', 'graphify-out'
])
const RIPGREP_MANDATORY_EXCLUSIONS = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/vendor/**',
  '!**/.next/**',
  '!**/.turbo/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/out/**',
  '!**/.buildflow/**',
  '!**/graphify-out/**',
  '!**/.env',
  '!**/.env.*',
  '!**/*.pem',
  '!**/*.key',
  '!**/*.p12',
  '!**/*.pfx'
]

function exactRejectShellComposition(value: string, index: number): void {
  if (/\0|[\r\n]/.test(value)) throw new Error(`args[${index}] contains prohibited control characters`)
  if (EXACT_STANDALONE_SHELL_CONTROL_TOKENS.has(value.trim())) throw new Error(`args[${index}] is a prohibited shell control token`)
  if (/`|\$\(/.test(value)) throw new Error(`args[${index}] contains prohibited command substitution syntax`)
}

function exactValidateNodeOrPnpmArgs(sourceRoot: string, cwd: string, args: unknown): string[] {
  if (!Array.isArray(args)) throw new Error('args must be an array')
  if (args.length > 0 && args[0] === '-e') {
    if (args.length !== 2 || typeof args[1] !== 'string') throw new Error('inline Node validation requires args ["-e", JavaScriptSource]')
    return ['--experimental-permission', `--allow-fs-read=${sourceRoot}`, '--disable-proto=throw', '-e', buildInlineNodeValidationSource(sourceRoot, cwd, args[1])]
  }
  return args.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`args[${index}] must be a string`)
    if (/\0|[\r\n]|;|&&|\|\||\||>|<|`|\$\(/.test(value)) throw new Error(`args[${index}] contains prohibited shell syntax`)
    if (path.isAbsolute(value)) {
      const resolved = path.resolve(value)
      if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`args[${index}] contains an absolute path outside the source root`)
    } else if (value.includes('..')) {
      const resolved = path.resolve(cwd, value)
      if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`args[${index}] resolves outside the source root`)
    }
    return value
  })
}

function exactValidateRipgrepPath(sourceRoot: string, value: string, index: number): string {
  if (path.isAbsolute(value)) throw new Error(`args[${index}] contains an absolute ripgrep search path`)
  const normalized = normalizeRepoRelativePath(value)
  const parts = normalized.split('/').filter(Boolean)
  if (parts.includes('..')) throw new Error(`args[${index}] contains repository traversal`)
  if (parts.some(part => RIPGREP_PROHIBITED_PATH_PARTS.has(part.toLowerCase()))) throw new Error(`args[${index}] targets a prohibited repository tree`)
  if (exactIsProtectedFile(normalized)) throw new Error(`args[${index}] targets a protected path`)
  const resolved = path.resolve(sourceRoot, normalized || '.')
  if (resolved !== sourceRoot && !resolved.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`args[${index}] resolves outside the source root`)
  if (!fs.existsSync(resolved)) throw new Error(`args[${index}] search path does not exist`)
  exactRealpathWithin(sourceRoot, resolved, `args[${index}] search path`)
  return value
}

function exactValidateRipgrepGlob(value: string, index: number): void {
  const normalized = value.toLowerCase().replace(/\\/g, '/')
  if ([...RIPGREP_PROHIBITED_PATH_PARTS].some(part => normalized.includes(part))) throw new Error(`args[${index}] glob references a prohibited repository tree`)
  if (/(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)(?:$|[/*?\[\]{}])/.test(normalized)) throw new Error(`args[${index}] glob references protected files`)
}

function exactValidateRipgrepBoundedValue(flag: string, value: string, index: number): void {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`args[${index}] requires a positive integer for ${flag}`)
  const parsed = Number(value)
  const maximum = flag === '-m' || flag === '--max-count' ? 100 : 1000
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`args[${index}] ${flag} exceeds the bounded maximum of ${maximum}`)
}

function exactValidateRipgrepArgs(sourceRoot: string, cwd: string, args: unknown): { args: string[]; searchPaths: string[] } {
  if (cwd !== sourceRoot) throw new Error('direct rg execution requires packageDir "." or no packageDir')
  if (!Array.isArray(args) || args.length === 0) throw new Error('rg args must be a non-empty array')
  if (args.length > 100) throw new Error('rg args exceed the bounded argument limit')

  const values = args.map((value, index) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 500) throw new Error(`args[${index}] must be a non-empty string of at most 500 characters`)
    exactRejectShellComposition(value, index)
    return value
  })

  const optionArgs: string[] = []
  const positional: Array<{ value: string; index: number }> = []
  let explicitPatternCount = 0
  let seenPositional = false

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--') throw new Error('rg argument terminator is not supported; use -e for patterns beginning with a dash')
    if (value === '--pre' || value.startsWith('--pre=') || value === '--pre-glob' || value.startsWith('--pre-glob=')) {
      throw new Error(`args[${index}] enables a prohibited ripgrep preprocessor`)
    }
    if (RIPGREP_BOOLEAN_FLAGS.has(value) || (/^-[niF]{2,}$/.test(value) && !value.includes('e'))) {
      if (seenPositional) throw new Error(`args[${index}] places an option after the pattern or search path`)
      optionArgs.push(value)
      continue
    }
    if (RIPGREP_VALUE_FLAGS.has(value)) {
      if (seenPositional) throw new Error(`args[${index}] places an option after the pattern or search path`)
      const optionValue = values[index + 1]
      if (optionValue === undefined) throw new Error(`args[${index}] requires a value`)
      if (value === '-e' || value === '--regexp') explicitPatternCount += 1
      else exactValidateRipgrepGlob(optionValue, index + 1)
      optionArgs.push(value, optionValue)
      index += 1
      continue
    }
    if (RIPGREP_BOUNDED_VALUE_FLAGS.has(value)) {
      if (seenPositional) throw new Error(`args[${index}] places an option after the pattern or search path`)
      const optionValue = values[index + 1]
      if (optionValue === undefined) throw new Error(`args[${index}] requires a value`)
      exactValidateRipgrepBoundedValue(value, optionValue, index + 1)
      optionArgs.push(value, optionValue)
      index += 1
      continue
    }
    if (value.startsWith('--regexp=')) {
      if (seenPositional) throw new Error(`args[${index}] places an option after the pattern or search path`)
      if (value.length === '--regexp='.length) throw new Error(`args[${index}] requires a pattern`)
      explicitPatternCount += 1
      optionArgs.push(value)
      continue
    }
    if (value.startsWith('--glob=')) {
      if (seenPositional) throw new Error(`args[${index}] places an option after the pattern or search path`)
      const glob = value.slice('--glob='.length)
      if (!glob) throw new Error(`args[${index}] requires a glob`)
      exactValidateRipgrepGlob(glob, index)
      optionArgs.push(value)
      continue
    }
    if (value.startsWith('-')) throw new Error(`args[${index}] uses an unsupported ripgrep option`)
    seenPositional = true
    positional.push({ value, index })
  }

  const searchPathEntries = explicitPatternCount > 0 ? positional : positional.slice(1)
  if (explicitPatternCount === 0 && positional.length === 0) throw new Error('rg requires a pattern')
  if (searchPathEntries.length === 0) throw new Error('rg requires at least one repository-relative search path')
  const searchPaths = searchPathEntries.map(entry => exactValidateRipgrepPath(sourceRoot, entry.value, entry.index))
  const mandatoryArgs = RIPGREP_MANDATORY_EXCLUSIONS.flatMap(glob => ['--glob', glob])
  return { args: [...optionArgs, ...mandatoryArgs, ...positional.map(entry => entry.value)], searchPaths }
}

function exactResolveNode20(): { nodeExecutable: string; binDir: string; nodeVersion: string; nodeMajorVersion: number } {
  const candidates: string[] = []
  const nvmDirs = Array.from(new Set([
    process.env.NVM_DIR,
    process.env.HOME ? path.join(process.env.HOME, '.nvm') : undefined
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
  for (const nvmDir of nvmDirs) {
    const versionsDir = path.join(nvmDir, 'versions', 'node')
    if (fs.existsSync(versionsDir)) {
      for (const entry of fs.readdirSync(versionsDir).filter(name => /^v20\./.test(name)).sort().reverse()) {
        candidates.push(path.join(versionsDir, entry, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'))
      }
    }
  }
  if (process.version.startsWith('v20.')) candidates.push(process.execPath)
  for (const nodeExecutable of candidates) {
    if (!fs.existsSync(nodeExecutable)) continue
    const nodeVersion = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8', timeout: 2_000 }).trim()
    const nodeMajorVersion = Number(nodeVersion.replace(/^v/, '').split('.')[0])
    if (nodeMajorVersion === 20) return { nodeExecutable, binDir: path.dirname(nodeExecutable), nodeVersion, nodeMajorVersion }
  }
  throw new Error('Node 20 is not installed or could not be resolved')
}

function exactMinimalEnv(binDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, CI: '1', NO_COLOR: '1' }
  for (const key of ['HOME', 'USER', 'TMPDIR', 'TEMP', 'TMP', 'TERM', 'FORCE_COLOR', 'NVM_DIR', 'PNPM_HOME', 'COREPACK_HOME', 'XDG_CACHE_HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function exactPackageScript(cwd: string, executable: ExactCommandExecutable, args: string[]): { resolvedScriptName?: string; scriptCommand?: string } {
  if (executable !== 'pnpm' || args.length === 0 || args[0] === '--version') return {}
  let scriptName: string | undefined
  if (args[0] === 'run') scriptName = args[1]
  else if (args[0] !== 'exec') scriptName = args[0]
  if (!scriptName) return {}
  if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('package script name contains unsafe characters')
  const packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
  const scriptCommand = packageJson.scripts?.[scriptName]
  if (typeof scriptCommand !== 'string') throw new Error(`Package script does not exist: ${scriptName}`)
  return { resolvedScriptName: scriptName, scriptCommand }
}

function exactAssertPolicy(scriptCommand: string | undefined, policy: ExactCommandPolicy | undefined): void {
  if (!scriptCommand) return
  const normalized = scriptCommand.toLowerCase()
  const checks: Array<[boolean | undefined, RegExp, string]> = [
    [policy?.denyDatabaseCommands, /\b(payload\s+migrate(?::status)?|prisma\s+(migrate|db)|seed|db:init|database:init|psql|mysql|sqlite3|mongosh|redis-cli)\b/i, 'database command'],
    [policy?.denyMigrationCommands, /\b(payload\s+migrate(?::status)?|prisma\s+migrate)\b/i, 'migration command'],
    [policy?.denyDeploymentCommands, /\b(docker\s+push|docker\s+compose\s+up|kubectl|deploy|production|latest)\b/i, 'deployment command'],
    [policy?.denyNetworkCommands, /\b(curl|wget|nc|netcat|ssh|scp|rsync)\b/i, 'network command']
  ]
  for (const [enabled, pattern, label] of checks) if (enabled && pattern.test(normalized)) throw new Error(`Package script is blocked by policy: ${label}`)
}

function exactGitSnapshot(sourceRoot: string): Map<string, string> {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: sourceRoot, encoding: 'utf8' })
  const result = new Map<string, string>()
  for (const line of output.split('\n').filter(Boolean)) result.set(normalizeRepoRelativePath(line.slice(3)), line.slice(0, 2))
  return result
}

function exactChangedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(item => !path.isAbsolute(item) && !item.split('/').includes('..'))
    .filter(item => before.get(item) !== after.get(item))
    .sort()
}

const EXACT_PROTECTED_SCAN_LIMIT = 150_000
const EXACT_PROTECTED_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx'])
const EXACT_PROTECTED_SCAN_PRUNED_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'out'
])

function exactIsProtectedFile(relativePath: string): boolean {
  const normalized = normalizeRepoRelativePath(relativePath)
  const parts = normalized.split('/')
  const basename = path.basename(normalized)
  return parts.includes('.git') || basename === '.env' || /^\.env\./.test(basename) || EXACT_PROTECTED_EXTENSIONS.has(path.extname(basename).toLowerCase())
}

function exactProtectedFilesystemSnapshot(sourceRoot: string): Map<string, string> {
  const rootReal = fs.realpathSync(sourceRoot)
  const snapshot = new Map<string, string>()
  let visited = 0
  const visit = (absolutePath: string, relativePath: string) => {
    visited += 1
    if (visited > EXACT_PROTECTED_SCAN_LIMIT) throw new Error('Protected path scan exceeded its bounded entry limit')
    const stat = fs.lstatSync(absolutePath)
    const normalized = normalizeRepoRelativePath(relativePath)
    const protectedEntry = normalized ? exactIsProtectedFile(normalized) && !normalized.split('/').includes('.git') : false
    if (protectedEntry) {
      snapshot.set(normalized, `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'}`)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    if (normalized && EXACT_PROTECTED_SCAN_PRUNED_DIRS.has(path.basename(normalized))) return
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
      const childAbsolute = path.join(absolutePath, entry.name)
      const childRelative = normalized ? `${normalized}/${entry.name}` : entry.name
      const resolved = path.resolve(childAbsolute)
      if (resolved !== rootReal && !resolved.startsWith(`${rootReal}${path.sep}`)) throw new Error('Protected path scan escaped the source root')
      visit(childAbsolute, childRelative)
    }
  }
  visit(rootReal, '')
  return snapshot
}

function exactProtectedChanges(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(item => before.get(item) !== after.get(item))
    .sort()
}

function exactPathHash(sourceRoot: string, relativePath: string): string {
  const fullPath = path.join(sourceRoot, relativePath)
  if (!fs.existsSync(fullPath)) return 'missing'
  const stat = fs.statSync(fullPath)
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(fullPath, { recursive: true }).map(String).sort()
    const hash = createHash('sha256')
    for (const entry of entries) {
      const child = path.join(fullPath, entry)
      if (fs.statSync(child).isFile()) hash.update(entry).update(fs.readFileSync(child))
    }
    return hash.digest('hex')
  }
  return createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')
}

async function runExactCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = fs.realpathSync(path.resolve(request.sourceRoot))
  const cwd = request.packageDir === '.' || !request.packageDir ? sourceRoot : assertPackageDir(sourceRoot, request.packageDir)
  exactRealpathWithin(sourceRoot, cwd, 'packageDir')
  const actualBranch = currentBranch(sourceRoot)
  if (request.requiredBranch && actualBranch !== request.requiredBranch) return exactBlockedResult(request, 'branch_mismatch', actualBranch)
  if (request.executable !== 'node' && request.executable !== 'pnpm' && request.executable !== 'rg') throw new Error('executable must be node, pnpm, or rg')

  const isRipgrep = request.executable === 'rg'
  if (isRipgrep && request.nodeVersion !== undefined) throw new Error('nodeVersion is not supported for direct rg execution')
  if (isRipgrep && request.networkAccess !== false) throw new Error('direct rg execution requires networkAccess: false')
  const ripgrepValidation = isRipgrep ? exactValidateRipgrepArgs(sourceRoot, cwd, request.args) : undefined
  const args = ripgrepValidation?.args || exactValidateNodeOrPnpmArgs(sourceRoot, cwd, request.args)
  const runtime = isRipgrep ? undefined : exactResolveNode20()
  if (request.nodeVersion === '20' && runtime?.nodeMajorVersion !== 20) throw new Error('Resolved child runtime is not Node 20')
  const { resolvedScriptName, scriptCommand } = exactPackageScript(cwd, request.executable, args)
  exactAssertPolicy(scriptCommand, request.policy)
  const protectedPaths = (request.protectedPaths || []).map(item => assertSafeRepoPath(item, 'protectedPath'))
  const protectedBefore = new Map(protectedPaths.map(item => [item, exactPathHash(sourceRoot, item)]))
  const before = exactGitSnapshot(sourceRoot)
  const mandatoryProtectedBefore = exactProtectedFilesystemSnapshot(sourceRoot)
  const pnpmName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const pnpmCandidates = runtime ? [
    path.join(runtime.binDir, pnpmName),
    process.env.PNPM_HOME ? path.join(process.env.PNPM_HOME, pnpmName) : undefined,
    ...getGuardedCommandPath().split(path.delimiter).filter(Boolean).map(entry => path.join(entry, pnpmName))
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0) : []
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const rgCandidates = getGuardedCommandPath().split(path.delimiter).filter(Boolean).map(entry => path.join(entry, rgName))
  const executablePath = request.executable === 'node'
    ? runtime!.nodeExecutable
    : request.executable === 'pnpm'
      ? pnpmCandidates.find(candidate => fs.existsSync(candidate))
      : rgCandidates.find(candidate => fs.existsSync(candidate))
  if (!executablePath) throw new Error(`Unable to resolve allowlisted executable: ${request.executable}`)
  const executionBinDir = runtime?.binDir || path.dirname(executablePath)
  const executionEnv = exactMinimalEnv(executionBinDir)
  const startedAt = Date.now()
  const outputState = { bytes: 0, truncated: false }
  const inlineNode = request.executable === 'node' && Array.isArray(request.args) && request.args[0] === '-e'
  const timeoutCeiling = request.persistedValidation ? MAX_TIMEOUT_MS : 12_000
  const timeoutMs = Math.min(timeoutCeiling, Math.max(1_000, request.timeoutMs || 8_000))
  const result = await new Promise<SafeCommandResult>((resolve, reject) => {
    const child = spawn(executablePath, args, { cwd, shell: false, detached: process.platform !== 'win32', env: executionEnv })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let outputLimitExceeded = false
    let killTimer: NodeJS.Timeout | undefined
    const signalProcess = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, signal); return } catch { /* direct child fallback */ }
      }
      child.kill(signal)
    }
    const timer = setTimeout(() => {
      timedOut = true
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => signalProcess('SIGKILL'), 500)
    }, timeoutMs)
    const terminateForOutputLimit = () => {
      if ((!inlineNode && !isRipgrep) || !outputState.truncated || outputLimitExceeded) return
      outputLimitExceeded = true
      clearTimeout(timer)
      signalProcess('SIGTERM')
      killTimer = setTimeout(() => signalProcess('SIGKILL'), 500)
    }
    child.stdout.on('data', chunk => {
      stdout = appendLimited(stdout, Buffer.from(chunk), outputState)
      terminateForOutputLimit()
    })
    child.stderr.on('data', chunk => {
      stderr = appendLimited(stderr, Buffer.from(chunk), outputState)
      terminateForOutputLimit()
    })
    child.on('error', error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error) })
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      const matchStatus = isRipgrep
        ? exitCode === 0 ? 'matches_found' : exitCode === 1 ? 'no_matches' : 'execution_error'
        : undefined
      const status = outputLimitExceeded
        ? 'failed'
        : timedOut
          ? 'timed_out'
          : isRipgrep && exitCode === 1
            ? 'completed'
            : exitCode === 0
              ? 'completed'
              : 'failed'
      resolve({
        status,
        commandKind: request.commandKind,
        reason: outputLimitExceeded ? 'output_limit_exceeded' : isRipgrep && exitCode !== null && exitCode >= 2 ? 'ripgrep_execution_error' : undefined,
        command: [request.executable!, ...args],
        cwd,
        executable: request.executable,
        args,
        shell: false,
        matchStatus,
        resolvedRepositoryRoot: sourceRoot,
        filesChanged: false,
        packageDir: request.packageDir || '.',
        requiredBranch: request.requiredBranch,
        actualBranch,
        runtime: runtime ? { requestedNodeVersion: request.nodeVersion, nodeExecutable: runtime.nodeExecutable, nodeVersion: runtime.nodeVersion, nodeMajorVersion: runtime.nodeMajorVersion } : undefined,
        exitCode,
        signal,
        stdout,
        stderr,
        outputTruncated: outputState.truncated,
        durationMs: Date.now() - startedAt,
        changedPaths: [],
        protectedPathsChanged: [],
        riskLevel: 'medium',
        requiresConfirmation: false,
        details: isRipgrep
          ? { searchPaths: ripgrepValidation?.searchPaths || [], exactInvocation: { executable: request.executable, args, shell: false } }
          : resolvedScriptName ? { resolvedScriptName } : undefined
      })
    })
  })
  if (request.executable === 'pnpm') {
    try { result.runtime = { ...result.runtime, pnpmVersion: execFileSync(executablePath, ['--version'], { cwd, env: executionEnv, encoding: 'utf8', timeout: 2_000 }).trim() } } catch { /* retain command evidence */ }
  } else if (request.executable === 'rg') {
    try { result.runtime = { rgVersion: execFileSync(executablePath, ['--version'], { cwd, env: executionEnv, encoding: 'utf8', timeout: 2_000 }).split('\n')[0].trim() } } catch { /* retain command evidence */ }
  }
  const mandatoryProtectedAfter = exactProtectedFilesystemSnapshot(sourceRoot)
  result.changedPaths = exactChangedPaths(before, exactGitSnapshot(sourceRoot))
  result.filesChanged = result.changedPaths.length > 0
  const callerProtectedChanges = protectedPaths.filter(item => protectedBefore.get(item) !== exactPathHash(sourceRoot, item))
  const mandatoryProtectedChanges = exactProtectedChanges(mandatoryProtectedBefore, mandatoryProtectedAfter)
  result.protectedPathsChanged = [...new Set([...callerProtectedChanges, ...mandatoryProtectedChanges])].sort()
  if (result.protectedPathsChanged.length > 0) {
    result.status = 'blocked'
    result.reason = mandatoryProtectedChanges.length > 0 ? 'mandatory_protected_path_changed' : 'protected_path_changed'
  } else if (isRipgrep && result.filesChanged) {
    result.status = 'blocked'
    result.reason = 'read_only_command_changed_worktree'
  }
  return result
}

const n8nWorkflowExportDependencies = {
  hasCommandConfirmation,
  needsConfirmationResult,
  resolveSafePath,
  exactRealpathWithin,
  assertSafeRepoPath,
  exactPathHash,
  exactGitSnapshot,
  exactChangedPaths,
  exactProtectedFilesystemSnapshot,
  exactProtectedChanges
}

export async function runSafeCommand(request: SafeCommandRequest): Promise<SafeCommandResult> {
  const sourceRoot = path.resolve(request.sourceRoot)

  if (request.commandKind === 'run_exact_command') return runExactCommand(request)
  if (request.commandKind === 'run_repo_shell') return runRepoShellCommand(request)
  if (request.commandKind === 'n8n_workflow_export') return runN8nWorkflowExportCapability(request, n8nWorkflowExportDependencies)

  if (request.commandKind === 'verify_write_policy') return runRepoLocalTsxScript(request, 'scripts/verify-write-policy.ts')
  if (request.commandKind === 'verify_source_reindex_resilience') return runRepoLocalTsxScript(request, 'scripts/verify-source-reindex-resilience.ts')
  if (request.commandKind === 'diagnose_performance') return runRepoLocalTsxScript(request, 'scripts/diagnose-performance.ts')
  if (request.commandKind === 'local_cli_github_auth_status') return runProcess(request, ['gh', 'auth', 'status'], sourceRoot)
  if (request.commandKind === 'local_cli_github_repo_view') return runProcess(request, ['gh', 'repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], sourceRoot)

  if (request.commandKind === 'validate_json_files') return validateJsonFiles(request)
  if (request.commandKind === 'security_scan_paths') return scanSecurityPaths(request)

  if (request.commandKind === 'git_diff_check') {
    const pathspecs = assertExplicitPaths(request.paths).map(item => {
      const normalized = normalizeRepoRelativePath(item)
      if (!normalized || normalized === '.' || normalized.startsWith('-')) throw new Error(`Unsafe git pathspec: ${item}`)
      const resolved = path.resolve(sourceRoot, normalized)
      const relative = path.relative(sourceRoot, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Git pathspec escaped the source root: ${item}`)
      return normalized
    })
    return runProcess(request, ['git', 'diff', '--check', '--', ...pathspecs], sourceRoot)
  }

  if (request.commandKind === 'git_add_paths') {
    const requestedInputPaths = assertExplicitPaths(request.paths, { allowBinaryPaths: true })
    const expansion = expandApprovedPathScopes(sourceRoot, requestedInputPaths)
    const paths = expansion.paths
    const approvalRequirements: GitApprovalRequirement[] = []
    for (const relPath of paths) {
      const requirement = assertStagePathAllowed(request, sourceRoot, relPath)
      if (!requirement) continue
      if (!requirement.satisfied) {
        return needsConfirmationResult(request, requirement.reason, {
          confirmationToken: requirement.confirmationToken,
          paths: requirement.paths
        })
      }
      approvalRequirements.push(requirement)
    }
    const pathsToStage = paths.filter(relPath => !isStagedDeletion(sourceRoot, relPath))
    const result = pathsToStage.length > 0
      ? await runProcess(request, ['git', 'add', '--', ...pathsToStage], sourceRoot)
      : structuredLocalResult(request, 'completed', ['git', 'add', '--'], '')
    if (result.status !== 'completed') return result
    const evidence = buildExactStagingEvidence(paths, getStagedPathStatuses(sourceRoot))
    return withApprovalRequirementDetails({
      ...result,
      details: {
        ...evidence,
        requestedInputPaths,
        expandedPathScopes: expansion.expandedPathScopes,
        staticAssets: buildStaticAssetMetadata(sourceRoot, paths)
      }
    }, approvalRequirements)
  }

  if (request.commandKind === 'git_commit') {
    const requestedInputPaths = request.paths === undefined
      ? undefined
      : assertExplicitPaths(request.paths, { allowBinaryPaths: true })
    const requestedPaths = requestedInputPaths === undefined
      ? undefined
      : expandApprovedPathScopes(sourceRoot, requestedInputPaths).paths
    const stagedStatuses = getStagedPathStatuses(sourceRoot)
    const staged = stagedStatuses.map(item => item.path)
    if (staged.length === 0) throw new Error('git_commit requires staged changes')
    if (requestedPaths) {
      const evidence = buildExactStagingEvidence(requestedPaths, stagedStatuses)
      if (!evidence.exactMatch) {
        const mismatch = structuredLocalResult(
          request,
          'failed',
          ['git', 'commit'],
          evidence,
          'The complete staged path set does not exactly match the requested paths.',
          1
        )
        mismatch.reason = 'staged_path_set_mismatch'
        return mismatch
      }
    }
    const approvalRequirements: GitApprovalRequirement[] = []
    for (const item of stagedStatuses) {
      const requirement = assertCommitPathAllowed(request, sourceRoot, item)
      if (!requirement) continue
      if (!requirement.satisfied) {
        return needsConfirmationResult(request, requirement.reason, {
          confirmationToken: requirement.confirmationToken,
          paths: requirement.paths
        })
      }
      approvalRequirements.push(requirement)
    }
    const message = typeof request.message === 'string' ? request.message.trim() : ''
    const body = typeof request.body === 'string' ? request.body.trim() : ''
    if (!message || /[\r\n]/.test(message) || message.length > 200) throw new Error('message must be a short single-line string')
    if (body && body.length > 2000) throw new Error('body is too long')
    assertNoSecretLikeText(message, 'message')
    if (body) assertNoSecretLikeText(body, 'body')
    const result = await runAndAppendGitLog(request, ['git', 'commit', '-m', message, ...(body ? ['-m', body] : [])], sourceRoot)
    return result.status === 'completed' ? withApprovalRequirementDetails(result, approvalRequirements) : result
  }

  if (request.commandKind === 'git_push') {
    const remote = typeof request.remote === 'string' && request.remote.trim() ? request.remote.trim() : 'origin'
    const branch = typeof request.branch === 'string' && request.branch.trim() ? request.branch.trim() : currentBranch(sourceRoot)
    if (!SAFE_REMOTE.test(remote)) throw new Error('remote must be a safe remote name')
    if (!SAFE_BRANCH.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('branch must be a safe branch name')
    return runGithubCliBackedPush(request, remote, branch, sourceRoot)
  }

  if (request.commandKind === 'run_package_script') {
    const cwd = assertPackageDir(sourceRoot, request.packageDir)
    const scriptName = typeof request.scriptName === 'string' ? request.scriptName : ''
    if (!SAFE_SCRIPT_NAME.test(scriptName)) throw new Error('scriptName contains unsafe characters')
    return runProcess(request, ['npm', 'run', scriptName], cwd)
  }

  if (request.commandKind === 'run_package_test') {
    return runProcess(request, ['npm', 'test'], assertPackageDir(sourceRoot, request.packageDir))
  }

  if (request.commandKind === 'run_package_test_marker') {
    const cwd = assertPackageDir(sourceRoot, request.packageDir)
    const marker = typeof request.marker === 'string' ? request.marker : ''
    if (!marker || marker.length > 160 || !SAFE_MARKER.test(marker)) throw new Error('marker contains unsafe characters')
    return runProcess(request, ['npm', 'test', '--', '--test-name-pattern', marker], cwd)
  }

  const command = STATIC_COMMANDS[request.commandKind]
  if (!command) throw new Error(`Command kind is not allowlisted: ${request.commandKind}`)

  if (request.commandKind === 'git_diff' || request.commandKind === 'git_diff_stat' || request.commandKind === 'git_diff_name_only') {
    const pathspecs = (request.paths || []).map(item => {
      if (typeof item !== 'string' || !item.trim()) throw new Error('paths must contain non-empty repository-relative strings')
      const normalized = normalizeRepoRelativePath(item)
      if (!normalized || normalized === '.' || normalized.startsWith('-')) throw new Error(`Unsafe git pathspec: ${item}`)
      const resolved = path.resolve(sourceRoot, normalized)
      const relative = path.relative(sourceRoot, resolved)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Git pathspec escaped the source root: ${item}`)
      return normalized
    })
    const result = await runProcess(request, pathspecs.length > 0 ? [...command, '--', ...pathspecs] : command, sourceRoot)
    if (pathspecs.length === 0) return result

    const status = await runProcess(
      request,
      ['git', 'status', '--short', '--untracked-files=all', '--', ...pathspecs],
      sourceRoot
    )
    const untracked = status.stdout
      .split('\n')
      .map(line => line.trimEnd())
      .filter(line => line.startsWith('?? '))
    if (untracked.length > 0) {
      const outputState = {
        bytes: Buffer.byteLength(result.stdout, 'utf8'),
        truncated: result.outputTruncated
      }
      result.stdout = appendLimited(
        result.stdout,
        Buffer.from(`${result.stdout.endsWith('\n') || result.stdout.length === 0 ? '' : '\n'}\nUntracked path evidence:\n${untracked.join('\n')}\n`),
        outputState
      )
      result.outputTruncated = outputState.truncated
    }
    return result
  }

  return runProcess(request, command, sourceRoot)
}

function lineNumberAt(content: string, index: number): number {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) if (content[cursor] === '\n') line += 1
  return line
}

function securityFinding(
  content: string,
  relPath: string,
  index: number,
  ruleId: string,
  pattern: string,
  syntaxCategory: SecurityFinding['syntaxCategory'],
  confidence: SecurityFinding['confidence'],
  executable: boolean
): SecurityFinding {
  const line = lineNumberAt(content, index)
  const snippet = redactOutput(content.split(/\r?\n/)[line - 1] || '').slice(0, 240)
  const id = createHash('sha256').update(`${ruleId}\0${relPath}\0${line}\0${snippet}`).digest('hex').slice(0, 16)
  return { id, ruleId, path: relPath, line, pattern, syntaxCategory, confidence, executable, snippet }
}

function scanJavaScriptNetworkUsage(content: string, relPath: string): SecurityFinding[] {
  const { masked, literals } = maskJavaScriptInertText(content)
  const findings: SecurityFinding[] = []
  const seen = new Set<string>()
  const add = (index: number, ruleId: string, pattern: string, syntaxCategory: SecurityFinding['syntaxCategory']) => {
    const key = `${ruleId}:${index}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push(securityFinding(content, relPath, index, ruleId, pattern, syntaxCategory, 'high', true))
  }
  const runRule = (ruleId: string, pattern: string, expression: RegExp) => {
    for (const match of masked.matchAll(expression)) add(match.index || 0, ruleId, pattern, 'CallExpression')
  }

  runRule('forbidden_upload_network.fetch_member_call', 'network_fetch', /\b(?:globalThis|window|self)\s*\.\s*fetch\s*\(/g)
  for (const match of masked.matchAll(/\bfetch\s*\(/g)) {
    const index = match.index || 0
    const prefix = masked.slice(0, index).trimEnd()
    if (prefix.endsWith('.')) continue
    add(index, 'forbidden_upload_network.fetch_call', 'network_fetch', 'CallExpression')
  }
  runRule('forbidden_upload_network.axios_member_call', 'network_fetch', /\baxios\s*\.\s*(?:get|post|put|patch|delete|request|head|options)\s*\(/g)
  runRule('forbidden_upload_network.axios_call', 'network_fetch', /\baxios\s*\(/g)
  runRule('forbidden_upload_network.xml_http_request', 'network_fetch', /\b(?:new\s+)?XMLHttpRequest\s*\(/g)
  runRule('forbidden_upload_network.curl_or_wget_call', 'curl_or_wget', /\b(?:curl|wget)\s*\(/g)
  runRule('forbidden_upload_network.form_data_call', 'upload_keyword', /\b(?:new\s+)?FormData\s*\(/g)
  runRule('forbidden_upload_network.upload_call', 'upload_keyword', /\bupload\s*\(/gi)

  for (const literal of literals) {
    const moduleName = literal.value.toLowerCase()
    if (moduleName !== 'node-fetch' && moduleName !== 'axios') continue
    const lineStart = masked.lastIndexOf('\n', literal.start) + 1
    const prefix = masked.slice(lineStart, literal.start)
    if (/\bfrom\s*$/.test(prefix) || /\brequire\s*\(\s*$/.test(prefix) || /\bimport\s*\(\s*$/.test(prefix)) {
      add(literal.start, `forbidden_upload_network.${moduleName === 'axios' ? 'axios' : 'node_fetch'}_import`, 'network_fetch', 'ImportDeclaration')
    }
  }

  return findings.sort((left, right) => left.line - right.line || left.ruleId.localeCompare(right.ruleId) || left.id.localeCompare(right.id))
}

function scanSecurityPaths(request: SafeCommandRequest): SafeCommandResult {
  const paths = assertExplicitPaths(request.paths)
  const patternSet = request.patternSet || 'forbidden_all_high_risk'
  const patterns = patternList(patternSet)
  const includesNetworkRules = patternSet === 'forbidden_upload_network' || patternSet === 'forbidden_all_high_risk'
  const findings: SecurityFinding[] = []

  for (const relPath of paths) {
    const fullPath = resolveSafePath(path.resolve(request.sourceRoot), relPath)
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) throw new Error(`scan path not found: ${relPath}`)
    const size = fs.statSync(fullPath).size
    if (size > TEXT_SCAN_MAX_BYTES) throw new Error(`scan file too large: ${relPath}`)
    const content = fs.readFileSync(fullPath, 'utf8')
    const isJavaScriptSource = JAVASCRIPT_SOURCE_EXTENSIONS.has(path.extname(relPath).toLowerCase())

    if (includesNetworkRules && isJavaScriptSource) findings.push(...scanJavaScriptNetworkUsage(content, relPath))

    const lexicalPatterns = includesNetworkRules && isJavaScriptSource
      ? patterns.filter(entry => !NETWORK_PATTERN_NAMES.has(entry.name))
      : patterns
    const lines = content.split(/\r?\n/)
    let offset = 0
    lines.forEach(line => {
      for (const entry of lexicalPatterns) {
        if (!entry.pattern.test(line)) continue
        if (isJavaScriptSource && entry.name === 'secret_assignment') {
          const assignmentIndex = line.indexOf('=') >= 0 ? line.indexOf('=') : line.indexOf(':')
          const rightHandSide = assignmentIndex >= 0 ? line.slice(assignmentIndex + 1).trimStart() : ''
          const assemblesKnownNetworkToken = rightHandSide.startsWith('[')
            && /\.join\(\s*['"]{2}\s*\)/.test(rightHandSide)
            && /\b(fetch|axios|XMLHttpRequest|curl|wget|upload|multipart|formData)\b/i.test(rightHandSide)
          if (assemblesKnownNetworkToken) continue
        }
        findings.push(securityFinding(content, relPath, offset, `${patternSet}.${entry.name}`, entry.name, 'LexicalFallback', 'medium', true))
      }
      offset += line.length + 1
    })
  }

  findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.ruleId.localeCompare(right.ruleId) || left.id.localeCompare(right.id))

  return {
    status: findings.length === 0 ? 'completed' : 'failed',
    commandKind: request.commandKind,
    command: ['buildflow', 'security_scan_paths', patternSet],
    cwd: path.resolve(request.sourceRoot),
    exitCode: findings.length === 0 ? 0 : 1,
    signal: null,
    stdout: JSON.stringify({ findings }, null, 2),
    stderr: '',
    outputTruncated: false,
    durationMs: 0,
    details: { findings }
  }
}
