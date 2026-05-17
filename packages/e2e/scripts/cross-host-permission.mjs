#!/usr/bin/env node
// Cross-host permission-relay e2e helper. Same shape as cross-host-peer.mjs
// but covers the permission_request → permission_verdict round-trip rather
// than task_dispatch → task_result.
//
// Two roles:
//   --role requester  emits permission_request, waits for permission_verdict
//   --role approver   waits for permission_request, calls /v1/permission/respond
//
// Common args: --relay --secret-path --self --remote [--timeout-ms N]
// Requester extra: --request-id <5 chars from [a-km-z]> --tool <name>
//                  --input-preview <str>
// Approver extra: --verdict allow|deny [--reason <str>]

import { readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'

function parseArgs(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a?.startsWith('--')) {
      const k = a.slice(2)
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'
      out[k] = v
    }
  }
  return out
}

function emit(phase, fields) {
  console.log(JSON.stringify({ phase, t: new Date().toISOString(), ...fields }))
}

async function postMessage(relayUrl, token, body, idemKey) {
  const res = await fetch(new URL('/v1/messages', relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idemKey.toLowerCase(),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status !== 201) throw new Error(`POST /v1/messages ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function postRespond(relayUrl, token, body) {
  const res = await fetch(new URL('/v1/permission/respond', relayUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status !== 200) throw new Error(`POST /v1/permission/respond ${res.status}: ${text}`)
  return JSON.parse(text)
}

async function* streamEnvelopes(relayUrl, token, signal) {
  const res = await fetch(new URL('/v1/stream', relayUrl), {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    signal,
  })
  if (res.status !== 200 || !res.body) throw new Error(`GET /v1/stream ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      let event = 'message'
      const dataParts = []
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataParts.push(line.slice(5).replace(/^ /, ''))
      }
      if (event !== 'message' || dataParts.length === 0) continue
      try { yield JSON.parse(dataParts.join('\n')) } catch { /* ignore parse error */ }
    }
  }
}

async function runRequester(opts) {
  const token = readFileSync(opts['secret-path'], 'utf8').trim()
  const requestId = (opts['request-id'] ?? 'abcde').toLowerCase()
  if (!/^[a-km-z]{5}$/.test(requestId)) {
    throw new Error(`request-id "${requestId}" violates /^[a-km-z]{5}$/ — 'l' excluded`)
  }
  emit('requester.start', { self: opts.self, remote: opts.remote, request_id: requestId })

  const ctrl = new AbortController()
  const timeoutMs = Number(opts['timeout-ms'] ?? 30_000)
  const timer = setTimeout(() => ctrl.abort(new Error('requester timeout')), timeoutMs)

  const sendPromise = postMessage(opts.relay, token, {
    to: opts.remote,
    kind: 'permission_request',
    content: opts['input-preview'] ?? 'rm -rf dist/',
    meta: {
      request_id: requestId,
      tool_name: opts.tool ?? 'Bash',
      input_preview: opts['input-preview'] ?? 'rm -rf dist/',
      requester: opts.self,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  }, requestId).then(env => {
    emit('requester.sent', { msg_id: env.id, request_id: requestId, delivered_at: env.delivered_at })
    return env
  })

  try {
    let sent = false
    for await (const env of streamEnvelopes(opts.relay, token, ctrl.signal)) {
      if (!sent) { await sendPromise; sent = true }
      if (env.kind === 'permission_verdict' && env.meta?.request_id === requestId) {
        emit('requester.received_verdict', {
          msg_id: env.id, from: env.from,
          request_id: env.meta.request_id,
          behavior: env.meta.behavior,
          reason: env.meta.reason ?? '',
        })
        clearTimeout(timer); ctrl.abort(); return
      }
    }
  } finally {
    clearTimeout(timer)
  }
  throw new Error('requester exited without seeing matching verdict')
}

async function runApprover(opts) {
  const token = readFileSync(opts['secret-path'], 'utf8').trim()
  const verdict = (opts.verdict ?? 'allow').toLowerCase()
  if (!['allow', 'deny'].includes(verdict)) throw new Error(`--verdict must be allow|deny`)
  emit('approver.start', { self: opts.self, remote: opts.remote, verdict })

  const ctrl = new AbortController()
  const timeoutMs = Number(opts['timeout-ms'] ?? 30_000)
  const timer = setTimeout(() => ctrl.abort(new Error('approver timeout')), timeoutMs)

  try {
    for await (const env of streamEnvelopes(opts.relay, token, ctrl.signal)) {
      if (env.kind === 'permission_request' && env.from === opts.remote) {
        const requestId = env.meta?.request_id
        emit('approver.received_request', {
          msg_id: env.id, from: env.from,
          request_id: requestId,
          tool_name: env.meta?.tool_name,
          input_preview: env.meta?.input_preview,
        })
        const body = { request_id: requestId, verdict }
        if (opts.reason) body.reason = opts.reason
        const r = await postRespond(opts.relay, token, body)
        emit('approver.sent_verdict', { verdict_id: r.verdict_id, verdict, request_id: requestId })
        clearTimeout(timer); ctrl.abort(); return
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

const args = parseArgs(argv.slice(2))
const role = args.role
if (!role || !['requester', 'approver'].includes(role)) {
  console.error('--role must be requester or approver')
  exit(2)
}
for (const required of ['relay', 'secret-path', 'self', 'remote']) {
  if (!args[required]) { console.error(`missing --${required}`); exit(2) }
}

const fn = role === 'requester' ? runRequester : runApprover
fn(args).catch(err => {
  emit(`${role}.error`, { err: String(err?.message ?? err) })
  exit(1)
})
