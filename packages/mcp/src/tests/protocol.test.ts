import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWorkbenchMcpServer } from '../mcp-server.js'
import { loadWorkbenchMcpScope } from '../scope.js'
import { CLIENT_WORKFLOW_TOOL_NAMES } from '../client-workflow-tools.js'
import { PERSISTED_VALIDATION_COMMAND_KINDS, RUN_WORKBENCH_DIRECT_COMMAND_KINDS, sessionAwareRunWorkbenchCommandRequestSchema } from '@workbench/shared'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const sessionCommand = (command: Record<string, unknown>) => ({
  version: 2,
  sessionId: 'session-agent-example',
  command
})

async function connectedPair(invoke?: Parameters<typeof createWorkbenchMcpServer>[0]['invoke']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    invoke: invoke ?? (async (_contract, input) => ({ ok: true, result: { status: 'ok', input } }))
  })
  const client = new Client({ name: 'workbench-mcp-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, server }
}

test('initializes, advertises instructions, and lists the full Workbench tool surface', async () => {
  const { client, server } = await connectedPair()
  try {
    assert(client.getInstructions()?.includes('admitted bounded Workbench actions'))
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), [
      ...CLIENT_WORKFLOW_TOOL_NAMES,
      'getWorkbenchStatus',
      'readWorkbenchContext',
      'applyWorkbenchFileChange',
      'commitWorkbenchChanges',
      'runWorkbenchCommand'
    ])
    assert.equal(listed.tools.find(tool => tool.name === 'getWorkbenchStatus')?.annotations?.readOnlyHint, true)
    assert.equal(listed.tools.find(tool => tool.name === 'applyWorkbenchFileChange')?.annotations?.destructiveHint, true)
    const runWorkbenchCommand = listed.tools.find(tool => tool.name === 'runWorkbenchCommand')
    assert(runWorkbenchCommand)
    const inputSchema = runWorkbenchCommand?.inputSchema || {}
    assert.equal(inputSchema.type, 'object')
    assert.equal(Array.isArray((inputSchema as { anyOf?: unknown[] }).anyOf), false)
    const properties = (inputSchema as { properties?: Record<string, unknown> }).properties || {}
    const command = properties.command as { properties?: Record<string, unknown> }
    const commandProperties = command.properties || {}
    assert(Object.keys(properties).length > 0)
    assert.equal(properties.version !== undefined, true)
    assert.equal(properties.sessionId !== undefined, true)
    assert.equal(properties.command !== undefined, true)
    for (const name of [
      'sourceId', 'commandKind', 'migration', 'validationJobOperation', 'executable', 'args', 'packageDir',
      'scriptName', 'marker', 'patternSet', 'paths', 'message', 'body', 'remote', 'branch', 'timeoutMs',
      'validationJobTimeoutMs', 'validationJobId', 'runId', 'packetId', 'taskId', 'confirmedByUser',
      'nodeVersion', 'policy', 'protectedPaths', 'requiredBranch', 'networkAccess'
    ]) assert.equal(commandProperties[name] !== undefined, true, name)
    for (const name of ['shell', 'environment', 'credentials', 'headers']) assert(!Object.hasOwn(commandProperties, name))
    const commandKinds = [...((commandProperties.commandKind as { enum?: string[] }).enum ?? [])].sort()
    assert.deepEqual(
      commandKinds,
      [...new Set([...RUN_WORKBENCH_DIRECT_COMMAND_KINDS, ...PERSISTED_VALIDATION_COMMAND_KINDS, 'n8n_workflow_migration'])].sort()
    )
    const migration = commandProperties.migration as { type?: string; properties?: Record<string, { enum?: string[] }> }
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
    assert.deepEqual([...(migration.properties?.phase?.enum ?? [])].sort(), ['execute', 'prepare', 'status'])
    assert.deepEqual([...(migration.properties?.mode?.enum ?? [])].sort(), ['apply', 'rollback'])
    const serialized = JSON.stringify(inputSchema)
    assert(Buffer.byteLength(serialized, 'utf8') < 20_000)
    assert.equal(serialized.includes('"anyOf"'), false)
  } finally {
    await client.close()
    await server.close()
  }
})

