import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { getActiveSourceContext, getEnabledSources, loadConfig } from './config'
import { containsProtectedRepositoryContent, evaluateConnectedRepositoryPath } from '@workbench/shared'

export type WriteChangeType =
  | 'create'
  | 'append'
  | 'overwrite'
  | 'patch'
  | 'delete_file'
  | 'delete_directory'
  | 'move'
  | 'rename'
  | 'mkdir'
  | 'rmdir'

export type MaintainerWriteProfile = 'repo_app_write' | 'repo_app_maintainer'

export type WritePolicySummary = {
  allowCreate: boolean
  allowOverwrite: boolean
  allowAppend: boolean
  allowPatch: boolean
  allowCreateParentDirectories: boolean
  allowDelete: boolean
  allowDeleteDirectory: boolean
  allowMove: boolean
  allowRename: boolean
  allowMkdir: boolean
  allowRmdir: boolean
  recursiveDeleteRequiresConfirmation: boolean
  maxRecursiveDeleteFilesWithoutConfirmation: number
  allowedRoots: string[]
  blockedGlobs: string[]
  blockedWriteGlobs: string[]
  generatedDeleteAllowedGlobs: string[]
  confirmationRequiredGlobs: string[]
  protectedWriteGlobs: string[]
  protectedGlobs: string[]
  blockedContentPatterns: string[]
  binaryWriteBlocked: boolean
  binaryDeleteAllowedWithConfirmation: boolean
  maxWriteBytes: number
  maxCreateBytes: number
  maxOverwriteBytes: number
  maxPatchTargetBytes: number
}

export type WriteValidationErrorCode =
  | 'WRITE_PATH_BLOCKED'
  | 'PROTECTED_PATH'
  | 'PARENT_DIRECTORY_MISSING'
  | 'CREATE_NOT_ALLOWED'
  | 'OVERWRITE_NOT_ALLOWED'
  | 'APPEND_NOT_ALLOWED'
  | 'PATCH_NOT_ALLOWED'
  | 'DELETE_NOT_ALLOWED'
  | 'MOVE_NOT_ALLOWED'
  | 'RENAME_NOT_ALLOWED'
  | 'MKDIR_NOT_ALLOWED'
  | 'RMDIR_NOT_ALLOWED'
  | 'PATCH_FIND_NOT_FOUND'
  | 'PATCH_MULTIPLE_MATCHES'
  | 'SOURCE_NOT_WRITABLE'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_NOT_FOUND'
  | 'PATH_TRAVERSAL_BLOCKED'
  | 'ABSOLUTE_PATH_BLOCKED'
  | 'PATH_NOT_ALLOWED'
  | 'SECRET_PATH_BLOCKED'
  | 'SECRET_FILE_BLOCKED'
  | 'SECRET_PATTERN_BLOCKED'
  | 'GENERATED_FILE_BLOCKED'
  | 'GENERATED_WRITE_BLOCKED'
  | 'LOCKFILE_WRITE_BLOCKED'
  | 'BINARY_FILE_BLOCKED'
  | 'BINARY_WRITE_BLOCKED'
  | 'BINARY_DELETE_REQUIRES_CONFIRMATION'
  | 'DIRECTORY_NOT_EMPTY'
  | 'TARGET_ALREADY_EXISTS'
  | 'SOURCE_PATH_NOT_FOUND'
  | 'INVALID_CONFIRMATION_TOKEN'
  | 'CONFIRMATION_TOKEN_EXPIRED'
  | 'FILE_TOO_LARGE'
  | 'INVALID_ENCODING'
  | 'VERIFY_FAILED'
  | 'REQUIRES_EXPLICIT_CONFIRMATION'
  | 'OPERATION_NOT_SUPPORTED'

export type WritePreflightResult = {
  status: 'allowed' | 'needs_confirmation' | 'blocked'
  code?: WriteValidationErrorCode
  sourceId?: string
  operation: WriteChangeType
  requestedPath: string
  normalizedPath: string
  from?: string
  to?: string
  reason: string
  hint: string
  matchedAllowGlob?: string
  matchedBlockGlob?: string
  matchedConfirmationGlob?: string
  exists?: boolean
  isDirectory?: boolean
  directoryEmpty?: boolean
  recursiveDeleteCount?: number
  recursiveDirectoryCount?: number
  wouldWrite?: boolean
  wouldDelete?: boolean
  wouldMove?: boolean
  wouldCreateDirectory?: boolean
  requiresConfirmation: boolean
  confirmationToken?: string
  verified: false
}

export type WriteValidationError = {
  code: WriteValidationErrorCode
  message: string
  userMessage: string
  reason: string
  hint: string
  matchedAllowGlob?: string
  matchedBlockGlob?: string
  matchedConfirmationGlob?: string
  requiresConfirmation: boolean
}

