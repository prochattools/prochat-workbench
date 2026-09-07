import fs from 'node:fs'
import path from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import {
  sessionAwareRunWorkbenchCommandRequestSchema,
  type PersistedValidationCommandKind,
  type RunWorkbenchDirectCommandKind
} from '@workbench/shared'
import { zodToJsonSchema } from 'zod-to-json-schema'

export const WORKBENCH_TOOL_NAMES = [
  'getWorkbenchStatus',
  'readWorkbenchContext',
  'applyWorkbenchFileChange',
  'commitWorkbenchChanges',
  'runWorkbenchCommand'
] as const

export type WorkbenchToolName = typeof WORKBENCH_TOOL_NAMES[number]
export type JsonSchema = Record<string, unknown>

export type WorkbenchToolContract = {
  name: WorkbenchToolName
  title: string
  description: string
  inputSchema: JsonSchema
  method: 'GET' | 'POST'
  endpoint: string
  mutationCapable: boolean
  validate: ValidateFunction
}

type OpenApiOperation = {
  operationId?: unknown
  summary?: unknown
  description?: unknown
  parameters?: Array<Record<string, unknown>>
  requestBody?: {
    content?: {
      'application/json'?: { schema?: JsonSchema }
    }
  }
}

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

const ACTIONS: Record<WorkbenchToolName, { method: 'get' | 'post'; endpoint: string; mutationCapable: boolean }> = {
  getWorkbenchStatus: { method: 'get', endpoint: '/api/actions/status', mutationCapable: false },
  readWorkbenchContext: { method: 'post', endpoint: '/api/actions/read-context', mutationCapable: false },
  applyWorkbenchFileChange: { method: 'post', endpoint: '/api/actions/apply-file-change', mutationCapable: true },
  commitWorkbenchChanges: { method: 'post', endpoint: '/api/actions/commit-changes', mutationCapable: true },
  runWorkbenchCommand: { method: 'post', endpoint: '/api/actions/run-command', mutationCapable: true }
}

const MAX_OPENAPI_BYTES = 512 * 1024

function readOpenApi(repoRoot: string): OpenApiDocument {
  const schemaPath = path.join(repoRoot, 'docs', 'openapi.chatgpt.json')
  const stat = fs.statSync(schemaPath)
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_OPENAPI_BYTES) {
    throw new Error('Committed Workbench OpenAPI artifact is missing or outside the allowed size.')
  }
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as OpenApiDocument
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSchema(schema: JsonSchema): JsonSchema {
  if (!isObjectRecord(schema)) return schema

  const composites = ['anyOf', 'oneOf', 'allOf']
    .flatMap(key => Array.isArray(schema[key]) ? schema[key] as JsonSchema[] : [])
    .filter(Boolean)

  if (composites.length > 0 && composites.every(isObjectRecord)) {
    return mergeObjectSchemas(composites.map(item => normalizeSchema(item)))
  }

  const projected: Record<string, unknown> = { ...schema }
  if (isObjectRecord(schema.properties)) {
    projected.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, normalizeSchema(value as JsonSchema)])
    )
  }
  if (isObjectRecord(schema.items)) {
    projected.items = normalizeSchema(schema.items as JsonSchema)
  }
  delete projected.anyOf
  delete projected.oneOf
  delete projected.allOf
  return projected
}

function mergeEnumValues(left: JsonSchema, right: JsonSchema): JsonSchema | undefined {
  const leftEnum = Array.isArray(left.enum) ? left.enum : undefined
  const rightEnum = Array.isArray(right.enum) ? right.enum : undefined
  if (!leftEnum && !rightEnum) return undefined
  const merged = [...new Set([...(leftEnum ?? []), ...(rightEnum ?? [])])]
  if (left.type === 'boolean' || right.type === 'boolean' || merged.every(value => typeof value === 'boolean')) {
    return { type: 'boolean' }
  }
  const schema: Record<string, unknown> = { enum: merged }
  if (merged.every(value => typeof value === 'string')) schema.type = 'string'
  return schema
}

