import { z } from 'zod'
import { controlledWorkflowCanonicalizationVersionSchema } from './controlled-workflow-topology'
import {
  WORKBENCH_EVIDENCE_PAGE_MAX_BYTES,
  WorkbenchEvidenceReadOwnerSchema,
  workbenchEvidenceIdSchema
} from './workbench-evidence'

export const RUN_WORKBENCH_DIRECT_COMMAND_KINDS = [
  'git_status_short',
  'git_diff_stat',
  'git_diff_name_only',
  'git_diff',
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
  'n8n_workflow_export',
  'n8n_workflow_migration'
] as const

export const PERSISTED_VALIDATION_COMMAND_KINDS = [
  'git_diff_check',
  'validate_json_files',
  'security_scan_paths',
  'run_package_script',
  'run_package_test',
  'run_package_test_marker',
  'type_check_web',
  'type_check_cli',
  'run_exact_command'
] as const

// Provider-owned MCP admission for R23.3. These are the persisted validators
// whose existing Workbench policy is read-only and bounded. Package scripts and
// exact commands remain persisted-job capabilities for internal callers, but are
// not exposed through the MCP validation surface.
export const SAFE_MCP_VALIDATION_COMMAND_KINDS = [
  'git_diff_check',
  'validate_json_files',
  'security_scan_paths',
  'run_package_test',
  'run_package_test_marker',
  'type_check_web',
  'type_check_cli'
] as const

const blockedSourceIds = new Set(['default', 'workspace', 'current', 'repo'])

export const workbenchSourceIdSchema = z.string().trim().min(1).max(160).refine(
  value => !blockedSourceIds.has(value),
  'sourceId must be an exact enabled source ID'
)

const shortIdSchema = z.string().trim().min(1).max(200)
const repoPathSchema = z.string().trim().min(1).max(1000)
const pathListSchema = z.array(repoPathSchema).min(1).max(50)
const optionalPathListSchema = z.array(repoPathSchema).max(50)
const protectedPathListSchema = z.array(repoPathSchema).max(50)
const timeoutMsSchema = z.number().int().min(1000).max(12000)
const validationTimeoutMsSchema = z.number().int().min(1000).max(900000)
const validationResultCursorSchema = z.string().min(1).max(2000)
const validationResultPageBytesSchema = z.number().int().min(256).max(4000)
const validationResultStreamSchema = z.enum(['stdout', 'stderr'])
const validationCancelReasonSchema = z.string().trim().min(1).max(500)
const confirmationTokenSchema = z.string().min(1).max(4096)
const argsSchema = z.array(z.string().min(1).max(500)).max(100)
const packageDirSchema = repoPathSchema.max(500)
const scriptNameSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/)
const markerSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9 _:\-()|]+$/)
const remoteSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/)
const branchSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9._/-]+$/).refine(
  value => !value.startsWith('-') && !value.includes('..'),
  'branch must be a safe branch name'
)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const exactCommandPolicySchema = z.object({
  denyDatabaseCommands: z.boolean().optional(),
  denyMigrationCommands: z.boolean().optional(),
  denyDeploymentCommands: z.boolean().optional(),
  denyNetworkCommands: z.boolean().optional()
}).strict()

export const securityPatternSetSchema = z.enum([
  'forbidden_runtime_execution',
  'forbidden_secret_material',
  'forbidden_upload_network',
  'forbidden_all_high_risk'
])

const commandSchema = <K extends string, S extends z.ZodRawShape>(commandKind: K, shape: S) => z.object({
  sourceId: workbenchSourceIdSchema,
  commandKind: z.literal(commandKind),
  timeoutMs: timeoutMsSchema.optional(),
  ...shape
}).strict()

const emptyCommandSchema = <K extends string>(commandKind: K) => commandSchema(commandKind, {})

export const n8nWorkflowMigrationPrepareSchema = z.object({
  mode: z.enum(['apply', 'rollback']),
  phase: z.literal('prepare'),
  workflowId: shortIdSchema,
  candidatePath: repoPathSchema,
  rollbackPath: repoPathSchema,
  manifestPath: repoPathSchema,
  networkAccess: z.literal(true)
}).strict()

export const n8nWorkflowMigrationExecuteSchema = z.object({
  mode: z.enum(['apply', 'rollback']),
  phase: z.literal('execute'),
  operationId: shortIdSchema,
  confirmationToken: confirmationTokenSchema
}).strict()