export type WriteValidationResult =
  | {
      ok: true
      requestedPath: string
      normalizedPath: string
      sourceRootRelativePath: string
      fullPath: string
      parentPath: string
      policy: WritePolicySummary
    }
  | {
      ok: false
      requestedPath: string
      normalizedPath: string
      sourceRootRelativePath: string
      error: WriteValidationError
      policy: WritePolicySummary
    }

const ENV_TEMPLATE_FILES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example'
])

const BLOCKED_WRITE_PATTERNS = [
  /\.pem$/i,
  /\.key$/i,
  /\.crt$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_dsa$/i,
  /(^|\/)id_ed25519$/i,
  /(^|\/)secrets(\/|$)/i,
  /(^|\/)secret(\/|$)/i,
  /(^|\/)credentials(\/|$)/i,
  /(^|\/)[^/]*private_key[^/]*$/i,
  /(^|\/)[^/]*credential[^/]*$/i,
  /(^|\/)[^/]*token[^/]*$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)\.next(\/|$)/i,
  /(^|\/)dist(\/|$)/i,
  /(^|\/)build(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)generated(\/|$)/i,
  /(^|\/)vendor(\/|$)/i,
  /(^|\/)\.cache(\/|$)/i,
  /(^|\/)\.turbo(\/|$)/i,
  /(^|\/)\.vercel(\/|$)/i,
  /(^|\/)\.npm(\/|$)/i,
  /(^|\/)\.yarn(\/|$)/i,
  /(^|\/)\.pnpm-store(\/|$)/i,
  /(^|\/)\.prisma\/client(\/|$)/i
]

const SAFE_ROOT_WRITE_FILES = new Set([
  'README.md',
  'DESIGN.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'ROADMAP.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  '.gitignore',
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
  '.env.development.example',
  '.env.production.example'
])

const SAFE_WRITE_ROOTS = [
  'src',
  'app',
  'components',
  'lib',
  'pages',
  'server',
  'client',
  'shared',
  'features',
  'modules',
  'utils',
  'hooks',
  'services',
  'styles',
  'types',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'playwright',
  'cypress',
  'prisma',
  'scripts',
  'bin',
  'tools',
  'ai/skills',
  'operations/runbooks',
  'operations/specs/video-orchestrator',
  'projects/probot/src',
  'apps/web',
  'docs',
  'docs/product',
  'docs/product/releases',
  'docs/product/plans',
  'docs/product/prompts',
  'docs/product/notes',
  'docs/plans',
  'docs/prompts',
  'docs/notes',
  'plans',
  'notes',
  'artifacts',
  'projects',
  '.buildflow'
]

const PROTECTED_FILES = new Set<string>()
const BLOCKED_DIRECTORY_NAMES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.git'])
const ALLOWED_DOTFILES = new Set(['.github', '.kiro', '.ai', '.env.example', '.env.sample', '.env.template', '.env.local.example', '.env.development.example', '.env.production.example', '.gitignore', '.buildflow', '.nvmrc', '.prettierrc', '.eslintrc'])
const CONFIRMATION_REQUIRED_GLOBS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '.github/**', 'LICENSE']
const BLOCKED_CONTENT_PATTERNS = [
  ['BEGIN RSA PRIVATE', ' KEY'].join(''),
  ['BEGIN OPENSSH PRIVATE', ' KEY'].join(''),
  ['BEGIN EC PRIVATE', ' KEY'].join(''),
  ['gh', 'p_'].join(''),
  ['github', '_pat_'].join(''),
  ['sk', '_live_'].join(''),
  ['rk', '_live_'].join(''),
  ['xo', 'xb-'].join(''),
  ['AK', 'IA'].join(''),
  ['AI', 'za'].join('')
]
const STATIC_ASSET_EXTENSIONS = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.bmp',
  '.tiff',
  '.avif',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.tar',
  '.tgz'
])
const STATIC_ASSET_ROOT_PATTERNS = [
  'public/**',
  'assets/**',
  'static/**',
  'docs/assets/**',
  'docs/images/**',
  'docs/media/**'
]

const DOCKER_CONFIG_BASENAMES = /^(docker-compose(\.[a-z0-9_-]+)?\.ya?ml|compose(\.[a-z0-9_-]+)?\.ya?ml|Dockerfile(\.[a-z0-9_-]+)?|\.dockerignore)$/i

export function isDockerConfigPath(normalizedPath: string): boolean {
  const basename = path.basename(normalizedPath)
  return DOCKER_CONFIG_BASENAMES.test(basename)
}

export function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath) return false
  const normalized = relativePath.replace(/\\/g, '/')
  if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) return false
  return true
}

