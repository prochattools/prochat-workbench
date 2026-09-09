import { SearchResult } from '@workbench/shared'
import { BoundedSearchResult, VaultSearcher } from './search'
import { readFile } from './vault'
import { redactSecrets, truncateContent } from './safe-access'
import { GPT_ACTION_DEFAULT_FILE_BYTES } from './payload-budget'

const MAX_CANDIDATE_RESULTS = 12
const MAX_FILES_TO_EXCERPT = 5
const DEFAULT_CONTEXT_BYTES_PER_FILE = 800
const LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES = 100 * 1024
// Leave room for the public action's bounded activity envelope. The resulting
// prepared packet plus that envelope remains below the 8 KiB GPT target.
const PREPARED_CONTEXT_MAX_BYTES = 7 * 1024
const EXACT_EVIDENCE_BUDGET_BYTES = 2_800
const MAX_NAVIGATION_ITEMS = 5

export type TaskContextNavigation = {
  backend?: string
  graphAvailable: boolean
  provider?: string
  providerVersion?: string
  freshness?: { status?: string; basis?: string }
  suggestedFiles: string[]
  suggestedSymbols: string[]
  relationships: string[]
  warning?: string
}

export type StructuralContextPreparation = {
  resolve: (input: { sourceId: string; query: string; limit: number }) => Promise<Record<string, unknown>>
}

type CandidateFile = {
  sourceId: string
  path: string
  title?: string
  score?: number
  snippet?: string
  contentExcerpt?: string
  truncated?: boolean
  sizeBytes?: number
  modifiedAt?: string
  error?: string
}

export type PreparedContext = {
  mode: 'prepare_task_context'
  status: 'ok'
  query: string
  sourceIds: string[]
  summary: string
  exactVerification: boolean
  exactEvidence: Array<{
    sourceId: string
    path: string
    content: string
    truncated: boolean
    sizeBytes?: number
    modifiedAt?: string
    verification: 'exact_source_read'
  }>
  topFiles: Array<{
    sourceId?: string
    path: string
    reason: string
    confidence?: number
    suggestedRead?: boolean
    exactVerified?: boolean
  }>
  exactReadPlan: Array<{
    sourceId?: string
    path: string
    purpose: string
    maxBytesPerFile: number
    suggestedMode?: 'read_paths' | 'grep_context'
  }>
  uncertainty: string[]
  searchNotes: string[]
  candidates: Array<{
    sourceId: string
    path: string
    score?: number
    snippet?: string
    sizeBytes?: number
    modifiedAt?: string
  }>
  strategy: {
    kind: 'deterministic_search'
    localAiUsed: false
    reason: string
  }
  timings: {
    totalMs: number
    searchMs: number
    readMs: number
  }
  navigationEvidence?: TaskContextNavigation
  knowledgeContext?: {
    packageId: string
    auditReferences: string[]
    sourceIds: string[]
    files: number
    bytes: number
    tokens: number
    queries: number
    warnings: string[]
    documents: Array<{ providerId: string; documentId: string; reasons: string[]; score: number; bytes: number; truncated: boolean }>
    sources: Array<{ providerId: string; freshness: string; indexGeneration: number; freshnessState: string }>
    diagnostics: { available: boolean; latencyMs: number; packageBytes: number; failures: number }
  }
  contextMetadata?: {
    selectedSource?: string
    freshnessState?: string
    indexedRevision?: string
    observedRevision?: string
    indexGeneration?: string
    warnings: string[]
  }
}

export type KnowledgeContextPreparation = {
  sessionId: string
  sourceIds: string[]
  prepare: (input: { query: string; sessionId: string; sourceIds: string[]; limit: number; maxBytes: number }) => Promise<{ ok: true; package: NonNullable<PreparedContext['knowledgeContext']> } | { ok: false; code: string; message: string; diagnostics?: NonNullable<PreparedContext['knowledgeContext']>['diagnostics'] }>
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined) return fallback
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function dedupeResults(results: SearchResult[], seedPaths: Array<{ sourceId: string; path: string }>): CandidateFile[] {
  const seen = new Set<string>()
  const candidates: CandidateFile[] = []

  for (const seed of seedPaths) {
    const key = `${seed.sourceId}::${seed.path}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ sourceId: seed.sourceId, path: seed.path, snippet: 'User-provided seed path.' })
  }

  for (const result of results) {
    const key = `${result.sourceId}::${result.path}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      sourceId: result.sourceId,
      path: result.path,
      title: result.title,
      score: result.score,
      snippet: result.snippet,
      sizeBytes: result.sizeBytes,
      modifiedAt: result.modifiedAt
    })
  }

  return candidates.slice(0, MAX_CANDIDATE_RESULTS)
}

