import {
  runWorkbenchCommandRequestSchema,
  sessionAwareRunWorkbenchCommandRequestSchema,
  type N8nWorkflowMigrationRequest,
  type WorkbenchEvidenceReadOwner
} from '@workbench/shared'
import type { WorkbenchAdmissionOperation } from './workbench-admission-orchestrator'
import type {
  ExactCommandPolicy,
  SafeCommandKind,
  SafeCommandRequest,
  SecurityPatternSet
} from './command-runner'
import type {
  PersistedValidationCommandKind,
  WorkbenchValidationJobRequest
} from './workbench-validation-jobs'

export type RunCommandValidationIssue = {
  path: string
  message: string
}

export type RunCommandValidationError = {
  code: 'INVALID_WORKBENCH_COMMAND_REQUEST'
  message: string
  issues: RunCommandValidationIssue[]
}

export type DirectRunCommandPlan = Omit<SafeCommandRequest, 'sourceRoot' | 'persistedValidation'>

export type MigrationRunCommandPlan = {
  sourceId: string
  commandKind: 'n8n_workflow_migration'
  migration: N8nWorkflowMigrationRequest
}

export type ParsedRunCommandRequest =
  | { ok: false; error: RunCommandValidationError }
  | { ok: true; kind: 'direct'; sourceId: string; request: DirectRunCommandPlan }
  | { ok: true; kind: 'validation_submit'; sourceId: string; request: WorkbenchValidationJobRequest }
  | {
      ok: true
      kind: 'validation_status'
      sourceId: string
      commandKind: PersistedValidationCommandKind
      validationJobId: string
      timeoutMs?: number
      resultStream?: 'stdout' | 'stderr'
      resultCursor?: string
      resultPageBytes?: number
    }
  | {
      ok: true
      kind: 'validation_cancel'
      sourceId: string
      commandKind: PersistedValidationCommandKind
      validationJobId: string
      cancelReason?: string
      timeoutMs?: number
    }
  | {
      ok: true
      kind: 'evidence'
      sourceId: string
      evidenceId: string
      evidenceOwner?: WorkbenchEvidenceReadOwner
      evidenceCursor?: string
      evidencePageBytes?: number
      timeoutMs?: number
    }
  | { ok: true; kind: 'migration'; sourceId: string; request: MigrationRunCommandPlan }

export type ParsedRunCommandSuccess = Exclude<ParsedRunCommandRequest, { ok: false }>

export type ParsedSessionAwareRunCommandRequest =
  | { ok: false; error: RunCommandValidationError }
  | { ok: true; version: 2; sessionId: string; command: ParsedRunCommandSuccess }

export type ParsedRunCommandRouteRequest =
  | { ok: false; error: RunCommandValidationError }
  | { ok: true; mode: 'legacy'; command: ParsedRunCommandSuccess }
  | { ok: true; mode: 'session_aware'; version: 2; sessionId: string; command: ParsedRunCommandSuccess }

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>

const requiredString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`Validated request invariant failed for ${key}`)
  return value
}

const optionalString = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

const optionalNumber = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

const optionalBoolean = (record: Record<string, unknown>, key: string): boolean | undefined => {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

const requiredStrings = (record: Record<string, unknown>, key: string): string[] => {
  const value = record[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`Validated request invariant failed for ${key}`)
  }
  return value
}

const optionalStrings = (record: Record<string, unknown>, key: string): string[] | undefined => {
  const value = record[key]
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}

const optionalPolicy = (record: Record<string, unknown>): ExactCommandPolicy | undefined => {
  const value = record.policy
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ExactCommandPolicy
    : undefined
}

const directBase = (
  sourceId: string,
  commandKind: SafeCommandKind,
  timeoutMs: number | undefined
): DirectRunCommandPlan => ({ sourceId, commandKind, timeoutMs })

