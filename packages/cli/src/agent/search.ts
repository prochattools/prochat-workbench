import Fuse from 'fuse.js'
import type { FuseResult } from 'fuse.js'
import { IndexedDoc, SearchResult } from '@workbench/shared'

type SearchMode = 'path' | 'content'

type SourceIndex = {
  sourceId: string
  docs: IndexedDoc[]
  pathFuse: Fuse<IndexedDoc>
  contentFuse: Fuse<IndexedDoc>
}

const DEFAULT_LIMIT = 10
const CONTENT_QUERY_PREFIX = 'content:'
const FULL_TEXT_QUERY_PREFIX = 'full:'
const DEFAULT_SEARCH_DEADLINE_MS = 1500
const DEFAULT_MAX_PATH_DOCS_PER_SOURCE = 1500
const DEFAULT_MAX_CONTENT_DOCS_PER_SOURCE = 350
const MAX_CONTENT_CHARS_FOR_BOUNDED_FUSE = 1200

export type SearchSourceWarning = {
  sourceId: string
  reason: 'deadline_exceeded' | 'large_source_bounded' | 'content_search_bounded' | 'no_fast_candidates'
  docCount?: number
  searchedDocCount?: number
  maxDocsPerSource?: number
  message: string
}

export type BoundedSearchOptions = {
  deadlineMs?: number
  startedAt?: number
  maxDocsPerSource?: number
  maxContentDocsPerSource?: number
}

export type BoundedSearchResult = {
  results: SearchResult[]
  query: string
  mode: SearchMode
  timedOut: boolean
  partial: boolean
  searchedSourceCount: number
  searchedDocCount: number
  totalDocCount: number
  sourceWarnings: SearchSourceWarning[]
}

function normalizeSourceIds(sourceIds?: string[]): string[] | undefined {
  if (!Array.isArray(sourceIds)) return undefined
  const normalized = Array.from(new Set(sourceIds.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())))
  return normalized.length > 0 ? normalized : undefined
}