function mergePropertySchemas(left: JsonSchema, right: JsonSchema): JsonSchema {
  const normalizedLeft = normalizeSchema(left)
  const normalizedRight = normalizeSchema(right)
  const enumSchema = mergeEnumValues(normalizedLeft, normalizedRight)
  if (enumSchema) return enumSchema

  if (isObjectRecord(normalizedLeft.properties) || isObjectRecord(normalizedRight.properties)) {
    const schemas: JsonSchema[] = []
    if (isObjectRecord(normalizedLeft.properties) || normalizedLeft.type === 'object') schemas.push(normalizedLeft)
    if (isObjectRecord(normalizedRight.properties) || normalizedRight.type === 'object') schemas.push(normalizedRight)
    if (schemas.length > 0) return mergeObjectSchemas(schemas)
  }

  if (normalizedLeft.type === 'boolean' || normalizedRight.type === 'boolean') {
    return { type: 'boolean' }
  }
  if (normalizedLeft.type === 'string' || normalizedRight.type === 'string') {
    const projected: Record<string, unknown> = { type: 'string' }
    if (typeof normalizedLeft.minLength === 'number' || typeof normalizedRight.minLength === 'number') {
      projected.minLength = Math.min(
        typeof normalizedLeft.minLength === 'number' ? normalizedLeft.minLength : Number.POSITIVE_INFINITY,
        typeof normalizedRight.minLength === 'number' ? normalizedRight.minLength : Number.POSITIVE_INFINITY
      )
    }
    if (typeof normalizedLeft.maxLength === 'number' || typeof normalizedRight.maxLength === 'number') {
      projected.maxLength = Math.max(
        typeof normalizedLeft.maxLength === 'number' ? normalizedLeft.maxLength : 0,
        typeof normalizedRight.maxLength === 'number' ? normalizedRight.maxLength : 0
      )
    }
    if (typeof normalizedLeft.pattern === 'string' || typeof normalizedRight.pattern === 'string') {
      projected.pattern = typeof normalizedLeft.pattern === 'string' ? normalizedLeft.pattern : normalizedRight.pattern
    }
    return projected
  }
  if (normalizedLeft.type === 'integer' || normalizedRight.type === 'integer') {
    const projected: Record<string, unknown> = { type: 'integer' }
    const leftMin = typeof normalizedLeft.minimum === 'number' ? normalizedLeft.minimum : Number.NEGATIVE_INFINITY
    const rightMin = typeof normalizedRight.minimum === 'number' ? normalizedRight.minimum : Number.NEGATIVE_INFINITY
    const leftMax = typeof normalizedLeft.maximum === 'number' ? normalizedLeft.maximum : Number.POSITIVE_INFINITY
    const rightMax = typeof normalizedRight.maximum === 'number' ? normalizedRight.maximum : Number.POSITIVE_INFINITY
    if (Number.isFinite(leftMin) || Number.isFinite(rightMin)) projected.minimum = Math.max(leftMin, rightMin)
    if (Number.isFinite(leftMax) || Number.isFinite(rightMax)) projected.maximum = Math.min(leftMax, rightMax)
    return projected
  }
  if (normalizedLeft.type === 'array' || normalizedRight.type === 'array') {
    const items = normalizedLeft.items && normalizedRight.items && isObjectRecord(normalizedLeft.items) && isObjectRecord(normalizedRight.items)
      ? mergePropertySchemas(normalizedLeft.items as JsonSchema, normalizedRight.items as JsonSchema)
      : normalizedLeft.items || normalizedRight.items
    const projected: Record<string, unknown> = { type: 'array' }
    if (items) projected.items = normalizeSchema(items as JsonSchema)
    if (typeof normalizedLeft.minItems === 'number' || typeof normalizedRight.minItems === 'number') {
      projected.minItems = Math.min(
        typeof normalizedLeft.minItems === 'number' ? normalizedLeft.minItems : Number.POSITIVE_INFINITY,
        typeof normalizedRight.minItems === 'number' ? normalizedRight.minItems : Number.POSITIVE_INFINITY
      )
    }
    if (typeof normalizedLeft.maxItems === 'number' || typeof normalizedRight.maxItems === 'number') {
      projected.maxItems = Math.max(
        typeof normalizedLeft.maxItems === 'number' ? normalizedLeft.maxItems : 0,
        typeof normalizedRight.maxItems === 'number' ? normalizedRight.maxItems : 0
      )
    }
    return projected
  }

  return normalizedLeft
}

function mergeObjectSchemas(schemas: JsonSchema[]): JsonSchema {
  const projectedSchemas = schemas.map(schema => normalizeSchema(schema))
  const properties = new Map<string, JsonSchema>()
  const requiredCounts = new Map<string, number>()

  for (const schema of projectedSchemas) {
    const schemaProperties = isObjectRecord(schema.properties) ? schema.properties : {}
    for (const [name, value] of Object.entries(schemaProperties)) {
      const existing = properties.get(name)
      properties.set(name, existing ? mergePropertySchemas(existing, value as JsonSchema) : normalizeSchema(value as JsonSchema))
    }
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      requiredCounts.set(name, (requiredCounts.get(name) || 0) + 1)
    }
  }

  const required = [...requiredCounts.entries()]
    .filter(([, count]) => count === projectedSchemas.length)
    .map(([name]) => name)
    .sort()

  return {
    type: 'object',
    properties: Object.fromEntries([...properties.entries()].sort(([a], [b]) => a.localeCompare(b))),
    required: required.length > 0 ? required : undefined,
    additionalProperties: false
  }
}