const normalizeDirectRequest = (record: Record<string, unknown>): DirectRunCommandPlan => {
  const sourceId = requiredString(record, 'sourceId')
  const commandKind = requiredString(record, 'commandKind') as SafeCommandKind
  const timeoutMs = optionalNumber(record, 'timeoutMs')
  const base = directBase(sourceId, commandKind, timeoutMs)

  switch (commandKind) {
    case 'git_status_short':
    case 'git_log_latest':
    case 'git_branch_current':
    case 'verify_public_scope':
    case 'type_check_web':
    case 'type_check_cli':
    case 'verify_write_policy':
    case 'verify_source_reindex_resilience':
    case 'git_diff_cached_stat':
    case 'git_diff_cached_name_only':
    case 'diagnose_performance':
    case 'local_cli_github_auth_status':
    case 'local_cli_github_repo_view':
      return base
    case 'git_diff_stat':
    case 'git_diff_name_only':
    case 'git_diff':
      return { ...base, paths: optionalStrings(record, 'paths') }
    case 'git_add_paths':
      return {
        ...base,
        paths: requiredStrings(record, 'paths'),
        confirmedByUser: optionalBoolean(record, 'confirmedByUser'),
        confirmationToken: optionalString(record, 'confirmationToken')
      }
    case 'git_commit':
      return {
        ...base,
        paths: optionalStrings(record, 'paths'),
        message: requiredString(record, 'message'),
        body: optionalString(record, 'body'),
        confirmedByUser: optionalBoolean(record, 'confirmedByUser'),
        confirmationToken: optionalString(record, 'confirmationToken')
      }
    case 'git_push':
      return {
        ...base,
        remote: optionalString(record, 'remote'),
        branch: optionalString(record, 'branch')
      }
    case 'validate_json_files':
      return { ...base, paths: requiredStrings(record, 'paths') }
    case 'run_package_script':
      return {
        ...base,
        packageDir: requiredString(record, 'packageDir'),
        scriptName: requiredString(record, 'scriptName')
      }
    case 'run_package_test':
      return { ...base, packageDir: requiredString(record, 'packageDir') }
    case 'run_package_test_marker':
      return {
        ...base,
        packageDir: requiredString(record, 'packageDir'),
        marker: requiredString(record, 'marker')
      }
    case 'security_scan_paths':
      return {
        ...base,
        paths: requiredStrings(record, 'paths'),
        patternSet: requiredString(record, 'patternSet') as SecurityPatternSet
      }
    case 'run_exact_command':
      return {
        ...base,
        packageDir: optionalString(record, 'packageDir'),
        executable: requiredString(record, 'executable') as SafeCommandRequest['executable'],
        args: requiredStrings(record, 'args'),
        nodeVersion: optionalString(record, 'nodeVersion') === '20' ? '20' : undefined,
        policy: optionalPolicy(record),
        protectedPaths: optionalStrings(record, 'protectedPaths'),
        requiredBranch: optionalString(record, 'requiredBranch'),
        networkAccess: optionalBoolean(record, 'networkAccess')
      }
    case 'n8n_workflow_export':
      return {
        ...base,
        workflowId: requiredString(record, 'workflowId'),
        outputPath: requiredString(record, 'outputPath'),
        networkAccess: true,
        protectedPaths: optionalStrings(record, 'protectedPaths'),
        confirmedByUser: optionalBoolean(record, 'confirmedByUser'),
        confirmationToken: optionalString(record, 'confirmationToken')
      }
  }
}

const normalizeValidationSubmit = (record: Record<string, unknown>): WorkbenchValidationJobRequest => {
  const sourceId = requiredString(record, 'sourceId')
  const commandKind = requiredString(record, 'commandKind') as PersistedValidationCommandKind
  const common: WorkbenchValidationJobRequest = {
    sourceId,
    idempotencyKey: requiredString(record, 'idempotencyKey'),
    commandKind,
    timeoutMs: optionalNumber(record, 'validationJobTimeoutMs'),
    runId: optionalString(record, 'runId'),
    packetId: optionalString(record, 'packetId'),
    taskId: optionalString(record, 'taskId'),
    networkAccess: optionalBoolean(record, 'networkAccess') === false ? false : undefined
  }

  switch (commandKind) {
    case 'git_diff_check':
    case 'validate_json_files':
      return { ...common, paths: requiredStrings(record, 'paths') }
    case 'security_scan_paths':
      return {
        ...common,
        paths: requiredStrings(record, 'paths'),
        patternSet: requiredString(record, 'patternSet') as SecurityPatternSet
      }
    case 'type_check_web':
    case 'type_check_cli':
      return common
    case 'run_package_script':
      return {
        ...common,
        packageDir: requiredString(record, 'packageDir'),
        scriptName: requiredString(record, 'scriptName')
      }
    case 'run_package_test':
      return { ...common, packageDir: requiredString(record, 'packageDir') }
    case 'run_package_test_marker':
      return {
        ...common,
        packageDir: requiredString(record, 'packageDir'),
        marker: requiredString(record, 'marker')
      }
    case 'run_exact_command':
      return {
        ...common,
        packageDir: optionalString(record, 'packageDir'),
        executable: requiredString(record, 'executable') as SafeCommandRequest['executable'],
        args: requiredStrings(record, 'args'),
        nodeVersion: optionalString(record, 'nodeVersion') === '20' ? '20' : undefined,
        policy: optionalPolicy(record),
        requiredBranch: optionalString(record, 'requiredBranch'),
        protectedPaths: optionalStrings(record, 'protectedPaths')
      }
  }
}

