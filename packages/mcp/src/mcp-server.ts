import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { createWorkbenchClient, MAX_ACTION_REQUEST_BYTES, type BridgeResult } from './client.js'
import {
  WORKBENCH_TOOL_NAMES,
  buildRunWorkbenchCommandDiscoverySchema,
  loadWorkbenchToolContracts,
  validateToolInput,
  type WorkbenchToolContract,
  type WorkbenchToolName
} from './contracts.js'
import { loadWorkbenchMcpScope, type WorkbenchMcpScope } from './scope.js'
import { createClientCapabilityRequest, createClientWorkflowSession, decideClientCapabilityRequest, getClientCapabilityRequest, getClientWorkflowSession, listClientCapabilityRequests, transitionClientWorkflowSession } from './client-capability-workflow.js'
import { listCapabilityProviders } from './capability-provider.js'
import { resolveCapabilities } from './capability-resolution.js'
import { createAndPersistCapabilityPlan, listCapabilityPlans, transitionCapabilityPlan } from './capability-planning.js'
import { createCapabilityRuntimeGateway } from './capability-runtime-gateway.js'
import { createMcpCapabilityAdapter } from './mcp-capability-adapter.js'
import { listExecutionRecords } from './capability-execution-coordinator.js'
import type { CapabilityBroker } from './capability-broker.js'
import { CLIENT_WORKFLOW_TOOL_NAMES, type ClientWorkflowToolName } from './client-workflow-tools.js'

type InvokeWorkbench = (contract: WorkbenchToolContract, input: Record<string, unknown>, signal?: AbortSignal) => Promise<BridgeResult>
type InvokeClientWorkflow = (operation: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

const CLIENT_WORKFLOW_TOOLS = [
  { name: 'mcpClientSessionCreate', description: 'Create an owner-local opaque MCP client workflow session.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientId', 'expiresAt'], properties: { clientId: { type: 'string', minLength: 1, maxLength: 256 }, expiresAt: { type: 'string', minLength: 24, maxLength: 40 } } } },
  { name: 'mcpClientSessionStatus', description: 'Validate an opaque MCP client workflow session.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 } } } },
  { name: 'mcpClientSessionRevoke', description: 'Revoke an opaque MCP client workflow session.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 } } } },
  { name: 'mcpCapabilityRequest', description: 'Request a capability for explicit approval; does not execute anything.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId', 'capabilityId', 'operation', 'expiresAt'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 }, capabilityId: { type: 'string', minLength: 1, maxLength: 256 }, operation: { type: 'string', minLength: 1, maxLength: 256 }, expiresAt: { type: 'string', minLength: 24, maxLength: 40 }, permissions: { type: 'array', maxItems: 6, items: { enum: ['read', 'write', 'command', 'git', 'network', 'capability'] } }, budgets: { type: 'object', additionalProperties: false, properties: { maximumBytes: { type: 'number', minimum: 0 }, maximumDurationMs: { type: 'number', minimum: 0 }, maximumQueries: { type: 'number', minimum: 0 } } } } } },
  { name: 'mcpCapabilityDiscover', description: 'Discover bounded capabilities from the existing enabled provider inventory.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'mcpCapabilityApproval', description: 'Record an explicit approval or rejection for a capability request.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'decision'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 256 }, decision: { enum: ['approved', 'rejected', 'cancelled'] }, approvedBy: { type: 'string', minLength: 1, maxLength: 256 } } } },
  { name: 'mcpCapabilityRequestStatus', description: 'Retrieve bounded capability request status.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: { type: 'string', minLength: 1, maxLength: 256 } } } },
  { name: 'mcpCapabilityPlan', description: 'Create a persisted capability plan through the Workbench authorization boundary.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId', 'query', 'operation', 'budgets', 'expiresAt'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 }, query: { type: 'string', minLength: 1, maxLength: 2000 }, capabilityId: { type: 'string', maxLength: 256 }, operation: { type: 'string', minLength: 1, maxLength: 256 }, permissions: { type: 'array', maxItems: 6, items: { enum: ['read', 'write', 'command', 'git', 'network', 'capability'] } }, budgets: { type: 'object', additionalProperties: false, required: ['maximumBytes', 'maximumDurationMs', 'maximumQueries'], properties: { maximumBytes: { type: 'number', minimum: 0 }, maximumDurationMs: { type: 'number', minimum: 0 }, maximumQueries: { type: 'number', minimum: 0 } } }, expiresAt: { type: 'string', minLength: 24, maxLength: 40 }, createdBy: { type: 'string', maxLength: 256 } } } },
  { name: 'mcpCapabilityPlanApprove', description: 'Explicitly approve a persisted capability plan.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId', 'planId'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 }, planId: { type: 'string', minLength: 1, maxLength: 256 } } } },
  { name: 'mcpCapabilityExecute', description: 'Execute only an approved capability plan through the runtime gateway.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId', 'planId', 'requestId', 'requestedBy', 'runtimeId'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 }, planId: { type: 'string', minLength: 1, maxLength: 256 }, requestId: { type: 'string', minLength: 1, maxLength: 256 }, requestedBy: { type: 'string', minLength: 1, maxLength: 256 }, runtimeId: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'number', minimum: 1, maximum: 300000 } } } },
  { name: 'mcpCapabilityResult', description: 'Retrieve a bounded capability execution result owned by the client session.', inputSchema: { type: 'object', additionalProperties: false, required: ['clientSessionId', 'executionId'], properties: { clientSessionId: { type: 'string', minLength: 1, maxLength: 256 }, executionId: { type: 'string', minLength: 1, maxLength: 256 } } } }
] as const