function filterSchemaByCommandKinds(
  schema: JsonSchema,
  admittedCommandKinds: ReadonlySet<RunWorkbenchDirectCommandKind>,
  admittedValidationKinds: ReadonlySet<PersistedValidationCommandKind> = new Set()
): JsonSchema | undefined {
  if (!isObjectRecord(schema)) return schema
  const projected: Record<string, unknown> = { ...schema }

  if (isObjectRecord(schema.properties)) {
    const properties: Record<string, unknown> = { ...schema.properties }
    const commandKind = properties.commandKind
    const validationBranch = Object.hasOwn(properties, 'validationJobOperation')
    if (isObjectRecord(commandKind) && Array.isArray(commandKind.enum)) {
      const admitted = commandKind.enum.filter(
        (value): value is string => typeof value === 'string' && (
          validationBranch
            ? admittedValidationKinds.has(value as PersistedValidationCommandKind)
            : admittedCommandKinds.has(value as RunWorkbenchDirectCommandKind)
        )
      )
      if (admitted.length === 0) return undefined
      properties.commandKind = { ...commandKind, enum: admitted }
    } else if (validationBranch && admittedValidationKinds.size === 0) {
      return undefined
    }
    if (isObjectRecord(properties.command)) {
      const filteredCommand = filterSchemaByCommandKinds(properties.command, admittedCommandKinds, admittedValidationKinds)
      if (!filteredCommand) return undefined
      properties.command = filteredCommand
    }
    projected.properties = properties
  }

  for (const key of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(schema[key])) continue
    const admittedBranches = (schema[key] as JsonSchema[])
      .map(branch => filterSchemaByCommandKinds(branch, admittedCommandKinds, admittedValidationKinds))
      .filter((branch): branch is JsonSchema => branch !== undefined)
    if (admittedBranches.length === 0) return undefined
    projected[key] = admittedBranches
  }
  if (Array.isArray(schema.allOf)) {
    const admittedBranches = (schema.allOf as JsonSchema[])
      .map(branch => filterSchemaByCommandKinds(branch, admittedCommandKinds, admittedValidationKinds))
    if (admittedBranches.some(branch => branch === undefined)) return undefined
    projected.allOf = admittedBranches as JsonSchema[]
  }

  return projected
}

export function buildRunWorkbenchCommandDiscoverySchema(
  admittedCommandKinds?: ReadonlySet<RunWorkbenchDirectCommandKind>,
  admittedValidationKinds: ReadonlySet<PersistedValidationCommandKind> = new Set()
): JsonSchema {
  const strictSchema = zodToJsonSchema(sessionAwareRunWorkbenchCommandRequestSchema, {
    target: 'openApi3',
    $refStrategy: 'none'
  }) as JsonSchema
  const scopedSchema = admittedCommandKinds
    ? filterSchemaByCommandKinds(strictSchema, admittedCommandKinds, admittedValidationKinds)
    : strictSchema
  if (!scopedSchema) throw new Error('Workbench MCP runWorkbenchCommand scope admits no command kinds.')
  return mergeObjectSchemas([scopedSchema])
}

function statusInputSchema(operation: OpenApiOperation): JsonSchema {
  const properties: Record<string, unknown> = {}
  for (const parameter of operation.parameters ?? []) {
    if (parameter.in !== 'query' || typeof parameter.name !== 'string') continue
    properties[parameter.name] = parameter.schema && typeof parameter.schema === 'object'
      ? parameter.schema
      : { type: 'string' }
  }
  return { type: 'object', additionalProperties: false, properties }
}

function operationInputSchema(name: WorkbenchToolName, operation: OpenApiOperation, method: 'get' | 'post'): JsonSchema {
  if (method === 'get') return statusInputSchema(operation)
  if (name === 'runWorkbenchCommand') {
    return buildRunWorkbenchCommandDiscoverySchema()
  }
  const schema = operation.requestBody?.content?.['application/json']?.schema
  if (!schema || schema.type !== 'object') throw new Error('Workbench action is missing an object request schema.')
  if (name === 'readWorkbenchContext') {
    return addContextWorkflowProperties(schema)
  }
  return schema
}

