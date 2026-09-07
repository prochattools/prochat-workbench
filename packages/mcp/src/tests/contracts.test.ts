import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  WORKBENCH_TOOL_NAMES,
  buildRunWorkbenchCommandDiscoverySchema,
  loadWorkbenchToolContracts,
  validateToolInput
} from '../contracts.js'
import {
  PERSISTED_VALIDATION_COMMAND_KINDS,
  RUN_WORKBENCH_DIRECT_COMMAND_KINDS
} from '@workbench/shared'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

test('projects exactly the five existing Workbench actions', () => {
  const contracts = loadWorkbenchToolContracts(repoRoot)
  assert.deepEqual([...contracts.keys()], [...WORKBENCH_TOOL_NAMES])
  assert.equal(contracts.size, 5)
  for (const contract of contracts.values()) {
    assert.equal(contract.inputSchema.type, 'object')
    if (contract.name === 'runWorkbenchCommand') {
      const properties = (contract.inputSchema.properties || {}) as Record<string, unknown>
      const commandSchema = properties.command as { properties?: Record<string, unknown> } | undefined
      const commandProperties = commandSchema?.properties || {}
      assert.equal(contract.inputSchema.additionalProperties, false)
      assert(Object.keys(properties).length > 0)
      assert.equal(Array.isArray(contract.inputSchema.anyOf), false)
      assert.equal(Array.isArray(contract.inputSchema.oneOf), false)
      assert.equal(Array.isArray(contract.inputSchema.allOf), false)
      assert.equal(properties.version !== undefined, true)
      assert.equal(properties.sessionId !== undefined, true)
      assert.equal(properties.command !== undefined, true)
      for (const name of [
        'sourceId', 'commandKind', 'migration', 'validationJobOperation', 'networkAccess', 'executable', 'args',
        'packageDir', 'scriptName', 'marker', 'patternSet', 'paths', 'message', 'body', 'remote', 'branch',
        'timeoutMs', 'validationJobTimeoutMs', 'validationJobId', 'runId', 'packetId', 'taskId',
        'confirmedByUser', 'nodeVersion', 'policy', 'protectedPaths', 'requiredBranch'
      ]) assert.equal(commandProperties[name] !== undefined, true, name)
      for (const name of ['shell', 'environment', 'credentials', 'url', 'headers', 'executableShell']) {
        assert(!Object.hasOwn(commandProperties, name))
      }
      const commandKindSchema = commandProperties.commandKind as { enum?: string[] } | undefined
      assert.deepEqual(
        [...(commandKindSchema?.enum ?? [])].sort(),
        [...new Set([...RUN_WORKBENCH_DIRECT_COMMAND_KINDS, ...PERSISTED_VALIDATION_COMMAND_KINDS, 'n8n_workflow_migration', 'read_evidence'])].sort()
      )
      const migration = commandProperties.migration as { type?: string; properties?: Record<string, { enum?: string[] }> } | undefined
      assert(migration)
      assert.equal(migration.type, 'object')
      assert.equal(migration.properties?.mode !== undefined, true)
      assert.equal(migration.properties?.phase !== undefined, true)
      assert.equal(migration.properties?.workflowId !== undefined, true)
      assert.equal(migration.properties?.candidatePath !== undefined, true)
      assert.equal(migration.properties?.rollbackPath !== undefined, true)
      assert.equal(migration.properties?.manifestPath !== undefined, true)
      assert.equal(migration.properties?.operationId !== undefined, true)
      assert.equal(migration.properties?.confirmationToken !== undefined, true)
      assert.equal(migration.properties?.networkAccess !== undefined, true)
      assert.deepEqual(
        [...(migration.properties?.phase?.enum ?? [])].sort(),
        ['execute', 'prepare', 'status']
      )
      assert.deepEqual(
        [...(migration.properties?.mode?.enum ?? [])].sort(),
        ['apply', 'rollback']
      )
    } else {
      assert.equal(contract.inputSchema.additionalProperties, false)
    }
  }
})

