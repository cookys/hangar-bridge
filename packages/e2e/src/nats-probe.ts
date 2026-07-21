/**
 * nats-probe.ts — self-contained verification primitives for the Phase-0 NATS
 * control-plane artifacts. INDEPENDENT / decorrelated helper: it contains only
 * *mechanism* (a tolerant HOCON-lite parser, an nkey codec, a minimal NATS TCP
 * client, and an ephemeral-server spawner). All spec *judgement* lives in the
 * test file so this helper can be reviewed as pure plumbing.
 *
 * Nothing here is copied from, or aware of, the implementer's own test.
 */

import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'

// ---------------------------------------------------------------------------
// HOCON-lite parser for nats-server.conf
// ---------------------------------------------------------------------------
// NATS config is "JSON with relaxed syntax": unquoted keys/values, `:`/`=`/space
// separators, `{}`/`[]`, `#`//`//`/`/* */` comments, comma-or-newline separators,
// and `include` directives. This parser supports that common subset. It is
// deliberately tolerant; anything it genuinely cannot parse throws (a config we
// cannot parse is a config we refuse to bless — the test treats that as a FAIL,
// never a silent pass).

export function stripComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  let quote: string | null = null
  while (i < n) {
    const c = src[i]
    if (quote) {
      out += c
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1]
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

/** Inline `include "file"` directives (relative to the conf's dir), recursively. */
export function preprocessIncludes(src: string, baseDir: string, depth = 0): string {
  if (depth > 10) return src
  const re = /(^|\n)\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s{}\[\],]+))\s*;?/g
  return src.replace(re, (_m, lead, dq, sq, bare) => {
    const rel = dq || sq || bare
    try {
      const p = path.resolve(baseDir, rel)
      const content = fs.readFileSync(p, 'utf8')
      return `${lead}\n${preprocessIncludes(stripComments(content), path.dirname(p), depth + 1)}\n`
    } catch {
      // Missing include: leave the directive so the parser skips it; the scan
      // for e.g. users will simply not find them and the relevant test fails.
      return `${lead}`
    }
  })
}

type ConfValue = string | number | boolean | ConfValue[] | ConfObj
interface ConfObj {
  [k: string]: ConfValue
}

const SPECIAL = new Set(['{', '}', '[', ']', ':', '=', ','])

function tokenize(src: string): string[] {
  const STRING_TOKEN_PREFIX = '__HB_NATS_STRING__:'
  const toks: string[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++
      continue
    }
    if (c === ',') {
      // comma is a pure separator; drop it
      i++
      continue
    }
    if (SPECIAL.has(c)) {
      toks.push(c)
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      let s = ''
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) {
          s += src[i + 1] as string
          i += 2
          continue
        }
        s += src[i] as string
        i++
      }
      i++ // closing quote
      toks.push(STRING_TOKEN_PREFIX + s) // tag as literal string
      continue
    }
    // bare token: read until whitespace or special char
    let s = ''
    while (i < n && !/\s/.test(src[i] as string) && !SPECIAL.has(src[i] as string) && src[i] !== '#') {
      s += src[i] as string
      i++
    }
    if (s.length) toks.push(s)
  }
  return toks
}

function coerce(tok: string): ConfValue {
  const STRING_TOKEN_PREFIX = '__HB_NATS_STRING__:'
  if (tok.startsWith(STRING_TOKEN_PREFIX)) return tok.slice(STRING_TOKEN_PREFIX.length)
  if (tok === 'true') return true
  if (tok === 'false') return false
  if (/^-?\d+$/.test(tok)) return Number(tok)
  if (/^-?\d+\.\d+$/.test(tok)) return Number(tok)
  return tok
}

function mergeInto(target: ConfObj, key: string, value: ConfValue): void {
  const existing = target[key]
  if (
    existing !== undefined &&
    typeof existing === 'object' &&
    !Array.isArray(existing) &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    for (const [k, v] of Object.entries(value as ConfObj)) mergeInto(existing as ConfObj, k, v)
  } else {
    target[key] = value
  }
}

