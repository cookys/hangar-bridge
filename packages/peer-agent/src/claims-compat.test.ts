import { describe, expect, it, vi } from 'vitest'
import { verifyClaimCompatibility } from './claims-compat.ts'

describe('verifyClaimCompatibility', () => {
  it('returns the client only after an authenticated list probe succeeds', async () => {
    const client = {
      listClaims: vi.fn(async () => []),
      claim: vi.fn(),
      releaseClaim: vi.fn(),
    }
    await expect(verifyClaimCompatibility(client)).resolves.toBe(client)
    expect(client.listClaims).toHaveBeenCalledOnce()
  })

  it('rejects invalid/unreachable compatibility credentials', async () => {
    const client = {
      listClaims: vi.fn(async () => { throw new Error('listClaims failed: 401') }),
      claim: vi.fn(),
      releaseClaim: vi.fn(),
    }
    await expect(verifyClaimCompatibility(client)).rejects.toThrow(/401/)
  })
})
