import {
  inspectRepository,
  listSourceDetails,
  addRepository,
  removeSourceRegistration,
  setSourceEnabledSafe,
  refreshSourceMetadata,
  addBranchSource,
  registerExistingWorktree,
  removeBranchSource,
  startSourceReindex,
  SourceManagementError
} from './source-management'
import { applyReconciliationApproval, resolveReconciliationOwnerAuthority, type ReconciliationAction, type ReconciliationApprovalAction, type ReconciliationClassification, type ReconciliationReasonCode, type ReconciliationRegistrationType } from './source-reconciliation'
import { approveSourceRecoveryManifest, createSourceRecoveryManifest, executeSourceRecoveryManifest, getSourceRecoveryManifest } from './source-recovery-manifest'
import { setSourceDiscoverySettings, discoverRepositories } from './config'
import type { PortableOperationHandlers } from '../../../../apps/web/src/lib/actions/portable-operation-dispatcher'
import { PortableOperationError } from './portable-operation-errors'

type Payload = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireString(payload: Payload, key: string): string {
  const v = asString(payload[key])
  if (!v) throw new PortableOperationError('invalid_request', `${key} is required`)
  return v
}

function requireAction(value: unknown): ReconciliationApprovalAction {
  if (value === 'disable' || value === 'remove' || value === 'retain' || value === 'defer' || value === 'clear') return value
  throw new PortableOperationError('invalid_request', 'action must be disable, remove, retain, defer, or clear')
}

function requireRegistrationType(value: unknown): ReconciliationRegistrationType {
  if (value === 'source' || value === 'provider') return value
  throw new PortableOperationError('invalid_request', 'registrationType must be source or provider')
}

function toPortableError(err: unknown): never {
  if (err instanceof SourceManagementError) {
    const code = err.code === 'not_found' ? 'source_mismatch'
      : err.code === 'path_traversal' ? 'policy_rejected'
      : err.code === 'not_initialized' ? 'dependency_unavailable'
      : err.code === 'duplicate_path' || err.code === 'duplicate_id' || err.code === 'duplicate_branch_source' ? 'invalid_request'
      : 'command_failed'
    throw new PortableOperationError(code, err.message)
  }
  throw new PortableOperationError('command_failed', err instanceof Error ? err.message : String(err))
}

