import crypto from 'crypto'
import { appendAgentEvent, hasPacketValidationActivityEvent } from './agent-events'
import { getAgentJob, updateAgentJob } from './agent-jobs'
import { executeWorkbenchPacket, type WorkbenchPacketExecutionResult } from './workbench-packet-executor'
import { recordWorkbenchContinuationDecision } from './workbench-continuation-decisions'
import { recordWorkbenchPacketResult as persistWorkbenchPacketResult, type WorkbenchPacketCompactResult } from './workbench-packet-results'
import { recordWorkbenchRepairEligibility } from './workbench-repair-state'
import { claimNextWorkbenchPacket, getWorkbenchPacketRecord, releaseWorkbenchPacketLease, renewWorkbenchPacketLease } from './workbench-packet-store'

export const WORKBENCH_PACKET_WORKER_VERSION = 1 as const
const DEFAULT_LEASE_MS = 60_000
const MIN_RENEW_INTERVAL_MS = 5_000

function setRunActivePacket(runId: string, packetId?: string): void {
  const run = getAgentJob(runId)
  if (!run) return
  updateAgentJob(runId, { activePacketId: packetId })
}

function recordWorkbenchPacketResult(
  params: Parameters<typeof persistWorkbenchPacketResult>[0]
): WorkbenchPacketCompactResult {
  const result = persistWorkbenchPacketResult(params)
  const packetRecord = getWorkbenchPacketRecord(result.packetId)
  for (const [validationIndex, validation] of result.validation.entries()) {
    const evidenceRef = validation.evidenceRefs?.[0]?.evidenceId || `${result.packetId}:validation:${validationIndex}`
    const kind = validation.status === 'completed' ? 'validation_completed' : 'validation_failed'
    if (hasPacketValidationActivityEvent({
      jobId: result.runId,
      sourceId: result.sourceId,
      packetId: result.packetId,
      evidenceRef,
      kind
    })) continue
    appendAgentEvent({
      jobId: result.runId,
      sourceId: result.sourceId,
      type: kind,
      activityKind: kind,
      packetId: result.packetId,
      taskId: packetRecord?.packet.taskId,
      commandKind: validation.commandKind,
      status: validation.status,
      evidenceRefs: [{ kind: 'validation', ref: evidenceRef }],
      telemetry: { durationMs: validation.durationMs },
      message: `Packet validation ${validation.commandKind} ${validation.status}`
    })
  }
  if (!['completed', 'failed', 'paused', 'cancelled'].includes(result.status)) return result

  let run = getAgentJob(result.runId)
  if (!run) return result

  // A goal-dispatch packet is the complete bounded goal, not merely one step
  // of the default multi-phase roadmap. Close that run after its packet has
  // been durably persisted so the coordinator cannot schedule another Action
  // round for internal roadmap work.
  if (result.status === 'completed' && packetRecord?.packet.goalDispatch && run.status === 'running') {
    run = updateAgentJob(run.id, {
      status: 'completed',
      activeTaskId: undefined,
      activePacketId: undefined,
      summary: 'The dispatched Workbench goal completed locally with a durable terminal result.',
      nextActions: ['Review the compact terminal result.']
    })
  }

  const failedPacketRecord = result.status === 'failed'
    ? getWorkbenchPacketRecord(result.packetId)
    : undefined
  const repairState = failedPacketRecord && failedPacketRecord.packet.runId === result.runId
    ? recordWorkbenchRepairEligibility({
        runId: result.runId,
        taskId: failedPacketRecord.packet.taskId,
        failedPacketId: result.packetId
      })
    : undefined

  const validationPassed = result.validation.every(item => item.status === 'completed')
  const blocked = run.status === 'blocked' || run.status === 'needs_confirmation' || run.requiresConfirmation
  const repairExhausted = repairState?.status === 'exhausted'
  const outcome = blocked
    ? 'blocked'
    : result.status === 'failed'
      ? repairExhausted ? 'stop' : 'repair'
      : result.status === 'completed' && run.status === 'running' && Boolean(run.activeTaskId)
        ? 'continue'
        : 'stop'
  const nextTaskId = outcome === 'continue'
    ? run.activeTaskId
    : repairExhausted
      ? failedPacketRecord?.packet.taskId
      : undefined
  const reason = outcome === 'continue'
    ? `Packet ${result.packetId} completed; continue with task ${nextTaskId}.`
    : outcome === 'repair'
      ? `Packet ${result.packetId} failed; preserve evidence for one bounded repair decision.`
      : repairExhausted
        ? `Packet ${result.packetId} failed after ${repairState.attemptCount} automatic repair attempt; automatic continuation stopped for task ${nextTaskId}.`
        : outcome === 'blocked'
          ? `Packet ${result.packetId} cannot continue while the run is blocked or awaiting confirmation.`
          : `Packet ${result.packetId} reached ${result.status}; automatic continuation stopped.`

  const decisionEvidence = {
    status: result.status,
    completedSteps: result.completedSteps,
    validationPassed,
    commitHash: result.commitHash,
    errorCodes: result.errors.map(error => error.code)
  }
  const evidenceInstruction = [
    `Continuation ${outcome} after packet ${result.packetId}.`,
    `status=${decisionEvidence.status}`,
    `steps=${decisionEvidence.completedSteps}`,
    `validationPassed=${decisionEvidence.validationPassed}`,
    repairState ? `repairAttempts=${repairState.attemptCount}` : '',
    decisionEvidence.errorCodes.length > 0 ? `errors=${decisionEvidence.errorCodes.join(',')}` : ''
  ].filter(Boolean).join(' ')
  const exhaustedInstructions = repairExhausted && failedPacketRecord && repairState
    ? [
        evidenceInstruction,
        `Automatic repair exhausted for task ${failedPacketRecord.packet.taskId} after ${repairState.attemptCount} attempt.`,
        `Review failed packet ${result.packetId} and exact paths: ${failedPacketRecord.exactPaths.join(', ') || '(none)'}.`,
        `Manual resume: inspect the recorded validation errors, then reserve a new explicit-path packet for task ${failedPacketRecord.packet.taskId}; automatic retry is disabled.`
      ]
    : undefined

  updateAgentJob(run.id, {
    resumeState: {
      ...run.resumeState,
      nextTaskId: nextTaskId || run.resumeState.nextTaskId,
      nextFiles: exhaustedInstructions && failedPacketRecord
        ? failedPacketRecord.exactPaths
        : run.resumeState.nextFiles,
      instructions: exhaustedInstructions || [evidenceInstruction, ...run.resumeState.instructions].slice(0, 4)
    },
    metrics: repairState
      ? {
          ...run.metrics,
          repairAttempts: Math.max(run.metrics.repairAttempts, repairState.attemptCount)
        }
      : run.metrics,
    summary: reason
  })

  recordWorkbenchContinuationDecision({
    runId: result.runId,
    packetId: result.packetId,
    outcome,
    nextTaskId,
    evidence: decisionEvidence,
    reason
  })
  return result
}