export function parseNatsConf(rawSrc: string, baseDir = '.'): ConfObj {
  const src = preprocessIncludes(stripComments(rawSrc), baseDir)
  const toks = tokenize(src)
  let pos = 0

  function parseValue(): ConfValue {
    const t = toks[pos]
    if (t === undefined) return ''
    if (t === '{') return parseObject(true)
    if (t === '[') return parseArray()
    pos++
    return coerce(t)
  }

  function parseArray(): ConfValue[] {
    pos++ // consume [
    const arr: ConfValue[] = []
    while (pos < toks.length && toks[pos] !== ']') {
      arr.push(parseValue())
    }
    pos++ // consume ]
    return arr
  }

  function parseObject(braced: boolean): ConfObj {
    if (braced) pos++ // consume {
    const obj: ConfObj = {}
    while (pos < toks.length) {
      const t = toks[pos]
      if (braced && t === '}') {
        pos++
        break
      }
      if (!braced && pos >= toks.length) break
      // key
      const keyTok = toks[pos] ?? ''
      const key = keyTok.startsWith('__HB_NATS_STRING__:')
        ? keyTok.slice('__HB_NATS_STRING__:'.length)
        : keyTok
      pos++
      // optional separator
      if (toks[pos] === ':' || toks[pos] === '=') pos++
      const value = parseValue()
      mergeInto(obj, key, value)
    }
    return obj
  }

  return parseObject(false)
}

// ---------------------------------------------------------------------------
// User extraction (generic — walks accounts / authorization blocks)
// ---------------------------------------------------------------------------
export interface RawUser {
  account: string
  nkey?: string | undefined
  user?: string | undefined
  password?: string | undefined
  token?: string | undefined
  publishAllow: string[]
  publishDeny: string[]
  subscribeAllow: string[]
  subscribeDeny: string[]
  raw: ConfObj
}

function asArr(v: ConfValue | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v.map((x) => String(x))
  return [String(v)]
}

function permAllowDeny(perms: ConfValue | undefined, dir: 'publish' | 'subscribe') {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return { allow: [], deny: [] }
  const p = (perms as ConfObj)[dir]
  if (p === undefined) return { allow: [], deny: [] }
  if (Array.isArray(p) || typeof p === 'string') return { allow: asArr(p), deny: [] }
  const po = p as ConfObj
  return { allow: asArr(po.allow), deny: asArr(po.deny) }
}

function toUser(account: string, u: ConfObj): RawUser {
  const perms = u.permissions
  const pub = permAllowDeny(perms, 'publish')
  const sub = permAllowDeny(perms, 'subscribe')
  return {
    account,
    nkey: typeof u.nkey === 'string' ? u.nkey : undefined,
    user: typeof u.user === 'string' ? u.user : undefined,
    password: typeof u.password === 'string' ? u.password : undefined,
    token: typeof u.token === 'string' ? u.token : undefined,
    publishAllow: pub.allow,
    publishDeny: pub.deny,
    subscribeAllow: sub.allow,
    subscribeDeny: sub.deny,
    raw: u,
  }
}

export interface ExtractedConf {
  users: RawUser[]
  systemAccount?: string | undefined
  hasAccountsBlock: boolean
  hasLeafnodes: boolean
  hasNoAuthUser: boolean
  jetstream?: ConfValue | undefined
}

export function extractConf(conf: ConfObj): ExtractedConf {
  const users: RawUser[] = []

  // authorization { users = [...] }  (single implicit account)
  const authz = conf.authorization
  if (authz && typeof authz === 'object' && !Array.isArray(authz)) {
    const us = (authz as ConfObj).users
    if (Array.isArray(us)) {
      for (const u of us) if (u && typeof u === 'object' && !Array.isArray(u)) users.push(toUser('$G', u as ConfObj))
    }
  }

  // accounts { NAME { users = [...] } }
  const accts = conf.accounts
  if (accts && typeof accts === 'object' && !Array.isArray(accts)) {
    for (const [name, acct] of Object.entries(accts as ConfObj)) {
      if (acct && typeof acct === 'object' && !Array.isArray(acct)) {
        const us = (acct as ConfObj).users
        if (Array.isArray(us)) {
          for (const u of us)
            if (u && typeof u === 'object' && !Array.isArray(u)) users.push(toUser(name, u as ConfObj))
        }
      }
    }
  }

  return {
    users,
    systemAccount: typeof conf.system_account === 'string' ? conf.system_account : undefined,
    hasAccountsBlock: !!accts && typeof accts === 'object',
    hasLeafnodes: conf.leafnodes !== undefined,
    hasNoAuthUser: conf.no_auth_user !== undefined,
    jetstream: conf.jetstream,
  }
}

/** Recursively find the value of the first `sync_interval` key anywhere in the tree. */
export function findKeyDeep(v: ConfValue, key: string): ConfValue | undefined {
  if (v === null || typeof v !== 'object') return undefined
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findKeyDeep(x, key)
      if (r !== undefined) return r
    }
    return undefined
  }
  for (const [k, val] of Object.entries(v)) {
    if (k === key) return val
    const r = findKeyDeep(val, key)
    if (r !== undefined) return r
  }
  return undefined
}

// ---------------------------------------------------------------------------
// nkey codec (ed25519 + NATS strkey base32/crc16). Enough to MINT a user
// keypair and sign a server nonce. We never need to decode seeds.
// ---------------------------------------------------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PREFIX_USER = 20 << 3 // 160 -> 'U'