test('advertises and enforces an installation-admitted tool and nested-command scope', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    scope: loadWorkbenchMcpScope({
      WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand',
      WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: 'n8n_workflow_migration',
      WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS: ''
    }),
    invoke: async (_contract, input) => ({ ok: true, result: { status: 'ok', input } })
  })
  const client = new Client({ name: 'workbench-mcp-scope-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), [
      'getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand'
    ])
    const runWorkbenchCommand = listed.tools.find(tool => tool.name === 'runWorkbenchCommand')
    assert(runWorkbenchCommand)
    const runInputSchema = runWorkbenchCommand.inputSchema as {
      properties?: Record<string, unknown>
    }
    const runCommandSchema = runInputSchema.properties?.command as {
      properties?: Record<string, unknown>
    }
    const runCommandProperties = runCommandSchema.properties || {}
    assert.deepEqual(
      (runCommandProperties.commandKind as { enum?: string[] }).enum,
      ['n8n_workflow_migration']
    )
    assert.equal(runCommandProperties.validationJobOperation, undefined)
    await assert.rejects(
      client.callTool({ name: 'applyWorkbenchFileChange', arguments: {} }),
      /Unknown or unadmitted Workbench MCP tool/
    )
    await assert.rejects(
      client.callTool({ name: 'mcpClientSessionCreate', arguments: { clientId: 'brain', expiresAt: '2099-01-01T00:00:00.000Z' } }),
      /Unknown or unadmitted Workbench MCP tool/
    )
    const denied = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({ sourceId: 'brain', commandKind: 'git_status_short' })
    })
    assert.equal(denied.isError, true)
    assert(JSON.stringify(denied).includes('mcp_scope_denied'))
  } finally {
    await client.close()
    await server.close()
  }
})

test('does not advertise or invoke runWorkbenchCommand without admitted command kinds', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    scope: loadWorkbenchMcpScope({
      WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus,runWorkbenchCommand',
      WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: ''
    })
  })
  const client = new Client({ name: 'workbench-mcp-empty-scope-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(tool => tool.name), ['getWorkbenchStatus'])
    await assert.rejects(
      client.callTool({
        name: 'runWorkbenchCommand',
        arguments: sessionCommand({ sourceId: 'brain', commandKind: 'n8n_workflow_migration' })
      }),
      /Unknown or unadmitted Workbench MCP tool/
    )
  } finally {
    await client.close()
    await server.close()
  }
})

test('admits safe validation through the default Workbench profile and denies unrestricted validation kinds', async () => {
  const calls: Record<string, unknown>[] = []
  const { client, server } = await connectedPair(async (_contract, input) => {
    calls.push(input)
    return { ok: true, result: { status: 'accepted' } }
  })
  try {
    const accepted = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({
        sourceId: 'fixture-source',
        commandKind: 'validate_json_files',
        validationJobOperation: 'submit',
        idempotencyKey: 'mcp-safe-validation-test',
        paths: ['package.json'],
        networkAccess: false
      })
    })
    assert.equal(accepted.isError, false)
    assert.equal(calls.length, 1)

    const denied = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({
        sourceId: 'fixture-source',
        commandKind: 'run_exact_command',
        validationJobOperation: 'submit',
        idempotencyKey: 'mcp-unsafe-validation-test',
        executable: 'rg',
        args: ['--files', '.'],
        networkAccess: false
      })
    })
    assert.equal(denied.isError, true)
    assert(JSON.stringify(denied).includes('mcp_scope_denied'))
    assert.equal(calls.length, 1)
  } finally {
    await client.close()
    await server.close()
  }
})

test('serialization keeps non-command tool contracts intact', async () => {
  const { client, server } = await connectedPair()
  try {
    const listed = await client.listTools()
    for (const tool of listed.tools.filter(item => item.name !== 'runWorkbenchCommand')) {
      const schema = tool.inputSchema as { type?: string; properties?: Record<string, unknown>; additionalProperties?: boolean }
      assert.equal(schema.type, 'object')
      assert.equal(schema.additionalProperties, false)
      assert(Object.keys(schema.properties || {}).length >= 0)
    }
  } finally {
    await client.close()
    await server.close()
  }
})

