import crypto from 'node:crypto'
import {
  acquireWorkbenchBudget,
  releaseWorkbenchBudget,
  type WorkbenchBudgetFailure,
  type WorkbenchBudgetOptions,
  type WorkbenchWorkerClass
} from './workbench-global-budget-store'
import {
  cancelRepositoryWork,
  claimRepositoryWork,
  completeRepositoryWork,
  enqueueRepositoryWork,
  type RepositoryScheduleClass,
  type RepositorySchedulerFailure,
  type RepositorySchedulerOptions
} from './workbench-repository-scheduler'
import {
  getWorkbenchSession,
  type WorkbenchSessionStoreFailure,
  type WorkbenchSessionStoreOptions
} from './workbench-session-store'
import {
  recordWorkbenchSessionAdmissionFailure,
  type WorkbenchSessionAdmissionPredicate
} from './workbench-session-admission-diagnostics'

export type WorkbenchAdmissionOperation =
  | 'status'
  | 'approval'
  | 'read'
  | 'git'
  | 'install'
  | 'index'
  | 'write'
  | 'migration_execute'
  | 'destructive'

export type WorkbenchAdmissionClassification = {
  workerClass: WorkbenchWorkerClass
  repositoryClass?: RepositoryScheduleClass
}

export type WorkbenchAdmissionFailure = {
  ok: false
  code:
    | 'ADMISSION_INVALID_SESSION'
    | 'ADMISSION_SOURCE_NOT_OWNED'
    | 'ADMISSION_BUDGET_REJECTED'
    | 'ADMISSION_REPOSITORY_REJECTED'
    | 'ADMISSION_EXECUTION_FAILED'
  message: string
  cause?: WorkbenchBudgetFailure | RepositorySchedulerFailure | WorkbenchSessionStoreFailure
}

export type WorkbenchAdmissionOptions = {
  session?: WorkbenchSessionStoreOptions
  budget?: WorkbenchBudgetOptions
  repository?: RepositorySchedulerOptions
  workerId?: string
  leaseMs?: number
  now?: string
}

export type WorkbenchAdmissionLease = {
  requestId: string
  sessionId: string
  sourceId: string
  operation: WorkbenchAdmissionOperation
  operationKind: string
  workerClass: WorkbenchWorkerClass
  repositoryClass?: RepositoryScheduleClass
  budgetLeaseId: string
  budgetLeaseProof: string
  repositoryRequestId?: string
  repositoryLeaseProof?: string
}

export type WorkbenchAdmissionLeaseResult =
  | { ok: true; lease: WorkbenchAdmissionLease }
  | WorkbenchAdmissionFailure

export function classifyWorkbenchAdmissionOperation(operation: WorkbenchAdmissionOperation): WorkbenchAdmissionClassification {
  switch (operation) {
    case 'status':
      return { workerClass: 'status' }
    case 'approval':
      return { workerClass: 'approval' }
    case 'read':
      return { workerClass: 'read', repositoryClass: 'read_shared' }
    case 'git':
    case 'install':
    case 'index':
    case 'write':
    case 'migration_execute':
    case 'destructive':
      return { workerClass: 'mutation', repositoryClass: 'mutation_exclusive' }
  }
}

function isSessionFailure(value: ReturnType<typeof getWorkbenchSession>): value is WorkbenchSessionStoreFailure {
  return !!value && 'ok' in value && value.ok === false
}

function isBudgetFailure<T extends { ok: boolean }>(value: T | WorkbenchBudgetFailure): value is WorkbenchBudgetFailure {
  return value.ok === false
}

function isRepositoryFailure<T extends { ok: boolean }>(value: T | RepositorySchedulerFailure): value is RepositorySchedulerFailure {
  return value.ok === false
}

