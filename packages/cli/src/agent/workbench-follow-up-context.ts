import type { WorkbenchTerminalValidation } from './workbench-follow-up-context-types'

export const WORKBENCH_FOLLOW_UP_CONTEXT_TTL_MS = 30 * 60 * 1000
export const MAX_FOLLOW_UP_PATHS = 20
export const MAX_FOLLOW_UP_VALIDATION = 8
export const MAX_FOLLOW_UP_HISTORY = 8

export type WorkbenchFollowUpValidation = WorkbenchTerminalValidation

export type WorkbenchContinuationContext = {
  sourceId: string
  sourceLabel?: string
  previousGoal: string
  summary: string
  changedFiles: string[]
  validation: WorkbenchFollowUpValidation[]
  explicitPaths: string[]
  taskHistory: string[]
  createdAt: string
  expiresAt: string
}

export type WorkbenchFollowUpContextInput = Partial<WorkbenchContinuationContext> & {
  sourceId: string
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

function boundedList(value: unknown, limit: number, itemLimit = 240): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => boundedText(item, itemLimit))
    .filter(Boolean)))
    .slice(0, limit)
}

export function normalizeContextPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/$/, '').trim()
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return ''
  return normalized
}

function normalizeContextPaths(value: unknown, limit = MAX_FOLLOW_UP_PATHS): string[] {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map(normalizeContextPath)
    .filter(Boolean)))
    .slice(0, limit)
}

function isValidContextPathList(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > MAX_FOLLOW_UP_PATHS) return false
  return value.every(item => typeof item === 'string' && Boolean(normalizeContextPath(item)))
}

function normalizeValidation(value: unknown): WorkbenchFollowUpValidation[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_FOLLOW_UP_VALIDATION).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const raw = item as Record<string, unknown>
    const commandKind = boundedText(raw.commandKind, 120)
    const status = boundedText(raw.status, 80)
    if (!commandKind || !status) return []
    const exitCode = typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? Math.trunc(raw.exitCode) : undefined
    const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? Math.max(0, raw.durationMs) : undefined
    return [{ commandKind, status, ...(exitCode === undefined ? {} : { exitCode }), ...(durationMs === undefined ? {} : { durationMs }) }]
  })
}

export function isFollowUpContextExpired(context: Pick<WorkbenchContinuationContext, 'expiresAt'>, now = Date.now()): boolean {
  const expiresAt = Date.parse(context.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

export function normalizeFollowUpContext(
  value: unknown,
  expectedSourceId: string,
  now = Date.now()
): { ok: true; context: WorkbenchContinuationContext } | { ok: false; code: string; message: string } {
  if (!value || typeof value !== 'object') return { ok: false, code: 'FOLLOW_UP_CONTEXT_INVALID', message: 'Follow-up context is invalid.' }
  const raw = value as WorkbenchFollowUpContextInput
  const sourceId = boundedText(raw.sourceId, 240)
  if (!sourceId || sourceId !== expectedSourceId) {
    return { ok: false, code: 'FOLLOW_UP_SOURCE_MISMATCH', message: 'This result belongs to a different repository. Select the original repository before continuing.' }
  }
  const createdAtMs = typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN
  const expiresAtMs = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : NaN
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= createdAtMs || expiresAtMs <= now) {
    return { ok: false, code: 'FOLLOW_UP_CONTEXT_EXPIRED', message: 'This result context has expired. Start a fresh goal or rerun the original result.' }
  }
  if (!isValidContextPathList(raw.changedFiles) || !isValidContextPathList(raw.explicitPaths)) {
    return { ok: false, code: 'FOLLOW_UP_CONTEXT_INVALID', message: 'Follow-up context contains an invalid repository path.' }
  }
  const summary = boundedText(raw.summary, 600)
  const previousGoal = boundedText(raw.previousGoal, 4_000)
  if (!summary || !previousGoal) return { ok: false, code: 'FOLLOW_UP_CONTEXT_INVALID', message: 'Follow-up context is missing the previous result summary.' }
  return {
    ok: true,
    context: {
      sourceId,
      ...(boundedText(raw.sourceLabel, 180) ? { sourceLabel: boundedText(raw.sourceLabel, 180) } : {}),
      previousGoal,
      summary,
      changedFiles: normalizeContextPaths(raw.changedFiles),
      validation: normalizeValidation(raw.validation),
      explicitPaths: normalizeContextPaths(raw.explicitPaths),
      taskHistory: boundedList(raw.taskHistory, MAX_FOLLOW_UP_HISTORY, 500),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    }
  }
}

export function createFollowUpContext(params: {
  sourceId: string
  sourceLabel?: string
  previousGoal: string
  summary: string
  changedFiles?: string[]
  validation?: WorkbenchFollowUpValidation[]
  explicitPaths?: string[]
  taskHistory?: string[]
  now?: number
}): WorkbenchContinuationContext {
  const now = params.now ?? Date.now()
  return {
    sourceId: boundedText(params.sourceId, 240),
    ...(boundedText(params.sourceLabel, 180) ? { sourceLabel: boundedText(params.sourceLabel, 180) } : {}),
    previousGoal: boundedText(params.previousGoal, 4_000),
    summary: boundedText(params.summary, 600),
    changedFiles: normalizeContextPaths(params.changedFiles),
    validation: normalizeValidation(params.validation),
    explicitPaths: normalizeContextPaths(params.explicitPaths),
    taskHistory: boundedList(params.taskHistory, MAX_FOLLOW_UP_HISTORY, 500),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WORKBENCH_FOLLOW_UP_CONTEXT_TTL_MS).toISOString()
  }
}

export function mergeFollowUpPaths(context: WorkbenchContinuationContext | undefined, paths: unknown): string[] {
  return Array.from(new Set([
    ...(context?.explicitPaths || []),
    ...normalizeContextPaths(paths)
  ])).slice(0, MAX_FOLLOW_UP_PATHS)
}

export function continuationHintPaths(context: WorkbenchContinuationContext | undefined): string[] {
  return context?.changedFiles || []
}
