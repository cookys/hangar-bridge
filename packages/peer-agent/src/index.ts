#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  PERMISSION_REQUEST_TTL_MS, DISPATCH_REQUEST_TIMEOUT_MS, PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_MS, newInstanceId,
} from '@hangar-bridge/shared'
import { createMcpServer } from './mcp-server.ts'
import { loadConfig, loadToken, assertTokenNotInRepo, assertSecretFilePrivate } from './config.ts'
import { readTokenFile } from './cli/token-file.ts'
import { loadRoster } from './subject-acl.ts'
import { RelayClient, type ClaimClient, type InboxClient, type PeerTransport } from './outbound.ts'
import { NatsTransport } from './nats-transport.ts'
import { createNatsAuditWriter } from './audit-log.ts'
import {
  registerTools, resolveInboxClient, buildPresenceBody, peerCaps,
  TOOL_DESCRIPTORS, TOOL_DESCRIPTORS_CLAIMS, TOOL_DESCRIPTOR_RESPOND,
  TOOL_DESCRIPTOR_POLL_INBOX, dispatchToolDescriptor,
} from './tools.ts'
import { detectWorkingContext } from './roots.ts'
import { SenderGate } from './gate.ts'
import { InboundDispatcher } from './inbound.ts'
import { checkChannelsFlag, checkChannelCapability } from './deaf-check.ts'
import {
  HealthState, resolveFinalMileHealth, shouldClearPersistedDeafState, withOutboundHealth,
} from './health-state.ts'
import { createPresenceTracker } from './presence-tracker.ts'
import { StreamClient } from './stream.ts'
import { PermissionTracker, PermissionOutboundTracker } from './permission.ts'
import { DispatchTracker } from './correlation.ts'
import { ApprovalRouter, type RoutingPolicy } from './approval-routing.ts'
import { registerOutboundPermissionRelay } from './permission-relay.ts'
import { ReplyLimiter } from './reply-limiter.ts'
import { defaultDispatchStatePath, defaultCursorStatePath, defaultHealthStatePath } from './paths.ts'
import { CursorStore, cursorSink } from './cursor-store.ts'
import { installLifecycleShutdown } from './lifecycle.ts'
import { FileNatsInstanceGuard } from './nats-instance-lock.ts'
import { verifyClaimCompatibility } from './claims-compat.ts'
import { pathToFileURL } from 'node:url'
import { logJson } from './logger.ts'
import { deliverViaAgentCall } from './agent-call-ingress.ts'