export function normalizeRepoRelativePath(requestedPath: string): string {
  return requestedPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

export function getDefaultWritePolicy(): WritePolicySummary {
  return {
    allowCreate: true,
    allowOverwrite: true,
    allowAppend: true,
    allowPatch: true,
    allowCreateParentDirectories: true,
    allowDelete: true,
    allowDeleteDirectory: true,
    allowMove: true,
    allowRename: true,
    allowMkdir: true,
    allowRmdir: true,
    recursiveDeleteRequiresConfirmation: true,
    maxRecursiveDeleteFilesWithoutConfirmation: 0,
    // Kept for response compatibility. Repository scope is the authorization boundary;
    // protected resources are denied centrally rather than allowlisted by folder.
    allowedRoots: ['**'],
    blockedGlobs: ['.env', '.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/known_hosts', '.git/**', '.ssh/**', '.gnupg/**', '.aws/**', '.azure/**', '.kube/**', 'ai/private/**', 'ai/secrets/**'],
    blockedWriteGlobs: [],
    generatedDeleteAllowedGlobs: [],
    confirmationRequiredGlobs: CONFIRMATION_REQUIRED_GLOBS,
    protectedWriteGlobs: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', '.github/**', 'LICENSE'],
    protectedGlobs: [],
    blockedContentPatterns: BLOCKED_CONTENT_PATTERNS,
    binaryWriteBlocked: true,
    binaryDeleteAllowedWithConfirmation: true,
    maxWriteBytes: 1_000_000,
    maxCreateBytes: 200_000,
    maxOverwriteBytes: 300_000,
    maxPatchTargetBytes: 1_000_000
  }
}

/**
 * Resolves the effective write policy for a source. Source-specific array fields
 * (allowedRoots, generatedDeleteAllowedGlobs, protectedGlobs, protectedWriteGlobs,
 * blockedGlobs, blockedWriteGlobs, confirmationRequiredGlobs, blockedContentPatterns)
 * are merged additively with the default so that default protections are never removed.
 * Scalar fields (booleans, numbers) use the source override when explicitly set, otherwise
 * fall back to the default. Policy is always resolved server-side from the registered
 * source record — never accepted from the client.
 */
export function resolveSourceWritePolicy(sourceId?: string): WritePolicySummary {
  const def = getDefaultWritePolicy()
  if (!sourceId) return def

  try {
    const config = loadConfig()
    const source = config?.sources?.find(s => s.id === sourceId)
    const raw = source?.writePolicy
    if (!raw || typeof raw !== 'object') return def

    const overlay = raw as Record<string, unknown>

    // Array fields: merge additively (source additions beyond the default baseline)
    const mergeArrayField = (field: keyof WritePolicySummary): string[] => {
      const base = def[field] as string[]
      const extra = overlay[field]
      if (!Array.isArray(extra)) return base
      const combined = [...base]
      for (const item of extra) {
        if (typeof item === 'string' && !combined.includes(item)) combined.push(item)
      }
      return combined
    }

    // Scalar fields: use source override only when explicitly present and correct type
    const scalarBool = (field: keyof WritePolicySummary): boolean => {
      const v = overlay[field]
      return typeof v === 'boolean' ? v : (def[field] as boolean)
    }
    const scalarNum = (field: keyof WritePolicySummary): number => {
      const v = overlay[field]
      return typeof v === 'number' ? v : (def[field] as number)
    }

    return {
      allowCreate: scalarBool('allowCreate'),
      allowOverwrite: scalarBool('allowOverwrite'),
      allowAppend: scalarBool('allowAppend'),
      allowPatch: scalarBool('allowPatch'),
      allowCreateParentDirectories: scalarBool('allowCreateParentDirectories'),
      allowDelete: scalarBool('allowDelete'),
      allowDeleteDirectory: scalarBool('allowDeleteDirectory'),
      allowMove: scalarBool('allowMove'),
      allowRename: scalarBool('allowRename'),
      allowMkdir: scalarBool('allowMkdir'),
      allowRmdir: scalarBool('allowRmdir'),
      recursiveDeleteRequiresConfirmation: scalarBool('recursiveDeleteRequiresConfirmation'),
      maxRecursiveDeleteFilesWithoutConfirmation: scalarNum('maxRecursiveDeleteFilesWithoutConfirmation'),
      allowedRoots: ['**'],
      blockedGlobs: def.blockedGlobs,
      blockedWriteGlobs: [],
      generatedDeleteAllowedGlobs: [],
      confirmationRequiredGlobs: mergeArrayField('confirmationRequiredGlobs'),
      protectedWriteGlobs: mergeArrayField('protectedWriteGlobs'),
      protectedGlobs: mergeArrayField('protectedGlobs'),
      blockedContentPatterns: mergeArrayField('blockedContentPatterns'),
      binaryWriteBlocked: scalarBool('binaryWriteBlocked'),
      binaryDeleteAllowedWithConfirmation: scalarBool('binaryDeleteAllowedWithConfirmation'),
      maxWriteBytes: scalarNum('maxWriteBytes'),
      maxCreateBytes: scalarNum('maxCreateBytes'),
      maxOverwriteBytes: scalarNum('maxOverwriteBytes'),
      maxPatchTargetBytes: scalarNum('maxPatchTargetBytes')
    }
  } catch {
    return def
  }
}

export function isWithinAllowedRoots(normalized: string, policy?: WritePolicySummary): boolean {
  const effectivePolicy = policy ?? getDefaultWritePolicy()
  if (!normalized) return false
  if (isStaticAssetPath(normalized)) return false
  if (normalized === 'public' || normalized.startsWith('public/')) return true
  if (!normalized.includes('/') && SAFE_ROOT_WRITE_FILES.has(normalized)) return true
  if (effectivePolicy.allowedRoots.some(pattern => matchesGlob(pattern, normalized))) return true
  if (normalized.endsWith('.md') || normalized.endsWith('.mdx') || normalized.endsWith('.txt') || normalized.endsWith('.json') || normalized.endsWith('.ts') || normalized.endsWith('.tsx') || normalized.endsWith('.js') || normalized.endsWith('.jsx') || normalized.endsWith('.mjs') || normalized.endsWith('.cjs') || normalized.endsWith('.cts') || normalized.endsWith('.mts') || normalized.endsWith('.css') || normalized.endsWith('.scss') || normalized.endsWith('.sass') || normalized.endsWith('.html') || normalized.endsWith('.sql') || normalized.endsWith('.prisma') || normalized.endsWith('.graphql') || normalized.endsWith('.gql') || normalized.endsWith('.yaml') || normalized.endsWith('.yml') || normalized.endsWith('.toml') || normalized.endsWith('.sh') || normalized.endsWith('.bash') || normalized.endsWith('.zsh')) return true
  return SAFE_WRITE_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

/**
 * Extensionless Git staging has no file-type signal, so new files must land in
 * one of the ordinary text/source roots even though normal repository writes
 * remain bounded by the broader source-root policy.
 */
export function isWithinOrdinaryWriteRoots(normalized: string, policy?: WritePolicySummary): boolean {
  const effectivePolicy = policy ?? getDefaultWritePolicy()
  if (!normalized || isStaticAssetPath(normalized)) return false
  if (normalized === 'public' || normalized.startsWith('public/')) return true
  if (!normalized.includes('/') && SAFE_ROOT_WRITE_FILES.has(normalized)) return true
  if (effectivePolicy.allowedRoots.some(pattern => pattern !== '**' && matchesGlob(pattern, normalized))) return true
  return SAFE_WRITE_ROOTS.some(root => normalized === root || normalized.startsWith(`${root}/`))
}

function classifyConnectedRepositoryPath(normalized: string): { code: WriteValidationErrorCode; reason: string; message: string; hint: string } | null {
  const protection = evaluateConnectedRepositoryPath(normalized)
  if (protection) return { code: protection.code, reason: protection.reason, message: protection.message, hint: protection.hint }
  if (PROTECTED_FILES.has(path.basename(normalized))) {
    return { code: 'PROTECTED_PATH', reason: 'protected_file', message: 'This file is protected by policy.', hint: 'Use a repository file outside the protected security boundary.' }
  }
  return null
}

function classifyBlockedPath(normalized: string): { code: WriteValidationErrorCode; reason: string; message: string; hint: string } | null {
  const posixPath = normalized.replace(/\\/g, '/')
  const normalizedPosixPath = path.posix.normalize(posixPath)
  if (path.posix.isAbsolute(posixPath) || path.isAbsolute(normalized)) {
    return { code: 'ABSOLUTE_PATH_BLOCKED', reason: 'absolute_path', message: 'Absolute paths outside the repo are blocked.', hint: 'Use a repo-relative path inside the connected source.' }
  }
  const pathSegments = posixPath.split('/')
  if (pathSegments.some(segment => segment === '..') || normalizedPosixPath === '..' || normalizedPosixPath.startsWith('../')) {
    return { code: 'PATH_TRAVERSAL_BLOCKED', reason: 'path_traversal', message: 'Path traversal outside the repo is blocked.', hint: 'Use a normalized path within the connected source root.' }
  }
  if (ENV_TEMPLATE_FILES.has(path.basename(normalized))) {
    return null
  }
  if (isDockerConfigPath(normalized)) {
    return null
  }
  if (/(\.env(\..*)?)$/i.test(normalized) || /(^|\/)\.env(\..*)?$/i.test(normalized)) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'Files that may contain secrets are blocked.', hint: 'Choose a documentation path instead of an environment file.' }
  }
  if (/(^|\/)ai\/(private|secrets)(\/|$)/i.test(normalized)) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'Private or secret AI paths are blocked.', hint: 'Use ai/skills/** for skill content and keep private notes elsewhere.' }
  }
  if (normalized.split('/').some(part => part === '.next' || part === 'dist' || part === 'build' || part === 'coverage' || part === '.cache' || part === '.turbo' || part === '.vercel' || part === '.npm' || part === '.yarn' || part === '.pnpm-store' || part === 'generated' || part === '.prisma')) {
    return { code: 'GENERATED_WRITE_BLOCKED', reason: 'generated_write', message: 'Generated or build output paths are blocked.', hint: 'Write to the source file or a repo note instead.' }
  }
  if (normalized.split('/').some(part => BLOCKED_DIRECTORY_NAMES.has(part))) {
    return { code: 'PROTECTED_PATH', reason: 'protected_directory', message: 'Protected runtime directories are blocked.', hint: 'Write outside build, dist, node_modules, or .git directories.' }
  }
  if (BLOCKED_WRITE_PATTERNS.some(pattern => pattern.test(normalized))) {
    return { code: 'SECRET_PATH_BLOCKED', reason: 'secret_path', message: 'This path looks like a secret or credential file.', hint: 'Use a docs or project note path instead.' }
  }
  if (PROTECTED_FILES.has(path.basename(normalized))) {
    return { code: 'PROTECTED_PATH', reason: 'protected_file', message: 'This file is protected by policy.', hint: 'Use a docs path or update the source write policy if intentional.' }
  }
  return null
}