test('rejects unknown or incoherent admitted scope values', () => {
  assert.throws(() => loadWorkbenchMcpScope({ WORKBENCH_MCP_ALLOWED_TOOLS: 'unknown' }), /unknown values/)
  assert.throws(() => loadWorkbenchMcpScope({
    WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus',
    WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: 'n8n_workflow_migration'
  }), /requires runWorkbenchCommand/)
  assert.throws(() => loadWorkbenchMcpScope({
    WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS: 'mcpClientSessionCreate,unknownWorkflowTool'
  }), /WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS contains unknown values/)
  assert.equal(loadWorkbenchMcpScope({ WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS: '' }).clientWorkflowTools.size, 0)
})

test('Brain profile exposes exactly its three admitted tools and no client workflow tools', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createWorkbenchMcpServer({
    repoRoot,
    scope: loadWorkbenchMcpScope({
      WORKBENCH_MCP_ALLOWED_TOOLS: 'getWorkbenchStatus,readWorkbenchContext,runWorkbenchCommand',
      WORKBENCH_MCP_ALLOWED_COMMAND_KINDS: 'n8n_workflow_migration',
      WORKBENCH_MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS: ''
    })
  })
  const client = new Client({ name: 'brain-mcp-scope-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), [
      'getWorkbenchStatus', 'readWorkbenchContext', 'runWorkbenchCommand'
    ])
    await assert.rejects(
      client.callTool({ name: 'mcpCapabilityDiscover', arguments: {} }),
      /Unknown or unadmitted Workbench MCP tool/
    )
    const deniedValidation = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({
        sourceId: 'brain',
        commandKind: 'type_check_cli',
        validationJobOperation: 'submit',
        idempotencyKey: 'brain-validation-denied'
      })
    })
    assert.equal(deniedValidation.isError, true)
    assert(JSON.stringify(deniedValidation).includes('mcp_scope_denied'))
  } finally {
    await client.close()
    await server.close()
  }
})

test('invokes a validated tool and returns structured content', async () => {
  const { client, server } = await connectedPair()
  try {
    const result = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({ sourceId: 'workbench-example-source', commandKind: 'git_status_short' })
    })
    assert.equal(result.isError, false)
    assert.deepEqual(result.structuredContent, {
      status: 'ok',
      input: sessionCommand({ sourceId: 'workbench-example-source', commandKind: 'git_status_short' })
    })
  } finally {
    await client.close()
    await server.close()
  }
})