function recordAdmissionFailure(input: {
  requestId?: string
  sessionId: string
  sourceId: string
  operation: WorkbenchAdmissionOperation
  operationKind: string
  code: string
  predicate: WorkbenchSessionAdmissionPredicate
}, options: WorkbenchAdmissionOptions): void {
  recordWorkbenchSessionAdmissionFailure(input, {
    rootDir: options.session?.rootDir,
    now: options.session?.now
  })
}

export function acquireWorkbenchAdmission(input: {
  requestId?: string
  sessionId: string
  sourceId: string
  operation: WorkbenchAdmissionOperation
  operationKind: string
  cost?: number
}, options: WorkbenchAdmissionOptions = {}): WorkbenchAdmissionLeaseResult {
  const session = getWorkbenchSession(input.sessionId, options.session)
  if (!session || isSessionFailure(session) || session.status !== 'active') {
    const predicate: WorkbenchSessionAdmissionPredicate = !session
      ? 'session_not_found'
      : isSessionFailure(session)
        ? 'session_store_error'
        : session.status === 'completed'
          ? 'expired'
          : 'inactive'
    recordAdmissionFailure({ ...input, code: 'ADMISSION_INVALID_SESSION', predicate }, options)
    return {
      ok: false,
      code: 'ADMISSION_INVALID_SESSION',
      message: 'An active Workbench session is required before admission.',
      ...(isSessionFailure(session) ? { cause: session } : {})
    }
  }
  if (!session.lockedSourceIds.includes(input.sourceId)) {
    recordAdmissionFailure({ ...input, code: 'ADMISSION_SOURCE_NOT_OWNED', predicate: 'source_mismatch' }, options)
    return { ok: false, code: 'ADMISSION_SOURCE_NOT_OWNED', message: 'The session does not own the selected source.' }
  }

  const classification = classifyWorkbenchAdmissionOperation(input.operation)
  const requestId = input.requestId || `admission-${crypto.randomUUID()}`
  const budget = acquireWorkbenchBudget({
    requestId,
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    workerClass: classification.workerClass,
    cost: input.cost,
    leaseMs: options.leaseMs,
    now: options.now
  }, options.budget)
  if (isBudgetFailure(budget)) {
    recordAdmissionFailure({ ...input, code: 'ADMISSION_BUDGET_REJECTED', predicate: 'budget_rejected' }, options)
    return { ok: false, code: 'ADMISSION_BUDGET_REJECTED', message: budget.message, cause: budget }
  }

  let repositoryRequestId: string | undefined
  let repositoryLeaseProof: string | undefined
  if (classification.repositoryClass) {
    const queued = enqueueRepositoryWork({
      requestId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      class: classification.repositoryClass,
      operationKind: input.operationKind,
      now: options.now
    }, options.repository)
    if (isRepositoryFailure(queued)) {
      releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, outcome: 'cancelled', now: options.now }, options.budget)
      recordAdmissionFailure({ ...input, code: 'ADMISSION_REPOSITORY_REJECTED', predicate: 'repository_rejected' }, options)
      return { ok: false, code: 'ADMISSION_REPOSITORY_REJECTED', message: queued.message, cause: queued }
    }
    const claimed = claimRepositoryWork({
      requestId,
      workerId: options.workerId || 'workbench-admission',
      leaseMs: options.leaseMs,
      now: options.now
    }, options.repository)
    if (isRepositoryFailure(claimed)) {
      cancelRepositoryWork({ requestId, now: options.now }, options.repository)
      releaseWorkbenchBudget({ leaseId: budget.lease.leaseId, leaseProof: budget.leaseProof, outcome: 'cancelled', now: options.now }, options.budget)
      recordAdmissionFailure({ ...input, requestId, code: 'ADMISSION_REPOSITORY_REJECTED', predicate: 'repository_rejected' }, options)
      return { ok: false, code: 'ADMISSION_REPOSITORY_REJECTED', message: claimed.message, cause: claimed }
    }
    repositoryRequestId = requestId
    repositoryLeaseProof = claimed.leaseProof
  }

  return {
    ok: true,
    lease: {
      requestId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      operation: input.operation,
      operationKind: input.operationKind,
      workerClass: classification.workerClass,
      ...(classification.repositoryClass ? { repositoryClass: classification.repositoryClass } : {}),
      budgetLeaseId: budget.lease.leaseId,
      budgetLeaseProof: budget.leaseProof,
      ...(repositoryRequestId ? { repositoryRequestId } : {}),
      ...(repositoryLeaseProof ? { repositoryLeaseProof } : {})
    }
  }
}