export function createSourceManagementHandlers(): PortableOperationHandlers {
  return {
    createSourceRecoveryManifest: payload => {
      const p = payload as Payload
      if (!Array.isArray(p.selections)) throw new PortableOperationError('invalid_request', 'selections must be an exact array of reviewed proposals')
      return createSourceRecoveryManifest({ selections: p.selections, actorId: resolveReconciliationOwnerAuthority() })
    },
    getSourceRecoveryManifest: payload => {
      const p = payload as Payload
      return getSourceRecoveryManifest(requireString(p, 'manifestId'))
    },
    approveSourceRecoveryManifest: payload => {
      const p = payload as Payload
      if (p.ownerConfirmed !== true) throw new PortableOperationError('invalid_request', 'ownerConfirmed must be true')
      return approveSourceRecoveryManifest({ manifestId: requireString(p, 'manifestId'), digest: requireString(p, 'digest'), ownerConfirmed: true, actorId: resolveReconciliationOwnerAuthority() })
    },
    executeSourceRecoveryManifest: async payload => {
      const p = payload as Payload
      return executeSourceRecoveryManifest({ manifestId: requireString(p, 'manifestId'), digest: requireString(p, 'digest'), actorId: resolveReconciliationOwnerAuthority() })
    },
    approveSourceReconciliation: payload => {
      const p = payload as Payload
      const action = requireAction(p.action)
      const result = applyReconciliationApproval({
        proposalId: requireString(p, 'proposalId'),
        action,
        actorId: resolveReconciliationOwnerAuthority(),
        registrationId: requireString(p, 'registrationId'),
        registrationType: requireRegistrationType(p.registrationType),
        canonicalPath: requireString(p, 'canonicalPath'),
        classification: requireString(p, 'classification') as ReconciliationClassification,
        reasonCode: requireString(p, 'reasonCode') as ReconciliationReasonCode,
        ownerConfirmed: true
      })
      return result
    },
    inspectRepository: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      try { return inspectRepository(dirPath) } catch (err) { toPortableError(err) }
    },

    listSourceDetails: () => {
      try { return { sources: listSourceDetails() } } catch (err) { toPortableError(err) }
    },

    addRepository: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      const label = asString(p.label)
      const id = asString(p.id)
      try {
        const result = addRepository(dirPath, label, id)
        const added = result.sources[result.sources.length - 1]
        if (added?.id && added.enabled) startSourceReindex(added.id)
        return { sources: listSourceDetails() }
      } catch (err) { toPortableError(err) }
    },

    removeSource: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return removeSourceRegistration(sourceId) } catch (err) { toPortableError(err) }
    },

    setSourceEnabled: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      if (typeof p.enabled !== 'boolean') throw new PortableOperationError('invalid_request', 'enabled (boolean) is required')
      try { return setSourceEnabledSafe(sourceId, p.enabled as boolean) } catch (err) { toPortableError(err) }
    },

    refreshSourceMetadata: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return refreshSourceMetadata(sourceId) } catch (err) { toPortableError(err) }
    },

    addBranchSource: (payload) => {
      const p = payload as Payload
      const parentSourceId = requireString(p, 'parentSourceId')
      const branchName = requireString(p, 'branchName')
      try { return addBranchSource(parentSourceId, branchName) } catch (err) { toPortableError(err) }
    },

    registerExistingWorktree: (payload) => {
      const p = payload as Payload
      const dirPath = requireString(p, 'path')
      const parentSourceId = requireString(p, 'parentSourceId')
      const label = asString(p.label)
      try { return registerExistingWorktree(dirPath, parentSourceId, label) } catch (err) { toPortableError(err) }
    },

    removeBranchSource: (payload) => {
      const p = payload as Payload
      const sourceId = requireString(p, 'sourceId')
      try { return removeBranchSource(sourceId) } catch (err) { toPortableError(err) }
    },

    discoverRepositories: (payload) => {
      const p = payload as Payload
      const rootPath = p.rootPath === undefined ? undefined : requireString(p, 'rootPath')
      try { return discoverRepositories(rootPath) } catch (err) { toPortableError(err) }
    },

    setSourceDiscoverySettings: (payload) => {
      const p = payload as Payload
      if (p.rootPath !== undefined && typeof p.rootPath !== 'string') throw new PortableOperationError('invalid_request', 'rootPath must be a string')
      if (p.allowedRoots !== undefined && (!Array.isArray(p.allowedRoots) || p.allowedRoots.some(item => typeof item !== 'string'))) throw new PortableOperationError('invalid_request', 'allowedRoots must be an array of strings')
      if (p.ignorePatterns !== undefined && (!Array.isArray(p.ignorePatterns) || p.ignorePatterns.some(item => typeof item !== 'string'))) throw new PortableOperationError('invalid_request', 'ignorePatterns must be an array of strings')
      if (p.namingPattern !== undefined && typeof p.namingPattern !== 'string') throw new PortableOperationError('invalid_request', 'namingPattern must be a string')
      if (p.intervalMinutes !== undefined && typeof p.intervalMinutes !== 'number') throw new PortableOperationError('invalid_request', 'intervalMinutes must be a number')
      try {
        setSourceDiscoverySettings({
          rootPath: p.rootPath as string | undefined,
          allowedRoots: p.allowedRoots as string[] | undefined,
          ignorePatterns: p.ignorePatterns as string[] | undefined,
          namingPattern: p.namingPattern as string | undefined,
          intervalMinutes: p.intervalMinutes as number | undefined
        })
        return discoverRepositories()
      } catch (err) { toPortableError(err) }
    }
  }
}
