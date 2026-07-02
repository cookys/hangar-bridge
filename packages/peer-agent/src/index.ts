#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { PERMISSION_REQUEST_TTL_MS, DISPATCH_REQUEST_TIMEOUT_MS } from '@hangar-bridge/shared'
import { createMcpServer } from './mcp-server.ts'
import { loadConfig, loadToken, assertTokenNotInRepo } from './config.ts'
import { readTokenFile } from './cli/token-file.ts'
import { loadRoster } from './subject-acl.ts'
import { RelayClient, type PeerTransport } from './outbound.ts'
import { NatsTransport } from './nats-transport.ts'
import { registerTools, TOOL_DESCRIPTORS, TOOL_DESCRIPTOR_RESPOND, TOOL_DESCRIPTOR_DISPATCH } from './tools.ts'
import { SenderGate } from './gate.ts'
import { InboundDispatcher } from './inbound.ts'
import { StreamClient } from './stream.ts'
import { PermissionTracker, PermissionOutboundTracker } from './permission.ts'
import { DispatchTracker } from './correlation.ts'
import { ApprovalRouter, type RoutingPolicy } from './approval-routing.ts'
import { registerOutboundPermissionRelay } from './permission-relay.ts'
import { ReplyLimiter } from './reply-limiter.ts'
import { defaultDispatchStatePath } from './paths.ts'
import { pathToFileURL } from 'node:url'
import { logJson } from './logger.ts'

async function main(): Promise<void> {
  const cfg = loadConfig()
  let token: string | undefined

  if (cfg.transport === 'sse') {
    assertTokenNotInRepo(cfg.token_path)
    token = loadToken(cfg.token_path)
  }

  const selfHandle = cfg.self ?? ''

  const permissionRelayEnabled = cfg.permission_relay.enabled
  const { server } = createMcpServer({ permissionRelay: permissionRelayEnabled })
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

  let cursor: string | undefined
  const dispatcher = new InboundDispatcher({
    gate,
    emit: n => { void server.notification(n as never) },
    setCursor: id => { cursor = id },
    interest: cfg.subjects.interest,
    permissionTracker,
    dispatchTracker,
    permissionOutboundTracker,
    replyLimiter,
  })

  let client: PeerTransport
  let stream: { start: () => Promise<void> }

  if (cfg.transport === 'nats') {
    if (!selfHandle) throw new Error('self is required when transport is nats')
    if (!cfg.nats) throw new Error(`nats transport requires a nats config block`)
    const nkeySeedPath = cfg.nats.nkey_seed_path
    const rosterPath = cfg.nats.roster_path
    if (!nkeySeedPath) throw new Error(`nats.nkey_seed_path is required when transport is nats`)
    if (!rosterPath) throw new Error(`nats.roster_path is required when transport is nats`)
    const roster = loadRoster(rosterPath)
    const nkeySeed = readTokenFile(nkeySeedPath)
    const natsTransport = new NatsTransport({
      selfHandle,
      natsUrl: cfg.nats.url ?? cfg.relay_url,
      nkeySeed,
      roster,
      // exactOptionalPropertyTypes: only pass inboxPrefix when set (NatsTransport
      // defaults it to `_INBOX.<selfHandle>` otherwise).
      ...(cfg.nats.inbox_prefix ? { inboxPrefix: cfg.nats.inbox_prefix } : {}),
      onEnvelope: e => dispatcher.handle(e),
      onAuthError,
      onOverflow: dropped => {
        logJson('warn', 'peer.nats.outbox_overflow', { dropped })
      },
      reconnectBaseMs: 500,
    })
    client = natsTransport
    stream = natsTransport
  } else {
    if (!token) throw new Error('sse transport requires token_path')
    client = new RelayClient({ relayUrl: cfg.relay_url, token })
    stream = new StreamClient({
      relayUrl: cfg.relay_url,
      token,
      sinceCursor: () => cursor,
      subjects: cfg.subjects.interest,
      onEnvelope: e => dispatcher.handle(e),
      onAuthError,
    })
  }

  const originalSend = client.send.bind(client)
  client.send = async (msg, opts) => {
    if (msg.kind === 'chat' && typeof msg.to === 'string' && msg.to !== '@team') {
      approvalRouter.recordDm(msg.to)
    }
    return originalSend(msg, opts)
  }

  const { callTool } = registerTools(client, cfg.presence, permissionTracker, replyLimiter, dispatchTracker)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...TOOL_DESCRIPTORS,
      ...(permissionRelayEnabled ? [TOOL_DESCRIPTOR_RESPOND] : []),
      TOOL_DESCRIPTOR_DISPATCH,
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
  setInterval(refreshRoster, 60_000)

  await server.connect(new StdioServerTransport())
  await stream.start().catch(err => {
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