function matchesGlob(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DOUBLESTAR::').replace(/\*/g, '[^/]*').replace(/::DOUBLESTAR::/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function matchesGlobAny(patterns: string[] | undefined, value: string): boolean {
  if (!Array.isArray(patterns)) return false
  return patterns.some(pattern => matchesGlob(pattern, value))
}

function buildConfirmationError(reason: string, hint: string): WriteValidationError {
  return { code: 'REQUIRES_EXPLICIT_CONFIRMATION', message: 'This change requires explicit confirmation.', userMessage: 'BuildFlow needs explicit confirmation before making this change.', reason, hint, requiresConfirmation: true }
}

export function buildWriteConfirmationToken(sourceId: string | undefined, operation: WriteChangeType, normalizedPath: string, toPath?: string): string {
  return `confirm:${sourceId || ''}:${operation}:${normalizedPath}${toPath ? `->${normalizeRepoRelativePath(toPath)}` : ''}`
}

export function hasValidWriteConfirmation(params: {
  sourceId?: string
  changeType: WriteChangeType
  normalizedPath: string
  toPath?: string
  confirmedByUser?: boolean
  confirmationToken?: string
}): boolean {
  if (params.confirmedByUser === true) return true
  if (typeof params.confirmationToken !== 'string' || !params.confirmationToken) return false
  return params.confirmationToken === buildWriteConfirmationToken(params.sourceId, params.changeType, params.normalizedPath, params.toPath)
}