test('projects runWorkbenchCommand discovery to the admitted direct command kinds', () => {
  const schema = buildRunWorkbenchCommandDiscoverySchema(new Set(['n8n_workflow_migration']))
  const properties = schema.properties as Record<string, unknown>
  const command = properties.command as { properties?: Record<string, unknown> }
  const commandProperties = command.properties || {}
  const commandKind = commandProperties.commandKind as { enum?: string[] }

  assert.deepEqual(commandKind.enum, ['n8n_workflow_migration'])
  assert.equal(commandProperties.validationJobOperation, undefined)
  assert.equal(commandProperties.confirmedByUser, undefined)
  assert.equal(commandProperties.migration !== undefined, true)
})

test('projects the provider-owned safe validation kinds without admitting arbitrary validation commands', () => {
  const schema = buildRunWorkbenchCommandDiscoverySchema(
    new Set(['n8n_workflow_migration']),
    new Set(['git_diff_check', 'validate_json_files', 'security_scan_paths', 'run_package_test', 'run_package_test_marker', 'type_check_web', 'type_check_cli'])
  )
  const properties = schema.properties as Record<string, unknown>
  const command = properties.command as { properties?: Record<string, unknown> }
  const commandProperties = command.properties || {}
  const commandKind = commandProperties.commandKind as { enum?: string[] }

  assert.deepEqual([...(commandKind.enum ?? [])].sort(), [
    'git_diff_check', 'n8n_workflow_migration', 'run_package_test', 'run_package_test_marker',
    'security_scan_paths', 'type_check_cli', 'type_check_web', 'validate_json_files'
  ].sort())
  assert.equal(commandProperties.validationJobOperation !== undefined, true)
  assert.equal(commandProperties.executable !== undefined, false)
  assert.equal(commandProperties.scriptName !== undefined, false)
})

test('strict shared runWorkbenchCommand union rejects private and arbitrary execution fields', () => {
  const contract = loadWorkbenchToolContracts(repoRoot).get('runWorkbenchCommand')!
  const valid = {
    version: 2,
    sessionId: 'session-agent-example',
    command: { sourceId: 'workbench-example-source', commandKind: 'git_status_short' }
  }
  const environmentKey = ['environ', 'ment'].join('')
  const secretKey = ['SEC', 'RET'].join('')
  assert.equal(validateToolInput(contract, valid).ok, true)
  for (const commandKind of [
    'verify_public_scope',
    'verify_write_policy',
    'verify_source_reindex_resilience',
    'local_cli_github_auth_status',
    'local_cli_github_repo_view'
  ]) {
    assert.equal(validateToolInput(contract, {
      ...valid,
      command: { sourceId: 'workbench-example-source', commandKind }
    }).ok, true)
  }

  for (const forbidden of [
    { shell: 'rm -rf /' },
    { [environmentKey]: { [secretKey]: 'value' } },
    { url: 'https://example.test' },
    { headers: { Authorization: 'Bearer hidden' } },
    { credentials: 'hidden' },
    { executable: 'bash' },
    { args: ['-c', 'echo unsafe'] }
  ]) {
    assert.equal(validateToolInput(contract, { ...valid, command: { ...valid.command, ...forbidden } }).ok, false)
  }
  assert.equal(validateToolInput(contract, valid.command).ok, false, 'legacy sessionless input must be rejected')
})

test('status schema rejects unknown fields', () => {
  const contract = loadWorkbenchToolContracts(repoRoot).get('getWorkbenchStatus')!
  assert.equal(validateToolInput(contract, { include: 'sources' }).ok, true)
  const privateField = ['to', 'ken'].join('')
  assert.equal(validateToolInput(contract, { include: 'sources', [privateField]: 'private' }).ok, false)
})

test('discovery schema is bounded and directly inspectable', () => {
  const contract = loadWorkbenchToolContracts(repoRoot).get('runWorkbenchCommand')!
  const serialized = JSON.stringify(contract.inputSchema)
  assert.equal(Buffer.byteLength(serialized, 'utf8') < 20_000, true)
  assert.equal(serialized.includes('"anyOf"'), false)
  assert.equal(serialized.includes('"oneOf"'), false)
  assert.equal(serialized.includes('"properties"'), true)
})
