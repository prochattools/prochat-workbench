import fs from 'node:fs'
import path from 'node:path'
import type { VaultSearcher } from './search'
import { prepareTaskContext, type PreparedContext } from './prepare-task-context'
import type { WorkbenchGoalDispatchInput } from './workbench-goal-dispatch'

export type NativeGoalIntent = 'read_only' | 'implementation' | 'commit' | 'push' | 'high_impact'

export type NativeGoalCompilation = {
  intent: NativeGoalIntent
  route: 'goal_dispatch' | 'roadmap' | 'blocked'
  reviewMessage: string
  dispatch?: WorkbenchGoalDispatchInput
  context?: Pick<PreparedContext, 'topFiles' | 'exactReadPlan' | 'exactEvidence' | 'timings'>
  compilerMs: number
}

export type NativeExactReplacement = {
  path: string
  find: string
  replace: string
}

const MAX_GOAL_BYTES = 4_000
const MAX_READS = 5
const MAX_SCOPE_PATHS = 5
const FALLBACK_FILES = ['README.md', 'package.json', 'Package.swift', 'pyproject.toml', 'Cargo.toml']
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'explain', 'find', 'for', 'from',
  'how', 'i', 'in', 'inspect', 'investigate', 'is', 'it', 'of', 'on', 'or',
  'please', 'review', 'show', 'the', 'this', 'to', 'why', 'with'
])

function normalizeGoal(goal: string): string {
  const normalized = goal.replace(/\s+/g, ' ').trim()
  if (!normalized) throw new Error('A goal is required.')
  if (Buffer.byteLength(normalized, 'utf8') > MAX_GOAL_BYTES) throw new Error('The goal is too long for a bounded native run.')
  return normalized
}

function hasWord(goal: string, words: readonly string[]): boolean {
  const value = goal.toLowerCase()
  return words.some(word => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(value))
}