export const n8nWorkflowMigrationStatusSchema = z.object({
  mode: z.enum(['apply', 'rollback']),
  phase: z.literal('status'),
  operationId: shortIdSchema
}).strict()

export const n8nWorkflowMigrationSchema = z.discriminatedUnion('phase', [
  n8nWorkflowMigrationPrepareSchema,
  n8nWorkflowMigrationExecuteSchema,
  n8nWorkflowMigrationStatusSchema
])

export const directRunWorkbenchCommandRequestSchema = z.discriminatedUnion('commandKind', [
  emptyCommandSchema('git_status_short'),
  commandSchema('git_diff_stat', { paths: optionalPathListSchema.optional() }),
  commandSchema('git_diff_name_only', { paths: optionalPathListSchema.optional() }),
  commandSchema('git_diff', { paths: optionalPathListSchema.optional() }),
  emptyCommandSchema('git_log_latest'),
  emptyCommandSchema('git_branch_current'),
  emptyCommandSchema('verify_public_scope'),
  emptyCommandSchema('type_check_web'),
  emptyCommandSchema('type_check_cli'),
  emptyCommandSchema('verify_write_policy'),
  emptyCommandSchema('verify_source_reindex_resilience'),
  emptyCommandSchema('git_diff_cached_stat'),
  emptyCommandSchema('git_diff_cached_name_only'),
  commandSchema('git_add_paths', {
    paths: pathListSchema,
    confirmedByUser: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema.optional()
  }),
  commandSchema('git_commit', {
    paths: optionalPathListSchema.optional(),
    message: z.string().trim().min(1).max(200).refine(value => !/[\r\n]/.test(value), 'message must be single-line'),
    body: z.string().trim().max(2000).optional(),
    confirmedByUser: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema.optional()
  }),
  commandSchema('git_push', {
    remote: remoteSchema.optional(),
    branch: branchSchema.optional()
  }),
  commandSchema('validate_json_files', { paths: pathListSchema }),
  commandSchema('run_package_script', {
    packageDir: packageDirSchema,
    scriptName: scriptNameSchema
  }),
  commandSchema('run_package_test', { packageDir: packageDirSchema }),
  commandSchema('run_package_test_marker', {
    packageDir: packageDirSchema,
    marker: markerSchema
  }),
  commandSchema('security_scan_paths', {
    paths: pathListSchema,
    patternSet: securityPatternSetSchema
  }),
  emptyCommandSchema('diagnose_performance'),
  emptyCommandSchema('local_cli_github_auth_status'),
  emptyCommandSchema('local_cli_github_repo_view'),
  commandSchema('run_exact_command', {
    packageDir: packageDirSchema.optional(),
    executable: z.enum(['node', 'pnpm', 'rg']),
    args: argsSchema,
    nodeVersion: z.literal('20').optional(),
    policy: exactCommandPolicySchema.optional(),
    protectedPaths: protectedPathListSchema.optional(),
    requiredBranch: branchSchema.optional(),
    networkAccess: z.boolean().optional()
  }),
  commandSchema('run_repo_shell', {
    packageDir: packageDirSchema.optional(),
    command: z.string().trim().min(1).max(4000),
    networkAccess: z.boolean().optional()
  }),
  commandSchema('n8n_workflow_export', {
    workflowId: shortIdSchema,
    outputPath: repoPathSchema,
    networkAccess: z.literal(true),
    protectedPaths: protectedPathListSchema.optional(),
    confirmedByUser: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema.optional()
  }),
  z.object({
    sourceId: workbenchSourceIdSchema,
    commandKind: z.literal('n8n_workflow_migration'),
    migration: n8nWorkflowMigrationSchema
  }).strict()
])

const validationSubmitCommonShape = {
  sourceId: workbenchSourceIdSchema,
  validationJobOperation: z.literal('submit'),
  idempotencyKey: z.string().trim().min(1).max(200),
  validationJobTimeoutMs: validationTimeoutMsSchema.optional(),
  runId: shortIdSchema.optional(),
  packetId: shortIdSchema.optional(),
  taskId: shortIdSchema.optional(),
  timeoutMs: timeoutMsSchema.optional(),
  networkAccess: z.literal(false).optional()
}

const validationSubmitSchema = <K extends string, S extends z.ZodRawShape>(commandKind: K, shape: S) => z.object({
  ...validationSubmitCommonShape,
  commandKind: z.literal(commandKind),
  ...shape
}).strict()

