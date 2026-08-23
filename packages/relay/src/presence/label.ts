import { isValidInstanceId } from '@hangar-bridge/shared'

/**
 * The SINGLE label resolver (plan §2.1 / rubric R5).
 *
 * Both `POST /v1/presence` (which WRITES the presence row) and the SSE
 * cleanup path (which DELETES it) must derive the same key, or a disconnect
 * deletes a row nobody wrote — or worse, a row another live process owns.
 * Keeping the derivation in one function is what makes that guarantee
 * checkable instead of a convention.
 *
 * Legacy fallback: a client that sends no instance keeps EXACTLY the current
 * behavior (bare token label). Because registry.remove is an exact-match
 * delete, a legacy key and an instance-bearing key can never cross-delete.
 */
export function effectiveLabel(tokenLabel: string, instance: string | null | undefined): string {
  return instance ? `${tokenLabel}#${instance}` : tokenLabel
}

export type InstanceParse = { ok: true; instance: string | undefined } | { ok: false }

/**
 * Validate a client-supplied instance id before it is composed into a row key.
 * An absent/empty value is the legacy path (not an error); anything present but
 * malformed is rejected rather than embedded, so the '#' separator stays
 * unambiguous and an attacker-controlled string never becomes a map key.
 */
export function parseInstanceHeader(raw: string | null | undefined): InstanceParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, instance: undefined }
  if (!isValidInstanceId(raw)) return { ok: false }
  return { ok: true, instance: raw }
}