function isConfirmationRequiredPath(normalizedPath: string): boolean {
  return CONFIRMATION_REQUIRED_GLOBS.some(pattern => matchesGlob(pattern, normalizedPath))
}

function isGitTracked(sourceRoot: string | undefined, normalizedPath: string): boolean {
  if (!sourceRoot) return false
  try {
    const root = path.resolve(sourceRoot)
    if (!fs.existsSync(path.join(root, '.git'))) return false
    execFileSync('git', ['ls-files', '--error-unmatch', '--', normalizedPath], { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    try {
      const root = path.resolve(sourceRoot)
      execFileSync('git', ['cat-file', '-e', `HEAD:${normalizedPath}`], { cwd: root, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
}

function isStaticAssetPath(normalizedPath: string): boolean {
  const ext = path.extname(normalizedPath).toLowerCase()
  return STATIC_ASSET_EXTENSIONS.has(ext) && STATIC_ASSET_ROOT_PATTERNS.some(pattern => matchesGlob(pattern, normalizedPath))
}

export function isDeleteOnlyTrackedBinaryAllowed(params: {
  sourceId?: string
  sourceRoot?: string
  normalizedPath: string
  changeType: WriteChangeType
  confirmedByUser?: boolean
  confirmationToken?: string
}): boolean {
  if (params.changeType !== 'delete_file') return false
  if (!isStaticAssetPath(params.normalizedPath)) return false
  if (!hasValidWriteConfirmation({
    sourceId: params.sourceId,
    changeType: params.changeType,
    normalizedPath: params.normalizedPath,
    confirmedByUser: params.confirmedByUser,
    confirmationToken: params.confirmationToken
  })) return false
  return isGitTracked(params.sourceRoot, params.normalizedPath)
}

function isDependencyChange(content?: string): boolean {
  if (typeof content !== 'string' || !content.trim()) return false
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return Boolean(parsed.dependencies || parsed.devDependencies || parsed.peerDependencies || parsed.optionalDependencies)
  } catch {
    return false
  }
}

export function validateWriteTarget(params: {
  sourceId?: string
  requestedPath: string
  changeType: WriteChangeType
  sourceRoot?: string
  allowCreateParentDirectories?: boolean
  content?: string
  toPath?: string
  confirmedByUser?: boolean
  confirmationToken?: string
}): WriteValidationResult {
  const policy = resolveSourceWritePolicy(params.sourceId)
  const requestedPath = params.requestedPath || ''
  const rawRequestedPath = requestedPath.replace(/\\/g, '/').trim()
  const normalizedPath = normalizeRepoRelativePath(requestedPath)
  const sourceRootRelativePath = normalizedPath

  if (!requestedPath || !normalizedPath) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'WRITE_PATH_BLOCKED', message: 'This path is blocked by the source write policy.', userMessage: 'BuildFlow can read this file, but it needs a valid repo-relative path to write it.', reason: 'empty_path', hint: 'Provide a repo-relative path like docs/README.md.', requiresConfirmation: false } }
  }

  if (rawRequestedPath.startsWith('/')) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'ABSOLUTE_PATH_BLOCKED', message: 'Absolute paths outside the repo are blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'absolute_path', hint: 'Use a repo-relative path inside the source root.', requiresConfirmation: false } }
  }

  const blocked = classifyConnectedRepositoryPath(normalizedPath)
  if (blocked) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: blocked.code, message: blocked.message, userMessage: blocked.message, reason: blocked.reason, hint: blocked.hint, requiresConfirmation: false } }
  }

  // Enforce source-specific protectedGlobs and protectedWriteGlobs as hard blocks,
  // but only when the path is NOT already covered by confirmationRequiredGlobs —
  // those paths remain confirmation-gated per existing contract.
  const isConfirmationPath = matchesGlobAny(policy.confirmationRequiredGlobs, normalizedPath)
  if (!isConfirmationPath && matchesGlobAny(policy.protectedGlobs, normalizedPath)) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PROTECTED_PATH', message: 'This path is protected by the source write policy.', userMessage: 'BuildFlow cannot write to this protected path.', reason: 'protected_glob', hint: 'This path is listed in the source write policy protectedGlobs.', requiresConfirmation: false } }
  }
  const writeOperation0 = params.changeType === 'create' || params.changeType === 'overwrite' || params.changeType === 'append' || params.changeType === 'patch' || params.changeType === 'move' || params.changeType === 'rename'
  if (!isConfirmationPath && writeOperation0 && matchesGlobAny(policy.protectedWriteGlobs, normalizedPath)) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PROTECTED_PATH', message: 'This path is protected by the source write policy.', userMessage: 'BuildFlow cannot write to this protected path.', reason: 'protected_write_glob', hint: 'This path is listed in the source write policy protectedWriteGlobs.', requiresConfirmation: false } }
  }

  const deleteOperation = params.changeType === 'delete_file' || params.changeType === 'delete_directory' || params.changeType === 'rmdir'
  const writeOperation = params.changeType === 'create' || params.changeType === 'overwrite' || params.changeType === 'append' || params.changeType === 'patch'
  if (writeOperation && policy.binaryWriteBlocked && STATIC_ASSET_EXTENSIONS.has(path.extname(normalizedPath).toLowerCase())) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'BINARY_WRITE_BLOCKED', message: 'Binary/static asset writes are blocked by policy.', userMessage: 'BuildFlow can delete confirmed tracked static assets, but it cannot create, overwrite, or modify binary/static asset files.', reason: 'binary_write_blocked', hint: 'Use a text source path, or delete an already tracked asset with explicit confirmation.', requiresConfirmation: false } }
  }
  const trackedStaticAssetDeleteAllowed = isDeleteOnlyTrackedBinaryAllowed({
    sourceId: params.sourceId,
    sourceRoot: params.sourceRoot,
    normalizedPath,
    changeType: params.changeType,
    confirmedByUser: params.confirmedByUser,
    confirmationToken: params.confirmationToken
  })
  if (deleteOperation && policy.binaryDeleteAllowedWithConfirmation && isStaticAssetPath(normalizedPath) && !trackedStaticAssetDeleteAllowed) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'BINARY_DELETE_REQUIRES_CONFIRMATION', message: 'Deleting a binary/static asset requires confirmation and an existing tracked file.', userMessage: 'Confirm deletion of an existing tracked binary/static asset before continuing.', reason: 'binary_delete_confirmation', hint: 'Confirm the delete and ensure the asset is tracked by Git.', requiresConfirmation: true } }
  }
  if (isConfirmationRequiredPath(normalizedPath) && !hasValidWriteConfirmation({
    sourceId: params.sourceId,
    changeType: params.changeType,
    normalizedPath,
    toPath: params.toPath,
    confirmedByUser: params.confirmedByUser,
    confirmationToken: params.confirmationToken
  })) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: buildConfirmationError('confirmation_required_path', 'Explicitly confirm before editing lockfiles, GitHub workflows, LICENSE, or Prisma migrations.') }
  }

  if (isDockerConfigPath(normalizedPath) && (params.changeType === 'delete_file' || params.changeType === 'move' || params.changeType === 'rename') && !hasValidWriteConfirmation({
    sourceId: params.sourceId,
    changeType: params.changeType,
    normalizedPath,
    toPath: params.toPath,
    confirmedByUser: params.confirmedByUser,
    confirmationToken: params.confirmationToken
  })) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: buildConfirmationError('docker_config_confirmation_required', 'Explicitly confirm before deleting or moving Docker configuration files.') }
  }

  if (normalizedPath === 'package.json' && (params.changeType === 'create' || params.changeType === 'overwrite')) {
    if (typeof params.content === 'string') {
      try {
        JSON.parse(params.content)
      } catch {
        return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'INVALID_ENCODING', message: 'Package.json content must be valid JSON.', userMessage: 'BuildFlow could not parse package.json content.', reason: 'invalid_json', hint: 'Provide valid JSON before writing package.json.', requiresConfirmation: false } }
      }
    }
  }

  if (typeof params.content === 'string') {
    const byteLength = Buffer.byteLength(params.content, 'utf8')
    const maxBytes = params.changeType === 'create' ? policy.maxCreateBytes : params.changeType === 'overwrite' ? policy.maxOverwriteBytes : policy.maxPatchTargetBytes
    if (byteLength > maxBytes) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'FILE_TOO_LARGE', message: 'The write exceeds the configured size limit.', userMessage: 'BuildFlow is not allowed to write content this large without a smaller change.', reason: 'content_too_large', hint: 'Reduce the file size or split the change into smaller edits.', requiresConfirmation: false } }
    }
    if (containsProtectedRepositoryContent(params.content) || BLOCKED_CONTENT_PATTERNS.some(pattern => params.content.includes(pattern))) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'SECRET_PATTERN_BLOCKED', message: 'The content looks like it contains a secret.', userMessage: 'BuildFlow will not write content that looks like a real secret or private key.', reason: 'blocked_content_pattern', hint: 'Replace secrets with placeholders such as [REDACTED] or <token>.', requiresConfirmation: false } }
    }
    if (/[\u0000]/.test(params.content)) {
      return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'BINARY_WRITE_BLOCKED', message: 'Binary content is blocked by policy.', userMessage: 'BuildFlow only writes text files with the general repo-write profile.', reason: 'binary_content', hint: 'Use a text-based file or a dedicated binary upload path.', requiresConfirmation: false } }
    }
  }

  if (params.changeType === 'create' && !policy.allowCreate) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'CREATE_NOT_ALLOWED', message: 'Create is blocked by policy.', userMessage: 'BuildFlow is not allowed to create files here.', reason: 'create_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'overwrite' && !policy.allowOverwrite) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'OVERWRITE_NOT_ALLOWED', message: 'Overwrite is blocked by policy.', userMessage: 'BuildFlow is not allowed to overwrite files here.', reason: 'overwrite_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'append' && !policy.allowAppend) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'APPEND_NOT_ALLOWED', message: 'Append is blocked by policy.', userMessage: 'BuildFlow is not allowed to append to files here.', reason: 'append_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'patch' && !policy.allowPatch) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PATCH_NOT_ALLOWED', message: 'Patch is blocked by policy.', userMessage: 'BuildFlow is not allowed to patch files here.', reason: 'patch_blocked', hint: 'Use an allowed docs path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'delete_file' && !policy.allowDelete) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'DELETE_NOT_ALLOWED', message: 'Delete is blocked by policy.', userMessage: 'BuildFlow is not allowed to delete files here.', reason: 'delete_blocked', hint: 'Use an allowed cleanup path or update the source policy.', requiresConfirmation: false } }
  }
  if ((params.changeType === 'delete_directory' || params.changeType === 'rmdir') && !policy.allowDeleteDirectory) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'DELETE_NOT_ALLOWED', message: 'Directory delete is blocked by policy.', userMessage: 'BuildFlow is not allowed to delete directories here.', reason: 'delete_directory_blocked', hint: 'Use an allowed cleanup path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'move' && !policy.allowMove) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'MOVE_NOT_ALLOWED', message: 'Move is blocked by policy.', userMessage: 'BuildFlow is not allowed to move files here.', reason: 'move_blocked', hint: 'Use an allowed archive path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'rename' && !policy.allowRename) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'RENAME_NOT_ALLOWED', message: 'Rename is blocked by policy.', userMessage: 'BuildFlow is not allowed to rename files here.', reason: 'rename_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }
  if (params.changeType === 'mkdir' && !policy.allowMkdir) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'MKDIR_NOT_ALLOWED', message: 'mkdir is blocked by policy.', userMessage: 'BuildFlow is not allowed to create directories here.', reason: 'mkdir_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }
  if ((params.changeType === 'delete_directory' || params.changeType === 'rmdir') && !policy.allowRmdir) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'RMDIR_NOT_ALLOWED', message: 'rmdir is blocked by policy.', userMessage: 'BuildFlow is not allowed to remove directories here.', reason: 'rmdir_blocked', hint: 'Use an allowed repo-local path or update the source policy.', requiresConfirmation: false } }
  }

  const sourceRoot = params.sourceRoot ? path.resolve(params.sourceRoot) : ''
  const fullPath = sourceRoot ? path.resolve(path.join(sourceRoot, normalizedPath)) : normalizedPath
  const parentPath = path.dirname(fullPath)
  if (sourceRoot && !isPathWithinRootAfterSymlinks(sourceRoot, fullPath)) {
    return { ok: false, requestedPath, normalizedPath, sourceRootRelativePath, policy, error: { code: 'PATH_TRAVERSAL_BLOCKED', message: 'Path traversal outside the repo is blocked.', userMessage: 'BuildFlow can only write inside the connected source root.', reason: 'path_outside_source_root', hint: 'Use a repo-relative path inside the source root.', requiresConfirmation: false } }
  }

  return { ok: true, requestedPath, normalizedPath, sourceRootRelativePath, fullPath, parentPath, policy }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export function isPathWithinRootAfterSymlinks(root: string, candidate: string): boolean {
  try {
    const rootReal = fs.realpathSync(path.resolve(root))
    let probe = path.resolve(candidate)
    const suffix: string[] = []
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe)
      if (parent === probe) return false
      suffix.unshift(path.basename(probe))
      probe = parent
    }
    const resolvedCandidate = path.resolve(fs.realpathSync(probe), ...suffix)
    return isPathWithinRoot(rootReal, resolvedCandidate)
  } catch {
    return false
  }
}

