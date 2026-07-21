import type { ClaimClient } from './outbound.ts'

/**
 * A claim tool is advertised only after this authenticated read succeeds. The caller
 * supplies a RelayClient with a bounded request timeout, so an unavailable legacy
 * relay cannot delay NATS startup indefinitely or create a phantom capability.
 */
export async function verifyClaimCompatibility<T extends ClaimClient>(client: T): Promise<T> {
  await client.listClaims()
  return client
}