test('preserves prepared migration operation through tools/call and supports strict follow-up requests', async () => {
  const preparedResult = {
    status: 'needs_confirmation',
    sourceId: 'brain',
    commandKind: 'n8n_workflow_migration',
    migrationMode: 'apply',
    migrationPhase: 'prepare',
    confirmationToken: 'confirmation-example',
    operation: {
      operationId: 'cap-op-example',
      status: 'prepared',
      revision: 0,
      binding: {
        sourceId: 'brain',
        workflowId: 'workflow-example',
        mode: 'apply',
        candidatePath: 'artifacts/candidate.json',
        candidateSha256: 'a'.repeat(64),
        rollbackPath: 'artifacts/rollback.json',
        rollbackSha256: 'b'.repeat(64),
        manifestPath: 'artifacts/manifest.json',
        manifestSha256: 'c'.repeat(64),
        wrapperSha256: 'd'.repeat(64)
      },
      confirmationExpiresAt: '2026-07-19T19:30:00.000Z',
      rollbackReady: true
    },
    activity: {
      operationId: 'runWorkbenchCommand',
      phase: 'waiting_for_confirmation'
    }
  }
  const { client, server } = await connectedPair(async () => ({ ok: true, result: preparedResult }))
  try {
    const response = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({
        sourceId: 'brain',
        commandKind: 'n8n_workflow_migration',
        migration: {
          mode: 'apply',
          phase: 'prepare',
          workflowId: 'workflow-example',
          candidatePath: 'artifacts/candidate.json',
          rollbackPath: 'artifacts/rollback.json',
          manifestPath: 'artifacts/manifest.json',
          networkAccess: true
        }
      })
    })
    assert.equal(response.isError, false)
    const structured = response.structuredContent as typeof preparedResult
    assert.equal(structured.confirmationToken, 'confirmation-example')
    assert.equal(structured.operation.operationId, 'cap-op-example')
    assert.equal(structured.operation.status, 'prepared')
    assert.equal(structured.operation.revision, 0)
    assert.equal(structured.operation.binding.sourceId, 'brain')
    assert.equal(structured.operation.binding.workflowId, 'workflow-example')
    assert.equal(structured.operation.binding.mode, 'apply')
    assert.equal(structured.operation.binding.candidatePath, 'artifacts/candidate.json')
    assert.equal(structured.operation.binding.candidateSha256, 'a'.repeat(64))
    assert.equal(structured.operation.binding.rollbackPath, 'artifacts/rollback.json')
    assert.equal(structured.operation.binding.rollbackSha256, 'b'.repeat(64))
    assert.equal(structured.operation.binding.manifestPath, 'artifacts/manifest.json')
    assert.equal(structured.operation.binding.manifestSha256, 'c'.repeat(64))
    assert.equal(structured.operation.binding.wrapperSha256, 'd'.repeat(64))
    assert.equal(structured.operation.confirmationExpiresAt, '2026-07-19T19:30:00.000Z')
    assert.equal(structured.operation.rollbackReady, true)
    assert.equal(structured.activity.operationId, 'runWorkbenchCommand')
    assert.notEqual(structured.activity.operationId, structured.operation.operationId)
    const content = response.content as Array<{ type: string; text?: string }>
    assert.equal(content[0]?.type, 'text')
    const text = content[0]?.text
    assert.equal(typeof text, 'string')
    const textPayload = JSON.parse(text as string) as typeof preparedResult
    assert.equal(textPayload.confirmationToken, structured.confirmationToken)
    assert.equal(textPayload.operation.operationId, structured.operation.operationId)

    const execute = sessionAwareRunWorkbenchCommandRequestSchema.safeParse(sessionCommand({
      sourceId: structured.sourceId,
      commandKind: 'n8n_workflow_migration',
      migration: {
        mode: structured.migrationMode,
        phase: 'execute',
        operationId: structured.operation.operationId,
        confirmationToken: structured.confirmationToken
      }
    }))
    assert.equal(execute.success, true)

    const status = sessionAwareRunWorkbenchCommandRequestSchema.safeParse(sessionCommand({
      sourceId: structured.sourceId,
      commandKind: 'n8n_workflow_migration',
      migration: {
        mode: structured.migrationMode,
        phase: 'status',
        operationId: structured.operation.operationId
      }
    }))
    assert.equal(status.success, true)
  } finally {
    await client.close()
    await server.close()
  }
})

test('preserves only protected-domain mismatch names in migration status projection', async () => {
  const failedResult = {
    status: 'failed',
    sourceId: 'brain',
    commandKind: 'n8n_workflow_migration',
    migrationMode: 'apply',
    migrationPhase: 'status',
    operation: {
      operationId: 'cap-op-failed',
      status: 'failed',
      reasonCode: 'PRECONDITION_UNAVAILABLE',
      executorReasonCode: 'PROTECTED_DOMAIN_MISMATCH',
      protectedDomains: 'unverified',
      protectedDomainMismatches: ['activation', 'settings'],
      requestCounters: { candidateUpdate: 0, rollbackUpdate: 0, readback: 1 }
    }
  }
  const { client, server } = await connectedPair(async () => ({ ok: true, result: failedResult }))
  try {
    const response = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({
        sourceId: 'brain',
        commandKind: 'n8n_workflow_migration',
        migration: { mode: 'apply', phase: 'status', operationId: 'cap-op-failed' }
      })
    })
    assert.equal(response.isError, false)
    const structured = response.structuredContent as typeof failedResult
    assert.deepEqual(structured.operation.protectedDomainMismatches, ['activation', 'settings'])
    assert.deepEqual(structured.operation.requestCounters, {
      candidateUpdate: 0,
      rollbackUpdate: 0,
      readback: 1
    })
    const text = (response.content as Array<{ type: string; text?: string }>)[0]?.text
    assert.equal(typeof text, 'string')
    assert.deepEqual(
      (JSON.parse(text as string) as typeof failedResult).operation.protectedDomainMismatches,
      ['activation', 'settings']
    )
  } finally {
    await client.close()
    await server.close()
  }
})

