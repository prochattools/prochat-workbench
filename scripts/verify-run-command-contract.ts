import assert from 'node:assert/strict'
import {
  RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
  runWorkbenchCommandRequestSchema
} from '../packages/shared/src/workbench-command-contract'
import { parseRunCommandRequest } from '../packages/cli/src/agent/run-command-request'

const expectValid = (value: unknown, label: string) => {
  const parsed = runWorkbenchCommandRequestSchema.safeParse(value)
  assert.equal(parsed.success, true, `${label} should parse: ${parsed.success ? '' : parsed.error.message}`)
}

const expectInvalid = (value: unknown, label: string) => {
  const parsed = runWorkbenchCommandRequestSchema.safeParse(value)
  assert.equal(parsed.success, false, `${label} should fail strict parsing`)
}

expectValid({ sourceId: 'workbench-example-source', commandKind: 'git_status_short', timeoutMs: 5000 }, 'status')
expectValid({ sourceId: 'workbench-example-source', commandKind: 'git_diff', paths: ['packages/shared/src/index.ts'] }, 'diff')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'git_add_paths',
  paths: ['.github/workflows/example.yml'],
  confirmedByUser: true,
  confirmationToken: 'confirm:example'
}, 'confirmed staging')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'git_commit',
  paths: ['.github/workflows/example.yml'],
  message: 'test: commit guarded workflow',
  confirmedByUser: true,
  confirmationToken: 'confirm:example'
}, 'confirmed commit')
const parsedConfirmedCommit = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'git_commit',
  paths: ['.github/workflows/example.yml'],
  message: 'test: commit guarded workflow',
  confirmedByUser: true,
  confirmationToken: 'confirm:example'
})
assert.equal(parsedConfirmedCommit.ok, true)
if (parsedConfirmedCommit.ok && parsedConfirmedCommit.kind === 'direct') {
  assert.equal(parsedConfirmedCommit.request.confirmedByUser, true)
  assert.equal(parsedConfirmedCommit.request.confirmationToken, 'confirm:example')
}
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_exact_command',
  executable: 'rg',
  args: ['-n', 'runWorkbenchCommandRequestSchema', 'packages/shared/src'],
  networkAccess: false,
  policy: { denyNetworkCommands: true }
}, 'exact rg')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_repo_shell',
  command: 'git status --short | head -n 1 && printf ready'
}, 'owner-scoped repository shell')
const parsedShell = parseRunCommandRequest({
  sourceId: 'workbench-example-source',
  commandKind: 'run_repo_shell',
  command: 'rg -n "Workbench" packages'
})
assert.equal(parsedShell.ok, true)
if (parsedShell.ok && parsedShell.kind === 'direct') assert.equal(parsedShell.request.networkAccess, false)
expectValid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_export',
  workflowId: 'workflow-id',
  outputPath: 'operations/reports/artifacts/rollback.json',
  networkAccess: true,
  protectedPaths: ['tools/n8n-api.sh']
}, 'existing n8n export')
expectValid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  migration: {
    mode: 'apply',
    phase: 'prepare',
    workflowId: 'workflow-id',
    candidatePath: 'operations/workflows/candidate.json',
    rollbackPath: 'operations/reports/rollback.json',
    manifestPath: 'operations/workflows/manifest.json',
    networkAccess: true
  }
}, 'migration prepare')
expectValid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  migration: {
    mode: 'apply',
    phase: 'execute',
    operationId: 'operation-id',
    confirmationToken: 'opaque-token'
  }
}, 'migration execute')
expectValid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  migration: { mode: 'rollback', phase: 'status', operationId: 'operation-id' }
}, 'migration status')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_package_script',
  validationJobOperation: 'submit',
  idempotencyKey: 'contract-job',
  packageDir: 'packages/shared',
  scriptName: 'type-check',
  networkAccess: false
}, 'validation submit')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_package_script',
  validationJobOperation: 'status',
  validationJobId: 'job-id',
  resultStream: 'stdout',
  resultCursor: 'opaque-cursor',
  resultPageBytes: 900
}, 'validation status')
expectValid({
  sourceId: 'workbench-example-source',
  commandKind: 'type_check_cli',
  validationJobOperation: 'cancel',
  validationJobId: 'job-id',
  cancelReason: 'stop the bounded test'
}, 'validation cancel')

expectInvalid({ sourceId: 'repo', commandKind: 'git_status_short' }, 'placeholder source')
expectInvalid({ sourceId: 'workbench-example-source', commandKind: 'git_status_short', args: ['status'] }, 'cross-command args')
expectInvalid({ sourceId: 'workbench-example-source', commandKind: 'git_diff', executable: 'rg' }, 'cross-command executable')
expectInvalid({ sourceId: 'workbench-example-source', commandKind: 'git_commit', message: 'bad\nmessage' }, 'multiline commit')
expectInvalid({ sourceId: 'workbench-example-source', commandKind: 'run_package_script', packageDir: '.', scriptName: 'bad script' }, 'unsafe script')
expectInvalid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  confirmedByUser: true,
  migration: { mode: 'apply', phase: 'status', operationId: 'operation-id' }
}, 'migration boolean confirmation')
expectInvalid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  executable: 'node',
  migration: { mode: 'apply', phase: 'status', operationId: 'operation-id' }
}, 'migration executable')
for (const [field, value] of Object.entries({
  args: ['update-workflow'], shell: false, environment: { SAMPLE: 'value' }, wrapperOperation: 'update-workflow',
  confirmationDigest: 'digest', dispatchAuthorization: 'authorization', leaseProof: 'lease-proof'
})) {
  expectInvalid({
    sourceId: 'brain', commandKind: 'n8n_workflow_migration',
    migration: { mode: 'apply', phase: 'status', operationId: 'operation-id', [field]: value }
  }, `migration ${field}`)
}
expectInvalid({
  sourceId: 'brain',
  commandKind: 'n8n_workflow_migration',
  migration: { mode: 'apply', phase: 'execute', operationId: 'operation-id', confirmationToken: 'token', candidatePath: 'extra.json' }
}, 'migration nested extra')
expectInvalid({
  sourceId: 'workbench-example-source',
  commandKind: 'type_check_web',
  validationJobOperation: 'submit',
  idempotencyKey: 'job',
  packageDir: '.'
}, 'validation cross-command package')
expectInvalid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_package_test',
  validationJobOperation: 'submit',
  idempotencyKey: 'job',
  packageDir: '.',
  networkAccess: true
}, 'validation network escalation')
expectInvalid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_package_script',
  validationJobOperation: 'status',
  validationJobId: 'job-id',
  idempotencyKey: 'extra'
}, 'status extra field')
expectInvalid({
  sourceId: 'workbench-example-source',
  commandKind: 'run_package_script',
  validationJobOperation: 'status',
  validationJobId: 'job-id',
  resultPageBytes: 9000
}, 'status result page over budget')
expectInvalid({ sourceId: 'workbench-example-source', commandKind: 'not_allowlisted' }, 'unknown command')

assert.equal(new Set(RUN_WORKBENCH_DIRECT_COMMAND_KINDS).size, RUN_WORKBENCH_DIRECT_COMMAND_KINDS.length, 'command kinds must be unique')
assert.ok(RUN_WORKBENCH_DIRECT_COMMAND_KINDS.includes('n8n_workflow_export'))
assert.ok(RUN_WORKBENCH_DIRECT_COMMAND_KINDS.includes('n8n_workflow_migration'))
assert.ok(RUN_WORKBENCH_DIRECT_COMMAND_KINDS.includes('run_repo_shell'))

console.log('runWorkbenchCommand strict contract verification passed')