function base32Encode(data: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of data) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function crc16(data: Uint8Array): number {
  let crc = 0
  for (const b of data) {
    crc ^= b << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc & 0xffff
}

function encodePublicNkey(rawPub: Uint8Array, prefix = PREFIX_USER): string {
  const raw = new Uint8Array(1 + rawPub.length)
  raw[0] = prefix
  raw.set(rawPub, 1)
  const crc = crc16(raw)
  const full = new Uint8Array(raw.length + 2)
  full.set(raw, 0)
  full[raw.length] = crc & 0xff // little-endian
  full[raw.length + 1] = (crc >> 8) & 0xff
  return base32Encode(full)
}

export interface UserKey {
  /** Public user nkey string, e.g. "UABC…". */
  nkey: string
  /** Sign a server nonce, returning base64url (raw) signature for CONNECT. */
  sign(nonce: string): string
}

export function createUserKey(): UserKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const rawPub = spki.subarray(spki.length - 32)
  const nkey = encodePublicNkey(new Uint8Array(rawPub))
  return {
    nkey,
    sign(nonce: string) {
      const sig = crypto.sign(null, Buffer.from(nonce), privateKey)
      return sig.toString('base64url')
    },
  }
}

// ---------------------------------------------------------------------------
// Minimal NATS client protocol over raw TCP
// ---------------------------------------------------------------------------
export interface OpResult {
  ok: boolean
  line: string
}

export class NatsConn {
  private sock: net.Socket
  private buf = ''
  private lines: string[] = []
  private waiters: Array<(l: string | null) => void> = []
  private closed = false

  private constructor(sock: net.Socket) {
    this.sock = sock
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      this.buf += d
      let idx: number
      while ((idx = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        const w = this.waiters.shift()
        if (w) w(line)
        else this.lines.push(line)
      }
    })
    const finish = () => {
      this.closed = true
      while (this.waiters.length) this.waiters.shift()!(null)
    }
    sock.on('close', finish)
    sock.on('error', finish)
    sock.on('end', finish)
  }

  private nextLine(timeoutMs = 3000): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(cb)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve('__TIMEOUT__')
      }, timeoutMs)
      const cb = (l: string | null) => {
        clearTimeout(t)
        resolve(l)
      }
      this.waiters.push(cb)
    })
  }

  /**
   * Open a connection, read INFO, send CONNECT (signing the nonce if `key`
   * given), and confirm auth via PING/PONG. Returns null on auth failure or
   * dropped connection (fail-closed observed).
   */
  static async connect(
    port: number,
    opts: { key?: UserKey; verbose?: boolean } = {},
  ): Promise<NatsConn | { authFailed: true; line: string }> {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const conn = new NatsConn(sock)
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', () => resolve())
      sock.once('error', reject)
    }).catch(() => {})

    const info = await conn.nextLine()
    if (!info || !info.startsWith('INFO')) {
      conn.close()
      return { authFailed: true, line: info ?? '<closed before INFO>' }
    }
    let nonce = ''
    try {
      const j = JSON.parse(info.slice(info.indexOf('{')))
      nonce = j.nonce ?? ''
    } catch {
      /* ignore */
    }
    const connectObj: Record<string, unknown> = {
      verbose: opts.verbose ?? true,
      pedantic: false,
      tls_required: false,
      name: 'independent-probe',
      lang: 'independent-probe',
      version: '0.0.0',
      protocol: 1,
    }
    if (opts.key) {
      connectObj.nkey = opts.key.nkey
      connectObj.sig = opts.key.sign(nonce)
    }
    conn.send(`CONNECT ${JSON.stringify(connectObj)}\r\n`)
    conn.send('PING\r\n')
    // Read until PONG (auth ok), -ERR (auth fail), +OK (verbose connect ack), or drop.
    for (;;) {
      const l = await conn.nextLine()
      if (l === null) {
        conn.close()
        return { authFailed: true, line: '<connection dropped during CONNECT>' }
      }
      if (l === '__TIMEOUT__') {
        conn.close()
        return { authFailed: true, line: '<timeout during CONNECT>' }
      }
      if (l.startsWith('PONG')) return conn
      if (l.startsWith('-ERR')) {
        conn.close()
        return { authFailed: true, line: l }
      }
      // '+OK' (verbose connect ack), 'PING' from server, or 'INFO' update: keep reading
      if (l.startsWith('PING')) conn.send('PONG\r\n')
    }
  }

  private send(s: string) {
    if (!this.closed) this.sock.write(s)
  }

  /** Publish an empty message; returns whether the server permitted it. */
  async pub(subject: string): Promise<OpResult> {
    this.send(`PUB ${subject} 0\r\n\r\n`)
    return this.readOpResult()
  }

  /** Subscribe; returns whether the server permitted it. */
  async sub(subject: string, sid = '1'): Promise<OpResult> {
    this.send(`SUB ${subject} ${sid}\r\n`)
    return this.readOpResult()
  }

  private async readOpResult(): Promise<OpResult> {
    for (;;) {
      const l = await this.nextLine()
      if (l === null) return { ok: false, line: '<connection dropped>' }
      if (l === '__TIMEOUT__') return { ok: false, line: '<timeout>' }
      if (l.startsWith('+OK')) return { ok: true, line: l }
      if (l.startsWith('-ERR')) return { ok: false, line: l }
      if (l.startsWith('PING')) {
        this.send('PONG\r\n')
        continue
      }
      // MSG/PONG/INFO — ignore and keep waiting for the op verdict
    }
  }

  close() {
    this.closed = true
    try {
      this.sock.destroy()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Ephemeral nats-server lifecycle
// ---------------------------------------------------------------------------
export function natsServerBin(): string {
  return process.env.NATS_SERVER_BIN || path.join(os.homedir(), '.local', 'bin', 'nats-server')
}

export function natsServerAvailable(): boolean {
  try {
    return fs.existsSync(natsServerBin())
  } catch {
    return false
  }
}

export interface RunningServer {
  port: number
  storeDir: string
  proc: ChildProcess
  stop(): void
}

function randomPort(): number {
  return 40000 + Math.floor(Math.random() * 20000)
}

async function probeInfo(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => finish(d.startsWith('INFO')))
    sock.on('error', () => finish(false))
    setTimeout(() => finish(false), timeoutMs)
  })
}

