export type CodexProviderAvailability = 'available' | 'rate_limited' | 'unavailable' | 'unknown'

export type CodexProviderStatus = {
  provider: 'codex'
  availability: CodexProviderAvailability
  checked: boolean
  fallback: 'direct' | 'governed' | 'none'
  reason: string
}

export type CodexProviderStatusInput = {
  fixture?: CodexProviderAvailability
  executablePresent?: boolean
  authenticated?: boolean
  directCapability?: boolean
}

/**
 * Pure status projection.  The fixture input is intentionally explicit so
 * tests can exercise rate-limit fallback without consuming a real quota or
 * launching a provider process.  Production callers may only claim
 * availability when they have authoritative evidence; otherwise status is
 * unknown and the governed path remains the safe choice.
 */
export function projectCodexProviderStatus(input: CodexProviderStatusInput = {}): CodexProviderStatus {
  const fallback = input.directCapability === true ? 'direct' : 'governed'
  if (input.fixture) {
    return {
      provider: 'codex',
      availability: input.fixture,
      checked: true,
      fallback: input.fixture === 'available' ? 'none' : fallback,
      reason: input.fixture === 'rate_limited' ? 'deterministic fixture: provider rate limit' : `deterministic fixture: ${input.fixture}`
    }
  }
  if (input.executablePresent === false) return { provider: 'codex', availability: 'unavailable', checked: true, fallback, reason: 'provider executable is unavailable' }
  if (input.authenticated === false) return { provider: 'codex', availability: 'unavailable', checked: true, fallback, reason: 'provider authentication is unavailable' }
  return { provider: 'codex', availability: 'unknown', checked: false, fallback, reason: 'provider availability is determined by the governed dispatch boundary' }
}