export function getSourceRoot(sourceId?: string): { id: string; path: string } {
  const sources = getEnabledSources({ includeIndexState: false })
  if (sources.length === 0) throw new Error('No enabled knowledge sources configured')
  if (sourceId) {
    const source = sources.find(s => s.id === sourceId)
    if (!source) throw new Error(`Source not found: ${sourceId}`)
    return { id: source.id, path: source.path }
  }
  return { id: sources[0].id, path: sources[0].path }
}

export function resolveTargetSourceId(sourceId?: string): string {
  const active = getActiveSourceContext()
  const enabled = getEnabledSources({ includeIndexState: false })
  if (sourceId) {
    const source = enabled.find(s => s.id === sourceId)
    if (!source) throw new Error(`Source not found: ${sourceId}`)
    return source.id
  }

  const activeIds = active.mode === 'all' ? enabled.map(s => s.id) : active.activeSourceIds
  if (activeIds.length === 1) return activeIds[0]
  throw new Error('Target sourceId required when multiple sources are active.')
}

export function getResolvedActiveSources(sourceIds?: string[]): Array<{ id: string; path: string }> {
  if (sourceIds && sourceIds.length > 0) {
    const enabled = getEnabledSources({ includeIndexState: false })
    const wanted = new Set(sourceIds)
    const resolved = enabled.filter(source => wanted.has(source.id)).map(source => ({ id: source.id, path: source.path }))
    if (resolved.length === 0) throw new Error('No matching active sources found')
    return resolved
  }

  const active = getActiveSourceContext()
  if (active.mode === 'all') {
    return getEnabledSources({ includeIndexState: false }).map(source => ({ id: source.id, path: source.path }))
  }
  return active.activeSourceIds.map(id => {
    const source = getEnabledSources({ includeIndexState: false }).find(s => s.id === id)
    if (!source) throw new Error(`Active source not found: ${id}`)
    return { id: source.id, path: source.path }
  })
}