export function releaseWorkbenchAdmission(
  lease: WorkbenchAdmissionLease,
  options: WorkbenchAdmissionOptions = {},
  outcome: 'released' | 'cancelled' = 'released'
): { ok: true } | WorkbenchAdmissionFailure {
  let repositoryFailure: RepositorySchedulerFailure | undefined
  if (lease.repositoryRequestId) {
    const repositoryResult = outcome === 'cancelled'
      ? cancelRepositoryWork({ requestId: lease.repositoryRequestId, now: options.now }, options.repository)
      : lease.repositoryLeaseProof
        ? completeRepositoryWork({ requestId: lease.repositoryRequestId, leaseProof: lease.repositoryLeaseProof, now: options.now }, options.repository)
        : { ok: false as const, code: 'SCHEDULER_LEASE_PROOF_INVALID' as const, message: 'Repository lease proof is missing.' }
    if (isRepositoryFailure(repositoryResult)) {
      if (repositoryResult.code === 'SCHEDULER_LEASE_CONFLICT') {
        const fallback = cancelRepositoryWork({ requestId: lease.repositoryRequestId, now: options.now }, options.repository)
        if (isRepositoryFailure(fallback)) repositoryFailure = repositoryResult
      } else {
        repositoryFailure = repositoryResult
      }
    }
  }

  const budgetResult = releaseWorkbenchBudget({
    leaseId: lease.budgetLeaseId,
    leaseProof: lease.budgetLeaseProof,
    outcome,
    now: options.now
  }, options.budget)

  if (repositoryFailure) {
    return { ok: false, code: 'ADMISSION_REPOSITORY_REJECTED', message: repositoryFailure.message, cause: repositoryFailure }
  }
  if (isBudgetFailure(budgetResult)) {
    return { ok: false, code: 'ADMISSION_BUDGET_REJECTED', message: budgetResult.message, cause: budgetResult }
  }
  return { ok: true }
}

export async function executeWithWorkbenchAdmission<T>(input: {
  requestId?: string
  sessionId: string
  sourceId: string
  operation: WorkbenchAdmissionOperation
  operationKind: string
  cost?: number
  execute: () => Promise<T> | T
}, options: WorkbenchAdmissionOptions = {}): Promise<{ ok: true; result: T } | WorkbenchAdmissionFailure> {
  const acquired = acquireWorkbenchAdmission({
    requestId: input.requestId,
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    operation: input.operation,
    operationKind: input.operationKind,
    cost: input.cost
  }, options)
  if (acquired.ok === false) return acquired

  try {
    const result = await input.execute()
    const released = releaseWorkbenchAdmission(acquired.lease, options, 'released')
    if (released.ok === false) {
      recordAdmissionFailure({
        requestId: input.requestId,
        sessionId: input.sessionId,
        sourceId: input.sourceId,
        operation: input.operation,
        operationKind: input.operationKind,
        code: released.code,
        predicate: released.code === 'ADMISSION_REPOSITORY_REJECTED' ? 'repository_rejected' : 'budget_rejected'
      }, options)
      return released
    }
    return { ok: true, result }
  } catch (error) {
    releaseWorkbenchAdmission(acquired.lease, options, 'cancelled')
    recordAdmissionFailure({
      requestId: input.requestId,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      operation: input.operation,
      operationKind: input.operationKind,
      code: 'ADMISSION_EXECUTION_FAILED',
      predicate: 'execution_failed'
    }, options)
    return { ok: false, code: 'ADMISSION_EXECUTION_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
}