async function main(): Promise<void> {
  const cfg = loadConfig()
  let token: string | undefined
  let claimClient: ClaimClient | undefined

  if (cfg.transport === 'sse') {
    assertTokenNotInRepo(cfg.token_path)
    token = loadToken(cfg.token_path)
  } else {
    // During the reversible NATS cutover (P5), the relay remains available. Reuse
    // its authenticated coordination API for claim_asset/list_claims/release_claim
    // when the legacy token is still present, without making NATS transport startup
    // depend on that optional compatibility path. P6 must port or retire claims
    // before the relay can be deleted.
    try {
      assertTokenNotInRepo(cfg.token_path)
      const candidate = new RelayClient({
        relayUrl: cfg.relay_url,
        token: loadToken(cfg.token_path),
        requestTimeoutMs: 1_500,
      })
      // Tool advertisement is a capability promise. Prove both reachability and
      // authentication with a bounded, read-only request before exposing claim tools.
      claimClient = await verifyClaimCompatibility(candidate)
    } catch (err) {
      logJson('warn', 'peer.claims.unavailable', describeError(err))
    }
  }

  const selfHandle = cfg.self ?? ''

  // ONE instance id for the whole process (P2 §2.1). Generated here — not per
  // connection — so the relay's per-(label, instance) connection refcount can
  // aggregate every SSE reconnect this process makes. It is presence/observability
  // only: nothing addresses a peer by instance (no `to_instance`).
  const instanceId = newInstanceId()
  const healthStatePath = defaultHealthStatePath(
    process.env.CLAUDE_CODE_SESSION_ID ?? instanceId,
  )
  // FIX4: mutated once inboxClient resolves below (line ~228 wiring), before
  // any presence write actually fires — presenceIdentity/decorated setPresence
  // are closures invoked only after that point (stream.start(), heartbeats).
  // Declaring it here — rather than a hardcoded caps string — is what stops a
  // NATS-only peer with no relay compatibility client from advertising
  // poll_inbox when the tool isn't even registered (index.ts §ListTools).
  let inboxAvailable = false
  const presenceIdentity = () => ({
    instance: instanceId,
    delivery_state: health.deliveryState(),
    caps: peerCaps(inboxAvailable),
  })

  // P0 deaf-immunity: walk /proc ancestry for the claude process and verify its
  // channels flag names OUR mcp config key (HANGAR_MCP_KEY, plumbed by every
  // registration path). A missing or mismatched flag means the client silently
  // drops every inbound notification — the failure mode this fleet ran under for
  // two months. Fail-open: non-Claude harness / unreadable /proc / unknown key ⇒
  // skip. Runs BEFORE transport wiring so the FIRST presence report already
  // carries the delivery_state.



  const permissionRelayEnabled = cfg.permission_relay.enabled
  const { server, capabilities } = createMcpServer({ permissionRelay: permissionRelayEnabled })

  // Two independent deafness modes; either one silences inbound entirely.
  // Mode 2 is checked first because it is decidable with certainty (we are
  // inspecting our own declaration), whereas the flag walk fails open.
  const deafCheck = resolveFinalMileHealth(cfg.final_mile.kind, () => {
    const capabilityCheck = checkChannelCapability(capabilities)
    return capabilityCheck.state === 'deaf'
      ? capabilityCheck
      : checkChannelsFlag({ mcpKey: process.env.HANGAR_MCP_KEY })
  })
  // P4'c: deafness needs a FIRST-detected timestamp that survives restarts, or
  // deaf_since resets every boot and the two-months/five-minutes distinction dies.
  let deafSinceMs: number | undefined
  if (deafCheck.state === 'deaf') {
    try {
      const raw = JSON.parse(readFileSync(healthStatePath, 'utf8')) as { deaf_since_ms?: number }
      deafSinceMs = typeof raw.deaf_since_ms === 'number' ? raw.deaf_since_ms : undefined
    } catch { /* fail-open: first detection, or unreadable state */ }
    if (deafSinceMs === undefined) {
      deafSinceMs = Date.now()
      try {
        writeFileSync(healthStatePath, JSON.stringify({ deaf_since_ms: deafSinceMs }), { mode: 0o600 })
      } catch { /* best-effort: an unwritable config dir must not block startup */ }
    }
  } else if (shouldClearPersistedDeafState(deafCheck)) {
    // Recovered: clear the stamp so a future deafness starts its own clock.
    try { rmSync(healthStatePath, { force: true }) } catch { /* best-effort */ }
  }
  const health = new HealthState(deafCheck, deafSinceMs)

  if (health.isDeaf()) {
    logJson('error', 'peer.startup.deaf_suspected', { reason: deafCheck.reason })
    process.stderr.write(
      `\n[hangar-bridge] DEAF SESSION SUSPECTED: ${deafCheck.reason}\n` +
      `[hangar-bridge] Restart with: claude --dangerously-load-development-channels server:${process.env.HANGAR_MCP_KEY} --resume <name>\n\n`
    )
  } else {
    logJson('info', 'peer.startup.channels_check', { state: deafCheck.state, reason: deafCheck.reason })
  }


  const permissionTracker = permissionRelayEnabled
    ? new PermissionTracker({ ttlMs: PERMISSION_REQUEST_TTL_MS })
    : undefined
  // SEC-M1: outbound relay-target authorization for inbound permission_verdicts.
  const permissionOutboundTracker = permissionRelayEnabled
    ? new PermissionOutboundTracker({ ttlMs: PERMISSION_REQUEST_TTL_MS })
    : undefined
  const dispatchTracker = new DispatchTracker({
    ttlMs: DISPATCH_REQUEST_TIMEOUT_MS,
    persistPath: defaultDispatchStatePath(),
  })
  const approvalRouter = new ApprovalRouter({ routing: cfg.permission_relay.routing as RoutingPolicy })
  const replyLimiter = new ReplyLimiter({ windowMs: 10_000, maxReplies: 2 })

  const gate = new SenderGate([])
  const onAuthError = () => {
    logJson('error', 'peer.auth_failed')
    process.exit(2)
  }

  // P3: the resume cursor is durable. A restart now resumes with `?since=`
  // (id-cursor only) instead of the lossy cold-start `delivered_at IS NULL`
  // drain — the relay stamps delivered_at at socket-write time, so a relay
  // killed mid-drain would otherwise silently strand rows for this client.
  const cursorStore = new CursorStore({ persistPath: defaultCursorStatePath() })
  // FIX2: the durable cursor file is SSE-only (see cursor-store.ts doc on
  // cursorSink). Deriving the sink from cfg.transport HERE — before the
  // transport-specific block below constructs the actual client/stream —
  // keeps a NATS-selected process from ever persisting a NATS message id
  // into the SSE resume cursor.
  // AC7: the SSE/relay lane delivers presence_update heartbeats through the
  // dispatcher; this tracker records peer liveness while the dispatcher swallows
  // the heartbeat instead of waking the MCP host. (NATS keeps its own tracker at
  // the wire layer.)
  const presenceTracker = createPresenceTracker(PRESENCE_TTL_MS)
  const dispatcher = new InboundDispatcher({
    gate,
    emit: async (notification, envelope) => {
      if (cfg.final_mile.kind === 'claude-channel') {
        await server.notification(notification as never)
        return
      }
      const receipt = await deliverViaAgentCall(envelope, {
        target: cfg.final_mile.target,
        bin: cfg.final_mile.bin,
      })
      logJson('info', 'peer.inbound.agent_call_accepted', {
        msg_id: envelope.id,
        target: cfg.final_mile.target,
        receipt_status: receipt.status,
      })
    },
    setCursor: cursorSink(cfg.transport, cursorStore),
    interest: cfg.subjects.interest,
    permissionTracker,
    dispatchTracker,
    permissionOutboundTracker,
    replyLimiter,
    presenceTracker,
    finalMileKind: cfg.final_mile.kind,
    acceptBroadcast: cfg.final_mile.kind === 'agent-call' ? cfg.final_mile.accept_broadcast : false,
  })

  let client: PeerTransport
  let stream: { start: () => Promise<void>; stop: () => void | Promise<void> }

  if (cfg.transport === 'nats') {
    if (!selfHandle) throw new Error('self is required when transport is nats')
    if (!cfg.nats) throw new Error(`nats transport requires a nats config block`)
    const nkeySeedPath = cfg.nats.nkey_seed_path
    const rosterPath = cfg.nats.roster_path
    if (!nkeySeedPath) throw new Error(`nats.nkey_seed_path is required when transport is nats`)
    if (!rosterPath) throw new Error(`nats.roster_path is required when transport is nats`)
    const roster = loadRoster(rosterPath)
    assertTokenNotInRepo(nkeySeedPath)
    assertSecretFilePrivate(nkeySeedPath, 'NKey seed')
    const nkeySeed = readTokenFile(nkeySeedPath)
    const natsTransport = new NatsTransport({
      selfHandle,
      instance: instanceId,
      natsUrl: cfg.nats.url ?? cfg.relay_url,
      nkeySeed,
      roster,
      // exactOptionalPropertyTypes: only pass inboxPrefix when set (NatsTransport
      // defaults it to `_INBOX.<selfHandle>` otherwise).
      ...(cfg.nats.inbox_prefix ? { inboxPrefix: cfg.nats.inbox_prefix } : {}),
      onEnvelope: e => dispatcher.handle(e),
      onAuthError,
      auditWriter: createNatsAuditWriter(cfg.audit_log),
      instanceGuard: new FileNatsInstanceGuard(selfHandle),
      reconnectBaseMs: 500,
    })
    client = natsTransport
    stream = natsTransport
  } else {
    if (!token) throw new Error('sse transport requires token_path')
    const relayClient = new RelayClient({
      relayUrl: cfg.relay_url,
      token,
      instance: instanceId,
      attributionVersion: 'v1',
    })
    client = relayClient
    claimClient = relayClient

    // Auto-report presence on every (re)connect and on a heartbeat, so
    // list_peers.online reflects the live SSE connection without requiring an
    // explicit set_summary call. The NATS transport owns its separate heartbeat.
    let lastSummary = '(connected)'
    const originalSetPresence = relayClient.setPresence.bind(relayClient)
    relayClient.setPresence = async body => {
      if (body.summary) lastSummary = body.summary
      // Single-builder rule (P0/P2): the DEAF marker, the instance id and the
      // delivery_state ride on EVERY presence write — connect, heartbeat, and
      // explicit set_summary — so none of them can be washed out by the next
      // 30s heartbeat, and the row key never changes mid-process.
      const decorated = {
        ...body,
        summary: health.decorateSummary(body.summary ?? lastSummary),
        instance: instanceId,
        delivery_state: health.deliveryState(),
        caps: peerCaps(inboxAvailable),
      }
      return originalSetPresence(decorated)
    }
    const reportPresence = async () => {
      try {
        await relayClient.setPresence(buildPresenceBody(
          cfg.presence, lastSummary, detectWorkingContext(), presenceIdentity(),
        ))
      } catch (err) {
        logJson('warn', 'peer.presence.auto_report_error', describeError(err))
      }
    }

    stream = new StreamClient({
      relayUrl: cfg.relay_url,
      token,
      sinceCursor: () => cursorStore.get(),
      subjects: cfg.subjects.interest,
      onEnvelope: async e => { await dispatcher.handle(e) },
      onAuthError,
      onConnect: reportPresence,
      heartbeatMs: PRESENCE_HEARTBEAT_MS,
      instanceId,
      // A message the final mile refused three times is skipped, not replayed
      // forever: advance the cursor past it (it stays readable via poll_inbox)
      // and stamp the presence summary so the fleet can see this peer is
      // refusing, instead of reading "(connected)" while nothing arrives.
      onGiveUp: e => {
        cursorSink(cfg.transport, cursorStore)(e.id)
        health.noteFinalMileGaveUp()
        void reportPresence()
      },
    })
  }

  const originalSend = client.send.bind(client)
  client.send = async (msg, opts) => {
    if (msg.kind === 'chat' && typeof msg.to === 'string' && msg.to !== '@team') {
      approvalRouter.recordDm(msg.to)
    }
    // Single-builder rule, outbound edition (P4'c): apply at the common
    // PeerTransport boundary so SSE and NATS cannot diverge.
    return originalSend(withOutboundHealth(msg, health), opts)
  }

  // The relay's durable buffer is what backs poll_inbox. On SSE that is the
  // transport itself; during the NATS cutover it is the relay compatibility
  // client, if one authenticated. Advertise the tool only when something can
  // actually serve it.
  const inboxClient = resolveInboxClient(client, claimClient as unknown as InboxClient | undefined)
  inboxAvailable = Boolean(inboxClient)
  const { callTool } = registerTools(
    client, cfg.presence, permissionTracker, replyLimiter, dispatchTracker, claimClient, inboxClient,
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...TOOL_DESCRIPTORS,
      ...(inboxClient ? [TOOL_DESCRIPTOR_POLL_INBOX] : []),
      ...(claimClient ? TOOL_DESCRIPTORS_CLAIMS : []),
      ...(permissionRelayEnabled ? [TOOL_DESCRIPTOR_RESPOND] : []),
      dispatchToolDescriptor(client),
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    try { return await callTool(req.params.name, req.params.arguments ?? {}) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }
    }
  })

  // OUTBOUND permission relay (Claude Code → peer). Only wired when permission_relay is
  // enabled — same gate as the `claude/channel/permission` capability, so Claude Code
  // won't even send these notifications otherwise. The ApprovalRouter is a second gate:
  // routing=never_relay (the default) picks no peer, so nothing is forwarded and the
  // local dialog stays the sole authority.
  if (permissionRelayEnabled) {
    registerOutboundPermissionRelay(server, {
      client,
      approvalRouter,
      selfHandle,
      ttlMs: PERMISSION_REQUEST_TTL_MS,
      outboundTracker: permissionOutboundTracker,
    })
  }

  logJson('info', 'peer.startup', { relay_url: cfg.relay_url })

  // Seed the roster. Failing here used to crash the peer-agent hard, breaking
  // every Claude Code session if transport is down. Now: start
  // with an empty roster, let the refresh loop recover once transport starts.
  const refreshRoster = async () => {
    try {
      const peers = await client.listPeers()
      gate.setRoster(peers.map(p => p.handle))
      logJson('info', 'peer.roster.refreshed', { count: peers.length })
    } catch (err) {
      logJson('warn', 'peer.roster.refresh_error', describeError(err))
    }
  }
  void refreshRoster()
  // unref so this background timer never keeps the event loop alive on its own —
  // the process should live and die with its stdio parent, not with this timer.
  const rosterTimer = setInterval(refreshRoster, 60_000)
  rosterTimer.unref?.()

  await server.connect(new StdioServerTransport())
  // Exit with the stdio parent (Claude Code). Without this the process orphans on
  // parent death and keeps a stale transport connection alive under the same handle,
  // which makes presence flap between duplicates. Works for both the SSE and NATS
  // transports (both expose start()/stop()). See lifecycle.ts.
  installLifecycleShutdown({
    cleanup: () => { clearInterval(rosterTimer); void stream.stop() },
    onShutdown: reason => logJson('info', 'peer.shutdown', { reason }),
  })
  stream.start().catch(err => {
    logJson('error', 'peer.stream.fatal', {
      err: String(err instanceof Error ? err.message : err),
    })
    process.exit(1)
  })
}

function describeError(err: unknown): Record<string, string> {
  if (!(err instanceof Error)) return { err: String(err) }
  const out: Record<string, string> = { err: err.message, name: err.name }
  const anyErr = err as { code?: unknown; cause?: unknown }
  if (typeof anyErr.code === 'string') out.code = anyErr.code
  if (anyErr.cause instanceof Error) {
    out.cause_message = anyErr.cause.message
    out.cause_name = anyErr.cause.name
    const anyCause = anyErr.cause as { code?: unknown; address?: unknown; port?: unknown }
    if (typeof anyCause.code === 'string') out.cause_code = anyCause.code
    if (typeof anyCause.address === 'string') out.cause_address = anyCause.address
    if (typeof anyCause.port === 'number') out.cause_port = String(anyCause.port)
  } else if (anyErr.cause !== undefined) {
    out.cause = String(anyErr.cause)
  }
  return out
}

const invokedAsScript = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href
if (invokedAsScript) {
  main().catch(err => {
    logJson('error', 'peer.fatal', describeError(err))
    process.exit(1)
  })
}