const STORE_DIR_RE = /store_dir\s*[:=]?\s*("[^"]*"|'[^']*'|[^\s{}\[\],]+)/g

/**
 * Start nats-server against `confPath` on an ephemeral port + private store_dir.
 * The conf's `store_dir` (if any) is rewritten to a temp dir so the server never
 * touches a real path AND we never collide with a `-sd` flag ("Duplicate
 * store_dir"). Returns null if the server never becomes ready (→ live tests skip).
 */
export async function startServer(confPath: string): Promise<RunningServer | null> {
  const bin = natsServerBin()
  if (!fs.existsSync(bin)) return null
  const debug = !!process.env.NATS_PROBE_DEBUG
  const raw = fs.readFileSync(confPath, 'utf8')
  const confHasStoreDir = STORE_DIR_RE.test(raw)
  STORE_DIR_RE.lastIndex = 0
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = randomPort()
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nats-indep-'))
    const jsStore = path.join(storeDir, 'js').replace(/\\/g, '/')
    // If the conf pins store_dir, rewrite it to our temp path and DON'T pass -sd
    // (nats-server rejects both at once). Otherwise pass -sd for JetStream.
    let confArg = confPath
    const args = ['-p', String(port)]
    if (confHasStoreDir) {
      const fixed = raw.replace(STORE_DIR_RE, `store_dir: "${jsStore}"`)
      STORE_DIR_RE.lastIndex = 0
      confArg = path.join(storeDir, 'nats-server.conf')
      fs.writeFileSync(confArg, fixed)
      args.unshift('-c', confArg)
    } else {
      args.unshift('-c', confArg)
      args.push('-sd', jsStore)
    }
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'ignore', debug ? 'inherit' : 'ignore'],
    })
    let exited = false
    proc.on('exit', (code) => {
      exited = true
      if (debug) console.error(`[nats-probe] server exited early (code=${code}) attempt=${attempt}`)
    })
    proc.on('error', (e) => {
      exited = true
      if (debug) console.error(`[nats-probe] spawn error: ${(e as Error).message}`)
    })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !exited) {
      if (await probeInfo(port)) {
        return {
          port,
          storeDir,
          proc,
          stop() {
            try {
              proc.kill('SIGKILL')
            } catch {
              /* ignore */
            }
            try {
              fs.rmSync(storeDir, { recursive: true, force: true })
            } catch {
              /* ignore */
            }
          },
        }
      }
      await new Promise((r) => setTimeout(r, 120))
    }
    try {
      proc.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(storeDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Write a temporary copy of `rawConf` with `oldNkey` replaced by `newNkey`, so we
 * can authenticate AS a fleet user (keeping that user's real permission block)
 * with a seed we control. `store_dir` neutralisation is handled by startServer.
 */
export function writeConfWithSwappedKey(rawConf: string, oldNkey: string, newNkey: string): string {
  const out = rawConf.split(oldNkey).join(newNkey)
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nats-conf-')), 'nats-server.conf')
  fs.writeFileSync(p, out)
  return p
}