function confidenceFromScore(score: number | undefined): number | undefined {
  if (typeof score !== 'number') return undefined
  return Math.max(0, Math.min(1, 1 - score))
}

function summarizeCandidate(candidate: CandidateFile): string {
  if (candidate.snippet) return candidate.snippet.slice(0, 240)
  if (candidate.contentExcerpt) return candidate.contentExcerpt.replace(/\s+/g, ' ').slice(0, 240)
  return 'Search matched this path or its contents.'
}

function compactUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const source = Buffer.from(value, 'utf8')
  if (source.byteLength <= maxBytes) return { value, truncated: false }
  return { value: source.subarray(0, Math.max(0, maxBytes)).toString('utf8'), truncated: true }
}

function compactNavigation(navigation?: TaskContextNavigation): TaskContextNavigation | undefined {
  if (!navigation) return undefined
  return {
    ...navigation,
    suggestedFiles: navigation.suggestedFiles.slice(0, MAX_NAVIGATION_ITEMS),
    suggestedSymbols: navigation.suggestedSymbols.slice(0, MAX_NAVIGATION_ITEMS),
    relationships: navigation.relationships.slice(0, MAX_NAVIGATION_ITEMS),
    ...(navigation.warning ? { warning: compactUtf8(navigation.warning, 240).value } : {})
  }
}

function compactPreparedContext(context: PreparedContext): PreparedContext {
  const evidencePerFile = Math.max(256, Math.floor(EXACT_EVIDENCE_BUDGET_BYTES / Math.max(context.exactEvidence.length, 1)))
  const compacted: PreparedContext = {
    ...context,
    query: compactUtf8(context.query, 240).value,
    summary: compactUtf8(context.summary, 320).value,
    exactEvidence: context.exactEvidence.map(item => {
      const content = compactUtf8(item.content, evidencePerFile)
      return { ...item, content: content.value, truncated: item.truncated || content.truncated }
    }),
    topFiles: context.topFiles.slice(0, MAX_FILES_TO_EXCERPT).map(item => ({
      ...item,
      reason: compactUtf8(item.reason, 180).value
    })),
    exactReadPlan: context.exactReadPlan.slice(0, MAX_FILES_TO_EXCERPT),
    uncertainty: context.uncertainty.slice(0, 4).map(item => compactUtf8(item, 180).value),
    searchNotes: context.searchNotes.slice(0, 4).map(item => compactUtf8(item, 180).value),
    candidates: context.candidates.slice(0, MAX_FILES_TO_EXCERPT).map(item => ({
      ...item,
      ...(item.snippet ? { snippet: compactUtf8(item.snippet, 120).value } : {})
    })),
    ...(context.navigationEvidence ? { navigationEvidence: compactNavigation(context.navigationEvidence) } : {})
  }

  const encodedBytes = () => Buffer.byteLength(JSON.stringify(compacted), 'utf8')
  if (encodedBytes() > PREPARED_CONTEXT_MAX_BYTES) {
    compacted.exactEvidence = compacted.exactEvidence.map(item => {
      const content = compactUtf8(item.content, 320)
      return { ...item, content: content.value, truncated: true }
    })
    compacted.topFiles = compacted.topFiles.slice(0, 3)
    compacted.candidates = compacted.candidates.slice(0, 3)
    compacted.exactReadPlan = compacted.exactReadPlan.slice(0, 3)
    compacted.searchNotes = compacted.searchNotes.slice(0, 3)
  }
  if (encodedBytes() > PREPARED_CONTEXT_MAX_BYTES) {
    compacted.exactEvidence = compacted.exactEvidence.slice(0, 3)
    compacted.topFiles = compacted.topFiles.slice(0, 2)
    compacted.candidates = compacted.candidates.slice(0, 2)
    compacted.exactReadPlan = compacted.exactReadPlan.slice(0, 2)
    compacted.uncertainty = compacted.uncertainty.slice(0, 2)
    if (compacted.navigationEvidence) {
      compacted.navigationEvidence = compactNavigation({
        ...compacted.navigationEvidence,
        suggestedFiles: compacted.navigationEvidence.suggestedFiles.slice(0, 2),
        suggestedSymbols: compacted.navigationEvidence.suggestedSymbols.slice(0, 2),
        relationships: compacted.navigationEvidence.relationships.slice(0, 2)
      })
    }
  }
  if (encodedBytes() > PREPARED_CONTEXT_MAX_BYTES) {
    compacted.exactEvidence = compacted.exactEvidence.map(item => ({ ...item, content: compactUtf8(item.content, 160).value, truncated: true }))
    compacted.candidates = []
    compacted.searchNotes = []
    compacted.navigationEvidence = undefined
  }
  return compacted
}