test('rejects malformed, unknown, and oversized tool calls', async () => {
  const { client, server } = await connectedPair()
  try {
    const malformed = await client.callTool({
      name: 'runWorkbenchCommand',
      arguments: sessionCommand({ sourceId: 'workbench-example-source', commandKind: 'git_status_short', shell: 'bash' })
    })
    assert.equal(malformed.isError, true)
    assert(JSON.stringify(malformed).includes('invalid_mcp_request'))

    const oversized = await client.callTool({
      name: 'readWorkbenchContext',
      arguments: { mode: 'search', sourceId: 'source', query: 'x'.repeat(70_000) }
    })
    assert.equal(oversized.isError, true)
    assert(JSON.stringify(oversized).includes('exceeded the allowed size'))

    await assert.rejects(
      client.callTool({ name: 'unknownWorkbenchTool', arguments: {} }),
      /Unknown or unadmitted Workbench MCP tool/
    )
  } finally {
    await client.close()
    await server.close()
  }
})

test('propagates cancellation to an in-flight Workbench client', async () => {
  let observedAbort = false
  const { client, server } = await connectedPair(async (_contract, _input, signal) => {
    await new Promise<void>(resolve => {
      if (signal?.aborted) {
        observedAbort = true
        resolve()
        return
      }
      signal?.addEventListener('abort', () => { observedAbort = true; resolve() }, { once: true })
    })
    return { ok: false, code: 'bridge_internal_error', message: 'Workbench MCP request was cancelled.' }
  })
  try {
    const controller = new AbortController()
    const pending = client.callTool({
      name: 'getWorkbenchStatus',
      arguments: {}
    }, undefined, { signal: controller.signal })
    controller.abort()
    await assert.rejects(pending)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(observedAbort, true)
  } finally {
    await client.close()
    await server.close()
  }
})

test('runs the fixed stdio entrypoint, lists tools, and closes cleanly', async () => {
  const transport = new StdioClientTransport({
    command: '/opt/homebrew/bin/node',
    args: [path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js')],
    cwd: repoRoot
  })
  const client = new Client({ name: 'workbench-stdio-test', version: '1.0.0' })
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name), [
    ...CLIENT_WORKFLOW_TOOL_NAMES,
    'getWorkbenchStatus',
    'readWorkbenchContext',
    'applyWorkbenchFileChange',
    'commitWorkbenchChanges',
    'runWorkbenchCommand'
  ])
  await client.close()
})

test('repeated cold initialize and tools/list complete within justified budget', async () => {
  const ITERATIONS = 3
  const BUDGET_MS = 5_000  // 25x the measured 194ms cold-start; justified by startup_timeout_sec = 10
  for (let i = 0; i < ITERATIONS; i++) {
    const start = Date.now()
    const transport = new StdioClientTransport({
      command: '/opt/homebrew/bin/node',
      args: [path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js')],
      cwd: repoRoot
    })
    const client = new Client({ name: `workbench-cold-${i}`, version: '1.0.0' })
    await client.connect(transport)
    const listed = await client.listTools()
    assert.equal(listed.tools.length, CLIENT_WORKFLOW_TOOL_NAMES.length + 5, `Cold start ${i + 1}: expected full Workbench tool surface`)
    await client.close()
    const elapsed = Date.now() - start
    assert.ok(elapsed < BUDGET_MS, `Cold start ${i + 1} took ${elapsed}ms, exceeds ${BUDGET_MS}ms justified budget`)
  }
})

test('rejects an oversized newline-delimited stdio message', async () => {
  const child = spawn('/opt/homebrew/bin/node', [path.join(repoRoot, 'packages', 'mcp', 'dist', 'server.js')], {
    cwd: repoRoot,
    stdio: ['pipe', 'ignore', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(`${'x'.repeat(70_000)}\n`)
  const [code] = await once(child, 'exit') as [number | null]
  assert.notEqual(code, 0)
  assert(stderr.includes('MCP stdin message exceeded the allowed size'))
})