function isClientWorkflowTool(name: string): name is ClientWorkflowToolName { return CLIENT_WORKFLOW_TOOL_NAMES.includes(name as ClientWorkflowToolName) }
function clientWorkflowResponse(result: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { result }, isError: !!result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false } }

function toolResponse(result: BridgeResult) {
  const payload = result.ok ? result.result : result
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { result: payload },
    isError: !result.ok
  }
}

export function createWorkbenchMcpServer(params: { repoRoot: string; invoke?: InvokeWorkbench; invokeClientWorkflow?: InvokeClientWorkflow; scope?: WorkbenchMcpScope; contextIntelligenceSessionId?: string; capabilityBroker?: CapabilityBroker }) {
  const contracts = loadWorkbenchToolContracts(params.repoRoot)
  const invoke = params.invoke ?? createWorkbenchClient()
  const scope = params.scope ?? loadWorkbenchMcpScope()
  const runWorkbenchCommandAdmitted = scope.tools.has('runWorkbenchCommand') && (scope.commandKinds.size > 0 || scope.validationKinds.size > 0)
  const admittedToolNames = WORKBENCH_TOOL_NAMES.filter(name =>
    scope.tools.has(name) && (name !== 'runWorkbenchCommand' || runWorkbenchCommandAdmitted)
  )
  const admittedToolNameSet = new Set<WorkbenchToolName>(admittedToolNames)
  const runWorkbenchCommandDiscoverySchema = runWorkbenchCommandAdmitted
    ? buildRunWorkbenchCommandDiscoverySchema(scope.commandKinds, scope.validationKinds)
    : undefined
  const server = new Server({ name: 'workbench', version: '1.3.14-beta' }, {
    capabilities: { tools: {} },
    instructions: 'Use only the admitted bounded Workbench actions. Workbench remains authoritative for source selection, policy, confirmation, grants, dispatch, audit, and execution. Never retry mutation-capable calls after ambiguous transport results.'
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...CLIENT_WORKFLOW_TOOLS.filter(tool => scope.clientWorkflowTools.has(tool.name)), ...admittedToolNames.map(name => {
      const contract = contracts.get(name)!
      return {
        name,
        title: contract.title,
        description: contract.description,
        inputSchema: (name === 'runWorkbenchCommand'
          ? runWorkbenchCommandDiscoverySchema
          : contract.inputSchema) as { type: 'object'; [key: string]: unknown },
        annotations: {
          readOnlyHint: !contract.mutationCapable,
          destructiveHint: contract.mutationCapable,
          idempotentHint: !contract.mutationCapable,
          openWorldHint: false
        }
      }
    })]
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name as WorkbenchToolName
    if (isClientWorkflowTool(name)) {
      if (!scope.clientWorkflowTools.has(name)) throw new McpError(ErrorCode.MethodNotFound, 'Unknown or unadmitted Workbench MCP tool.')
      const input = (request.params.arguments ?? {}) as Record<string, unknown>
      const options = { rootDir: process.env.WORKBENCH_PROVIDER_STATE_DIR }
      let result: unknown
      if (name === 'mcpClientSessionCreate') result = createClientWorkflowSession({ clientId: String(input.clientId ?? ''), ownerId: `owner-${typeof process.getuid === 'function' ? process.getuid() : 'local'}`, expiresAt: String(input.expiresAt ?? '') }, options)
      else if (name === 'mcpClientSessionStatus') result = getClientWorkflowSession(String(input.clientSessionId ?? ''), options)
      else if (name === 'mcpClientSessionRevoke') result = transitionClientWorkflowSession(String(input.clientSessionId ?? ''), 'revoked', options)
      else if (name === 'mcpCapabilityDiscover') {
        const inventory = listCapabilityProviders(options)
        result = inventory.ok ? { ok: true, value: inventory.value.filter(provider => provider.enabled && provider.registrationState === 'enabled' && provider.health === 'healthy').slice(0, 64).map(provider => ({ providerId: provider.providerId, displayName: provider.displayName, providerType: provider.providerType, capabilities: provider.capabilities.slice(0, 128), health: provider.health })) } : inventory
      }
      else if (params.invokeClientWorkflow) result = await params.invokeClientWorkflow(name, input, extra.signal)
      else if (name === 'mcpCapabilityPlan') {
        const clientSessionId = String(input.clientSessionId ?? '')
        const external = getClientWorkflowSession(clientSessionId, options)
        const requests = listClientCapabilityRequests(clientSessionId, options)
        const providers = listCapabilityProviders(options)
        const request = requests.ok ? requests.value.reverse().find(item => item.capabilityId === String(input.capabilityId ?? '') && item.state === 'approved') : undefined
        if (!external.ok || !requests.ok || !providers.ok || !request) result = { ok: false, code: 'authorization_required', message: 'An active session, healthy provider, and approved capability request are required.' }
        else {
          const context = { sessionId: clientSessionId, status: 'confirmed' as const, sourceIds: [] }
          const resolution = resolveCapabilities({ context, intent: { query: String(input.query ?? ''), requestedCapabilities: [request.capabilityId], requiredPermissions: request.permissions }, providers: providers.value, now: new Date().toISOString() })
          const grant = { grantId: `external-approval-${request.requestId}`, grantVersion: 1, state: 'active' as const, permissions: request.permissions, budgets: request.budgets }
          result = createAndPersistCapabilityPlan({ context, resolution, providers: providers.value, grants: [grant], selectedCapabilityId: request.capabilityId, requestedOperation: request.operation, requiredPermissions: request.permissions, requiredBudgets: request.budgets, expiresAt: String(input.expiresAt ?? request.expiresAt), createdBy: typeof input.createdBy === 'string' ? input.createdBy : 'external-client', now: new Date().toISOString() }, options)
        }
      }
      else if (name === 'mcpCapabilityPlanApprove') {
        const clientSessionId = String(input.clientSessionId ?? ''); const plans = listCapabilityPlans(options); const plan = plans.ok ? plans.value.find(item => item.planId === String(input.planId ?? '') && item.contextSessionId === clientSessionId) : undefined
        result = !getClientWorkflowSession(clientSessionId, options).ok || !plan ? { ok: false, code: 'plan_not_found', message: 'Owned capability plan was not found.' } : transitionCapabilityPlan(plan.planId, 'reviewed', options).ok ? transitionCapabilityPlan(plan.planId, 'approved', options) : { ok: false, code: 'invalid_transition', message: 'Capability plan approval transition was rejected.' }
      }
      else if (name === 'mcpCapabilityExecute') {
        const clientSessionId = String(input.clientSessionId ?? ''); const plans = listCapabilityPlans(options); const plan = plans.ok ? plans.value.find(item => item.planId === String(input.planId ?? '') && item.contextSessionId === clientSessionId) : undefined; const providers = listCapabilityProviders(options); const provider = providers.ok && plan ? providers.value.find(item => item.providerId === plan.providerId) : undefined
        if (!getClientWorkflowSession(clientSessionId, options).ok || !plan || !provider) result = { ok: false, code: 'context_missing', message: 'Owned session, approved plan, and provider are required.' }
        else if (params.capabilityBroker) {
          const sourceId = plan.sourceIds[0]
          result = sourceId
            ? params.capabilityBroker.run({ capabilityId: plan.capabilityId, sourceId, sessionId: clientSessionId, runId: String(input.requestId ?? ''), requestId: String(input.requestId ?? ''), idempotencyKey: String(input.requestId ?? ''), requestedBy: String(input.requestedBy ?? ''), input: { planId: plan.planId, operation: plan.requestedOperation } })
            : { ok: false, code: 'job_invalid_request', message: 'An explicit source is required before submitting a capability job.' }
        }
        else {
          const request = { clientSessionId, planId: plan.planId, requestId: String(input.requestId ?? ''), requestedBy: String(input.requestedBy ?? ''), runtimeId: String(input.runtimeId ?? '') }
          const grant = { grantId: plan.grantBinding.grantId, grantVersion: plan.grantBinding.grantVersion, state: 'active' as const, permissions: plan.requiredPermissions, budgets: plan.requiredBudgets }
          const adapter = createMcpCapabilityAdapter({ rootDir: options.rootDir, boundary: async () => ({ ok: true, result: { providerId: provider.providerId, capabilityId: plan.capabilityId, operation: plan.requestedOperation, inspected: true } }) })
          const gateway = createCapabilityRuntimeGateway({ rootDir: options.rootDir, adapters: [adapter as never], resolveContext: sessionId => sessionId === clientSessionId ? { sessionId, status: 'confirmed' as const, sourceIds: [], clientId: clientSessionId } : undefined, resolvePlan: planId => { const current = listCapabilityPlans(options); return current.ok ? current.value.find(item => item.planId === planId) : undefined }, resolveProvider: providerId => providerId === provider.providerId ? provider : undefined, resolveValidationState: () => ({ context: { sessionId: clientSessionId, status: 'confirmed' as const, sourceIds: [] }, provider, grant, advertisedCapabilities: provider.capabilities, operationAllowed: true, riskPolicy: { allowLowRisk: true, allowMediumRisk: true, allowHighRisk: false } }) })
          result = await gateway.execute({ capabilityPlanId: plan.planId, contextSessionId: clientSessionId, providerId: provider.providerId, capabilityId: plan.capabilityId, operation: plan.requestedOperation, requestIdentity: { requestedBy: request.requestedBy, requestedAt: new Date().toISOString() }, owner: { runtimeId: request.runtimeId, clientId: clientSessionId, sessionId: clientSessionId, requestId: request.requestId }, timeoutMs: typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined })
        }
      }
      else if (name === 'mcpCapabilityResult') {
        const clientSessionId = String(input.clientSessionId ?? ''); const executionId = String(input.executionId ?? '')
        if (params.capabilityBroker) {
          const job = params.capabilityBroker.listJobs().find(item => item.jobId === executionId && item.sessionId === clientSessionId)
          result = job ? params.capabilityBroker.status(job.jobId, { sourceId: job.sourceId, sessionId: job.sessionId, runId: job.runId, requestId: job.requestId }) : { ok: false, code: 'execution_not_found', message: 'Owned capability job was not found.' }
        } else {
          const records = listExecutionRecords({ rootDir: options.rootDir, adapters: [] }); const record = records.find(item => item.executionId === executionId && item.owner?.sessionId === clientSessionId); result = record ? { ok: true, value: record } : { ok: false, code: 'execution_not_found', message: 'Owned execution result was not found.' }
        }
      }
      else if (name === 'mcpCapabilityRequest') result = createClientCapabilityRequest({ clientSessionId: String(input.clientSessionId ?? ''), capabilityId: String(input.capabilityId ?? ''), operation: String(input.operation ?? ''), expiresAt: String(input.expiresAt ?? ''), permissions: Array.isArray(input.permissions) ? input.permissions as never : undefined, budgets: input.budgets as never }, options)
      else if (name === 'mcpCapabilityApproval') result = decideClientCapabilityRequest(String(input.requestId ?? ''), String(input.decision ?? '') as 'approved' | 'rejected' | 'cancelled', typeof input.approvedBy === 'string' ? input.approvedBy : undefined, options)
      else result = getClientCapabilityRequest(String(input.requestId ?? ''), options)
      return clientWorkflowResponse(result)
    }
    const contract = contracts.get(name)
    if (!contract || !admittedToolNameSet.has(name)) throw new McpError(ErrorCode.MethodNotFound, 'Unknown or unadmitted Workbench MCP tool.')
    if (Buffer.byteLength(JSON.stringify(request.params.arguments ?? {}), 'utf8') > MAX_ACTION_REQUEST_BYTES) {
      return toolResponse({
        ok: false,
        code: 'invalid_mcp_request',
        message: 'Workbench MCP request exceeded the allowed size.'
      })
    }
    const rawInput = request.params.arguments ?? {}
    if (contract.name === 'runWorkbenchCommand') {
      const command = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>).command
        : undefined
      const commandKind = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).commandKind
        : undefined
      const validationOperation = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).validationJobOperation
        : undefined
      const admitted = validationOperation !== undefined
        ? typeof commandKind === 'string' && (scope.validationKinds.has(commandKind as never) || commandKind === 'read_evidence')
        : typeof commandKind === 'string' && scope.commandKinds.has(commandKind as never)
      if (typeof commandKind === 'string' && !admitted) {
        return toolResponse({
          ok: false,
          code: 'mcp_scope_denied',
          message: 'Workbench MCP command kind is outside the admitted scope.'
        })
      }
    }
    const parsed = validateToolInput(contract, rawInput)
    if (!parsed.ok) {
      return toolResponse({
        ok: false,
        code: 'invalid_mcp_request',
        message: 'Workbench MCP input failed strict validation.',
        details: parsed.issues
      })
    }
    if (contract.name === 'runWorkbenchCommand') {
      const command = parsed.value.command
      const commandKind = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).commandKind
        : undefined
      const validationOperation = command && typeof command === 'object' && !Array.isArray(command)
        ? (command as Record<string, unknown>).validationJobOperation
        : undefined
      const admitted = validationOperation !== undefined
        ? typeof commandKind === 'string' && (scope.validationKinds.has(commandKind as never) || commandKind === 'read_evidence')
        : typeof commandKind === 'string' && scope.commandKinds.has(commandKind as never)
      if (!admitted) {
        return toolResponse({
          ok: false,
          code: 'mcp_scope_denied',
          message: 'Workbench MCP command kind is outside the admitted scope.'
        })
      }
    }
    const invokeInput = params.contextIntelligenceSessionId
      ? { ...parsed.value, contextIntelligenceSessionId: params.contextIntelligenceSessionId }
      : parsed.value
    return toolResponse(await invoke(contract, invokeInput, extra.signal))
  })

  return server
}