function normalizeNavigation(payload: Record<string, unknown>): TaskContextNavigation {
  const freshnessValue = payload.freshness && typeof payload.freshness === 'object' && !Array.isArray(payload.freshness)
    ? payload.freshness as Record<string, unknown>
    : undefined
  const diagnostics = payload.diagnostics && typeof payload.diagnostics === 'object' && !Array.isArray(payload.diagnostics)
    ? payload.diagnostics as Record<string, unknown>
    : undefined
  const strings = (value: unknown, limit = MAX_NAVIGATION_ITEMS) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, limit)
    : []
  return {
    backend: typeof diagnostics?.backend === 'string' ? diagnostics.backend : undefined,
    graphAvailable: payload.graphAvailable === true,
    provider: typeof diagnostics?.providerId === 'string' ? diagnostics.providerId : undefined,
    providerVersion: typeof diagnostics?.providerVersion === 'string' ? diagnostics.providerVersion : undefined,
    freshness: freshnessValue ? {
      status: typeof freshnessValue.status === 'string' ? freshnessValue.status : undefined,
      basis: typeof freshnessValue.basis === 'string' ? freshnessValue.basis : undefined
    } : undefined,
    suggestedFiles: strings(payload.suggestedFiles),
    suggestedSymbols: strings(payload.suggestedSymbols),
    relationships: strings(payload.matches),
    ...(typeof payload.warning === 'string' ? { warning: payload.warning } : {})
  }
}

export function shouldPrepareStructuralContext(query: string, paths?: string[]): boolean {
  if (Array.isArray(paths) && paths.length > 0) return false
  return /\b(architecture|architectural|relationship|relationships|dependency|dependencies|caller|callers|callee|callees|import|imports|impact|entrypoint|entrypoints|lifecycle|provider|authentication|routing|pipeline|integration|related)\b/i.test(query)
}