export function parseRunCommandRequest(input: unknown): ParsedRunCommandRequest {
  const parsed = runWorkbenchCommandRequestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_WORKBENCH_COMMAND_REQUEST',
        message: 'The runWorkbenchCommand request failed strict validation.',
        issues: parsed.error.issues.slice(0, 10).map(issue => ({
          path: issue.path.join('.') || 'request',
          message: issue.message
        }))
      }
    }
  }

  const record = asRecord(parsed.data)
  const sourceId = requiredString(record, 'sourceId')
  const validationJobOperation = optionalString(record, 'validationJobOperation')

  if (validationJobOperation === 'submit') {
    return {
      ok: true,
      kind: 'validation_submit',
      sourceId,
      request: normalizeValidationSubmit(record)
    }
  }

  if (validationJobOperation === 'status') {
    return {
      ok: true,
      kind: 'validation_status',
      sourceId,
      commandKind: requiredString(record, 'commandKind') as PersistedValidationCommandKind,
      validationJobId: requiredString(record, 'validationJobId'),
      timeoutMs: optionalNumber(record, 'timeoutMs'),
      resultStream: optionalString(record, 'resultStream') as 'stdout' | 'stderr' | undefined,
      resultCursor: optionalString(record, 'resultCursor'),
      resultPageBytes: optionalNumber(record, 'resultPageBytes')
    }
  }

  if (validationJobOperation === 'cancel') {
    return {
      ok: true,
      kind: 'validation_cancel',
      sourceId,
      commandKind: requiredString(record, 'commandKind') as PersistedValidationCommandKind,
      validationJobId: requiredString(record, 'validationJobId'),
      cancelReason: optionalString(record, 'cancelReason'),
      timeoutMs: optionalNumber(record, 'timeoutMs')
    }
  }

  if (validationJobOperation === 'evidence') {
    return {
      ok: true,
      kind: 'evidence',
      sourceId,
      evidenceId: requiredString(record, 'evidenceId'),
      evidenceOwner: record.evidenceOwner as WorkbenchEvidenceReadOwner | undefined,
      evidenceCursor: optionalString(record, 'evidenceCursor'),
      evidencePageBytes: optionalNumber(record, 'evidencePageBytes'),
      timeoutMs: optionalNumber(record, 'timeoutMs')
    }
  }

  if (record.commandKind === 'n8n_workflow_migration') {
    return {
      ok: true,
      kind: 'migration',
      sourceId,
      request: {
        sourceId,
        commandKind: 'n8n_workflow_migration',
        migration: record.migration as N8nWorkflowMigrationRequest
      }
    }
  }

  return {
    ok: true,
    kind: 'direct',
    sourceId,
    request: normalizeDirectRequest(record)
  }
}

export function parseSessionAwareRunCommandRequest(input: unknown): ParsedSessionAwareRunCommandRequest {
  const parsed = sessionAwareRunWorkbenchCommandRequestSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_WORKBENCH_COMMAND_REQUEST',
        message: 'The session-aware runWorkbenchCommand request failed strict validation.',
        issues: parsed.error.issues.slice(0, 10).map(issue => ({
          path: issue.path.join('.') || 'request',
          message: issue.message
        }))
      }
    }
  }

  const command = parseRunCommandRequest(parsed.data.command)
  if (command.ok === false) return command
  return { ok: true, version: 2, sessionId: parsed.data.sessionId, command }
}

function isVersion2RunCommandRequest(input: unknown): boolean {
  return typeof input === 'object'
    && input !== null
    && !Array.isArray(input)
    && (input as Record<string, unknown>).version === 2
}

export function parseRunCommandRouteRequest(input: unknown): ParsedRunCommandRouteRequest {
  if (isVersion2RunCommandRequest(input)) {
    const sessionAware = parseSessionAwareRunCommandRequest(input)
    if (sessionAware.ok === false) return sessionAware
    return {
      ok: true,
      mode: 'session_aware',
      version: sessionAware.version,
      sessionId: sessionAware.sessionId,
      command: sessionAware.command
    }
  }

  const command = parseRunCommandRequest(input)
  if (command.ok === false) return command
  return { ok: true, mode: 'legacy', command }
}

const STATUS_COMMAND_KINDS = new Set<SafeCommandKind>([
  'git_status_short',
  'git_log_latest',
  'git_branch_current',
  'git_diff_stat',
  'git_diff_name_only',
  'git_diff_cached_stat',
  'git_diff_cached_name_only'
])

const READ_COMMAND_KINDS = new Set<SafeCommandKind>([
  'git_diff',
  'validate_json_files',
  'security_scan_paths',
  'type_check_web',
  'type_check_cli',
  'verify_public_scope',
  'verify_write_policy',
  'verify_source_reindex_resilience',
  'diagnose_performance',
  'local_cli_github_auth_status',
  'local_cli_github_repo_view'
])

export function classifyParsedRunCommandRequest(
  parsed: ParsedRunCommandSuccess
): WorkbenchAdmissionOperation {
  if (parsed.kind === 'validation_status') return 'status'
  if (parsed.kind === 'validation_cancel') return 'write'
  if (parsed.kind === 'migration') return 'migration_execute'
  if (parsed.kind === 'validation_submit') return 'write'
  if (parsed.kind === 'evidence') return 'status'

  const commandKind = parsed.request.commandKind
  if (STATUS_COMMAND_KINDS.has(commandKind)) return 'status'
  if (READ_COMMAND_KINDS.has(commandKind)) return 'read'
  if (commandKind.startsWith('git_')) return 'git'
  if (commandKind === 'n8n_workflow_export') return 'migration_execute'
  return 'write'
}

export function toSafeCommandRequest(request: DirectRunCommandPlan, sourceRoot: string): SafeCommandRequest {
  return { ...request, sourceRoot }
}