export type WorkbenchPacketWorkerCycleResult = {
  workerVersion: typeof WORKBENCH_PACKET_WORKER_VERSION
  workerId: string
  status: 'idle' | 'completed' | 'failed' | 'paused' | 'cancelled' | 'requeued'
  packetId?: string
  runId?: string
  sourceId?: string
  execution?: WorkbenchPacketExecutionResult
  error?: string
}

export async function runNextWorkbenchPacket(params: {
  sourceRootFor: (sourceId: string) => string | undefined
  workerId?: string
  packetId?: string
  sourceId?: string
  runId?: string
  leaseMs?: number
}): Promise<WorkbenchPacketWorkerCycleResult> {
  const workerId = String(params.workerId || `packet-worker-${process.pid}-${crypto.randomUUID()}`).slice(0, 160)
  const leaseMs = Math.max(5_000, Math.min(300_000, Number(params.leaseMs || DEFAULT_LEASE_MS)))
  const claimed = claimNextWorkbenchPacket({
    workerId,
    packetId: params.packetId,
    sourceId: params.sourceId,
    runId: params.runId,
    leaseMs
  })

  if (claimed.ok === false) {
    if (claimed.code === 'PACKET_NOT_FOUND') {
      return { workerVersion: WORKBENCH_PACKET_WORKER_VERSION, workerId, status: 'idle' }
    }
    return {
      workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
      workerId,
      status: 'failed',
      error: `${claimed.code}: ${claimed.message}`
    }
  }

  const record = claimed.record
  const packetId = record.packet.packetId
  const runId = record.packet.runId
  const sourceId = record.packet.sourceId
  setRunActivePacket(runId, packetId)
  const leaseToken = record.leaseToken
  if (!leaseToken) {
    setRunActivePacket(runId)
    return {
      workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
      workerId,
      status: 'failed',
      packetId,
      runId,
      sourceId,
      error: 'Claimed packet did not contain a lease token.'
    }
  }

  appendAgentEvent({
    jobId: runId,
    sourceId,
    type: 'packet_claimed',
    status: 'running',
    message: `Worker ${workerId} claimed packet ${packetId}.`
  })

  const sourceRoot = params.sourceRootFor(sourceId)
  if (!sourceRoot) {
    releaseWorkbenchPacketLease({ packetId, leaseToken, requeue: true })
    setRunActivePacket(runId)
    appendAgentEvent({
      jobId: runId,
      sourceId,
      type: 'packet_failed',
      status: 'queued',
      message: `Packet ${packetId} was requeued because source ${sourceId} is unavailable.`
    })
    recordWorkbenchPacketResult({
      packetId,
      runId,
      sourceId,
      status: 'requeued',
      error: `Source root unavailable: ${sourceId}`
    })
    return {
      workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
      workerId,
      status: 'requeued',
      packetId,
      runId,
      sourceId,
      error: `Source root unavailable: ${sourceId}`
    }
  }

  appendAgentEvent({
    jobId: runId,
    sourceId,
    type: 'packet_started',
    status: 'running',
    message: `Worker ${workerId} started packet ${packetId}.`
  })

  const renewIntervalMs = Math.max(MIN_RENEW_INTERVAL_MS, Math.floor(leaseMs / 2))
  const renewal = setInterval(() => {
    const renewed = renewWorkbenchPacketLease({ packetId, leaseToken, leaseMs })
    if (renewed.ok) {
      appendAgentEvent({
        jobId: runId,
        sourceId,
        type: 'packet_lease_renewed',
        status: 'running',
        message: `Renewed execution lease for packet ${packetId}.`
      })
    }
  }, renewIntervalMs)
  renewal.unref?.()

  try {
    const execution = await executeWorkbenchPacket({
      packetId,
      leaseToken,
      sourceId,
      sourceRoot
    })

    if (execution.status === 'rejected') {
      releaseWorkbenchPacketLease({ packetId, leaseToken, requeue: true })
      appendAgentEvent({
        jobId: runId,
        sourceId,
        type: 'packet_failed',
        status: 'queued',
        message: `Packet ${packetId} was rejected before mutation and requeued.`
      })
      recordWorkbenchPacketResult({
        packetId,
        runId,
        sourceId,
        status: 'requeued',
        execution
      })
      return {
        workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
        workerId,
        status: 'requeued',
        packetId,
        runId,
        sourceId,
        execution
      }
    }

    const eventType = execution.status === 'completed'
      ? 'packet_completed'
      : execution.status === 'paused'
        ? 'packet_paused'
        : execution.status === 'cancelled'
          ? 'packet_cancelled'
          : 'packet_failed'
    appendAgentEvent({
      jobId: runId,
      sourceId,
      type: eventType,
      status: execution.status,
      message: execution.status === 'completed'
        ? `Packet ${packetId} completed with ${execution.completedSteps} verified step(s).`
        : execution.status === 'paused'
          ? `Packet ${packetId} paused after rollback at ${execution.completedSteps} verified step(s).`
          : execution.status === 'cancelled'
            ? `Packet ${packetId} cancelled after rollback at ${execution.completedSteps} verified step(s).`
            : `Packet ${packetId} failed after ${execution.completedSteps} verified step(s).`
    })
    if (execution.status === 'completed' && record.exactPaths.length > 0) {
      appendAgentEvent({
        jobId: runId,
        sourceId,
        type: 'file_changed',
        activityKind: 'file_changed',
        packetId,
        paths: record.exactPaths,
        status: 'completed',
        message: `Packet ${packetId} changed ${record.exactPaths.length} path${record.exactPaths.length === 1 ? '' : 's'}.`
      })
    }
    recordWorkbenchPacketResult({
      packetId,
      runId,
      sourceId,
      status: execution.status,
      execution
    })

    return {
      workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
      workerId,
      status: execution.status,
      packetId,
      runId,
      sourceId,
      execution
    }
  } catch (error) {
    releaseWorkbenchPacketLease({ packetId, leaseToken, requeue: true })
    const message = error instanceof Error ? error.message : String(error)
    appendAgentEvent({
      jobId: runId,
      sourceId,
      type: 'packet_failed',
      status: 'queued',
      message: `Packet ${packetId} worker cycle failed and was requeued: ${message}`
    })
    recordWorkbenchPacketResult({
      packetId,
      runId,
      sourceId,
      status: 'requeued',
      error: message
    })
    return {
      workerVersion: WORKBENCH_PACKET_WORKER_VERSION,
      workerId,
      status: 'requeued',
      packetId,
      runId,
      sourceId,
      error: message
    }
  } finally {
    clearInterval(renewal)
    setRunActivePacket(runId)
  }
}