function buildPreparedContext(query: string, candidates: CandidateFile[], totalMs: number, searchMs: number, readMs: number, extraSearchNotes: string[] = [], navigationEvidence?: TaskContextNavigation): PreparedContext {
  const readable = candidates.filter(candidate => !candidate.error).slice(0, 5)
  const errored = candidates.filter(candidate => candidate.error)
  const largeCandidates = readable.filter(candidate => typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES)
  const exactEvidence = readable
    .filter(candidate => typeof candidate.contentExcerpt === 'string')
    .map(candidate => ({
      sourceId: candidate.sourceId,
      path: candidate.path,
      content: candidate.contentExcerpt || '',
      truncated: candidate.truncated === true,
      ...(typeof candidate.sizeBytes === 'number' ? { sizeBytes: candidate.sizeBytes } : {}),
      ...(candidate.modifiedAt ? { modifiedAt: candidate.modifiedAt } : {}),
      verification: 'exact_source_read' as const
    }))
  const exactReadPlan = candidates
    .slice(0, MAX_FILES_TO_EXCERPT)
    .filter(candidate => typeof candidate.contentExcerpt !== 'string')
    .map(candidate => {
      const largeFile = typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES
      return {
        sourceId: candidate.sourceId,
        path: candidate.path,
        purpose: largeFile
          ? 'Large file: use grep_context with a specific symbol or text, then read_range around the match.'
          : candidate.error
            ? 'Exact source read failed; retry this path with a focused bounded read.'
            : 'Read this file to verify the exact source before editing.',
        maxBytesPerFile: GPT_ACTION_DEFAULT_FILE_BYTES,
        suggestedMode: largeFile ? 'grep_context' as const : 'read_paths' as const
      }
    })
  const exactVerification = exactEvidence.length > 0 && exactReadPlan.length === 0

  return {
    mode: 'prepare_task_context',
    status: 'ok',
    query,
    sourceIds: Array.from(new Set(candidates.map(candidate => candidate.sourceId))),
    summary: readable.length > 0
      ? `Prepared ${exactEvidence.length} exact-source file excerpt(s) from ${readable.length} ranked candidate(s).`
      : 'No strong candidate files were found. Refine the query or provide exact paths.',
    exactVerification,
    exactEvidence,
    topFiles: readable.map(candidate => ({
      sourceId: candidate.sourceId,
      path: candidate.path,
      reason: summarizeCandidate(candidate),
      confidence: confidenceFromScore(candidate.score),
      suggestedRead: typeof candidate.contentExcerpt !== 'string',
      exactVerified: typeof candidate.contentExcerpt === 'string'
    })),
    exactReadPlan: exactReadPlan.slice(0, MAX_FILES_TO_EXCERPT),
    uncertainty: [
      ...(readable.length === 0 ? ['No matching files found from the current index.'] : []),
      ...(errored.length > 0 ? [`${errored.length} candidate file(s) could not be excerpted.`] : []),
      ...(exactVerification ? [] : ['Exact-source verification is incomplete; do not treat navigation or ranking evidence as patch authority.'])
    ],
    searchNotes: [
      'Deterministic source-index ranking was used.',
      ...extraSearchNotes.slice(0, 4),
      ...(exactEvidence.length > 0 ? ['Exact-source excerpts were read locally and are authoritative for the returned paths.'] : []),
      largeCandidates.length > 0
        ? 'Large candidates require focused modes; do not request top-of-file fallback content.'
        : exactReadPlan.length > 0 ? 'Only paths in exactReadPlan still need focused verification.' : 'Use the returned exact evidence for the bounded investigation.'
    ],
    candidates: candidates.slice(0, MAX_CANDIDATE_RESULTS).map(candidate => ({
      sourceId: candidate.sourceId,
      path: candidate.path,
      score: candidate.score,
      snippet: candidate.snippet,
      sizeBytes: candidate.sizeBytes,
      modifiedAt: candidate.modifiedAt
    })),
    strategy: {
      kind: 'deterministic_search',
      localAiUsed: false,
      reason: 'Deterministic source-index ranking.'
    },
    timings: { totalMs, searchMs, readMs },
    ...(navigationEvidence ? { navigationEvidence } : {})
  }
}