export function classifyNativeGoal(goal: string): NativeGoalIntent {
  const value = normalizeGoal(goal).toLowerCase()
  if (/(?:do not|don't|dont|without|no)\s+(?:edit|change|write|commit|push)\b/.test(value) || /\b(?:inspect|review|read)\s+only\b/.test(value)) return 'read_only'
  const push = hasWord(value, ['push', 'publish', 'deploy', 'release'])
  const commit = hasWord(value, ['commit', 'commits'])
  const write = hasWord(value, ['change', 'create', 'delete', 'edit', 'fix', 'implement', 'patch', 'refactor', 'remove', 'rename', 'replace', 'rewrite', 'write'])
  const highImpact = hasWord(value, ['production', 'privileged', 'force', 'history', 'migration'])
  if (push) return 'push'
  if (highImpact) return 'high_impact'
  if (commit) return 'commit'
  if (write) return 'implementation'
  return 'read_only'
}

function safeRelative(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return ''
  return normalized
}

/**
 * The native mutation escape hatch is deliberately syntax-driven.  Requiring
 * explicit <<<...>>> delimiters keeps natural-language goals from silently
 * becoming writes and makes multi-line replacements deterministic.
 */
export function parseNativeExactReplacement(goal: string): NativeExactReplacement | undefined {
  const match = goal.match(/^\s*replace\s+exact\s+text\s+<<<([\s\S]{1,2000})>>>\s+with\s+<<<([\s\S]{0,2000})>>>\s+in\s+([^\s]+)\s*$/i)
  if (!match) return undefined
  const pathValue = safeRelative(match[3])
  if (!pathValue || match[1].includes('\0') || match[2].includes('\0')) return undefined
  return { path: pathValue, find: match[1], replace: match[2] }
}

function fallbackPaths(sourceRoot: string): string[] {
  return FALLBACK_FILES.filter(candidate => {
    try { return fs.statSync(path.join(sourceRoot, candidate)).isFile() } catch { return false }
  })
}

function candidatePaths(sourceRoot: string, prepared: PreparedContext): string[] {
  const candidates = [
    ...prepared.exactEvidence.map(item => item.path),
    ...prepared.exactReadPlan.map(item => item.path),
    ...prepared.topFiles.map(item => item.path),
    ...prepared.candidates.map(item => item.path),
    ...fallbackPaths(sourceRoot)
  ]
  return Array.from(new Set(candidates.map(safeRelative).filter(Boolean))).slice(0, MAX_SCOPE_PATHS)
}

function searchTerm(goal: string): string {
  const terms = goal
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .filter(item => item.length >= 3 && !STOP_WORDS.has(item))
  return terms[0] || 'TODO'
}

function readPlan(paths: string[]): NonNullable<WorkbenchGoalDispatchInput['reads']> {
  return paths.slice(0, MAX_READS).map(pathValue => ({ mode: 'read_range' as const, path: pathValue, startLine: 1, endLine: 80 }))
}

function commandPlan(goal: string, paths: string[]): NonNullable<WorkbenchGoalDispatchInput['commands']> {
  if (paths.length === 0) return [{ commandKind: 'git_status_short' as const, timeoutMs: 8_000 }]
  return [{
    commandKind: 'run_exact_command' as const,
    executable: 'rg' as const,
    args: ['-m', '1', '--max-columns', '200', '-n', '-F', searchTerm(goal), ...paths],
    timeoutMs: 8_000
  }]
}

export async function compileNativeGoal(params: {
  goal: string
  sourceId: string
  sourceRoot: string
  searcher: VaultSearcher
  paths?: string[]
  confirmedByUser?: boolean
  autoCommit?: boolean
}): Promise<NativeGoalCompilation> {
  const startedAt = Date.now()
  const goal = normalizeGoal(params.goal)
  const intent = classifyNativeGoal(goal)
  const exactReplacement = parseNativeExactReplacement(goal)
  if (exactReplacement && (intent === 'implementation' || (intent === 'commit' && params.autoCommit === true))) {
    const fullPath = path.join(params.sourceRoot, exactReplacement.path)
    let original: string
    try {
      const stat = fs.statSync(fullPath)
      if (!stat.isFile() || stat.size > 64_000) throw new Error('target is not a bounded regular file')
      original = fs.readFileSync(fullPath, 'utf8')
    } catch {
      return { intent, route: 'blocked', reviewMessage: `The exact Direct edit target could not be read: ${exactReplacement.path}`, compilerMs: Date.now() - startedAt }
    }
    const matchCount = original.split(exactReplacement.find).length - 1
    if (matchCount !== 1) {
      return {
        intent,
        route: 'blocked',
        reviewMessage: matchCount === 0
          ? `The exact Direct edit text was not found in ${exactReplacement.path}. No file was changed.`
          : `The exact Direct edit text matched ${matchCount} places in ${exactReplacement.path}; exactly one match is required.`,
        compilerMs: Date.now() - startedAt
      }
    }
    if (params.confirmedByUser !== true) {
      return {
        intent,
        route: 'blocked',
        reviewMessage: `Confirmation is required for the exact Direct edit of ${exactReplacement.path}. Re-submit the same bounded goal with confirmedByUser=true.`,
        compilerMs: Date.now() - startedAt
      }
    }
    const commitRequested = params.autoCommit === true
    const dispatch: WorkbenchGoalDispatchInput = {
      version: 1,
      expectedOutcome: `Apply one exact replacement in ${exactReplacement.path}, validate the resulting diff${commitRequested ? ', and create the exact scoped commit' : ', and stop without commit or push'}.`,
      scope: [exactReplacement.path],
      knownFiles: [exactReplacement.path],
      constraints: [
        'Read the exact target before mutation and require one exact match.',
        'Write only the selected repository-relative path.',
        commitRequested
          ? 'Validate the resulting diff, then commit only the selected path with the fixed Workbench message.'
          : 'Validate the resulting diff and stop before commit or push.'
      ],
      nonGoals: ['additional edits', ...(commitRequested ? [] : ['commit']), 'push', 'deployment'],
      stopConditions: ['The target changes before execution.', 'The exact text is absent or matches more than once.', 'A protected path or unavailable source is encountered.'],
      confirmationPolicy: 'single_exact',
      confirmedByUser: true,
      terminalResult: { style: 'natural_language', include: ['summary', 'changed_files', 'validation', ...(commitRequested ? ['commit' as const] : []), 'warnings', 'blocker'] },
      reads: [{ mode: 'read_range', path: exactReplacement.path, startLine: 1, endLine: 120 }],
      readOnly: false,
      steps: [{ type: 'patch', path: exactReplacement.path, find: exactReplacement.find, replace: exactReplacement.replace }],
      validation: [{ commandKind: 'git_diff_check', paths: [exactReplacement.path], timeoutMs: 8_000 }],
      ...(commitRequested ? { commit: { enabled: true, authorized: true, message: `Workbench: apply exact replacement in ${exactReplacement.path}` } } : {}),
      pushIntent: 'not_requested'
    }
    return { intent, route: 'goal_dispatch', reviewMessage: commitRequested
      ? 'Workbench will apply one confirmed exact replacement, validate it, and create one exact scoped commit without pushing.'
      : 'Workbench will apply one confirmed exact replacement locally, validate the diff, and stop before commit or push.', dispatch, compilerMs: Date.now() - startedAt }
  }
  if (intent !== 'read_only') {
    const reviewMessage = intent === 'push'
      ? 'Push, publish, and release requests remain behind the existing delivery authority; Workbench will not push from a native goal.'
      : intent === 'high_impact'
        ? 'This goal includes a protected or high-impact operation and must use the existing governed review path.'
        : intent === 'commit'
          ? 'Commit intent requires the existing exact-scope Git review and authorization path.'
          : 'This goal requests changes. Workbench will use the existing governed roadmap path so mutation scope is not inferred silently.'
    return { intent, route: intent === 'push' || intent === 'high_impact' ? 'blocked' : 'roadmap', reviewMessage, compilerMs: Date.now() - startedAt }
  }

  const prepared = await prepareTaskContext({
    query: goal,
    sourceIds: [params.sourceId],
    searcher: params.searcher,
    paths: params.paths,
    limit: 5,
    maxBytesPerFile: 1_200
  })
  const paths = Array.from(new Set([
    ...(params.paths || []).map(safeRelative),
    ...candidatePaths(params.sourceRoot, prepared)
  ].filter(Boolean))).slice(0, MAX_SCOPE_PATHS)
  if (paths.length === 0) {
    return {
      intent,
      route: 'blocked',
      reviewMessage: 'Workbench could not identify a bounded repository scope for this investigation. Add a narrower goal or select an exact path.',
      context: { topFiles: prepared.topFiles, exactReadPlan: prepared.exactReadPlan, exactEvidence: prepared.exactEvidence, timings: prepared.timings },
      compilerMs: Date.now() - startedAt
    }
  }

  const dispatch: WorkbenchGoalDispatchInput = {
    version: 1,
    expectedOutcome: `Investigate ${goal} with bounded local reads and return a concise natural-language result.`,
    scope: paths,
    knownFiles: paths,
    constraints: [
      'Read only the selected source and the bounded paths identified by Workbench.',
      'Do not modify files, commit, push, publish, deploy, or broaden the source scope.'
    ],
    nonGoals: ['mutation', 'commit', 'push', 'deployment'],
    stopConditions: ['A bounded path cannot be established.', 'The selected source changes before execution.', 'A protected path or unavailable source is encountered.'],
    confirmationPolicy: 'none',
    terminalResult: { style: 'natural_language', include: ['summary', 'changed_files', 'validation', 'warnings', 'blocker'] },
    reads: readPlan(paths),
    commands: commandPlan(goal, paths),
    readOnly: true,
    steps: [],
    pushIntent: 'not_requested'
  }
  return {
    intent,
    route: 'goal_dispatch',
    reviewMessage: 'Workbench will run a bounded read-only investigation locally. No files will be changed and no confirmation is required.',
    dispatch,
    context: { topFiles: prepared.topFiles, exactReadPlan: prepared.exactReadPlan, exactEvidence: prepared.exactEvidence, timings: prepared.timings },
    compilerMs: Date.now() - startedAt
  }
}