export function resolveWithinSource(relativePath: string, sourceId?: string): { sourceId: string; fullPath: string } {
  if (!isSafeRelativePath(relativePath)) throw new Error('Access denied. Invalid relative path.')
  const source = getSourceRoot(sourceId)
  const fullPath = path.resolve(path.join(source.path, path.normalize(relativePath)))
  const root = path.resolve(source.path)
  if (!isPathWithinRootAfterSymlinks(root, fullPath)) throw new Error('Access denied. Path outside source.')
  return { sourceId: source.id, fullPath }
}

export function isBlockedWritePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (!isSafeRelativePath(normalized)) return true
  return Boolean(evaluateConnectedRepositoryPath(normalized))
}

export function isAllowedArtifactRoot(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  return isSafeRelativePath(normalized) && !evaluateConnectedRepositoryPath(normalized)
}

export function isAllowedSafeWriteRoot(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  return isSafeRelativePath(normalized) && !evaluateConnectedRepositoryPath(normalized)
}

export function shouldIncludeEntry(name: string): boolean {
  if (BLOCKED_DIRECTORY_NAMES.has(name)) return false
  if (!name.startsWith('.')) return true
  return ALLOWED_DOTFILES.has(name)
}

export function truncateContent(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const buf = Buffer.from(content, 'utf8')
  if (buf.length <= maxBytes) return { content, truncated: false }
  return { content: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
}

export function redactSecrets(content: string): string {
  return content
    // Redact double-quoted real secrets, but preserve documentation placeholders [...]
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*"(?!\[)([^"]+)"/gi, '$1="[REDACTED]"')
    // Redact single-quoted real secrets, but preserve documentation placeholders [...]
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*'(?!\[)([^']+)'/gi, "$1='[REDACTED]'")
    // Redact unquoted real secrets: alphanumeric/special chars that look like tokens
    // Skip documentation placeholders like "[generate-...]" or "[new-dev-token-only]"
    .replace(/(AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*(?!\[)([a-zA-Z0-9_\-\.]{8,})/gi, '$1=[REDACTED]')
    // Redact private keys
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
}
