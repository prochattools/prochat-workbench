import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../utils/paths'

export type WorkbenchSessionAdmissionPredicate =
  | 'session_not_found'
  | 'session_store_error'
  | 'expired'
  | 'inactive'
  | 'source_mismatch'
  | 'budget_rejected'
  | 'repository_rejected'
  | 'execution_failed'

export type WorkbenchSessionAdmissionDiagnostic = {
  createdAt: string
  requestId?: string
  sessionId: string
  sourceId: string
  operation: string
  operationKind: string
  code: string
  predicate: WorkbenchSessionAdmissionPredicate
}

type DiagnosticStore = {
  version: 1
  updatedAt: string
  records: WorkbenchSessionAdmissionDiagnostic[]
}

export type WorkbenchSessionAdmissionDiagnosticsOptions = {
  rootDir?: string
  now?: () => Date
}

const MAX_RECORDS = 256

function resolvedRoot(options?: WorkbenchSessionAdmissionDiagnosticsOptions): string {
  return options?.rootDir ? path.resolve(options.rootDir) : getConfigDir()
}

function diagnosticsPath(options?: WorkbenchSessionAdmissionDiagnosticsOptions): string {
  return path.join(resolvedRoot(options), 'workbench-session-admission-diagnostics.json')
}

function nowIso(options?: WorkbenchSessionAdmissionDiagnosticsOptions): string {
  return (options?.now?.() || new Date()).toISOString()
}

function emptyStore(options?: WorkbenchSessionAdmissionDiagnosticsOptions): DiagnosticStore {
  return { version: 1, updatedAt: nowIso(options), records: [] }
}

function readStore(options?: WorkbenchSessionAdmissionDiagnosticsOptions): DiagnosticStore {
  try {
    const target = diagnosticsPath(options)
    if (!fs.existsSync(target)) return emptyStore(options)
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as Partial<DiagnosticStore>
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) return emptyStore(options)
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(options),
      records: parsed.records.filter(isDiagnostic).slice(-MAX_RECORDS)
    }
  } catch {
    return emptyStore(options)
  }
}

function isDiagnostic(value: unknown): value is WorkbenchSessionAdmissionDiagnostic {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkbenchSessionAdmissionDiagnostic>
  return typeof item.createdAt === 'string'
    && typeof item.sessionId === 'string'
    && typeof item.sourceId === 'string'
    && typeof item.operation === 'string'
    && typeof item.operationKind === 'string'
    && typeof item.code === 'string'
    && typeof item.predicate === 'string'
}

function persistStore(store: DiagnosticStore, options?: WorkbenchSessionAdmissionDiagnosticsOptions): void {
  const target = diagnosticsPath(options)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({
    version: 1,
    updatedAt: nowIso(options),
    records: store.records.slice(-MAX_RECORDS)
  }), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, target)
  fs.chmodSync(target, 0o600)
}

export function recordWorkbenchSessionAdmissionFailure(
  input: Omit<WorkbenchSessionAdmissionDiagnostic, 'createdAt'> & { createdAt?: string },
  options?: WorkbenchSessionAdmissionDiagnosticsOptions
): void {
  try {
    const store = readStore(options)
    store.records.push({ ...input, createdAt: input.createdAt || nowIso(options) })
    persistStore(store, options)
  } catch {
    // Diagnostics must never change the admission decision or action response.
  }
}

export function listWorkbenchSessionAdmissionDiagnostics(
  options?: WorkbenchSessionAdmissionDiagnosticsOptions
): WorkbenchSessionAdmissionDiagnostic[] {
  return readStore(options).records
}