function parseQueryMode(query: string): { mode: SearchMode; query: string } {
  const trimmed = query.trim()
  if (trimmed.toLowerCase().startsWith(CONTENT_QUERY_PREFIX)) {
    return { mode: 'content', query: trimmed.slice(CONTENT_QUERY_PREFIX.length).trim() }
  }
  if (trimmed.toLowerCase().startsWith(FULL_TEXT_QUERY_PREFIX)) {
    return { mode: 'content', query: trimmed.slice(FULL_TEXT_QUERY_PREFIX.length).trim() }
  }
  return { mode: 'path', query: trimmed }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function queryTokens(query: string): string[] {
  return Array.from(new Set(query
    .toLowerCase()
    .split(/[^a-z0-9_@.-]+/i)
    .map(token => token.trim())
    .filter(token => token.length >= 2)
  )).slice(0, 8)
}

function fastHaystack(doc: IndexedDoc, mode: SearchMode): string {
  const base = `${doc.path}\n${doc.title}\n${doc.tags.join(' ')}\n${doc.contentPreview || ''}`.toLowerCase()
  if (mode === 'path') return base
  return `${base}\n${doc.content.toLowerCase()}`
}

function docMatchesFastFilter(doc: IndexedDoc, tokens: string[], mode: SearchMode): boolean {
  if (tokens.length === 0) return false
  const haystack = fastHaystack(doc, mode)
  return tokens.some(token => haystack.includes(token))
}

function makeBoundedContentDocs(docs: IndexedDoc[], query: string): IndexedDoc[] {
  const normalizedQuery = query.trim().toLowerCase()
  const tokens = queryTokens(query).sort((left, right) => right.length - left.length)
  return docs.map(doc => ({
    ...doc,
    content: (() => {
      const lowerContent = doc.content.toLowerCase()
      let matchIndex = normalizedQuery ? lowerContent.indexOf(normalizedQuery) : -1
      if (matchIndex < 0) {
        for (const token of tokens) {
          matchIndex = lowerContent.indexOf(token)
          if (matchIndex >= 0) break
        }
      }
      if (matchIndex < 0) return doc.content.slice(0, MAX_CONTENT_CHARS_FOR_BOUNDED_FUSE)
      const start = Math.max(0, matchIndex - Math.floor(MAX_CONTENT_CHARS_FOR_BOUNDED_FUSE / 3))
      return doc.content.slice(start, start + MAX_CONTENT_CHARS_FOR_BOUNDED_FUSE)
    })()
  }))
}

function makePathFuse(docs: IndexedDoc[]): Fuse<IndexedDoc> {
  return new Fuse(docs, {
    keys: [
      { name: 'path', weight: 0.65 },
      { name: 'title', weight: 0.25 },
      { name: 'tags', weight: 0.1 }
    ],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true
  })
}

function makeContentFuse(docs: IndexedDoc[]): Fuse<IndexedDoc> {
  return new Fuse(docs, {
    keys: [
      { name: 'path', weight: 0.25 },
      { name: 'title', weight: 0.15 },
      { name: 'tags', weight: 0.05 },
      { name: 'content', weight: 0.55 }
    ],
    threshold: 0.3,
    ignoreLocation: true,
    includeScore: true
  })
}

export class VaultSearcher {
  private indexesBySource = new Map<string, SourceIndex>()
  private sourceOrder: string[] = []

  constructor(docs: IndexedDoc[]) {
    this.rebuild(docs)
  }

  rebuild(docs: IndexedDoc[]): void {
    const grouped = new Map<string, IndexedDoc[]>()
    for (const doc of docs) {
      const sourceDocs = grouped.get(doc.sourceId) || []
      sourceDocs.push(doc)
      grouped.set(doc.sourceId, sourceDocs)
    }

    this.indexesBySource = new Map()
    this.sourceOrder = []
    for (const [sourceId, sourceDocs] of grouped.entries()) {
      this.sourceOrder.push(sourceId)
      this.indexesBySource.set(sourceId, {
        sourceId,
        docs: sourceDocs,
        pathFuse: makePathFuse(sourceDocs),
        contentFuse: makeContentFuse(sourceDocs)
      })
    }
  }

  /** Expose the bounded document set so read handlers can merge a deterministic
   * filesystem fallback when the persisted semantic index is unavailable. */
  getDocs(): IndexedDoc[] {
    return this.sourceOrder.flatMap(sourceId => this.indexesBySource.get(sourceId)?.docs || [])
  }

  search(query: string, limit: number = DEFAULT_LIMIT, sourceIds?: string[]): SearchResult[] {
    return this.searchBounded(query, limit, sourceIds).results
  }

  searchBounded(query: string, limit: number = DEFAULT_LIMIT, sourceIds?: string[], options: BoundedSearchOptions = {}): BoundedSearchResult {
    const parsed = parseQueryMode(query)
    if (!parsed.query) {
      return {
        results: [],
        query: parsed.query,
        mode: parsed.mode,
        timedOut: false,
        partial: false,
        searchedSourceCount: 0,
        searchedDocCount: 0,
        totalDocCount: 0,
        sourceWarnings: []
      }
    }

    const normalizedSourceIds = normalizeSourceIds(sourceIds)
    const selectedSourceIds = normalizedSourceIds || this.sourceOrder
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit || DEFAULT_LIMIT)))
    const perSourceLimit = Math.max(boundedLimit, Math.ceil(boundedLimit / Math.max(selectedSourceIds.length, 1)) + 3)
    const startedAt = options.startedAt || Date.now()
    const deadlineMs = boundedInt(options.deadlineMs, DEFAULT_SEARCH_DEADLINE_MS, 100, 10_000)
    const maxPathDocsPerSource = boundedInt(options.maxDocsPerSource, DEFAULT_MAX_PATH_DOCS_PER_SOURCE, 10, 10_000)
    const maxContentDocsPerSource = boundedInt(options.maxContentDocsPerSource, DEFAULT_MAX_CONTENT_DOCS_PER_SOURCE, 5, 2500)
    const matches: Array<{ result: FuseResult<IndexedDoc>; sourceId: string }> = []
    const sourceWarnings: SearchSourceWarning[] = []
    let timedOut = false
    let searchedSourceCount = 0
    let searchedDocCount = 0
    let totalDocCount = 0

    for (const sourceId of selectedSourceIds) {
      if (Date.now() - startedAt >= deadlineMs) {
        timedOut = true
        sourceWarnings.push({
          sourceId,
          reason: 'deadline_exceeded',
          message: `Search stopped before source ${sourceId} because the agent search budget was exhausted.`
        })
        break
      }

      const index = this.indexesBySource.get(sourceId)
      if (!index) continue
      totalDocCount += index.docs.length

      const sourceSelection = this.selectDocsForBoundedSearch(index, parsed.query, parsed.mode, {
        maxPathDocsPerSource,
        maxContentDocsPerSource
      })
      if (sourceSelection.warning) sourceWarnings.push(sourceSelection.warning)
      if (sourceSelection.docs.length === 0) continue

      searchedSourceCount += 1
      searchedDocCount += sourceSelection.docs.length

      const fuse = sourceSelection.useFullIndex
        ? parsed.mode === 'content' ? index.contentFuse : index.pathFuse
        : parsed.mode === 'content' ? makeContentFuse(makeBoundedContentDocs(sourceSelection.docs, parsed.query)) : makePathFuse(sourceSelection.docs)
      const sourceResults = fuse.search(parsed.query, { limit: perSourceLimit })
      for (const result of sourceResults) {
        matches.push({ result, sourceId })
      }
    }

    const results = matches
      .sort((a, b) => (a.result.score || 0) - (b.result.score || 0))
      .slice(0, boundedLimit)
      .map(({ result }) => ({
        sourceId: result.item.sourceId,
        path: result.item.path,
        title: result.item.title,
        score: result.score || 0,
        snippet: this.extractSnippet(result.item, parsed.query, parsed.mode),
        modifiedAt: result.item.modifiedAt,
        sizeBytes: result.item.size
      }))

    return {
      results,
      query: parsed.query,
      mode: parsed.mode,
      timedOut,
      partial: timedOut || sourceWarnings.length > 0,
      searchedSourceCount,
      searchedDocCount,
      totalDocCount,
      sourceWarnings
    }
  }

  private selectDocsForBoundedSearch(index: SourceIndex, query: string, mode: SearchMode, limits: { maxPathDocsPerSource: number; maxContentDocsPerSource: number }): {
    docs: IndexedDoc[]
    useFullIndex: boolean
    warning?: SearchSourceWarning
  } {
    const maxDocsPerSource = mode === 'content' ? limits.maxContentDocsPerSource : limits.maxPathDocsPerSource
    if (index.docs.length <= maxDocsPerSource) {
      return { docs: index.docs, useFullIndex: true }
    }

    const tokens = queryTokens(query)
    const candidates: IndexedDoc[] = []
    const selected = new Set<string>()
    const normalizedQuery = query.trim().toLowerCase()
    if (normalizedQuery) {
      for (const doc of index.docs) {
        if (!fastHaystack(doc, mode).includes(normalizedQuery)) continue
        candidates.push(doc)
        selected.add(doc.id)
        if (candidates.length >= maxDocsPerSource) break
      }
    }
    for (const doc of index.docs) {
      if (candidates.length >= maxDocsPerSource) break
      if (selected.has(doc.id)) continue
      if (!docMatchesFastFilter(doc, tokens, mode)) continue
      candidates.push(doc)
    }

    if (candidates.length === 0) {
      return {
        docs: [],
        useFullIndex: false,
        warning: {
          sourceId: index.sourceId,
          reason: 'no_fast_candidates',
          docCount: index.docs.length,
          maxDocsPerSource,
          message: `Source ${index.sourceId} has ${index.docs.length} indexed docs. Search was not run because the fast prefilter found no bounded candidates; use grep_context, graph_context, read_range, or a more specific path/token.`
        }
      }
    }

    const reason = mode === 'content' ? 'content_search_bounded' : 'large_source_bounded'
    return {
      docs: candidates,
      useFullIndex: false,
      warning: {
        sourceId: index.sourceId,
        reason,
        docCount: index.docs.length,
        searchedDocCount: candidates.length,
        maxDocsPerSource,
        message: `Source ${index.sourceId} has ${index.docs.length} indexed docs. Search was bounded to ${candidates.length} fast-prefiltered docs to keep the agent responsive.`
      }
    }
  }

  private extractSnippet(doc: IndexedDoc, query: string, mode: SearchMode, contextLength: number = 100): string {
    if (mode === 'path') {
      return doc.contentPreview ? `${doc.contentPreview.slice(0, 200)}...` : `${doc.path}...`
    }

    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean)
    const lowerContent = doc.content.toLowerCase()

    for (const word of queryWords) {
      const idx = lowerContent.indexOf(word)
      if (idx !== -1) {
        const start = Math.max(0, idx - contextLength)
        const end = Math.min(doc.content.length, idx + contextLength + word.length)
        return doc.content.slice(start, end) + '...'
      }
    }

    return doc.contentPreview ? `${doc.contentPreview.slice(0, 200)}...` : doc.content.slice(0, 200) + '...'
  }
}
