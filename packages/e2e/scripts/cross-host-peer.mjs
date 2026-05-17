#!/usr/bin/env node
// Cross-host dispatch e2e helper. Single script, two roles. Runs against
// a live hangar-bridge relay over HTTP. No node-test/vitest deps — just
// built-in `fetch` + `crypto.randomUUID`, so the same artifact works on
// both openclaw (node 22 via deb) and gentoo (node 22 via nvm).
//
// Usage:
//   cross-host-peer.mjs --role dispatcher|responder \
//                       --relay <url> --secret-path <path> \
//                       --self <handle> --remote <handle> \
//                       [--correlation-id <ulid>] [--payload <str>] \
//                       [--timeout-ms 30000]

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

function ulidLike() {
  // Crockford base32, 26 chars. Not RFC ULID but matches our regex
  // /^[0-9A-HJKMNP-TV-Z]{26}$/i. Good enough as a correlation id.
  const alpha = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  for (let i = 0; i < 26; i++) {
    out += alpha[Math.floor(Math.random() * alpha.length)]
  }
  return out
}

function emit(phase, fields) {
  console.log(JSON.stringify({ phase, t: new Date().toISOString(), ...fields }))
}

async function postMessage(relayUrl, token, body, idempotencyKey) {
  const res = await fetch(new URL('/v1/messages', relayUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey.toLowerCase(),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (res.status !== 201) throw new Error(`POST /v1/messages ${res.status}: ${text}`)
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

async function runDispatcher(opts) {
  const token = readFileSync(opts['secret-path'], 'utf8').trim()
  const correlationId = (opts['correlation-id'] ?? ulidLike()).toUpperCase()
  const payload = opts.payload ?? 'cross-host dispatch ping'

  emit('dispatcher.start', { self: opts.self, remote: opts.remote, relay: opts.relay, correlation_id: correlationId })

  // Subscribe FIRST so the task_result envelope can't be missed even if
  // the responder races us.
  const ctrl = new AbortController()
  const timeoutMs = Number(opts['timeout-ms'] ?? 30_000)
  const timer = setTimeout(() => ctrl.abort(new Error('dispatcher timeout')), timeoutMs)

  // Kick off the dispatch in parallel with the subscribe.
  const dispatchPromise = postMessage(opts.relay, token, {
    to: opts.remote,
    kind: 'task_dispatch',
    content: payload,
    meta: { correlation_id: correlationId, task_kind: 'cross-host-probe' },
  }, correlationId).then(env => {
    emit('dispatcher.sent', { msg_id: env.id, correlation_id: correlationId, delivered_at: env.delivered_at })
    return env
  })

  try {
    let dispatchEnv = null
    for await (const env of streamEnvelopes(opts.relay, token, ctrl.signal)) {
      if (!dispatchEnv) {
        dispatchEnv = await dispatchPromise.catch(err => { throw err })
      }
      if (env.kind === 'task_result' && env.meta?.correlation_id === correlationId) {
        emit('dispatcher.received_result', {
          msg_id: env.id, from: env.from,
          correlation_id: env.meta.correlation_id,
          in_reply_to: env.in_reply_to,
          content: env.content,
        })
        clearTimeout(timer)
        ctrl.abort()
        return
      }
    }
  } finally {
    clearTimeout(timer)
  }
  throw new Error('dispatcher exited without seeing matching task_result')
}

async function runResponder(opts) {
  const token = readFileSync(opts['secret-path'], 'utf8').trim()
  emit('responder.start', { self: opts.self, remote: opts.remote, relay: opts.relay })

  const ctrl = new AbortController()
  const timeoutMs = Number(opts['timeout-ms'] ?? 30_000)
  const timer = setTimeout(() => ctrl.abort(new Error('responder timeout')), timeoutMs)

  try {
    for await (const env of streamEnvelopes(opts.relay, token, ctrl.signal)) {
      if (env.kind === 'task_dispatch' && env.from === opts.remote) {
        emit('responder.received_dispatch', {
          msg_id: env.id, from: env.from,
          correlation_id: env.meta?.correlation_id,
          task_kind: env.meta?.task_kind,
          content: env.content,
        })
        const replyEnv = await postMessage(opts.relay, token, {
          to: env.from,
          kind: 'task_result',
          content: `processed by ${opts.self}: ${env.content}`,
          in_reply_to: env.id,
          meta: { correlation_id: env.meta?.correlation_id ?? '' },
        }, ulidLike())
        emit('responder.sent_result', {
          msg_id: replyEnv.id, correlation_id: env.meta?.correlation_id,
        })
        clearTimeout(timer)
        ctrl.abort()
        return
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

const args = parseArgs(argv.slice(2))
const role = args.role
if (!role || !['dispatcher', 'responder'].includes(role)) {
  console.error('--role must be dispatcher or responder')
  exit(2)
}
for (const required of ['relay', 'secret-path', 'self', 'remote']) {
  if (!args[required]) { console.error(`missing --${required}`); exit(2) }
}

const fn = role === 'dispatcher' ? runDispatcher : runResponder
fn(args).catch(err => {
  emit(`${role}.error`, { err: String(err?.message ?? err) })
  exit(1)
})