export const validationJobSubmitRequestSchema = z.discriminatedUnion('commandKind', [
  validationSubmitSchema('git_diff_check', { paths: pathListSchema }),
  validationSubmitSchema('validate_json_files', { paths: pathListSchema }),
  validationSubmitSchema('security_scan_paths', {
    paths: pathListSchema,
    patternSet: securityPatternSetSchema
  }),
  validationSubmitSchema('type_check_web', {}),
  validationSubmitSchema('type_check_cli', {}),
  validationSubmitSchema('run_package_script', {
    packageDir: packageDirSchema,
    scriptName: scriptNameSchema
  }),
  validationSubmitSchema('run_package_test', { packageDir: packageDirSchema }),
  validationSubmitSchema('run_package_test_marker', {
    packageDir: packageDirSchema,
    marker: markerSchema
  }),
  validationSubmitSchema('run_exact_command', {
    packageDir: packageDirSchema.optional(),
    executable: z.enum(['node', 'pnpm', 'rg']),
    args: argsSchema,
    nodeVersion: z.literal('20').optional(),
    policy: exactCommandPolicySchema.optional(),
    protectedPaths: protectedPathListSchema.optional(),
    requiredBranch: branchSchema.optional()
  })
])

export const validationJobStatusRequestSchema = z.object({
  sourceId: workbenchSourceIdSchema,
  commandKind: z.enum(PERSISTED_VALIDATION_COMMAND_KINDS),
  validationJobOperation: z.literal('status'),
  validationJobId: shortIdSchema,
  timeoutMs: timeoutMsSchema.optional(),
  resultStream: validationResultStreamSchema.optional(),
  resultCursor: validationResultCursorSchema.optional(),
  resultPageBytes: validationResultPageBytesSchema.optional()
}).strict()

export const workbenchEvidenceReadRequestSchema = z.object({
  sourceId: workbenchSourceIdSchema,
  commandKind: z.literal('read_evidence'),
  validationJobOperation: z.literal('evidence'),
  evidenceId: workbenchEvidenceIdSchema,
  evidenceOwner: WorkbenchEvidenceReadOwnerSchema.optional(),
  evidenceCursor: z.string().min(1).max(2000).optional(),
  evidencePageBytes: z.number().int().min(256).max(WORKBENCH_EVIDENCE_PAGE_MAX_BYTES).optional(),
  timeoutMs: timeoutMsSchema.optional()
}).strict()

export const validationJobCancelRequestSchema = z.object({
  sourceId: workbenchSourceIdSchema,
  commandKind: z.enum(PERSISTED_VALIDATION_COMMAND_KINDS),
  validationJobOperation: z.literal('cancel'),
  validationJobId: shortIdSchema,
  cancelReason: validationCancelReasonSchema.optional(),
  timeoutMs: timeoutMsSchema.optional()
}).strict()

export const runWorkbenchCommandRequestSchema = z.union([
  workbenchEvidenceReadRequestSchema,
  validationJobStatusRequestSchema,
  validationJobCancelRequestSchema,
  validationJobSubmitRequestSchema,
  directRunWorkbenchCommandRequestSchema
])

export const sessionAwareRunWorkbenchCommandRequestSchema = z.object({
  version: z.literal(2),
  sessionId: shortIdSchema,
  command: runWorkbenchCommandRequestSchema
}).strict()

export const controlledWorkflowTopologyManifestMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('n8n-controlled-topology-migration'),
  workflow: z.object({
    id: shortIdSchema,
    canonicalizationVersion: controlledWorkflowCanonicalizationVersionSchema,
    expectedLiveCanonicalSha256: sha256Schema,
    candidateCanonicalSha256: sha256Schema,
    rollbackCanonicalSha256: sha256Schema
  }).strict()
}).strict()

export type RunWorkbenchDirectCommandKind = typeof RUN_WORKBENCH_DIRECT_COMMAND_KINDS[number]
export type PersistedValidationCommandKind = typeof PERSISTED_VALIDATION_COMMAND_KINDS[number]
export type RunWorkbenchCommandRequest = z.infer<typeof runWorkbenchCommandRequestSchema>
export type SessionAwareRunWorkbenchCommandRequest = z.infer<typeof sessionAwareRunWorkbenchCommandRequestSchema>
export type DirectRunWorkbenchCommandRequest = z.infer<typeof directRunWorkbenchCommandRequestSchema>
export type N8nWorkflowMigrationRequest = z.infer<typeof n8nWorkflowMigrationSchema>