function addContextWorkflowProperties(schema: JsonSchema): JsonSchema {
  const properties = isObjectRecord(schema.properties) ? { ...schema.properties } : {}
  const mode: JsonSchema = isObjectRecord(properties.mode) ? { ...properties.mode } : { type: 'string' }
  if (Array.isArray(mode.enum) && !mode.enum.includes('active_run')) {
    mode.enum = [...mode.enum, 'active_run']
  }
  properties.mode = mode
  properties.runId = { type: 'string', minLength: 1, maxLength: 256, description: 'Optional exact run ID for activity delta reads.' }
  properties.includeActivity = { type: 'boolean', description: 'Include the bounded Activity Ledger projection for an active-run read.' }
  properties.activityDelta = { type: 'boolean', description: 'Return only Activity Ledger events after activitySinceEventId.' }
  properties.activitySinceEventId = { type: 'string', minLength: 1, maxLength: 256 }
  properties.includePacket = { type: 'boolean', description: 'MCP-only: include the already-reserved bounded continuation packet for Codex consumption.' }
  properties.contextWorkflow = { type: 'boolean' }
  properties.contextIntelligenceSessionId = { type: 'string', minLength: 1, maxLength: 256 }
  properties.requestId = { type: 'string', minLength: 1, maxLength: 256 }
  properties.clientCapabilities = {
    type: 'object',
    additionalProperties: false,
    required: ['clientId'],
    properties: {
      clientId: { type: 'string', minLength: 1, maxLength: 128 },
      contextWorkflow: { type: 'boolean' },
      requestedScope: { enum: ['active-source', 'explicit-source', 'session-sources'] },
      features: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 64 } }
    }
  }
  return { ...schema, properties, additionalProperties: false }
}

export function loadWorkbenchToolContracts(repoRoot: string): Map<WorkbenchToolName, WorkbenchToolContract> {
  const document = readOpenApi(repoRoot)
  const ajv = new Ajv({ allErrors: true, strict: false })
  const contracts = new Map<WorkbenchToolName, WorkbenchToolContract>()
  const seenOperations: string[] = []

  for (const [endpoint, methods] of Object.entries(document.paths ?? {})) {
    for (const operation of Object.values(methods)) {
      if (typeof operation.operationId === 'string') seenOperations.push(operation.operationId)
    }
  }

  if (seenOperations.length !== WORKBENCH_TOOL_NAMES.length ||
      WORKBENCH_TOOL_NAMES.some(name => !seenOperations.includes(name))) {
    throw new Error('Committed Workbench OpenAPI artifact must expose exactly the five approved actions.')
  }

  for (const name of WORKBENCH_TOOL_NAMES) {
    const definition = ACTIONS[name]
    const operation = document.paths?.[definition.endpoint]?.[definition.method]
    if (!operation || operation.operationId !== name) {
      throw new Error(`Workbench OpenAPI action ${name} is missing or moved.`)
    }
    const inputSchema = operationInputSchema(name, operation, definition.method)
    contracts.set(name, {
      name,
      title: typeof operation.summary === 'string' ? operation.summary : name,
      description: typeof operation.description === 'string' ? operation.description : name,
      inputSchema,
      method: definition.method === 'get' ? 'GET' : 'POST',
      endpoint: definition.endpoint,
      mutationCapable: definition.mutationCapable,
      validate: ajv.compile(inputSchema)
    })
  }

  return contracts
}

export function validateToolInput(contract: WorkbenchToolContract, input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; issues: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, issues: ['request: expected an object'] }
  }
  if (contract.name === 'runWorkbenchCommand') {
    const strict = sessionAwareRunWorkbenchCommandRequestSchema.safeParse(input)
    if (!strict.success) {
      return {
        ok: false,
        issues: strict.error.issues.slice(0, 10).map(issue =>
          `${issue.path.join('.') || 'request'}: ${issue.message}`)
      }
    }
    if (strict.data.command && typeof strict.data.command.commandKind === 'string') {
      return { ok: true, value: strict.data as Record<string, unknown> }
    }
  }
  if (!contract.validate(input)) {
    return {
      ok: false,
      issues: (contract.validate.errors ?? []).slice(0, 10).map(issue =>
        `${issue.instancePath || 'request'}: ${issue.message || 'invalid value'}`)
    }
  }
  return { ok: true, value: input as Record<string, unknown> }
}