export async function prepareTaskContext(params: {
  query: string
  sourceIds: string[]
  searcher: VaultSearcher
  limit?: number
  paths?: string[]
  skipSearch?: boolean
  maxBytesPerFile?: number
  knowledgeContext?: KnowledgeContextPreparation
  structuralContext?: StructuralContextPreparation
  readExactFile?: typeof readFile
}): Promise<PreparedContext> {
  const startedAt = Date.now()
  const query = params.query.trim()
  const sourceIds = Array.from(new Set(params.sourceIds.filter(Boolean)))
  const limit = boundedInt(params.limit, 8, 3, MAX_CANDIDATE_RESULTS)
  const maxBytesPerFile = boundedInt(params.maxBytesPerFile, DEFAULT_CONTEXT_BYTES_PER_FILE, 800, GPT_ACTION_DEFAULT_FILE_BYTES)
  const seedPaths = Array.isArray(params.paths)
    ? params.paths.filter(path => typeof path === 'string' && path.trim().length > 0).slice(0, 5).flatMap(path => sourceIds.map(sourceId => ({ sourceId, path })))
    : []

  let navigationEvidence: TaskContextNavigation | undefined
  let navigationSeedPaths: Array<{ sourceId: string; path: string }> = []
  const shouldUseStructuralContext = Boolean(params.structuralContext && shouldPrepareStructuralContext(query, params.paths))
  if (shouldUseStructuralContext) {
    try {
      const result = await params.structuralContext!.resolve({ sourceId: sourceIds[0], query, limit: Math.min(limit, 5) })
      navigationEvidence = normalizeNavigation(result)
      navigationSeedPaths = navigationEvidence.suggestedFiles.map(path => ({ sourceId: sourceIds[0], path }))
    } catch {
      navigationEvidence = {
        backend: 'cbm',
        graphAvailable: false,
        freshness: { status: 'unknown', basis: 'navigation_unavailable' },
        suggestedFiles: [],
        suggestedSymbols: [],
        relationships: [],
        warning: 'Structural navigation was unavailable; exact-source search fallback was used.'
      }
    }
  }

  const searchStartedAt = Date.now()
  const emptySearchResult: Pick<BoundedSearchResult, 'results' | 'sourceWarnings' | 'partial'> = { results: [], sourceWarnings: [], partial: false }
  const pathSearch = params.skipSearch
    ? emptySearchResult
    : params.searcher.searchBounded(query, limit, sourceIds, {
      startedAt: searchStartedAt,
      deadlineMs: 900,
      maxDocsPerSource: 1200,
      maxContentDocsPerSource: 250
    })
  const contentSearch = params.skipSearch
    ? emptySearchResult
    : params.searcher.searchBounded(`content:${query}`, limit, sourceIds, {
      startedAt: searchStartedAt,
      deadlineMs: 1200,
      maxDocsPerSource: 1200,
      maxContentDocsPerSource: 250
    })
  const searchNotes = [...pathSearch.sourceWarnings, ...contentSearch.sourceWarnings]
    .map(warning => warning.message)
  const searchMs = Date.now() - searchStartedAt
  const candidates = dedupeResults([...pathSearch.results, ...contentSearch.results], [...seedPaths, ...navigationSeedPaths]).slice(0, limit)

  const readStartedAt = Date.now()
  const exactReader = params.readExactFile || readFile
  for (const candidate of candidates.slice(0, MAX_FILES_TO_EXCERPT)) {
    try {
      if (typeof candidate.sizeBytes === 'number' && candidate.sizeBytes > LARGE_FILE_FOCUSED_READ_THRESHOLD_BYTES) {
        candidate.truncated = true
        continue
      }
      const file = await exactReader(candidate.path, candidate.sourceId)
      const redacted = redactSecrets(file.content)
      const truncated = truncateContent(redacted, maxBytesPerFile)
      candidate.contentExcerpt = truncated.content
      candidate.truncated = truncated.truncated
    } catch (err) {
      candidate.error = String(err)
    }
  }
  const readMs = Date.now() - readStartedAt

  let prepared = buildPreparedContext(query, candidates, Date.now() - startedAt, searchMs, readMs, searchNotes, navigationEvidence)
  prepared.sourceIds = Array.from(new Set([...sourceIds, ...prepared.sourceIds])).sort()
  if (params.knowledgeContext) {
    const knowledge = await params.knowledgeContext.prepare({ query, sessionId: params.knowledgeContext.sessionId, sourceIds: params.knowledgeContext.sourceIds, limit: Math.min(limit, 12), maxBytes: Math.max(1, maxBytesPerFile * Math.min(limit, 5)) })
    if (knowledge.ok === false) throw new Error(`Knowledge context preparation failed: ${knowledge.code}: ${knowledge.message}`)
    prepared.knowledgeContext = { ...knowledge.package, auditReferences: [knowledge.package.packageId] }
    prepared.sourceIds = Array.from(new Set([...prepared.sourceIds, ...knowledge.package.sourceIds])).sort()
    prepared.searchNotes = [...prepared.searchNotes, `Knowledge context package ${knowledge.package.packageId} attached.`]
    prepared.uncertainty = [...prepared.uncertainty, ...knowledge.package.warnings]
  }
  return compactPreparedContext(prepared)
}
