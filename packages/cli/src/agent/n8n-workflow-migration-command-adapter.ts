import crypto from 'node:crypto'
import fs from 'node:fs'
import { loadControlledN8nWorkflowGrants, type ControlledN8nWorkflowGrant } from './capability-grants'
import type { CapabilityOperationStoreOptions } from './capability-operation-store'
import type { CapabilityMutationDispatchStoreOptions } from './capability-mutation-dispatch-store'
import type { KnowledgeSource } from '@workbench/shared'
import type { MigrationRunCommandPlan } from './run-command-request'
import {
  executeControlledWorkflowMigration,
  getControlledWorkflowMigrationStatus,
  prepareControlledWorkflowMigration,
  type ControlledMigrationExecutor,
  type ControlledMigrationFailure,
  type ControlledMigrationSource
} from './n8n-workflow-migration-capability'
import { createNodeN8nWorkflowMigrationExecutor } from './n8n-workflow-migration-executor'
import { createOwnerLocalN8nRuntimeConfigurationSnapshot } from './n8n-runtime-config'
import { isSourcePathAvailable } from './config'

type PublicMigrationFailureCode = ControlledMigrationFailure['error']['code'] | 'mutation_blocked'

type PublicMigrationResponse = {
  status: string
  sourceId: string
  commandKind: 'n8n_workflow_migration'
  migrationMode: 'apply' | 'rollback'
  migrationPhase: 'prepare' | 'execute' | 'status'
  operation?: unknown
  confirmationToken?: string
  error?: { code: PublicMigrationFailureCode; message: string }
}

export type MigrationCommandAdapterResult = { statusCode: number; body: PublicMigrationResponse }

export type MigrationCommandAdapterDependencies = {
  getSources: () => KnowledgeSource[]
  getConfiguredGrants: () => unknown
  realpath?: (value: string) => string
  digest?: (value: string) => string
  prepare?: typeof prepareControlledWorkflowMigration
  execute?: typeof executeControlledWorkflowMigration
  status?: typeof getControlledWorkflowMigrationStatus
  createExecutor?: typeof createNodeN8nWorkflowMigrationExecutor
  operationStore?: CapabilityOperationStoreOptions
  dispatchStore?: CapabilityMutationDispatchStoreOptions
  now?: () => Date
  randomBytes?: (size: number) => Buffer
  wrapperContract?: unknown
}

const publicFailure = (request: MigrationRunCommandPlan, code: PublicMigrationFailureCode, message: string): MigrationCommandAdapterResult => ({
  statusCode: code === 'operation_not_found' || code === 'source_not_found' ? 404 : code === 'capability_not_configured' ? 503 : 409,
  body: {
    status: 'blocked', sourceId: request.sourceId, commandKind: request.commandKind,
    migrationMode: request.migration.mode, migrationPhase: request.migration.phase,
    error: { code, message }
  }
})

function configuredSource(request: MigrationRunCommandPlan, dependencies: MigrationCommandAdapterDependencies): ControlledMigrationSource | undefined {
  const configured = dependencies.getSources().find(source => source.id === request.sourceId && source.enabled && (dependencies.realpath ? true : isSourcePathAvailable(source.path)))
  if (!configured) return undefined
  try {
    const rootPath = (dependencies.realpath || fs.realpathSync)(configured.path)
    const rootFingerprint = (dependencies.digest || (value => crypto.createHash('sha256').update(value).digest('hex')))(rootPath)
    return { sourceId: configured.id, rootPath, rootFingerprint, enabled: true }
  } catch {
    return undefined
  }
}

export async function runControlledWorkflowMigrationCommand(
  request: MigrationRunCommandPlan,
  dependencies: MigrationCommandAdapterDependencies
): Promise<MigrationCommandAdapterResult> {
  const source = configuredSource(request, dependencies)
  if (!source) return publicFailure(request, 'source_not_found', 'Source not found or disabled.')

  const loadedGrants = loadControlledN8nWorkflowGrants(dependencies.getConfiguredGrants())
  if (loadedGrants.issues.length > 0) {
    return publicFailure(request, 'capability_not_configured', 'Controlled workflow migration grants are invalid.')
  }
  const grants = loadedGrants.grants
  const getSource = (sourceId: string) => sourceId === source.sourceId ? source : undefined
  const createExecutor = dependencies.createExecutor || createNodeN8nWorkflowMigrationExecutor
  const loadRuntimeConfiguration = createOwnerLocalN8nRuntimeConfigurationSnapshot()
  const executor: ControlledMigrationExecutor = async input => {
    const { consumeMutationDispatch, ...invocation } = input
    return createExecutor({
      sourceRoot: source.rootPath,
      sourceId: source.sourceId,
      sourceRootFingerprint: source.rootFingerprint,
      loadRuntimeConfiguration,
      ...(consumeMutationDispatch ? { consumeMutationDispatch } : {})
    })(invocation)
  }
  const capabilityDependencies = {
    getSource,
    getGrants: () => grants as ControlledN8nWorkflowGrant[],
    executor,
    ...(dependencies.operationStore ? { operationStore: dependencies.operationStore } : {}),
    ...(dependencies.dispatchStore ? { dispatchStore: dependencies.dispatchStore } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
    ...(dependencies.randomBytes ? { randomBytes: dependencies.randomBytes } : {}),
    ...(dependencies.wrapperContract ? { wrapperContract: dependencies.wrapperContract } : {})
  }

  try {
    const result = request.migration.phase === 'prepare'
      ? await (dependencies.prepare || prepareControlledWorkflowMigration)({
          sourceId: request.sourceId,
          workflowId: request.migration.workflowId,
          mode: request.migration.mode,
          candidatePath: request.migration.candidatePath,
          rollbackPath: request.migration.rollbackPath,
          manifestPath: request.migration.manifestPath
        }, capabilityDependencies)
      : request.migration.phase === 'execute'
        ? await (dependencies.execute || executeControlledWorkflowMigration)({
            sourceId: request.sourceId,
            operationId: request.migration.operationId,
            mode: request.migration.mode,
            confirmationToken: request.migration.confirmationToken
          }, capabilityDependencies)
        : (dependencies.status || getControlledWorkflowMigrationStatus)({
            sourceId: request.sourceId,
            operationId: request.migration.operationId,
            mode: request.migration.mode
          }, capabilityDependencies)

    if (result.ok === false) return publicFailure(request, result.error.code, result.error.message)
    return {
      statusCode: 200,
      body: {
        status: result.status,
        sourceId: request.sourceId,
        commandKind: request.commandKind,
        migrationMode: request.migration.mode,
        migrationPhase: request.migration.phase,
        operation: result.operation,
        ...('confirmationToken' in result ? { confirmationToken: result.confirmationToken } : {})
      }
    }
  } catch {
    return publicFailure(request, 'mutation_blocked', 'Controlled workflow migration could not be completed safely.')
  }
}
