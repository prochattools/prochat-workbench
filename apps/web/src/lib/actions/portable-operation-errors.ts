export type PortableOperationErrorCode =
  | 'invalid_request'
  | 'unknown_operation'
  | 'source_mismatch'
  | 'session_invalid'
  | 'confirmation_required'
  | 'invalid_confirmation'
  | 'stale_head'
  | 'protected_path_rejected'
  | 'deadline_exceeded'
  | 'cancelled'
  | 'dependency_unavailable'
  | 'policy_rejected'
  | 'command_failed'
  | 'internal_error'

export class PortableOperationError extends Error {
  readonly code: PortableOperationErrorCode
  readonly details?: Record<string, unknown>
  readonly retryable?: boolean
  readonly requiresConfirmation?: boolean
  readonly confirmationToken?: string

  constructor(code: PortableOperationErrorCode, message: string, options: {
    details?: Record<string, unknown>
    retryable?: boolean
    requiresConfirmation?: boolean
    confirmationToken?: string
  } = {}) {
    super(message)
    this.name = 'PortableOperationError'
    this.code = code
    this.details = options.details
    this.retryable = options.retryable
    this.requiresConfirmation = options.requiresConfirmation
    this.confirmationToken = options.confirmationToken
  }
}

export function classifyPortableOperationError(error: unknown): PortableOperationError {
  if (error instanceof PortableOperationError) return error
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  if (normalized.includes('source mismatch') || (normalized.includes('source') && (normalized.includes('mismatch') || normalized.includes('does not match')))) {
    return new PortableOperationError('source_mismatch', message)
  }
  if (normalized.includes('session')) return new PortableOperationError('session_invalid', message)
  if (normalized.includes('confirmation')) return new PortableOperationError('invalid_confirmation', message)
  if (normalized.includes('stale') && normalized.includes('head')) return new PortableOperationError('stale_head', message)
  if (normalized.includes('protected')) return new PortableOperationError('protected_path_rejected', message)
  if (normalized.includes('timeout') || normalized.includes('deadline')) return new PortableOperationError('deadline_exceeded', message, { retryable: false })
  if (normalized.includes('cancel')) return new PortableOperationError('cancelled', message, { retryable: false })
  if (normalized.includes('unavailable')) return new PortableOperationError('dependency_unavailable', message, { retryable: true })
  return new PortableOperationError('internal_error', message)
}
