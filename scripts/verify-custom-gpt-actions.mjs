#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const LOCAL_BASE_URL = process.env.LOCAL_DASHBOARD_BASE_URL || 'http://127.0.0.1:3054'
const REQUIRE_LIVE_CHECK = process.argv.includes('--require-live')
const ROOT = process.cwd()

function actionCredential() {
  return process.env.WORKBENCH_ACTION_TOKEN || process.env.BUILDFLOW_ACTION_TOKEN || ''
}
const DOCS_SCHEMA_FILE = path.join(ROOT, 'docs/openapi.chatgpt.json')
const INSTRUCTIONS_FILE = path.join(ROOT, 'docs/CUSTOM_GPT_INSTRUCTIONS.md')
const DOCS_SCHEMA_DIR = path.join(ROOT, 'docs/openapi.chatgpt')

const MAX_SCHEMA_BYTES = 100_000
const MAX_INSTRUCTIONS_CHARACTERS = 8_000
const MAX_OPERATION_SUMMARY_CHARS = 300
const MAX_OPERATION_DESCRIPTION_CHARS = 300
const MAX_PARAMETER_DESCRIPTION_CHARS = 700
const TARGET_ACTION_RESPONSE_BYTES = 8_000
const HARD_ACTION_RESPONSE_BYTES = 32_000

const EXPECTED_OPERATION_IDS = [
  'getWorkbenchStatus',
  'readWorkbenchContext',
  'applyWorkbenchFileChange',
  'commitWorkbenchChanges',
  'runWorkbenchCommand'
]

