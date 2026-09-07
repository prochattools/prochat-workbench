export const WORKBENCH_OPERATION_IDS = {
  getWorkbenchStatus: 'getWorkbenchStatus',
  readWorkbenchContext: 'readWorkbenchContext',
  applyWorkbenchFileChange: 'applyWorkbenchFileChange',
  commitWorkbenchChanges: 'commitWorkbenchChanges',
  runWorkbenchCommand: 'runWorkbenchCommand',
  inspectRepository: 'inspectRepository',
  listSourceDetails: 'listSourceDetails',
  addRepository: 'addRepository',
  removeSource: 'removeSource',
  setSourceEnabled: 'setSourceEnabled',
  refreshSourceMetadata: 'refreshSourceMetadata',
  addBranchSource: 'addBranchSource',
  registerExistingWorktree: 'registerExistingWorktree',
  removeBranchSource: 'removeBranchSource'
} as const

export const WORKBENCH_PRIVATE_OPERATION_IDS = {
  manageWorkbenchApprovalIntent: 'manageWorkbenchApprovalIntent',
  discoverRepositories: 'discoverRepositories',
  setSourceDiscoverySettings: 'setSourceDiscoverySettings',
  getSourceHealth: 'getSourceHealth',
  approveSourceReconciliation: 'approveSourceReconciliation'
} as const

export type WorkbenchOperationId =
  | typeof WORKBENCH_OPERATION_IDS[keyof typeof WORKBENCH_OPERATION_IDS]
  | typeof WORKBENCH_PRIVATE_OPERATION_IDS[keyof typeof WORKBENCH_PRIVATE_OPERATION_IDS]
export type WorkbenchMutationClass = 'read_only' | 'mutation_capable'

export const WORKBENCH_OPERATION_MUTATION_CLASS: Record<WorkbenchOperationId, WorkbenchMutationClass> = {
  manageWorkbenchApprovalIntent: 'mutation_capable',
  getWorkbenchStatus: 'read_only',
  readWorkbenchContext: 'read_only',
  applyWorkbenchFileChange: 'mutation_capable',
  commitWorkbenchChanges: 'mutation_capable',
  runWorkbenchCommand: 'mutation_capable',
  inspectRepository: 'read_only',
  listSourceDetails: 'read_only',
  addRepository: 'mutation_capable',
  removeSource: 'mutation_capable',
  setSourceEnabled: 'mutation_capable',
  refreshSourceMetadata: 'mutation_capable',
  addBranchSource: 'mutation_capable',
  registerExistingWorktree: 'mutation_capable',
  removeBranchSource: 'mutation_capable',
  discoverRepositories: 'read_only',
  setSourceDiscoverySettings: 'mutation_capable',
  getSourceHealth: 'read_only',
  approveSourceReconciliation: 'mutation_capable'
}

export interface WorkbenchOperationRequest<TPayload = unknown> {
  protocolVersion: 1
  requestId: string
  operationId: WorkbenchOperationId
  sourceId?: string
  sessionId?: string
  deadlineAt: string
  cancellationId?: string
  confirmationToken?: string
  expectedHead?: string
  protectedPaths?: string[]
  caller?: { ingress: 'http' | 'cli' | 'native' | 'test'; client?: string }
  payload: TPayload
}

export interface WorkbenchOperationResponse<TPayload = unknown> {
  protocolVersion: 1
  requestId: string
  operationId: WorkbenchOperationId
  ok: boolean
  sourceId?: string
  sessionId?: string
  payload?: TPayload
  error?: {
    code: string
    message: string
    reason?: string
    retryable?: boolean
    requiresConfirmation?: boolean
    confirmationToken?: string
    details?: Record<string, unknown>
  }
  activity?: Record<string, unknown>
}

export const WORKBENCH_OPERATION_ID_LIST = Object.values(WORKBENCH_OPERATION_IDS) as WorkbenchOperationId[]
