import { z } from 'zod'
import type { OutboundMessage } from '@hangar-bridge/shared'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { ApprovalRouter } from './approval-routing.ts'
import type { RelayClient } from './outbound.ts'
import type { PermissionOutboundTracker } from './permission.ts'
import { logJson } from './logger.ts'

/**
 * OUTBOUND permission relay — the Claude Code → peer-agent → peer path.
 *
 * When this Claude's own tool call needs approval and this peer-agent declared the
 * `claude/channel/permission` capability, Claude Code sends the peer-agent a
 * `notifications/claude/channel/permission_request` notification (client→server;
 * same method name the peer-agent EMITS server→client for INBOUND peer requests, but
 * the reverse direction — see channels-reference "Relay permission prompts").
 *
 * This module turns that notification into an outbound `permission_request` envelope
 * to the peer chosen by the ApprovalRouter. The verdict returns as a
 * `permission_verdict` envelope which inbound.ts already maps back to a
 * `notifications/claude/channel/permission` notification, so Claude Code applies it.
 *
 * Security model (channels-reference + instructions.ts charter):
 *  - Claude Code keeps the LOCAL terminal dialog open the whole time; this relay runs
 *    in PARALLEL. Whichever answer arrives first wins and the other is dropped
 *    (first-answer-wins is Claude Code's own behaviour — we never close the local
 *    dialog and never synthesize a verdict here).
 *  - We NEVER auto-approve. This path only FORWARDS a request; the actual verdict is
 *    still authored by a human (the peer's local user via respond_to_permission, or
 *    this box's own local dialog).
 *  - Gated: only wired when permission_relay.enabled (capability declared) AND the
 *    ApprovalRouter policy actually picks a peer (never_relay ⇒ no relay).
 */

export const OutboundPermissionRequestNotificationSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),     // five lowercase letters [a-km-z]; echoed back in the verdict
    tool_name: z.string(),      // e.g. "Bash", "Write"
    description: z.string(),     // human-readable summary of this call
    input_preview: z.string(),  // tool args as JSON, truncated to ~200 chars by Claude Code
  }),
})

export type OutboundPermissionRequestParams =
  z.infer<typeof OutboundPermissionRequestNotificationSchema>['params']

/**
 * Build the outbound `permission_request` envelope for one target. Pure + exported so
 * the meta shape is unit-testable without a live relay. Mirrors the meta the L3
 * permission scenario asserts: {request_id, tool_name, input_preview, requester,
 * expires_at}. `content` carries the human-readable description (the receiving peer's
 * channel serializer surfaces it as the prompt `description`).
 */
export function buildOutboundPermissionRequest(
  params: OutboundPermissionRequestParams,
  to: string,
  requester: string,
  expiresAtIso: string,
): OutboundMessage {
  const meta: Record<string, string> = {
    request_id: params.request_id.toLowerCase(),
    tool_name: params.tool_name,
    input_preview: params.input_preview,
    expires_at: expiresAtIso,
  }
  if (requester) meta.requester = requester
  return {
    to,
    subject: null,
    kind: 'permission_request',
    content: params.description,
    meta,
  }
}

export interface OutboundPermissionRelayDeps {
  client: Pick<RelayClient, 'send'>
  approvalRouter: ApprovalRouter
  /** This peer's own handle, so ask_specific_peer:<self> never relays to itself. */
  selfHandle: string
  /** How long the relayed request stays valid (mirrors PERMISSION_REQUEST_TTL_MS). */
  ttlMs: number
  /**
   * SEC-M1: records the authorized responder set per request_id so the inbound verdict
   * path can reject a verdict from a peer we did NOT ask. Wired in production; optional
   * so pure routing-gate tests can omit it.
   */
  outboundTracker?: Pick<PermissionOutboundTracker, 'recordRelay' | 'revoke'> | undefined
  now?: () => Date
}

/**
 * Core relay logic, decoupled from the MCP transport for testing. Returns the peers
 * the request was relayed to (empty ⇒ policy declined to relay, local dialog only).
 */
export function makeOutboundPermissionHandler(deps: OutboundPermissionRelayDeps) {
  const now = deps.now ?? (() => new Date())
  return async function relay(params: OutboundPermissionRequestParams): Promise<{ relayedTo: string[] }> {
    // SEC-M2: without a known self handle we cannot prove a picked target isn't
    // ourselves (self-exclusion fails OPEN on the empty string). Fail closed — relay to
    // nobody; the local terminal dialog still resolves the prompt. init.ts writes
    // `self`; only a pre-`self` config reaches here, and re-init/adding `self` re-enables.
    if (!deps.selfHandle) {
      logJson('warn', 'peer.permission.relay_disabled', { request_id: params.request_id, reason: 'self_handle_unknown' })
      return { relayedTo: [] }
    }
    const picked = deps.approvalRouter.pick({ excludeSelf: deps.selfHandle })
    if (!picked || picked.length === 0) return { relayedTo: [] }
    // Defense in depth beyond ApprovalRouter: never relay a permission request to self.
    const targets = picked.filter(t => t !== deps.selfHandle)
    if (targets.length === 0) return { relayedTo: [] }
    // SEC-M1: record the authorized responder set BEFORE sending, so a verdict that
    // races back over SSE can never arrive before we've recorded who is allowed to answer.
    deps.outboundTracker?.recordRelay(params.request_id, targets)
    const expiresAt = new Date(now().getTime() + deps.ttlMs).toISOString()
    // Per-peer resilience: a failed send to one target must not abort the rest (matters
    // if a policy ever picks multiple concrete peers). A target we authorized but failed
    // to reach simply won't answer — harmless, since it never received the request_id.
    const relayed: string[] = []
    for (const to of targets) {
      try {
        await deps.client.send(buildOutboundPermissionRequest(params, to, deps.selfHandle, expiresAt))
        relayed.push(to)
      } catch (err) {
        // "actually relayed" invariant: we recorded this target BEFORE sending (race
        // safety), so if the send FAILED we must revoke it — a peer we never reached
        // must not stay authorized to apply a later verdict. If every target fails the
        // request_id's set empties out → any verdict is then fail-closed dropped.
        deps.outboundTracker?.revoke(params.request_id, to)
        logJson('warn', 'peer.permission.relay_send_error', {
          request_id: params.request_id, to, err: String(err instanceof Error ? err.message : err),
        })
      }
    }
    return { relayedTo: relayed }
  }
}

/**
 * Wire the outbound relay onto the MCP server's notification handler. A relay failure
 * (e.g. relay down) is logged, not thrown — it must not kill the notification pipeline
 * or the local permission dialog.
 */
export function registerOutboundPermissionRelay(server: Server, deps: OutboundPermissionRelayDeps): void {
  const relay = makeOutboundPermissionHandler(deps)
  server.setNotificationHandler(OutboundPermissionRequestNotificationSchema, async ({ params }) => {
    try {
      const { relayedTo } = await relay(params)
      if (relayedTo.length > 0) {
        logJson('info', 'peer.permission.relayed', { request_id: params.request_id, to: relayedTo.join(',') })
      } else {
        logJson('info', 'peer.permission.relay_skipped', { request_id: params.request_id, reason: 'no_target' })
      }
    } catch (err) {
      logJson('error', 'peer.permission.relay_error', {
        request_id: params.request_id,
        err: String(err instanceof Error ? err.message : err),
      })
    }
  })
}
