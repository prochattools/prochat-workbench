import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCodexProviderStatus } from './codex-provider-status'

test('rate-limit fixture selects Direct fallback without launching Codex', () => {
  assert.deepEqual(projectCodexProviderStatus({ fixture: 'rate_limited', directCapability: true }), {
    provider: 'codex',
    availability: 'rate_limited',
    checked: true,
    fallback: 'direct',
    reason: 'deterministic fixture: provider rate limit'
  })
})

test('unknown production status does not claim Codex availability', () => {
  const status = projectCodexProviderStatus({ directCapability: true })
  assert.equal(status.availability, 'unknown')
  assert.equal(status.checked, false)
  assert.equal(status.fallback, 'direct')
})
