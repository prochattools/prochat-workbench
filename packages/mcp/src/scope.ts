import {
  RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
  SAFE_MCP_VALIDATION_COMMAND_KINDS,
  type PersistedValidationCommandKind,
  type RunWorkbenchDirectCommandKind
} from '@workbench/shared'
import { WORKBENCH_TOOL_NAMES, type WorkbenchToolName } from './contracts.js'
import {
  BRAIN_PROFILE_ALLOWED_CLIENT_WORKFLOW_TOOLS,
  MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS_ENV,
  MCP_ALLOWED_COMMAND_KINDS_ENV,
  MCP_ALLOWED_TOOLS_ENV
} from './configure-core.js'
import { CLIENT_WORKFLOW_TOOL_NAMES, type ClientWorkflowToolName } from './client-workflow-tools.js'

export { MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS_ENV }

export type WorkbenchMcpScope = {
  tools: ReadonlySet<WorkbenchToolName>
  commandKinds: ReadonlySet<RunWorkbenchDirectCommandKind>
  validationKinds: ReadonlySet<PersistedValidationCommandKind>
  clientWorkflowTools: ReadonlySet<ClientWorkflowToolName>
}

function parseList(value: string | undefined, defaults: readonly string[]): string[] {
  if (value === undefined) return [...defaults]
  return Array.from(new Set(value.split(',').map(item => item.trim()).filter(Boolean)))
}

function requireKnown<T extends string>(values: string[], known: readonly T[], label: string): T[] {
  const allowed = new Set<string>(known)
  const unknown = values.filter(value => !allowed.has(value))
  if (unknown.length > 0) throw new Error(`${label} contains unknown values: ${unknown.join(', ')}`)
  return values as T[]
}

export function loadWorkbenchMcpScope(env: NodeJS.ProcessEnv = process.env): WorkbenchMcpScope {
  const tools = requireKnown(
    parseList(env[MCP_ALLOWED_TOOLS_ENV], WORKBENCH_TOOL_NAMES),
    WORKBENCH_TOOL_NAMES,
    MCP_ALLOWED_TOOLS_ENV
  )
  const commandKinds = requireKnown(
    parseList(env[MCP_ALLOWED_COMMAND_KINDS_ENV], RUN_WORKBENCH_DIRECT_COMMAND_KINDS),
    RUN_WORKBENCH_DIRECT_COMMAND_KINDS,
    MCP_ALLOWED_COMMAND_KINDS_ENV
  )
  if (!tools.includes('runWorkbenchCommand') && env[MCP_ALLOWED_COMMAND_KINDS_ENV] !== undefined && commandKinds.length > 0) {
    throw new Error(`${MCP_ALLOWED_COMMAND_KINDS_ENV} requires runWorkbenchCommand to be admitted.`)
  }
  // A restricted profile must opt in explicitly to client-workflow authority. This
  // keeps older Brain registrations fail-closed until they are regenerated with
  // the explicit empty value.
  const defaultClientWorkflowTools = env[MCP_ALLOWED_TOOLS_ENV] !== undefined || env[MCP_ALLOWED_COMMAND_KINDS_ENV] !== undefined
    ? BRAIN_PROFILE_ALLOWED_CLIENT_WORKFLOW_TOOLS
    : undefined
  const clientWorkflowTools = requireKnown(
    parseList(env[MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS_ENV], defaultClientWorkflowTools === '' ? [] : CLIENT_WORKFLOW_TOOL_NAMES),
    CLIENT_WORKFLOW_TOOL_NAMES,
    MCP_ALLOWED_CLIENT_WORKFLOW_TOOLS_ENV
  )
  // The unrestricted Workbench registration is the only profile that receives
  // the provider-owned safe validation surface. Restricted profiles (including
  // Brain) must opt into a separate, explicitly admitted validation policy in a
  // future release rather than inheriting Workbench validation accidentally.
  const unrestrictedWorkbenchProfile = env[MCP_ALLOWED_TOOLS_ENV] === undefined && env[MCP_ALLOWED_COMMAND_KINDS_ENV] === undefined
  const validationKinds = unrestrictedWorkbenchProfile
    ? SAFE_MCP_VALIDATION_COMMAND_KINDS
    : []
  return {
    tools: new Set(tools),
    commandKinds: new Set(commandKinds),
    validationKinds: new Set(validationKinds),
    clientWorkflowTools: new Set(clientWorkflowTools)
  }
}