const REQUIRED_ACTION_PATHS = [
  '/api/actions/status',
  '/api/actions/read-context',
  '/api/actions/apply-file-change',
  '/api/actions/commit-changes',
  '/api/actions/run-command'
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function readJson(file) {
  assert(fs.existsSync(file), `Missing file: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function byteLength(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
}

function collectOperations(schema) {
  const ops = []
  for (const [routePath, pathItem] of Object.entries(schema.paths || {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = pathItem?.[method]
      if (op && typeof op === 'object') ops.push({ routePath, method, ...op })
    }
  }
  return ops
}

function collectSchemaDescriptions(schema, basePath = 'schema') {
  if (!schema || typeof schema !== 'object') return []
  const descriptions = []
  if (typeof schema.description === 'string') {
    descriptions.push({ path: `${basePath}.description`, description: schema.description })
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, property] of Object.entries(schema.properties)) {
      descriptions.push(...collectSchemaDescriptions(property, `${basePath}.properties.${name}`))
    }
  }
  if (schema.items && typeof schema.items === 'object') {
    descriptions.push(...collectSchemaDescriptions(schema.items, `${basePath}.items`))
  }
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((item, index) => {
        descriptions.push(...collectSchemaDescriptions(item, `${basePath}.${keyword}[${index}]`))
      })
    }
  }
  return descriptions
}

function ensureOpenAiMetadataLimits(ops) {
  for (const op of ops) {
    assert(typeof op.summary === 'string' && op.summary.length > 0, `${op.operationId} summary missing`)
    assert(op.summary.length <= MAX_OPERATION_SUMMARY_CHARS, `${op.routePath} ${op.method} ${op.operationId} summary has length ${op.summary.length} exceeding limit of ${MAX_OPERATION_SUMMARY_CHARS}`)
    assert(typeof op.description === 'string' && op.description.length > 0, `${op.operationId} description missing`)
    assert(op.description.length <= MAX_OPERATION_DESCRIPTION_CHARS, `${op.routePath} ${op.method} ${op.operationId} description has length ${op.description.length} exceeding limit of ${MAX_OPERATION_DESCRIPTION_CHARS}`)

    for (const param of op.parameters || []) {
      if (typeof param.description !== 'string') continue
      assert(param.description.length <= MAX_PARAMETER_DESCRIPTION_CHARS, `${op.routePath} ${op.method} ${op.operationId} parameter ${param.name} description has length ${param.description.length} exceeding limit of ${MAX_PARAMETER_DESCRIPTION_CHARS}`)
    }

    const requestSchema = op.requestBody?.content?.['application/json']?.schema
    for (const item of collectSchemaDescriptions(requestSchema, `${op.operationId}.requestBody.schema`)) {
      assert(item.description.length <= MAX_PARAMETER_DESCRIPTION_CHARS, `${item.path} has length ${item.description.length} exceeding parameter/schema description limit of ${MAX_PARAMETER_DESCRIPTION_CHARS}`)
    }
  }
}

function verifyStatusOperationContract(ops) {
  const statusOp = ops.find(op => op.operationId === 'getWorkbenchStatus')
  assert(statusOp, 'getWorkbenchStatus operation must exist')
  assert(statusOp.routePath === '/api/actions/status', 'getWorkbenchStatus path must be /api/actions/status')
  assert(statusOp.method === 'get', 'getWorkbenchStatus method must be GET')
  assert(statusOp.operationId === 'getWorkbenchStatus', 'getWorkbenchStatus operationId must be stable')

  const params = statusOp.parameters || []
  const includeParam = params.find(p => p.name === 'include')
  assert(includeParam, 'status operation must have include parameter')
  const validValues = includeParam.schema?.enum || []
  assert(validValues.includes('sources'), 'include parameter must support sources')
  assert(validValues.includes('active'), 'include parameter must support active')
  assert(validValues.includes('all'), 'include parameter must support all')

  const auth = statusOp.security || []
  assert(auth.length > 0, 'status operation must have bearer auth')

  assert(statusOp['x-openai-isConsequential'] === false, 'status must be non-consequential')
  return { path: statusOp.routePath, method: statusOp.method, verified: true }
}

function ensureSchemaRules(schema) {
  const schemaBytes = byteLength(schema)
  assert(schemaBytes < MAX_SCHEMA_BYTES, `OpenAPI schema too large: ${schemaBytes} bytes`)
  assert(schema.openapi === '3.1.0', 'OpenAPI version must be exactly 3.1.0')
  assert(Array.isArray(schema.servers) && schema.servers.length === 1, 'OpenAPI must declare exactly one public server')
  assert(schema.servers[0]?.url === 'https://workbench.prochat.tools', 'OpenAPI server must be the public Workbench origin')
  assert(!schema.servers.some(server => /localhost|127\.0\.0\.1/i.test(String(server?.url || ''))), 'OpenAPI must not advertise loopback servers')
  assert(schema.components && typeof schema.components === 'object' && !Array.isArray(schema.components), 'OpenAPI components must be an object')
  assert(schema.components.schemas && typeof schema.components.schemas === 'object' && !Array.isArray(schema.components.schemas), 'OpenAPI components.schemas must be an object')
  assert(schema.components.securitySchemes?.bearerAuth?.type === 'http', 'OpenAPI bearerAuth must use HTTP authentication')
  assert(schema.components.securitySchemes?.bearerAuth?.scheme === 'bearer', 'OpenAPI bearerAuth scheme must be bearer')

  const ops = collectOperations(schema)
  const ids = ops.map(op => op.operationId)
  assert(ids.length === EXPECTED_OPERATION_IDS.length, `Expected ${EXPECTED_OPERATION_IDS.length} operations, found ${ids.length}: ${ids.join(', ')}`)
  assert(new Set(ids).size === ids.length, 'OperationIds must be unique')
  assert(JSON.stringify([...ids].sort()) === JSON.stringify([...EXPECTED_OPERATION_IDS].sort()), `OperationIds mismatch: ${ids.join(', ')}`)

  ensureOpenAiMetadataLimits(ops)
  verifyStatusOperationContract(ops)

  for (const op of ops) {
    assert(Array.isArray(op.security) && op.security.length > 0, `${op.operationId} missing security`)
    assert(op['x-openai-isConsequential'] === false, `${op.operationId} must be non-consequential for GPT action confirmation UX`)
    if (op.method === 'post') {
      assert(op.requestBody?.required === true, `${op.operationId} POST requestBody must be required`)
      assert(op.requestBody?.content?.['application/json']?.schema && typeof op.requestBody.content['application/json'].schema === 'object', `${op.operationId} POST request schema must be present`)
    }
  }

  for (const routePath of REQUIRED_ACTION_PATHS) {
    assert(schema.paths?.[routePath], `Missing action path: ${routePath}`)
  }

  const schemaText = JSON.stringify(schema)
  assert(!schemaText.includes('create_run, resume_run, or active_run'), 'Schema must use Workbench run lifecycle wording')
  for (const legacy of ['setBuildFlowContext', 'executeBuildFlowTask', 'manageBuildFlowAgent', '/api/actions/agent/execute-task', '/api/actions/agent/manage', 'action=list_sources', 'action=get_active', 'action=set_active', '/api/actions/sources', '/api/actions/context/active', 'git_push']) {
    assert(!schemaText.includes(legacy), `Legacy reference exposed in schema: ${legacy}`)
  }
  assert(!schemaText.includes('/api/actions/agent/'), 'Schema must not expose agent-mode action routes')

  const statusOp = ops.find(op => op.operationId === 'getWorkbenchStatus')
  const statusDescription = `${statusOp?.summary || ''} ${statusOp?.description || ''}`.toLowerCase()
  for (const phrase of ['resume', 'continue', 'current state', 'read-only', 'does not start', 'include=active']) {
    assert(statusDescription.includes(phrase), `getWorkbenchStatus schema must explicitly guide ${phrase} routing`)
  }
  assert(statusDescription.includes('known repository content'), 'getWorkbenchStatus must defer known repository content to readWorkbenchContext')

  const readContext = ops.find(op => op.operationId === 'readWorkbenchContext')
  const readSchema = readContext?.requestBody?.content?.['application/json']?.schema
  const readProps = readSchema?.properties || {}
  const modes = readProps.mode?.enum || []
  assert(readProps.mode?.description === 'Mode: prefer prepare_task_context for ordinary exploratory or multi-file work; it returns navigationEvidence and exactEvidence in one bounded packet. Use graph_context for explicit structure, exact modes for known paths/symbols. Persistent workflows use Workbench lifecycle.', 'readWorkbenchContext mode description must use lifecycle wording')
  const instructionsText = fs.readFileSync(path.join(ROOT, 'docs/CUSTOM_GPT_INSTRUCTIONS.md'), 'utf8')
  assert(instructionsText.includes('supported read-only session bootstrap'), 'Custom GPT instructions must document the bounded session bootstrap')
  assert(instructionsText.includes('workbenchRun.sessionId'), 'Custom GPT instructions must require the returned Workbench session ID')
  for (const phrase of ['Deterministic Resume Routing (MANDATORY)', 'MUST be exactly one', 'read-only `getWorkbenchStatus` call', 'include=active', 'chat history']) {
    assert(instructionsText.includes(phrase), `Custom GPT instructions must contain deterministic resume rule: ${phrase}`)
  }
  for (const phrase of ['changeType=create_run', 'never choose `resume_run` or `close_run`', 'Never infer IDs from source']) {
    assert(instructionsText.includes(phrase), `Custom GPT instructions must contain one-dispatch lifecycle guard: ${phrase}`)
  }
  for (const mode of ['grep_context', 'read_range', 'read_symbol']) {
    assert(modes.includes(mode), `readWorkbenchContext schema missing focused mode: ${mode}`)
  }
  assert(readProps.paths?.maxItems <= 5, 'readWorkbenchContext paths must be capped at 5 for GPT use')
  assert(readProps.limit?.maximum <= 5, 'readWorkbenchContext limit must be capped at 5 for GPT use')
  assert(readProps.maxBytesPerFile?.maximum <= 4000, 'readWorkbenchContext maxBytesPerFile must be capped at 4000 for GPT use')
  assert(readProps.before?.maximum <= 40, 'grep_context before must be capped at 40')
  assert(readProps.after?.maximum <= 60, 'grep_context after must be capped at 60')
  assert(readProps.maxMatches?.maximum <= 10, 'grep_context maxMatches must be capped at 10')
  assert(readContext.description.includes('skip status'), 'readWorkbenchContext must skip status when the source is already known')
  assert(readContext.description.includes('Never use runWorkbenchCommand as a generic content preflight'), 'readWorkbenchContext must own ordinary content routing')
  assert(readProps.sourceId?.description.includes('Workbench Private maps to prochattools-workbench'), 'source routing must preserve the Workbench Private exact ID mapping')

  const runCommand = ops.find(op => op.operationId === 'runWorkbenchCommand')
  const commandContent = runCommand?.requestBody?.content?.['application/json']
  const envelopeSchema = commandContent?.schema || {}
  const envelopeProps = envelopeSchema.properties || {}
  const commandProps = envelopeProps.command?.properties || {}
  const publicCommandKinds = commandProps.commandKind?.enum || []
  assert(!publicCommandKinds.includes('git_push'), 'runWorkbenchCommand must not expose git_push without an approved push workflow')
  assert(commandProps.executable?.description?.includes('explicitly allowlisted repository-supported deterministic operations'), 'run_exact_command must describe its explicit allowlist safety boundary')
  assert((envelopeSchema.required || []).includes('version'), 'runWorkbenchCommand must require envelope version')
  assert((envelopeSchema.required || []).includes('sessionId'), 'runWorkbenchCommand must require sessionId')
  assert((envelopeSchema.required || []).includes('command'), 'runWorkbenchCommand must require nested command')
  assert(envelopeProps.version?.enum?.length === 1 && envelopeProps.version.enum[0] === 2, 'runWorkbenchCommand envelope version must be exactly 2')
  assert(commandProps.timeoutMs?.maximum <= 12000, 'runWorkbenchCommand timeoutMs must be capped at 12000')
  assert(['submit', 'status', 'cancel', 'evidence'].every(operation => (commandProps.validationJobOperation?.enum || []).includes(operation)), 'validation job operation contract must expose submit, status, cancel, and evidence')
  assert((commandProps.commandKind?.enum || []).includes('read_evidence'), 'runWorkbenchCommand must expose the bounded read_evidence selector')
  assert(commandProps.evidenceId?.description?.includes('not a bearer credential'), 'evidenceId must not be documented as a bearer credential')
  assert(commandProps.evidenceOwner?.additionalProperties === false, 'evidenceOwner must be strict')
  assert(commandProps.evidencePageBytes?.maximum <= 4000, 'evidence pages must be capped at 4000 bytes')
  assert(/redacted/i.test(commandProps.evidencePageBytes?.description || ''), 'evidence pages must document current redaction')
  assert(commandProps.validationJobId?.description?.includes('resultRef'), 'validationJobId must document its durable resultRef role')
  assert(commandProps.resultStream?.enum?.includes('stdout') && commandProps.resultStream?.enum?.includes('stderr'), 'validation result streams must be stdout or stderr')
  assert(commandProps.resultPageBytes?.maximum <= 4000, 'validation result pages must be capped at 4000 bytes')
  assert(/opaque/i.test(commandProps.resultCursor?.description || ''), 'validation result cursor must be documented as opaque')
  assert((commandProps.commandKind?.enum || []).includes('n8n_workflow_export'), 'Generated schema must expose n8n_workflow_export')
  assert((commandProps.commandKind?.enum || []).includes('n8n_workflow_migration'), 'Generated schema must expose n8n_workflow_migration')
  assert(commandProps.workflowId, 'Generated schema must expose workflowId')
  assert(commandProps.outputPath, 'Generated schema must expose outputPath')
  assert(commandProps.networkAccess?.type === 'boolean', 'Generated schema networkAccess must be boolean')
  const sourceDescription = commandProps.sourceId?.description || ''
  for (const required of ['sessionId', 'default', 'workspace', 'current', 'repo']) {
    assert(sourceDescription.includes(required), `runWorkbenchCommand sourceId guidance missing ${required}`)
  }
  assert(sourceDescription.includes('Workbench Private maps to prochattools-workbench'), 'runWorkbenchCommand must preserve the Workbench Private exact ID mapping')
  assert(runCommand.description.includes('not generic repository/content preflight'), 'runWorkbenchCommand must not be the generic repository content route')
  assert(commandProps.commandKind.description.includes('Do not use commands as a generic content/status preflight'), 'runWorkbenchCommand commandKind must reject generic content preflight routing')
  assert(!Object.prototype.hasOwnProperty.call(commandContent || {}, 'examples'), 'Generated schema must not expose command examples')
  assert(commandProps.migration?.type === 'object' && commandProps.migration?.additionalProperties === false, 'Generated schema must expose an importer-safe strict migration object')
  assert(!['oneOf', 'anyOf', 'allOf'].some(keyword => Object.hasOwn(commandProps.migration || {}, keyword)), 'Generated schema must not hide migration fields behind schema composition')
  const migrationPhaseProperties = Object.keys(commandProps.migration?.properties || {})
  for (const forbidden of ['executable', 'args', 'shell', 'environment', 'wrapperOperation', 'confirmationDigest', 'dispatchAuthorization', 'leaseProof', 'credential']) {
    assert(!migrationPhaseProperties.includes(forbidden), `Migration schema must not expose ${forbidden}`)
  }
  const placeholderSources = new Set(['default', 'workspace', 'current', 'repo'])
  assert(!placeholderSources.has(String(commandProps.sourceId?.default || '').toLowerCase()), 'Schema must not define a placeholder command sourceId')
}

function ensureInstructions() {
  assert(fs.existsSync(INSTRUCTIONS_FILE), `Missing instructions file: ${INSTRUCTIONS_FILE}`)
  const text = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')
  const characters = [...text].length
  const bytes = byteLength(text)
  assert(characters <= MAX_INSTRUCTIONS_CHARACTERS, `Custom GPT instructions exceed ${MAX_INSTRUCTIONS_CHARACTERS} characters: ${characters}`)
  for (const required of EXPECTED_OPERATION_IDS) {
    assert(text.includes(required), `Instructions must mention ${required}`)
  }
  for (const required of [
    'sourceId',
    'Quick Mode',
    'Goal Mode',
    'Workbench lifecycle',
    'Never derive sessionId from sourceId',
    'Continue only inside approved scope',
    'Never:',
    'Never make indefinite requests'
  ]) {
    assert(text.includes(required), `Instructions must include ${required}`)
  }
  assert(/deadline|fail fast|timeout/i.test(text), 'Instructions must include timeout/deadline guidance')
  for (const forbidden of [
    '8–12 short actions',
    'Until persistent packet APIs are implemented',
    'arbitrary per-turn action counts'
  ]) {
    assert(!text.includes(forbidden), `Instructions must not contain stale migration wording: ${forbidden}`)
  }
  return { characters, bytes }
}

function ensureNoStaleSchemaFragments() {
  if (!fs.existsSync(DOCS_SCHEMA_DIR)) return { skipped: true }
  const stale = fs.readdirSync(DOCS_SCHEMA_DIR).filter(entry => entry.endsWith('.json'))
  assert(stale.length === 0, `Stale schema fragments found: ${stale.join(', ')}`)
  return { skipped: false }
}

function ensureDocumentationAlignment() {
  const docsToCheck = [
    'README.md',
    'docs/CUSTOM_GPT_INSTRUCTIONS.md',
    'docs/openapi.chatgpt/README.md',
    'docs/product/agent-mode.md',
    'docs/product/agent-mode-optimization-roadmap.md',
    'docs/custom-gpt-agent-performance-root-cause.md',
    'docs/openai-custom-gpt-limits.md'
  ]
  const forbidden = [
    'compact 6-action',
    'schema is 6 operations',
    'Total: 6 operations',
    'Keep the six GPT-facing operations',
    'setBuildFlowActiveContext` | POST',
    'Clear small batch: up to 3 tightly related tasks',
    'Hard maximum: 5 small tasks',
    'Until persistent packet APIs are implemented',
    'does not yet expose the final persistent run and packet contract',
    'Current use before packet APIs ship'
  ]
  const scanned = []
  for (const rel of docsToCheck) {
    const file = path.join(ROOT, rel)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    scanned.push(rel)
    for (const phrase of forbidden) {
      assert(!text.includes(phrase), `Documentation drift in ${rel}: ${phrase}`)
    }
  }
  return { scanned }
}

function ensureSourceDeadlineLayer() {
  const files = {
    deadline: path.join(ROOT, 'apps/web/src/lib/actions/deadline.ts'),
    transport: path.join(ROOT, 'apps/web/src/lib/actions/transport.ts'),
    gptActions: path.join(ROOT, 'apps/web/src/lib/actions/gpt.ts'),
    readContext: path.join(ROOT, 'apps/web/src/app/api/actions/read-context/route.ts'),
    runCommand: path.join(ROOT, 'apps/web/src/app/api/actions/run-command/route.ts'),
    openapi: path.join(ROOT, 'apps/web/src/app/api/openapi/route.ts'),
    canonicalSchema: path.join(ROOT, 'apps/web/src/lib/openapi-chatgpt.json'),
    schemaGenerator: path.join(ROOT, 'scripts/generate-openapi-chatgpt.mjs'),
    localStack: path.join(ROOT, 'scripts/workbench-local-stack.sh')
  }
  for (const [label, file] of Object.entries(files)) {
    assert(fs.existsSync(file), `Missing source file for deadline verification: ${label}`)
  }
  const deadlineText = fs.readFileSync(files.deadline, 'utf8')
  assert(deadlineText.includes('WORKBENCH_ACTION_DEADLINE_EXCEEDED'), 'Deadline helper must emit canonical structured deadline code')
  assert(deadlineText.includes('GPT_ACTION_DEADLINES_MS'), 'Deadline helper must define action deadlines')
  const transportText = fs.readFileSync(files.transport, 'utf8')
  assert(transportText.includes('signal?: AbortSignal'), 'Transport must accept AbortSignal')
  assert(transportText.includes('const REQUEST_TIMEOUT_MS = 12000'), 'Transport default timeout must be below the old 30s value')
  assert(fs.readFileSync(files.readContext, 'utf8').includes('withGptActionDeadline'), 'read-context route must use deadline wrapper')
  const runCommandText = fs.readFileSync(files.runCommand, 'utf8')
  assert(runCommandText.includes('commandTimeoutMs'), 'run-command route must clamp GPT command timeouts')
  assert(runCommandText.includes('sourceSelectionRequired(body.sourceId)'), 'run-command route must reject placeholder source IDs before dispatch')
  assert(runCommandText.includes('evidenceRefs: clean.evidenceRefs ?? job?.evidenceRefs'), 'run-command route must project canonical evidence metadata')
  assert(runCommandText.includes("'evidenceRefs', 'evidenceUnavailable'"), 'run-command minimal response must preserve evidence availability metadata')
  assert(runCommandText.includes("code: 'SOURCE_SELECTION_REQUIRED'" ) || fs.readFileSync(files.gptActions, 'utf8').includes("code: 'SOURCE_SELECTION_REQUIRED'"), 'Source-selection rejection must expose the canonical error code')
  const gptActionsText = fs.readFileSync(files.gptActions, 'utf8')
  for (const placeholder of ["'default'", "'workspace'", "'current'", "'repo'"]) {
    assert(gptActionsText.includes(placeholder), `Source-selection helper must reject ${placeholder}`)
  }
  const openapiText = fs.readFileSync(files.openapi, 'utf8')
  const canonicalSchemaText = fs.readFileSync(files.canonicalSchema, 'utf8')
  assert(openapiText.includes('canonicalOpenApiSchema'), 'OpenAPI route must use the canonical schema artifact')
  assert(
    JSON.stringify(readJson(files.canonicalSchema)) === JSON.stringify(readJson(DOCS_SCHEMA_FILE)),
    'Checked-in OpenAPI docs artifact must match the canonical schema artifact'
  )
  const canonicalSchema = readJson(files.canonicalSchema)
  const readContextDescription = canonicalSchema.paths?.['/api/actions/read-context']?.post?.description || ''
  const readModeDescription = canonicalSchema.paths?.['/api/actions/read-context']?.post?.requestBody?.content?.['application/json']?.schema?.properties?.mode?.description || ''
  assert(readContextDescription.toLowerCase().includes('prefer prepare_task_context'), 'OpenAPI must prefer prepare_task_context for ordinary exploratory work')
  assert(readModeDescription.includes('exactEvidence'), 'OpenAPI must describe the separate exact evidence packet')
  for (const required of ['sessionId']) {
    assert(canonicalSchemaText.includes(required), `Canonical OpenAPI schema must include ${required}`)
  }
  const generatorText = fs.readFileSync(files.schemaGenerator, 'utf8')
  for (const required of ['n8n_workflow_export', 'n8n_workflow_migration', 'workflowId', 'outputPath', 'migration', 'sessionId', 'current', 'repo', 'fs.renameSync']) {
    assert(generatorText.includes(required), `Schema generator must validate or atomically write ${required}`)
  }
  const localStackText = fs.readFileSync(files.localStack, 'utf8')
  assert(localStackText.includes('regenerate_openapi_schema'), 'Local stack start/restart must regenerate the verified GPT schema')
  assert(
    /! verify_stack \|\|\s+! verify_sustained_stack \|\|\s+! regenerate_openapi_schema; then/.test(localStackText),
    'Schema regeneration must run only after unified and sustained health pass'
  )
  for (const field of ['executable', 'args', 'shell', 'matchStatus', 'resolvedRepositoryRoot', 'filesChanged']) {
    assert(runCommandText.includes(`${field}: clean.${field}`) || runCommandText.includes(`${field}: clean.${field} ?? job?.${field}`), `run-command route must project exact-command evidence field: ${field}`)
  }
}

function ensureRetiredAgentActionRoutes() {
  const helper = path.join(ROOT, 'apps/web/src/lib/actions/retired-agent-actions.ts')
  assert(fs.existsSync(helper), 'Retired Agent Mode action helper must exist')
  const helperText = fs.readFileSync(helper, 'utf8')
  assert(helperText.includes('WORKBENCH_AGENT_ACTION_RETIRED'), 'Retired Agent Mode helper must emit canonical retired-action code')
  assert(helperText.includes('status: 200'), 'Retired Agent Mode helper must return HTTP 200 so stale GPT actions fail fast without platform connection errors')

  const retiredRoutes = [
    'control',
    'execute-task',
    'manage',
    'start',
    'status'
  ]
  for (const route of retiredRoutes) {
    const file = path.join(ROOT, `apps/web/src/app/api/actions/agent/${route}/route.ts`)
    assert(fs.existsSync(file), `Missing retired Agent Mode route: ${route}`)
    const text = fs.readFileSync(file, 'utf8')
    assert(text.includes('retiredAgentAction'), `${route} Agent Mode route must return retiredAgentAction`)
    assert(!text.includes("@/lib/actions/gpt"), `${route} Agent Mode route must not import GPT agent helpers`)
    assert(!text.includes("executeAction('/api/agent-jobs/"), `${route} Agent Mode route must not proxy to agent jobs`)
  }

  const dashboardText = fs.readFileSync(path.join(ROOT, 'apps/web/src/app/dashboard/page.tsx'), 'utf8')
  assert(dashboardText.includes('if (!hasActiveAgentJob) return'), 'Dashboard must not poll agent jobs when no active job exists')
  assert(!dashboardText.includes(': 7000'), 'Dashboard must not keep idle 7s agent-job polling')

  return { retiredRoutes }
}

function ensureActionBudgetAndTimeoutLanguage() {
  const text = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')
  assert(text.includes('Use the smallest safe mode'), 'Instructions must preserve bounded mode guidance')
  assert(text.includes('Stop when:'), 'Instructions must define Goal Mode stop conditions')
  assert(text.includes('loop indefinitely'), 'Instructions must prohibit unbounded continuation')
  assert(text.includes('prefer one bounded `prepare_task_context` call'), 'Instructions must prefer one bounded task-context call for exploratory repository work')
  assert(text.includes('exactEvidence'), 'Instructions must distinguish exact-source evidence from navigation evidence')
  assert(/fail fast|deadline|timeout/i.test(text), 'Instructions must include fail-fast, deadline, or timeout language')

  const deadlineText = fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/actions/deadline.ts'), 'utf8')
  assert(deadlineText.includes('suggestedNextAction'), 'Deadline helper must support suggestedNextAction parameter')
}

function ensureFocusedModeGuardrails() {
  const instructionsText = fs.readFileSync(INSTRUCTIONS_FILE, 'utf8')
  const readContextText = fs.readFileSync(path.join(ROOT, 'apps/web/src/app/api/actions/read-context/route.ts'), 'utf8')
  assert(readContextText.includes('boundedInt(body.maxBytesPerFile'), 'read-context must clamp maxBytesPerFile with boundedInt')
  assert(readContextText.includes('needsNarrowerScope'), 'read-context must enforce needsNarrowerScope guardrail')
  assert(readContextText.includes("mode === 'graph_context'"), 'read-context must expose graph_context as a bounded read mode')
  assert(readContextText.includes('PREPARED_CONTEXT_RESPONSE_BUDGET_BYTES'), 'read-context must enforce the bounded preparation packet budget')

  const graphContextFile = path.join(ROOT, 'packages/cli/src/agent/graph-context.ts')
  assert(fs.existsSync(graphContextFile), 'graph-context helper must exist')
  const graphContextText = fs.readFileSync(graphContextFile, 'utf8')
  assert(graphContextText.includes('GRAPH_REPORT.md'), 'graph-context must consume cached GRAPH_REPORT.md')
  assert(graphContextText.includes('missing_graph_artifacts'), 'graph-context must tolerate missing Graphify artifacts')
  assert(graphContextText.includes('buildConcreteNextActions'), 'graph-context must build concrete next focused read suggestions')
  assert(!graphContextText.includes('<suggested-file>'), 'graph-context must not return placeholder file suggestions')
  assert(!graphContextText.includes('graphify update'), 'graph-context must not build/update Graphify graphs inside GPT actions')

  const safeAccessText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/safe-access.ts'), 'utf8')
  assert(safeAccessText.includes("allowedRoots: ['**']"), 'write policy must use the connected repository as its scope')
  assert(safeAccessText.includes("blockedGlobs: ['.env', '.env.*'"), 'write policy must keep environment files blocked')
  assert(safeAccessText.includes('evaluateConnectedRepositoryPath'), 'write policy must use the centralized connected-repository deny policy')
  assert(instructionsText.includes('Activate Workbench'), 'instructions must define natural Workbench activation')
  assert(instructionsText.includes('normalizing common separators'), 'instructions must normalize common repository-name separators')
  assert(instructionsText.includes('workbench` matches `Workbench Private'), 'instructions must cover the hyphen/space repository-name variant')
  assert(instructionsText.includes('Never guess between matches'), 'instructions must require explicit disambiguation')

  const focusedReadFile = path.join(ROOT, 'packages/cli/src/agent/focused-read.ts')
  if (fs.existsSync(focusedReadFile)) {
    const focusedText = fs.readFileSync(focusedReadFile, 'utf8')
    assert(focusedText.includes('MAX_RESPONSE_BYTES'), 'focused-read must define MAX_RESPONSE_BYTES limit')
  }
}

async function requestJson(pathname, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${LOCAL_BASE_URL}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${actionCredential()}`,
        ...(options.headers || {})
      }
    })
    const text = await response.text()
    const bytes = byteLength(text)
    const json = text.trim() ? JSON.parse(text) : {}
    return { response, json, bytes }
  } finally {
    clearTimeout(timer)
  }
}

async function runLiveSmokeChecks() {
  if (!actionCredential() && REQUIRE_LIVE_CHECK) {
    throw new Error('Authenticated live GPT action smoke requires WORKBENCH_ACTION_TOKEN or BUILDFLOW_ACTION_TOKEN in the invoking process environment.')
  }
  if (!actionCredential()) return { requested: false, skipped: true, reason: 'optional_live_smoke_not_requested' }
  const status = await requestJson('/api/actions/status', { method: 'GET' })
  assert(status.response.status === 200, `status action returned ${status.response.status}`)
  assert(status.bytes <= HARD_ACTION_RESPONSE_BYTES, `status action exceeds hard budget: ${status.bytes}`)
  const retiredAgentStatus = await requestJson('/api/actions/agent/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update' })
  })
  assert(retiredAgentStatus.response.status === 404, `retired agent status must be unavailable, returned HTTP ${retiredAgentStatus.response.status}`)
  return {
    skipped: false,
    statusBytes: status.bytes,
    retiredAgentStatus: 'unavailable',
    targetBytes: TARGET_ACTION_RESPONSE_BYTES,
    hardBudgetBytes: HARD_ACTION_RESPONSE_BYTES,
    statusOverTarget: status.bytes > TARGET_ACTION_RESPONSE_BYTES
  }
}

function ensureWorkbenchRunModel() {
  const modelText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/agent-jobs.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_RUN_SCHEMA_VERSION',
    'planVersion',
    'completedPacketIds',
    'resumeState',
    'metrics',
    'AgentJobUpdate',
    'nextTaskId: patch.resumeState?.nextTaskId || activeTaskId',
    'Array.from(new Set((patch.completedPacketIds || job.completedPacketIds).filter(Boolean)))',
    'planVersion: Math.max(job.planVersion',
    'getActiveWorkbenchRun',
    'runSchemaVersion',
    'fs.renameSync(temporaryPath, JOB_STORE_PATH)'
  ]) {
    assert(modelText.includes(required), `Workbench run model must include ${required}`)
  }

  const serverText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/server.ts'), 'utf8')
  assert(serverText.includes("'/api/workbench-runs/active'"), 'Local server must expose the active-run endpoint')

  const routeText = fs.readFileSync(path.join(ROOT, 'apps/web/src/app/api/actions/read-context/route.ts'), 'utf8')
  assert(routeText.includes("mode === 'active_run'"), 'Internal read-context route must retain active_run support')

  const schema = readJson(DOCS_SCHEMA_FILE)
  const readSchema = schema.paths?.['/api/actions/read-context']?.post?.requestBody?.content?.['application/json']?.schema
  const modes = readSchema?.properties?.mode?.enum || []
  assert(!modes.includes('active_run'), 'OpenAPI schema must not expose internal active_run')

  for (const required of ['createWorkbenchRun', 'resumeWorkbenchRun']) {
    assert(modelText.includes(required), `Workbench run model must include ${required}`)
  }
  for (const endpoint of ["'/api/workbench-runs/create'", "'/api/workbench-runs/resume'"]) {
    assert(serverText.includes(endpoint), `Local server must expose ${endpoint}`)
  }
  const applySchema = schema.paths?.['/api/actions/apply-file-change']?.post?.requestBody?.content?.['application/json']?.schema
  const changeTypes = applySchema?.properties?.changeType?.enum || []
  assert(JSON.stringify(changeTypes) === JSON.stringify(['create', 'overwrite', 'patch', 'append', 'delete_file', 'move', 'create_run', 'resume_run', 'close_run']), 'OpenAPI schema must expose direct file and bounded run-lifecycle changeTypes')
  assert(JSON.stringify(Object.keys(applySchema?.properties || {}).sort()) === JSON.stringify(['allowMultiple', 'autoCommit', 'changeType', 'confirmationToken', 'confirmedByUser', 'content', 'documentationPath', 'dryRun', 'find', 'goal', 'goalDispatch', 'maxIterations', 'path', 'reason', 'replace', 'runId', 'sourceId', 'summary', 'to'].sort()), 'applyWorkbenchFileChange must expose only bounded file/lifecycle properties')
  const goalDispatch = applySchema?.properties?.goalDispatch
  assert(goalDispatch?.type === 'object' && goalDispatch.additionalProperties === false, 'applyWorkbenchFileChange goalDispatch must be a strict object')
  assert(goalDispatch.description?.includes('readOnly=true') && goalDispatch.description?.includes('steps to []'), 'goalDispatch must explain the read-only empty-steps shape')
  assert(JSON.stringify(goalDispatch.required || []) === JSON.stringify(['version', 'expectedOutcome', 'scope', 'confirmationPolicy', 'terminalResult', 'steps']), 'goalDispatch must require its bounded dispatch manifest')
  assert(goalDispatch.properties?.version?.enum?.[0] === 1, 'goalDispatch version must be exactly 1')
  assert(goalDispatch.properties?.scope?.description?.includes('directory prefixes'), 'goalDispatch scope must allow bounded directory prefixes')
  assert(goalDispatch.properties?.readOnly?.description?.includes('steps: []'), 'goalDispatch readOnly guidance must allow empty steps')
  assert(goalDispatch.properties?.steps?.maxItems <= 5, 'goalDispatch steps must be capped at 5')
  assert(goalDispatch.properties?.steps?.description?.includes('read-only'), 'goalDispatch steps guidance must describe read-only packets')
  assert(goalDispatch.properties?.reads?.maxItems <= 5, 'goalDispatch reads must be capped at 5')
  assert(goalDispatch.properties?.commands?.maxItems <= 3, 'goalDispatch commands must be capped at 3')
  assert(goalDispatch.properties?.commit?.additionalProperties === false, 'goalDispatch commit policy must be strict')
  for (const field of ['goal', 'runId', 'summary']) {
    assert(applySchema?.properties?.[field], `applyWorkbenchFileChange must expose lifecycle field ${field}`)
  }
  assert(!applySchema?.properties?.packet, 'applyWorkbenchFileChange must not expose packet state')

  const packetText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packets.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_PACKET_SCHEMA_VERSION',
    'idempotencyKey !== `${packet.runId}:${packet.packetId}`',
    "execFileSync('git', ['rev-parse', 'HEAD']",
    'STALE_EXPECTED_HEAD',
    'PACKET_ALREADY_COMPLETED',
    'validateWriteTarget',
    'errors.length > 0'
  ]) {
    assert(packetText.includes(required), `Workbench packet preflight must include ${required}`)
  }
  assert(serverText.includes("'/api/workbench-packets/preflight'"), 'Local server must expose packet preflight')
  assert(serverText.includes('writesPerformed: false'), 'Packet preflight must report that no writes were performed')

  const packetStoreText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-store.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_PACKET_STORE_VERSION',
    "fs.openSync(LOCK_PATH, 'wx')",
    'reserveWorkbenchPacket',
    "status: 'queued'",
    'PACKET_ID_CONFLICT',
    'IDEMPOTENCY_KEY_CONFLICT',
    'fs.renameSync(temporaryPath, STORE_PATH)',
    'updateWorkbenchPacketStatus',
    'listWorkbenchPacketRecords'
  ]) {
    assert(packetStoreText.includes(required), `Workbench packet store must include ${required}`)
  }
  assert(serverText.includes('reservationCreated: reservation.created'), 'Packet preflight must report reservation creation')
  assert(serverText.includes("status: 'queued'"), 'Accepted packet preflight must return queued status')
  assert(serverText.includes('listWorkbenchPacketRecords'), 'Active-run response must include packet lifecycle summaries')
  for (const required of [
    "const packets = listWorkbenchPacketRecords({ limit: 20 }).map(record => {",
    'packetId: record.packet.packetId',
    'runId: record.packet.runId',
    'taskId: record.packet.taskId',
    'sourceId: record.packet.sourceId',
    'status: record.status',
    'exactPaths: record.exactPaths.slice(0, 10)',
    'completedSteps: result?.completedSteps || 0',
    'failedStep: result?.failedStep',
    'rolledBack: result?.rolledBack === true',
    'validation: (result?.validation || []).slice(0, 5)',
    'commitHash: result?.commitHash || record.commitHash',
    'errorCodes: (result?.errors || []).slice(0, 5).map(error => error.code)'
  ]) {
    assert(serverText.includes(required), `Agent jobs status packet observability must include ${required}`)
  }
  for (const required of [
    'claimNextWorkbenchPacket',
    'renewWorkbenchPacketLease',
    'releaseWorkbenchPacketLease',
    'recoverStaleWorkbenchPacketLeases',
    'leaseToken',
    'leaseExpiresAt',
    'claimAttempt',
    "status: 'running'",
    "status: 'queued'"
  ]) {
    assert(packetStoreText.includes(required), `Workbench packet leases must include ${required}`)
  }
  for (const endpoint of [
    "'/api/workbench-packets/claim'",
    "'/api/workbench-packets/renew'",
    "'/api/workbench-packets/release'",
    "'/api/workbench-packets/recover-stale'"
  ]) {
    assert(serverText.includes(endpoint), `Local server must expose ${endpoint}`)
  }
  const gptActionText = fs.readFileSync(path.join(ROOT, 'apps/web/src/lib/actions/gpt.ts'), 'utf8')
  assert(gptActionText.includes("changeType === 'packet_claim'"), 'GPT action dispatcher must handle packet_claim')
  assert(gptActionText.includes("'/api/workbench-packets/claim'"), 'GPT action dispatcher must reach the packet claim endpoint')
  assert(gptActionText.includes("createHash('sha256')"), 'GPT packet claims must derive a stable authenticated fallback workerId')
  assert(gptActionText.includes('explicitWorkerId || fallbackWorkerId'), 'GPT packet claims must use the fallback when workerId is omitted')
  assert(serverText.includes('const recoveredPacketLeases = recoverStaleWorkbenchPacketLeases()'), 'Server startup must recover stale packet leases')
  assert(serverText.includes('writesPerformed: false'), 'Packet lease controls must not execute file writes')

  const packetPlanText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-plan.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_EXECUTION_PLAN_VERSION',
    'record.leaseToken !== leaseToken',
    'LEASE_EXPIRED',
    "execFileSync('git', ['rev-parse', 'HEAD']",
    'STALE_EXPECTED_HEAD',
    'validateWriteTarget',
    'RESERVED_PATHS_MISMATCH',
    'planHash: sha256(canonical)',
    'writesPerformed: false'
  ]) {
    assert(packetPlanText.includes(required), `Workbench execution planner must include ${required}`)
  }
  assert(serverText.includes("'/api/workbench-packets/plan'"), 'Local server must expose packet planning')
  assert(serverText.includes('planWorkbenchPacketExecution'), 'Local server must use the deterministic execution planner')

  const executorText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-executor.ts'), 'utf8')
  for (const required of [
    'executeWorkbenchPacket',
    'planWorkbenchPacketExecution(params)',
    'restoreSnapshots',
    'verifyFileHash',
    "status: 'completed'",
    "status: 'failed'",
    'finalizeWorkbenchPacketExecution',
    'syncRunOutcome',
    'rolledBack'
  ]) {
    assert(executorText.includes(required), `Workbench packet executor must include ${required}`)
  }
  assert(packetStoreText.includes('finalizeWorkbenchPacketExecution'), 'Packet store must finalize execution under the active lease')
  assert(serverText.includes("'/api/workbench-packets/execute'"), 'Local server must expose packet execution')
  assert(serverText.includes('executeWorkbenchPacket'), 'Local server must use the rollback-capable executor')

  const journalText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-execution-journal.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_EXECUTION_JOURNAL_VERSION',
    'prepareWorkbenchExecutionJournal',
    'markWorkbenchExecutionJournalStep',
    'restoreWorkbenchExecutionJournal',
    'recoverWorkbenchExecutionJournals',
    'fs.renameSync(temporary, target)',
    'contentBase64',
    "status: 'restoring'"
  ]) {
    assert(journalText.includes(required), `Workbench execution journal must include ${required}`)
  }
  assert(packetStoreText.includes('recoverInterruptedWorkbenchPacket'), 'Packet store must persist interrupted execution recovery')
  assert(executorText.includes('prepareWorkbenchExecutionJournal'), 'Packet executor must journal before mutation')
  assert(executorText.includes('markWorkbenchExecutionJournalStep'), 'Packet executor must checkpoint verified steps')
  assert(executorText.includes('completeWorkbenchExecutionJournal'), 'Packet executor must remove finalized journals')
  assert(serverText.includes('const recoveredExecutionJournals = recoverWorkbenchExecutionJournals'), 'Server startup must recover interrupted execution journals')
  assert(serverText.indexOf('recoverWorkbenchExecutionJournals') < serverText.indexOf('recoverStaleWorkbenchPacketLeases()'), 'Journal recovery must run before stale lease recovery')
  for (const required of [
    'WorkbenchPacketValidation',
    'MAX_PACKET_VALIDATIONS',
    'PACKET_VALIDATION_TIMEOUT_INVALID',
    'PACKET_COMMIT_NOT_AUTHORIZED'
  ]) {
    assert(packetText.includes(required), `Workbench packet validation policy must include ${required}`)
  }
  for (const required of [
    'await runSafeCommand',
    "commandKind: 'git_add_paths'",
    "commandKind: 'git_commit'",
    'record.exactPaths',
    'Validation ${result.commandKind} failed',
    'completeWorkbenchExecutionJournal(params.packetId)'
  ]) {
    assert(executorText.includes(required), `Workbench packet validation/commit execution must include ${required}`)
  }
  for (const required of [
    'assertCleanPacketPaths',
    "['status', '--porcelain=v1', '--untracked-files=all'",
    "['diff', '--cached', '--name-only']",
    'verifyExactPathSet',
    "['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']",
    "['rev-parse', 'HEAD']",
    'currentCommit: commitHash || run.currentCommit'
  ]) {
    assert(executorText.includes(required), `Workbench Git-state isolation must include ${required}`)
  }
  assert(packetStoreText.includes('commitHash?: string'), 'Packet records must persist commit hashes')
  assert(packetStoreText.includes("commitHash: params.status === 'completed' ? params.commitHash"), 'Packet finalization must store verified commit hashes')
  assert(serverText.includes('commitHash: record.commitHash'), 'Active-run packet summaries must expose commit hashes')
  for (const required of [
    'advanceWorkbenchRunAfterPacket',
    "status: 'completed' as const",
    "status: 'running' as const",
    'currentIteration: Math.min(job.maxIterations, job.currentIteration + 1)',
    'activeTaskId: nextTaskId',
    'nextTaskId,',
    "allTasks.every(task => task.status === 'completed' || task.status === 'skipped')",
    "status === 'completed'"
  ]) {
    assert(modelText.includes(required), `Workbench run progression must include ${required}`)
  }
  assert(modelText.includes("Object.prototype.hasOwnProperty.call(patch, 'activeTaskId')"), 'Run updates must allow activeTaskId to be cleared')
  assert(executorText.includes('advanceWorkbenchRunAfterPacket({'), 'Packet completion must advance the persistent run')

  const workerText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-worker.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_PACKET_WORKER_VERSION',
    'runNextWorkbenchPacket',
    'claimNextWorkbenchPacket',
    'renewWorkbenchPacketLease',
    'releaseWorkbenchPacketLease',
    'executeWorkbenchPacket',
    "type: 'packet_claimed'",
    "type: 'packet_started'",
    "const eventType = execution.status === 'completed'",
    "? 'packet_paused'",
    "? 'packet_cancelled'",
    "status: 'requeued'",
    'clearInterval(renewal)'
  ]) {
    assert(workerText.includes(required), `Workbench asynchronous worker core must include ${required}`)
  }
  assert(!serverText.includes('runNextWorkbenchPacket('), 'Server routes must not execute packets inline during staged async migration')
  assert(modelText.includes('activePacketId?: string'), 'Workbench runs must persist activePacketId')
  assert(modelText.includes("| 'activePacketId'"), 'Run updates and compact status must include activePacketId')
  assert(workerText.includes('setRunActivePacket(runId, packetId)'), 'Packet claims must set activePacketId')
  assert(workerText.includes('setRunActivePacket(runId)'), 'Terminal worker paths must clear activePacketId')
  const eventText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/agent-events.ts'), 'utf8')
  for (const required of ["'packet_paused'", "'packet_resumed'", "'packet_cancelled'"]) {
    assert(eventText.includes(required), `Packet lifecycle events must include ${required}`)
  }
  assert(workerText.includes("? 'packet_paused'"), 'Cooperative worker pause must emit packet_paused')
  assert(workerText.includes("? 'packet_cancelled'"), 'Cooperative worker cancel must emit packet_cancelled')
  assert(serverText.includes("? 'packet_resumed'"), 'Run resume controls must emit packet_resumed')

  const coordinatorText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-coordinator.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_PACKET_COORDINATOR_VERSION',
    'scheduleWorkbenchPacket',
    'scheduledPacketIds',
    "status: 'already_scheduled'",
    'setImmediate(() => {',
    'runNextWorkbenchPacket({',
    'scheduledPacketIds.delete(packetId)',
    'packetId,'
  ]) {
    assert(coordinatorText.includes(required), `Workbench asynchronous coordinator must include ${required}`)
  }
  assert(packetStoreText.includes('packetId?: string'), 'Packet claims must support exact packet selection')
  assert(packetStoreText.includes('record.packet.packetId === params.packetId'), 'Exact packet claims must filter atomically by packetId')
  assert(workerText.includes('packetId: params.packetId'), 'Worker claims must target the scheduled packet')
  assert(serverText.includes("'/api/workbench-packets/submit-async'"), 'Local server must expose staged asynchronous submission')
  assert(serverText.includes('scheduleWorkbenchPacket({'), 'Staged submission must use the duplicate-safe coordinator')
  assert(!schema.paths?.['/api/workbench-packets/submit-async'], 'Internal async submission must not be exposed in the public GPT schema yet')
  assert(!changeTypes.includes('packet_submit_async'), 'Public GPT change types must not expose async submission during staged migration')
  for (const required of [
    'drainQueuedWorkbenchPackets',
    'drainInProgress',
    "status: 'already_running'",
    'Math.min(20, Number(params.limit || 5))',
    "if (record.status !== 'queued') return false",
    '.sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))'
  ]) {
    assert(coordinatorText.includes(required), `Workbench restart-safe drain must include ${required}`)
  }
  assert(serverText.includes("'/api/workbench-packets/drain'"), 'Local server must expose the internal bounded drain endpoint')
  assert(serverText.includes('const drained = drainQueuedWorkbenchPackets({'), 'Server startup must drain queued packets after recovery')
  assert(serverText.indexOf('recoverStaleWorkbenchPacketLeases()') < serverText.indexOf('const drained = drainQueuedWorkbenchPackets({'), 'Startup drain must run after stale lease recovery')
  assert(!schema.paths?.['/api/workbench-packets/drain'], 'Internal packet drain must not be exposed in the public GPT schema yet')
  assert(!changeTypes.includes('packet_drain'), 'Public GPT change types must not expose packet drain during staged migration')

  const resultStoreText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-packet-results.ts'), 'utf8')
  for (const required of [
    'WORKBENCH_PACKET_RESULT_STORE_VERSION',
    'recordWorkbenchPacketResult',
    'getWorkbenchPacketResult',
    'MAX_PACKET_RESULTS',
    'MAX_ERRORS',
    'fs.renameSync(temporaryPath, RESULT_STORE_PATH)',
    'validation:',
    'commitHash:'
  ]) {
    assert(resultStoreText.includes(required), `Workbench compact packet results must include ${required}`)
  }
  assert(workerText.includes('recordWorkbenchPacketResult({'), 'Packet worker must persist compact outcomes')
  assert(serverText.includes("'/api/workbench-packets/status'"), 'Local server must expose compact packet status retrieval')
  assert(serverText.includes('getWorkbenchPacketResult(packetId)'), 'Packet status must include persisted compact results')
  assert(serverText.includes("listAgentEvents({ jobId: record.packet.runId, limit: 8 })"), 'Packet status must include bounded lifecycle evidence')
  assert(!schema.paths?.['/api/workbench-packets/status'], 'Internal packet status must not be exposed in the public GPT schema yet')
  assert(!changeTypes.includes('packet_status'), 'Public GPT change types must not expose packet status during staged migration')

  const continuationText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/workbench-continuation-decisions.ts'), 'utf8')
  for (const required of [
    'WorkbenchContinuationDecision',
    'recordWorkbenchContinuationDecision',
    'getWorkbenchContinuationDecision',
    'listWorkbenchContinuationDecisions',
    'MAX_DECISIONS',
    'fs.renameSync(temporaryPath, STORE_PATH)',
    "outcome: 'continue' | 'stop' | 'repair' | 'blocked'"
  ]) {
    assert(continuationText.includes(required), `Workbench continuation decisions must include ${required}`)
  }
  assert(workerText.includes('recordWorkbenchContinuationDecision({'), 'Terminal packet results must persist continuation decisions')
  assert(workerText.includes("if (!['completed', 'failed', 'paused', 'cancelled'].includes(result.status)) return result"), 'Only terminal packet results may produce continuation decisions')
  assert(workerText.includes('nextTaskId: nextTaskId || run.resumeState.nextTaskId'), 'Continuation review must persist the exact next task in resume state')
  assert(workerText.includes('Continuation ${outcome} after packet ${result.packetId}.'), 'Run resume instructions must include compact continuation evidence')
  assert(coordinatorText.includes("result.status === 'completed' && decision.outcome === 'continue' && decision.nextTaskId"), 'Automatic continuation must require a completed result and explicit continue decision')
  assert(coordinatorText.includes("run.status !== 'running' || run.requiresConfirmation || run.activePacketId"), 'Automatic continuation must stop for non-running, confirmation-required, or already-active runs')
  assert(coordinatorText.includes('run.activeTaskId !== decision.nextTaskId'), 'Automatic continuation must match the authoritative next task')
  assert(coordinatorText.includes("candidate.status === 'queued'") && coordinatorText.includes('candidate.packet.taskId === decision.nextTaskId'), 'Automatic continuation must schedule only an already-reserved queued packet for the next task')
  assert(coordinatorText.includes('.sort((a, b) => a.reservedAt.localeCompare(b.reservedAt))[0]'), 'Automatic continuation must choose only the oldest matching queued packet')

  const configText = fs.readFileSync(path.join(ROOT, 'packages/cli/src/agent/config.ts'), 'utf8')
  assert(configText.includes('autoCommitSourceIds?: string[]'), 'Agent config must expose a per-source auto-commit allowlist')
  assert(executorText.includes('(config?.autoCommitSourceIds || []).includes(params.sourceId)'), 'Packet executor must enforce the per-source auto-commit allowlist')
  assert(executorText.includes("run?.autoCommit === true && sourceAllowsAutoCommit"), 'Automatic commits must also require the run autoCommit flag')
  assert(executorText.includes("Automatic commit requires at least one targeted validation."), 'Automatic commits must require targeted validation')
  assert(executorText.includes("commandKind: 'security_scan_paths'"), 'Commit-capable packets must run an exact-path security scan')
  assert(executorText.includes("patternSet: 'forbidden_secret_material'"), 'Pre-commit scanning must block forbidden secret material')
  assert(executorText.includes("const commitMessage = record.packet.commit?.message?.trim() || `workbench: ${derivedTitle}`"), 'Commit messages must derive from the active task when not explicitly supplied')
  assert(executorText.includes('Workbench-Run: ${record.packet.runId}'), 'Commits must include a Workbench run trailer')
  assert(executorText.includes('Workbench-Packet: ${record.packet.packetId}'), 'Commits must include a Workbench packet trailer')
  assert(executorText.includes("commandKind: 'git_add_paths'"), 'Packet commits must preserve explicit-path staging')
  assert(!executorText.includes("commandKind: 'git_push'"), 'Packet execution must not auto-push by default')
  assert(executorText.includes('export function undoWorkbenchPacketCommit'), 'Phase 7 must expose bounded Workbench packet commit undo')
  assert(executorText.includes("Safe undo requires the Workbench-created commit to be the current HEAD."), 'Safe undo must reject non-HEAD packet commits')
  assert(executorText.includes('Workbench-Run: ${record.packet.runId}'), 'Safe undo must verify the Workbench run trailer')
  assert(executorText.includes('Workbench-Packet: ${record.packet.packetId}'), 'Safe undo must verify the Workbench packet trailer')
  assert(executorText.includes("'UNDO_PATH_MISMATCH'"), 'Safe undo must reject commit path mismatches')
  assert(executorText.includes("'UNDO_INDEX_NOT_CLEAN'"), 'Safe undo must require an empty Git index')
  assert(executorText.includes("'UNDO_PACKET_PATHS_DIRTY'"), 'Safe undo must reject dirty packet paths')
  assert(executorText.includes("execFileSync('git', ['revert', '--no-edit', head]"), 'Safe undo must create a bounded Git revert commit')
  assert(executorText.includes("'Undo commit'"), 'Safe undo must verify the revert commit exact path set')

  const repairStateFile = path.join(ROOT, 'packages/cli/src/agent/workbench-repair-state.ts')
  assert(fs.existsSync(repairStateFile), 'Phase 8 repair-state store must exist')
  const repairStateText = fs.readFileSync(repairStateFile, 'utf8')
  assert(repairStateText.includes('WORKBENCH_REPAIR_STATE_VERSION = 1'), 'Repair-state store must be versioned')
  assert(repairStateText.includes('MAX_AUTOMATIC_REPAIR_ATTEMPTS = 1'), 'Repair-state store must allow exactly one automatic repair attempt')
  assert(repairStateText.includes("status: 'eligible' | 'accepted' | 'exhausted' | 'cleared'"), 'Repair-state lifecycle must be explicit')
  assert(repairStateText.includes("path.join(getConfigDir(), 'workbench-repair-state.json')"), 'Repair state must persist in the Workbench config directory')
  assert(repairStateText.includes('fs.renameSync(temporaryPath, STORE_PATH)'), 'Repair-state persistence must be atomic')
  assert(repairStateText.includes('previous.failedPacketId !== params.failedPacketId'), 'Repair acceptance must match the persisted failed packet')
  assert(repairStateText.includes("previous.status !== 'eligible'"), 'Repair acceptance must reject non-eligible state')
  assert(repairStateText.includes('previous.attemptCount >= MAX_AUTOMATIC_REPAIR_ATTEMPTS'), 'Repair acceptance must enforce the attempt limit')
  assert(repairStateText.includes('acceptedRepairPacketId: params.repairPacketId'), 'Repair acceptance must persist the accepted repair packet')

  const repairCoordinatorFile = path.join(ROOT, 'packages/cli/src/agent/workbench-packet-coordinator.ts')
  assert(fs.existsSync(repairCoordinatorFile), 'Workbench packet coordinator must exist')
  const repairCoordinatorText = fs.readFileSync(repairCoordinatorFile, 'utf8')
  assert(repairCoordinatorText.includes("decision.outcome !== 'repair'"), 'Repair dispatch must require a persisted repair continuation decision')
  assert(repairCoordinatorText.includes('run.activeTaskId !== taskId'), 'Repair dispatch must require the failed task to remain active')
  assert(repairCoordinatorText.includes("repairState.status !== 'eligible'"), 'Repair dispatch must require eligible persisted repair state')
  assert(repairCoordinatorText.includes('repairState.failedPacketId !== result.packetId'), 'Repair dispatch must match the persisted failed packet')
  assert(repairCoordinatorText.includes('candidate.packet.taskId === taskId'), 'Repair dispatch must target the same task')
  assert(repairCoordinatorText.includes('acceptWorkbenchRepairAttempt({'), 'Repair dispatch must consume the single attempt before scheduling')
  assert(repairCoordinatorText.includes('repairPacketId: repairRecord.packet.packetId'), 'Repair acceptance must persist the selected repair packet identity')
  assert(repairCoordinatorText.includes('scheduledPacketIds.has(repairRecord.packet.packetId)'), 'Repair dispatch must prevent duplicate scheduling')
  assert(repairCoordinatorText.includes("result.status !== 'failed'"), 'Repair dispatch must only follow a terminal failed worker result')
  assert(repairCoordinatorText.includes('getWorkbenchRepairState(record.packet.runId, record.packet.taskId)'), 'Restart queue drain must load persisted repair state for each queued task')
  assert(repairCoordinatorText.includes("repairState.status === 'cleared'"), 'Restart queue drain must allow cleared repair state to resume normal scheduling')
  assert(repairCoordinatorText.includes("repairState.status === 'accepted'"), 'Restart queue drain must handle accepted repair state explicitly')
  assert(repairCoordinatorText.includes('repairState.acceptedRepairPacketId === record.packet.packetId'), 'Restart queue drain must allow only the exact accepted repair packet')
  assert(repairCoordinatorText.includes('return false'), 'Restart queue drain must block eligible, exhausted, and duplicate accepted repair packets')

  return {
    schemaVersion: 1,
    atomicPersistence: true,
    legacyJobCompatibility: true,
    activeRunMode: true,
    runCreateResume: true,
    packetPreflight: true,
    packetReservation: true,
    packetLeases: true,
    packetExecutionPlan: true,
    packetExecution: true,
    executionJournalRecovery: true,
    packetValidationCommit: true,
    packetGitIsolation: true,
    deterministicRunProgression: true,
    asynchronousWorkerCore: true,
    asynchronousCoordinator: true,
    restartSafeQueueDrain: true,
    packetControls: true,
    compactPacketResults: true,
    continuationDecisions: true
  }
}

async function main() {
  const schema = readJson(DOCS_SCHEMA_FILE)
  ensureSchemaRules(schema)
  const instructions = ensureInstructions()
  const staleFragments = ensureNoStaleSchemaFragments()
  const documentationAlignment = ensureDocumentationAlignment()
  ensureSourceDeadlineLayer()
  const retiredAgentActions = ensureRetiredAgentActionRoutes()
  ensureActionBudgetAndTimeoutLanguage()
  ensureFocusedModeGuardrails()
  const workbenchRunModel = ensureWorkbenchRunModel()
  const live = await runLiveSmokeChecks()

  const ops = collectOperations(schema)
  const statusContractVerified = verifyStatusOperationContract(ops)

  console.log(JSON.stringify({
    status: 'ok',
    schemaBytes: byteLength(schema),
    instructionsBytes: instructions.bytes,
    expectedOperationCount: EXPECTED_OPERATION_IDS.length,
    statusContractVerified,
    documentationAlignment,
    retiredAgentActions,
    workbenchRunModel,
    payloadBudgets: {
      statusBudgetBytes: 8_000,
      targetBytes: TARGET_ACTION_RESPONSE_BYTES,
      hardBudgetBytes: HARD_ACTION_RESPONSE_BYTES
    },
    openAiMetadataLimits: {
      operationSummaryChars: MAX_OPERATION_SUMMARY_CHARS,
      operationDescriptionChars: MAX_OPERATION_DESCRIPTION_CHARS,
      parameterDescriptionChars: MAX_PARAMETER_DESCRIPTION_CHARS
    },
    staleFragments,
    live
  }, null, 2))
}

main().catch(error => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exit(1)
})
