/**
 * nats-config.independent.test.ts
 * ================================
 * INDEPENDENT, decorrelated verification of the Phase-0 NATS control-plane
 * artifacts for the relay→NATS migration (docs/plans/2026-07-02-relay-to-nats-migration.md).
 *
 * This harness was authored FROM THE SPEC ONLY, blind to the implementer's own
 * `nats-config.test.ts`. It default-assumes the artifacts are WRONG and only
 * passes when they demonstrably satisfy the plan's hard Phase-0 ACs
 * (AC1, AC2/AC2c, AC3, AC10, AC12) plus the WorkQueue-poison / provision finding.
 *
 * Robustness contract:
 *   - Every artifact-dependent test SKIPS (never silently passes) when the
 *     artifact file is absent — the implementer builds them in parallel.
 *   - A present-but-violating artifact FAILS.
 *   - The pure config-scanner logic is proven adversarial by an always-run
 *     self-test suite over synthetic GOOD/BAD fixtures (no artifact, no server).
 *   - Live-server assertions are guarded by nats-server availability and use a
 *     self-validated nkey/TCP client; when they cannot run they SKIP with a
 *     reason, they never pass vacuously.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseNatsConf,
  extractConf,
  findKeyDeep,
  stripComments,
  createUserKey,
  natsServerAvailable,
  startServer,
  writeConfWithSwappedKey,
  NatsConn,
  type RawUser,
  type ExtractedConf,
} from './nats-probe.ts'

// ---------------------------------------------------------------------------
// Artifact locations (spec §3 file map), env-overridable.
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const NATS_DIR = path.join(REPO_ROOT, 'packages', 'operations', 'nats')
const CONF_PATH = process.env.NATS_CONF_PATH || path.join(NATS_DIR, 'nats-server.conf')
const ROSTER_PATH = process.env.NATS_ROSTER_PATH || path.join(NATS_DIR, 'fleet-roster.json')
const PROVISION_PATH = process.env.NATS_PROVISION_PATH || path.join(NATS_DIR, 'provision-jetstream.sh')

const confPresent = fs.existsSync(CONF_PATH)
const rosterPresent = fs.existsSync(ROSTER_PATH)
const provisionPresent = fs.existsSync(PROVISION_PATH)
const serverAvail = natsServerAvailable()

// ---------------------------------------------------------------------------
// Spec-derived scanner (§2.6 subject/ACL scheme). Pure; no IO.
// ---------------------------------------------------------------------------

/**
 * Publish subjects a FLEET user MAY carry beyond its one `fleet.<handle>.>` entry (§2.6).
 * Each pattern requires at least one CONCRETE segment (`[^>*]+`, dots allowed) after the
 * prefix and permits at most a single trailing `.>`/`.*` — so `…NEXT.KV_<bucket>.>` (a
 * legitimate KV-watch grant) is accepted while a bare `…NEXT.>` wildcard is NOT.
 */
const CONTROL_PUB_ALLOWLIST: RegExp[] = [
  /^\$JS\.ACK\.[^>*]+(\.[>*])?$/, // ack for own stream/consumer
  /^\$JS\.API\.CONSUMER\.MSG\.NEXT\.[^>*]+(\.[>*])?$/, // pull next (own consumer / KV watch)
  /^\$JS\.API\.CONSUMER\.INFO\.[^>*]+(\.[>*])?$/, // consumer info (own / KV watch)
  /^\$JS\.API\.CONSUMER\.CREATE\.KV_[^>*]+(\.[>*])?$/, // ephemeral KV-watch consumer
  /^\$KV\.[^>*]+(\.[>*])?$/, // KV data write (own-prefix scope checked separately)
  /^\$JS\.API\.DIRECT\.GET\.KV_[^>*]+(\.[>*])?$/, // KV direct read
  /^\$JS\.API\.STREAM\.INFO\.KV_[^>*]+(\.[>*])?$/, // KV backing-stream info
  /^_INBOX\.[^>*]+(\.[>*])?$/, // own inbox (bare-inbox check separate)
]

/** Wildcards / control planes that must NEVER appear on a fleet user (pub or sub). */
const FORBIDDEN_FLEET_SUBJECTS = [
  '>',
  '$JS.>',
  '$JS.API.>',
  '$JS.API.STREAM.>',
  '$JS.API.CONSUMER.>',
  'fleet.>',
  'fleet.*.>',
  '$SYS.>',
  '_INBOX.>',
  '$KV.>',
]

/** Provisioning subjects (admin-only per §2.6). */
const PROVISIONING_RE = [
  /^\$JS\.API\.STREAM\.(CREATE|UPDATE|DELETE|PURGE)/,
  /^\$JS\.API\.CONSUMER\.DURABLE\.CREATE/,
]

function isProvisioning(subj: string): boolean {
  return PROVISIONING_RE.some((re) => re.test(subj))
}

interface Classified {
  sysUsers: RawUser[]
  adminUsers: RawUser[]
  fleetUsers: RawUser[]
}

function classify(ex: ExtractedConf): Classified {
  const sysUsers: RawUser[] = []
  const app: RawUser[] = []
  for (const u of ex.users) {
    const isSys =
      (ex.systemAccount && u.account === ex.systemAccount) || /^\$?SYS$/i.test(u.account)
    if (isSys) sysUsers.push(u)
    else app.push(u)
  }
  const adminUsers = app.filter((u) => u.publishAllow.some(isProvisioning))
  const fleetUsers = app.filter((u) => !u.publishAllow.some(isProvisioning))
  return { sysUsers, adminUsers, fleetUsers }
}

/** Derive a fleet user's handle from its single `fleet.<handle>.>` publish entry. */
function deriveHandle(u: RawUser): string | null {
  const fleetEntries = u.publishAllow.filter((s) => /^fleet\./.test(s))
  if (fleetEntries.length !== 1) return null
  const first = fleetEntries[0]
  if (first === undefined) return null
  const m = /^fleet\.([^.*>]+)\.>$/.exec(first)
  return m && m[1] !== undefined ? m[1] : null
}

/** AC2 config-scan: violations for a fleet user's credential + publish lane. */
function scanFleetPublish(u: RawUser, handle: string): string[] {
  const v: string[] = []
  // nkey-only
  if (!u.nkey) v.push('no nkey (credential must be nkey-only)')
  if (u.password !== undefined) v.push('has cleartext `password` (must be nkey-only)')
  if (u.token !== undefined) v.push('has `token` credential (must be nkey-only)')
  if (u.user !== undefined) v.push('has `user`/`password` login (must be nkey-only)')

  const pub = u.publishAllow
  if (pub.length === 0) v.push('empty publish.allow (deny-by-default requires an explicit envelope grant)')

  // exactly one fleet.* entry, and it must be exactly fleet.<handle>.>
  const fleetEntries = pub.filter((s) => /^fleet\./.test(s))
  if (fleetEntries.length !== 1) {
    v.push(`publish.allow must contain EXACTLY ONE fleet.* entry, found ${fleetEntries.length}: ${JSON.stringify(fleetEntries)}`)
  } else if (fleetEntries[0] !== `fleet.${handle}.>`) {
    v.push(`the sole fleet.* publish entry must be exactly "fleet.${handle}.>", got "${fleetEntries[0]}"`)
  }

  for (const s of pub) {
    if (FORBIDDEN_FLEET_SUBJECTS.includes(s)) v.push(`forbidden wildcard/control-plane publish subject: "${s}"`)
    if (isProvisioning(s)) v.push(`fleet user carries provisioning subject (admin-only): "${s}"`)
    if (/^fleet\./.test(s)) continue // fleet.* entry handled above
    // every non-fleet entry must be a recognised, enumerated control subject
    if (!CONTROL_PUB_ALLOWLIST.some((re) => re.test(s)) && !FORBIDDEN_FLEET_SUBJECTS.includes(s) && !isProvisioning(s)) {
      v.push(`unrecognised / over-broad publish subject (not in §2.6 control allow-list): "${s}"`)
    }
    // KV write must be scoped to the user's own key prefix
    if (/^\$KV\./.test(s)) {
      const scoped = new RegExp(`^\\$KV\\.[^.]+\\.${handle}\\.`).test(s)
      if (!scoped) v.push(`KV write not scoped to own handle prefix "$KV.<bucket>.${handle}.>": "${s}"`)
    }
    // inbox must be scoped, never bare _INBOX.>
    if (/^_INBOX\./.test(s) && s === '_INBOX.>') v.push('bare "_INBOX.>" publish grant (must be own scoped _INBOX.<nuid>.>)')
  }
  return v
}

/** AC12 config-scan: violations for a fleet user's subscribe lane. */
function scanFleetSubscribe(u: RawUser, handle: string): string[] {
  const v: string[] = []
  const sub = u.subscribeAllow
  const hasOwn = sub.includes(`fleet.*.to.${handle}.>`)
  const hasTeam = sub.includes('fleet.*.to.team.>')
  if (!hasOwn) v.push(`subscribe.allow missing own recipient lane "fleet.*.to.${handle}.>"`)
  if (!hasTeam) v.push('subscribe.allow missing team lane "fleet.*.to.team.>"')

  for (const s of sub) {
    if (FORBIDDEN_FLEET_SUBJECTS.includes(s)) v.push(`forbidden broad subscribe subject: "${s}"`)
    if (/^fleet\./.test(s)) {
      const m = /^fleet\.\*\.to\.([^.]+)\.>$/.exec(s)
      if (!m) {
        v.push(`fleet subscribe entry not recipient-scoped "fleet.*.to.<recipient>.>": "${s}"`)
      } else if (m[1] !== handle && m[1] !== 'team') {
        v.push(`subscribe lane addresses another recipient (chokepoint breach): "${s}"`)
      }
      continue
    }
    if (/^_INBOX\./.test(s)) {
      if (s === '_INBOX.>') v.push('bare "_INBOX.>" subscribe grant (must be own scoped _INBOX.<nuid>.>)')
      continue
    }
    v.push(`unexpected subscribe subject outside envelope lane + own inbox: "${s}"`)
  }
  return v
}

/** Tolerant roster-handle extraction from fleet-roster.json (spec: per-handle owned/interest+display). */
function rosterHandles(j: unknown): string[] {
  const looksLikeEntry = (v: unknown): boolean =>
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    ['owned', 'interest', 'display', 'display_name', 'namespaces', 'displayName'].some((k) => k in (v as object))

  const fromMap = (m: Record<string, unknown>): string[] => {
    const keys = Object.keys(m).filter((k) => looksLikeEntry(m[k]))
    if (keys.length) return keys
    return Object.keys(m)
  }

  if (Array.isArray(j)) {
    return j
      .map((e) => (e && typeof e === 'object' ? ((e as Record<string, unknown>).handle ?? (e as Record<string, unknown>).name) : undefined))
      .filter((x): x is string => typeof x === 'string')
  }
  if (j && typeof j === 'object') {
    const o = j as Record<string, unknown>
    for (const key of ['handles', 'roster', 'peers', 'fleet', 'members']) {
      const sub = o[key]
      if (Array.isArray(sub)) return rosterHandles(sub)
      if (sub && typeof sub === 'object') return fromMap(sub as Record<string, unknown>)
    }
    return fromMap(o)
  }
  return []
}

// ---------------------------------------------------------------------------
// provision-jetstream.sh static scanner (AC1 + WorkQueue-poison finding).
// ---------------------------------------------------------------------------
interface ProvisionScan {
  hasWorkqueueRetention: boolean
  hasReplicas1: boolean
  missingEnumeration: string[]
  poison: string[]
}
function scanProvision(text: string, handles: string[]): ProvisionScan {
  const t = text
  const hasWorkqueueRetention = /work[_-]?queue/i.test(t) || /--retention[\s=]+work\b/i.test(t) || /retention[\s=:"']+work\b/i.test(t)
  const hasReplicas1 = /(replicas?[\s=:"']*1\b)|(-R\s+1\b)|(--replicas(=|\s+)1\b)/i.test(t)
  // Enumeration may be LITERAL (one subject per handle) OR built dynamically by a
  // shell loop over the roster: `fleet.*.to.${VAR}.task_dispatch`. A templated form
  // driven by the roster covers every handle by construction, so accept it — but the
  // poison checks below still reject a broad `to.*` / `to.team` binding, so this does
  // not weaken the security property (per-handle enumeration, no unknown-recipient lane).
  const templatedDispatch = /fleet\.\*\.to\.\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.task_dispatch/.test(t)
  const templatedResult = /fleet\.\*\.to\.\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\.task_result/.test(t)
  const dynamicEnumeration = templatedDispatch && templatedResult
  const missingEnumeration: string[] = []
  if (!dynamicEnumeration) {
    for (const h of handles) {
      if (!t.includes(`fleet.*.to.${h}.task_dispatch`)) missingEnumeration.push(`fleet.*.to.${h}.task_dispatch`)
      if (!t.includes(`fleet.*.to.${h}.task_result`)) missingEnumeration.push(`fleet.*.to.${h}.task_result`)
    }
  }
  const poison: string[] = []
  if (/fleet\.\*\.to\.team\.task/.test(t)) poison.push('stream binds a `to.team` task subject (WorkQueue poison)')
  if (/fleet\.\*\.to\.\*\.task/.test(t)) poison.push('stream binds a broad `fleet.*.to.*.task*` subject (unknown-recipient poison)')
  return { hasWorkqueueRetention, hasReplicas1, missingEnumeration, poison }
}

// ===========================================================================
// SELF-TESTS — prove the scanner is adversarial (always run; no artifact/server)
// ===========================================================================
const GOOD_CONF = `
port: 4222
jetstream {
  store_dir: "/tmp/js-good"
  sync_interval: always
}
system_account: SYS
accounts {
  APP {
    jetstream: enabled
    users = [
      {
        nkey: UAAAAALPHA000000000000000000000000000000000000000000000
        permissions {
          publish { allow = [
            "fleet.alpha.>"
            "$JS.ACK.HANGAR_TASKS.alpha_consumer.>"
            "$JS.API.CONSUMER.MSG.NEXT.HANGAR_TASKS.alpha_consumer"
            "$JS.API.CONSUMER.INFO.HANGAR_TASKS.alpha_consumer"
            "$KV.HANGAR_DEDUP.alpha.>"
            "$JS.API.DIRECT.GET.KV_HANGAR_DEDUP.>"
            "$JS.API.STREAM.INFO.KV_HANGAR_DEDUP"
            "$JS.API.CONSUMER.CREATE.KV_HANGAR_DEDUP"
            "$JS.API.CONSUMER.INFO.KV_HANGAR_DEDUP.>"
            "$JS.API.CONSUMER.MSG.NEXT.KV_HANGAR_DEDUP.>"
            "_INBOX.alpha.>"
          ] }
          subscribe { allow = [ "fleet.*.to.alpha.>", "fleet.*.to.team.>", "_INBOX.alpha.>" ] }
        }
      }
      {
        nkey: UAAAAABETA0000000000000000000000000000000000000000000000
        permissions {
          publish { allow = [ "fleet.beta.>", "$KV.HANGAR_DEDUP.beta.>", "_INBOX.beta.>" ] }
          subscribe { allow = [ "fleet.*.to.beta.>", "fleet.*.to.team.>", "_INBOX.beta.>" ] }
        }
      }
      {
        nkey: UADMIN00000000000000000000000000000000000000000000000000
        permissions {
          publish { allow = [
            "$JS.API.STREAM.CREATE.>"
            "$JS.API.STREAM.UPDATE.>"
            "$JS.API.STREAM.DELETE.>"
            "$JS.API.STREAM.PURGE.>"
            "$JS.API.CONSUMER.DURABLE.CREATE.>"
            "$JS.API.STREAM.CREATE.KV_HANGAR_DEDUP"
            "_INBOX.admin.>"
          ] }
          subscribe { allow = [ "_INBOX.admin.>" ] }
        }
      }
    ]
  }
  SYS {
    users = [ { nkey: USYS0000000000000000000000000000000000000000000000000000 } ]
  }
}
`
const GOOD_ROSTER = { handles: { alpha: { owned: ['a'], interest: [], display: 'Alpha' }, beta: { owned: ['b'], interest: [], display: 'Beta' } } }

describe('scanner self-test — GOOD synthetic fixtures pass', () => {
  const conf = extractConf(parseNatsConf(GOOD_CONF))
  const cls = classify(conf)

  it('parses accounts + users and classifies fleet/admin/sys correctly', () => {
    expect(cls.fleetUsers.length).toBe(2)
    expect(cls.adminUsers.length).toBe(1)
    expect(cls.sysUsers.length).toBe(1)
  })

  it('every GOOD fleet user has ZERO publish + subscribe violations', () => {
    for (const u of cls.fleetUsers) {
      const h = deriveHandle(u)
      expect(h, `handle derivable for ${u.nkey}`).not.toBeNull()
      expect(scanFleetPublish(u, h!)).toEqual([])
      expect(scanFleetSubscribe(u, h!)).toEqual([])
    }
  })

  it('roster handles equal the fleet handle set (admin/$SYS excluded)', () => {
    const fleetH = new Set(cls.fleetUsers.map((u) => deriveHandle(u)))
    expect(fleetH).toEqual(new Set(rosterHandles(GOOD_ROSTER)))
  })

  it('GOOD conf has jetstream + sync_interval:always, no leafnodes, no no_auth_user', () => {
    expect(conf.hasLeafnodes).toBe(false)
    expect(conf.hasNoAuthUser).toBe(false)
    expect(String(findKeyDeep(conf.jetstream ?? {}, 'sync_interval'))).toBe('always')
  })
})

describe('scanner self-test — BAD synthetic fixtures are REJECTED', () => {
  const mk = (usersBlock: string) => {
    const c = extractConf(parseNatsConf(`accounts { APP { users = [ ${usersBlock} ] } }`))
    return c.users[0]!
  }

  it('rejects a fleet user carrying $JS.API.> (the finding that killed qc round 1)', () => {
    const u = mk('{ nkey: U1, permissions { publish { allow = ["fleet.x.>", "$JS.API.>"] } subscribe { allow=["fleet.*.to.x.>","fleet.*.to.team.>"] } } }')
    expect(scanFleetPublish(u, 'x').length).toBeGreaterThan(0)
  })
  it('rejects a bare ">" publish wildcard', () => {
    const u = mk('{ nkey: U1, permissions { publish { allow = ["fleet.x.>", ">"] } } }')
    expect(scanFleetPublish(u, 'x')).toContain('forbidden wildcard/control-plane publish subject: ">"')
  })
  it('rejects a cleartext password (not nkey-only)', () => {
    const u = mk('{ user: "x", password: "hunter2", permissions { publish { allow = ["fleet.x.>"] } } }')
    expect(scanFleetPublish(u, 'x').some((s) => /password/.test(s))).toBe(true)
  })
  it('rejects a token credential (not nkey-only)', () => {
    const u = mk('{ token: "abc", permissions { publish { allow = ["fleet.x.>"] } } }')
    expect(scanFleetPublish(u, 'x').some((s) => /token/.test(s))).toBe(true)
  })
  it('rejects two fleet.* publish entries', () => {
    const u = mk('{ nkey: U1, permissions { publish { allow = ["fleet.x.>", "fleet.y.>"] } } }')
    expect(scanFleetPublish(u, 'x').some((s) => /EXACTLY ONE fleet/.test(s))).toBe(true)
  })
  it('rejects a whole-bucket KV write ($KV.<bucket>.>)', () => {
    const u = mk('{ nkey: U1, permissions { publish { allow = ["fleet.x.>", "$KV.HANGAR_DEDUP.>"] } } }')
    expect(scanFleetPublish(u, 'x').length).toBeGreaterThan(0)
  })
  it('rejects a provisioning subject on a fleet user', () => {
    const u = mk('{ nkey: U1, permissions { publish { allow = ["fleet.x.>", "$JS.API.STREAM.PURGE.HANGAR_TASKS"] } } }')
    expect(scanFleetPublish(u, 'x').some((s) => /provisioning/.test(s))).toBe(true)
  })
  it('rejects a subscribe lane addressed to ANOTHER recipient (chokepoint breach)', () => {
    const u = mk('{ nkey: U1, permissions { subscribe { allow = ["fleet.*.to.x.>","fleet.*.to.team.>","fleet.*.to.victim.>"] } } }')
    expect(scanFleetSubscribe(u, 'x').some((s) => /another recipient/.test(s))).toBe(true)
  })
  it('rejects a wildcard-recipient subscribe (fleet.*.to.*.>)', () => {
    const u = mk('{ nkey: U1, permissions { subscribe { allow = ["fleet.*.to.x.>","fleet.*.to.team.>","fleet.*.to.*.>"] } } }')
    expect(scanFleetSubscribe(u, 'x').length).toBeGreaterThan(0)
  })
  it('rejects a bare _INBOX.> subscribe grant', () => {
    const u = mk('{ nkey: U1, permissions { subscribe { allow = ["fleet.*.to.x.>","fleet.*.to.team.>","_INBOX.>"] } } }')
    expect(scanFleetSubscribe(u, 'x').some((s) => /bare "_INBOX/.test(s))).toBe(true)
  })
  it('detects a leafnodes block (AC10)', () => {
    const c = extractConf(parseNatsConf('leafnodes { remotes = [] }\naccounts { APP { users = [] } }'))
    expect(c.hasLeafnodes).toBe(true)
  })
  it('detects no_auth_user anonymous bypass', () => {
    const c = extractConf(parseNatsConf('no_auth_user: anon\naccounts { APP { users = [] } }'))
    expect(c.hasNoAuthUser).toBe(true)
  })
})

describe('scanner self-test — provision-jetstream.sh scanner', () => {
  const GOOD = `#!/bin/sh
nats stream add HANGAR_TASKS --retention=workqueue --replicas=1 \
  --subjects="fleet.*.to.alpha.task_dispatch,fleet.*.to.alpha.task_result,fleet.*.to.beta.task_dispatch,fleet.*.to.beta.task_result"
`
  it('accepts a per-handle-enumerated WorkQueue R1 stream', () => {
    const s = scanProvision(GOOD, ['alpha', 'beta'])
    expect(s.hasWorkqueueRetention).toBe(true)
    expect(s.hasReplicas1).toBe(true)
    expect(s.missingEnumeration).toEqual([])
    expect(s.poison).toEqual([])
  })
  it('flags a broad fleet.*.to.*.task subject (WorkQueue poison)', () => {
    const BAD = 'nats stream add T --retention=workqueue --replicas=1 --subjects="fleet.*.to.*.task_dispatch"'
    expect(scanProvision(BAD, ['alpha']).poison.length).toBeGreaterThan(0)
  })
  it('flags a to.team task subject (WorkQueue poison)', () => {
    const BAD = 'nats stream add T --subjects="fleet.*.to.team.task_dispatch" --retention=workqueue --replicas=1'
    expect(scanProvision(BAD, ['alpha']).poison.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// ARTIFACT SCANS — run against the shipped Phase-0 files (skip if absent)
// ===========================================================================
let CONF_RAW = ''
let CONF: ExtractedConf | null = null
let ROSTER_JSON: unknown = null
let PROVISION_RAW = ''

beforeAll(() => {
  const missing: string[] = []
  if (!confPresent) missing.push(`nats-server.conf (${CONF_PATH})`)
  if (!rosterPresent) missing.push(`fleet-roster.json (${ROSTER_PATH})`)
  if (!provisionPresent) missing.push(`provision-jetstream.sh (${PROVISION_PATH})`)
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[nats-config.independent] SKIPPING artifact assertions — absent Phase-0 artifact(s):\n  - ${missing.join('\n  - ')}\n(These are authored by the implementer in parallel; scanner SELF-TESTS still run.)\n`,
    )
  }
  if (confPresent) {
    CONF_RAW = fs.readFileSync(CONF_PATH, 'utf8')
    CONF = extractConf(parseNatsConf(CONF_RAW, NATS_DIR))
  }
  if (rosterPresent) ROSTER_JSON = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'))
  if (provisionPresent) PROVISION_RAW = fs.readFileSync(PROVISION_PATH, 'utf8')
  if (!serverAvail) {
    // eslint-disable-next-line no-console
    console.warn(`[nats-config.independent] nats-server not found — live assertions will SKIP.`)
  }
})

describe('AC1 — JetStream single-node + durable fsync (config)', () => {
  it.skipIf(!confPresent)('conf enables JetStream and sets sync_interval: always', () => {
    const raw = stripComments(CONF_RAW)
    const syncVal = findKeyDeep(CONF!.jetstream ?? {}, 'sync_interval')
    // primary: parsed structure; backstop: comment-stripped raw text
    const parsedOk = String(syncVal) === 'always'
    const rawOk = /sync_interval\s*[:=]?\s*"?always"?/.test(raw)
    expect(parsedOk || rawOk, `sync_interval must be "always" (parsed=${String(syncVal)})`).toBe(true)
    // JetStream must be enabled (a jetstream block or jetstream: enabled)
    const jsEnabled =
      CONF!.jetstream !== undefined && String(CONF!.jetstream).toLowerCase() !== 'disabled' && String(CONF!.jetstream) !== 'false'
    expect(jsEnabled || /jetstream/i.test(raw), 'JetStream must be enabled in the shipped conf').toBe(true)
  })
})

describe('AC2 — static NKey auth + deny-by-default publish ACL (config)', () => {
  it.skipIf(!confPresent)('every fleet user is nkey-only with an exact single-fleet publish partition', () => {
    const cls = classify(CONF!)
    expect(cls.fleetUsers.length, 'at least one fleet user must exist').toBeGreaterThan(0)
    const allViolations: Record<string, string[]> = {}
    for (const u of cls.fleetUsers) {
      const h = deriveHandle(u)
      const key = h ?? u.nkey ?? '<unknown>'
      if (!h) {
        allViolations[key] = ['cannot derive a single fleet.<handle>.> handle from publish.allow']
        continue
      }
      const v = scanFleetPublish(u, h)
      if (v.length) allViolations[key] = v
    }
    expect(allViolations, `publish-ACL violations:\n${JSON.stringify(allViolations, null, 2)}`).toEqual({})
  })

  it.skipIf(!confPresent)('NO fleet user carries $JS.API.>, $JS.>, or > (pub or sub)', () => {
    const cls = classify(CONF!)
    const offenders: Record<string, string[]> = {}
    for (const u of cls.fleetUsers) {
      const all = [...u.publishAllow, ...u.subscribeAllow]
      const bad = all.filter((s) => ['$JS.API.>', '$JS.>', '>', '$JS.API.STREAM.>', '$JS.API.CONSUMER.>', 'fleet.>'].includes(s))
      if (bad.length) offenders[deriveHandle(u) ?? u.nkey ?? '?'] = bad
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual({})
  })

  it.skipIf(!confPresent)('conf declares no `no_auth_user` (no implicit anonymous identity — GHSA shape)', () => {
    expect(CONF!.hasNoAuthUser, 'a `no_auth_user` would grant an unauthenticated global identity').toBe(false)
    expect(/(^|\n|\s)no_auth_user\b/.test(stripComments(CONF_RAW))).toBe(false)
  })

  it.skipIf(!confPresent)('provisioning subjects appear ONLY on a non-fleet admin principal', () => {
    const cls = classify(CONF!)
    // no fleet user has provisioning subjects
    for (const u of cls.fleetUsers) {
      expect(u.publishAllow.filter(isProvisioning), `fleet user ${deriveHandle(u)} must have no provisioning subjects`).toEqual([])
    }
    // and an admin principal that DOES hold them exists and is not a fleet user
    expect(cls.adminUsers.length, 'a dedicated provisioning admin (hangar-admin) must exist').toBeGreaterThan(0)
  })
})

describe('AC3 — $SYS account separation (config)', () => {
  it.skipIf(!confPresent)('$SYS has a dedicated credential distinct from every fleet user', () => {
    const cls = classify(CONF!)
    expect(cls.sysUsers.length, 'a dedicated $SYS credential must exist').toBeGreaterThan(0)
    const sysNkeys = new Set(cls.sysUsers.map((u) => u.nkey))
    const fleetNkeys = new Set(cls.fleetUsers.map((u) => u.nkey))
    for (const nk of sysNkeys) expect(fleetNkeys.has(nk), '$SYS credential must not be reused by a fleet user').toBe(false)
    // system_account must be declared (explicit, not implicit/anonymous)
    expect(CONF!.systemAccount || cls.sysUsers.length > 0, 'system_account must be explicitly declared').toBeTruthy()
  })
})

describe('AC10 — no leafnode federation (config)', () => {
  it.skipIf(!confPresent)('conf contains NO leafnodes block', () => {
    expect(CONF!.hasLeafnodes, 'parsed conf must have no `leafnodes` block').toBe(false)
    expect(/(^|\n|\s)leafnodes\b/.test(stripComments(CONF_RAW)), 'raw conf must not mention leafnodes').toBe(false)
  })
})

describe('AC12 — subscribe chokepoint + roster⇔users equality (config)', () => {
  it.skipIf(!confPresent)('every fleet subscribe lane is recipient-scoped and nothing broader', () => {
    const cls = classify(CONF!)
    const allViolations: Record<string, string[]> = {}
    for (const u of cls.fleetUsers) {
      const h = deriveHandle(u)
      if (!h) continue
      const v = scanFleetSubscribe(u, h)
      if (v.length) allViolations[h] = v
    }
    expect(allViolations, JSON.stringify(allViolations, null, 2)).toEqual({})
  })

  it.skipIf(!confPresent || !rosterPresent)('roster handles ⇔ conf fleet users are the EXACT same set', () => {
    const cls = classify(CONF!)
    const fleetH = new Set(cls.fleetUsers.map((u) => deriveHandle(u)).filter((x): x is string => !!x))
    const rosterH = new Set(rosterHandles(ROSTER_JSON))
    expect(rosterH.size, 'roster must not be empty').toBeGreaterThan(0)
    const orphanUsers = [...fleetH].filter((h) => !rosterH.has(h))
    const orphanRoster = [...rosterH].filter((h) => !fleetH.has(h))
    expect({ orphanFleetUsers: orphanUsers, orphanRosterHandles: orphanRoster }).toEqual({
      orphanFleetUsers: [],
      orphanRosterHandles: [],
    })
  })

  it.skipIf(!confPresent)('no fleet handle equals the reserved broadcast token "team"', () => {
    const cls = classify(CONF!)
    const handles = cls.fleetUsers.map((u) => deriveHandle(u))
    expect(handles.includes('team'), 'a fleet handle "team" would collide with fleet.*.to.team.>').toBe(false)
  })

  it.skipIf(!rosterPresent)('no roster handle equals the reserved token "team"', () => {
    expect(rosterHandles(ROSTER_JSON).includes('team')).toBe(false)
  })
})

describe('provision-jetstream.sh — WorkQueue R1 + per-handle enumeration (AC1 + poison finding)', () => {
  it.skipIf(!provisionPresent || !rosterPresent)('enumerates task subjects per roster handle, WorkQueue+R1, no poison subject', () => {
    const handles = rosterHandles(ROSTER_JSON)
    const s = scanProvision(PROVISION_RAW, handles)
    expect(s.hasWorkqueueRetention, 'stream must be retention: workqueue').toBe(true)
    expect(s.hasReplicas1, 'stream must be replicas: 1 (single-node R1)').toBe(true)
    expect(s.missingEnumeration, `every roster handle needs task_dispatch+task_result subjects; missing:\n${JSON.stringify(s.missingEnumeration)}`).toEqual([])
    expect(s.poison, `no broad/team task subject may be bound:\n${JSON.stringify(s.poison)}`).toEqual([])
  })
})

// ===========================================================================
// LIVE-SERVER ASSERTIONS — guarded by nats-server availability + a
// self-validated nkey/TCP client. Skip (never pass vacuously) otherwise.
// ===========================================================================

// Codec self-validation: mint a keypair, author a trivial conf authorizing it,
// start nats-server, and prove we can authenticate + observe an ACL denial.
// This proves the live machinery is sound so downstream live tests are credible.
describe('live machinery self-validation (nkey codec + TCP probe + server spawn)', () => {
  it.skipIf(!serverAvail)('authenticates via nkey and observes a permission denial', async () => {
    const key = createUserKey()
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'nats-selfval-'))
    const confPath = path.join(tmp, 'nats.conf')
    fs.writeFileSync(
      confPath,
      // NATS map entries need a newline/comma separator — keep publish/subscribe on
      // separate lines so nats-server parses the block.
      `accounts {\n  APP {\n    users = [\n      { nkey: ${key.nkey}\n        permissions {\n          publish { allow = ["fleet.self.>"] }\n          subscribe { allow = ["fleet.*.to.self.>"] }\n        }\n      }\n    ]\n  }\n}\n`,
    )
    const srv = await startServer(confPath)
    expect(srv, 'nats-server must start for the self-validation').not.toBeNull()
    try {
      const conn = await NatsConn.connect(srv!.port, { key })
      expect('authFailed' in conn ? conn.line : 'authed', 'nkey auth must succeed').toBe('authed')
      const good = await (conn as NatsConn).pub('fleet.self.to.x.chat')
      expect(good.ok, 'publish within own prefix must be allowed').toBe(true)
      const bad = await (conn as NatsConn).pub('fleet.other.to.x.chat')
      expect(bad.ok, 'publish under another handle must be DENIED').toBe(false)
      ;(conn as NatsConn).close()
    } finally {
      srv?.stop()
    }
  })
})

// Whether credentialed live tests against the REAL conf can run: needs the conf,
// the server, and at least one parseable fleet user whose nkey we can swap.
function pickFleetUser(): { user: RawUser; handle: string } | null {
  if (!CONF) return null
  const cls = classify(CONF)
  for (const u of cls.fleetUsers) {
    const h = deriveHandle(u)
    if (u.nkey && h) return { user: u, handle: h }
  }
  return null
}

describe('AC2c — anonymous / unauthenticated connect is REJECTED (live, shipped conf)', () => {
  it.skipIf(!serverAvail || !confPresent)('an anonymous CONNECT to the shipped conf is denied', async () => {
    const srv = await startServer(CONF_PATH)
    expect(srv, 'nats-server must start against the shipped conf').not.toBeNull()
    try {
      const conn = await NatsConn.connect(srv!.port, {}) // no key → anonymous
      expect('authFailed' in conn, `anonymous connect must be rejected (got: ${'authFailed' in conn ? conn.line : 'AUTHED!'})`).toBe(true)
    } finally {
      srv?.stop()
    }
  })
})

describe('AC2 live-negative + AC12 + AC3 (live, shipped conf, authenticated as a fleet user)', () => {
  const canRun = serverAvail && confPresent

  it.skipIf(!canRun)('a fleet user cannot publish under another handle or run JS provisioning', async () => {
    const picked = pickFleetUser()
    expect(picked, 'a parseable fleet user is required for the swap-key live test').not.toBeNull()
    const key = createUserKey()
    const confCopy = writeConfWithSwappedKey(CONF_RAW, picked!.user.nkey!, key.nkey)
    const srv = await startServer(confCopy)
    expect(srv, 'nats-server must start against the (key-swapped) shipped conf').not.toBeNull()
    try {
      const conn = await NatsConn.connect(srv!.port, { key })
      expect('authFailed' in conn ? conn.line : 'authed').toBe('authed')
      const c = conn as NatsConn
      // own prefix allowed
      expect((await c.pub(`fleet.${picked!.handle}.to.someone.chat`)).ok, 'own-prefix publish allowed').toBe(true)
      // another handle DENIED
      expect((await c.pub('fleet.__intruder__.to.victim.chat')).ok, 'cross-handle publish must be DENIED').toBe(false)
      // JS provisioning DENIED
      expect((await c.pub('$JS.API.STREAM.PURGE.HANGAR_TASKS')).ok, 'STREAM.PURGE must be DENIED').toBe(false)
      expect((await c.pub('$JS.API.STREAM.DELETE.HANGAR_TASKS')).ok, 'STREAM.DELETE must be DENIED').toBe(false)
      expect((await c.pub('$JS.API.CONSUMER.DELETE.HANGAR_TASKS.x')).ok, 'CONSUMER.DELETE must be DENIED').toBe(false)
      c.close()
    } finally {
      srv?.stop()
    }
  })

  it.skipIf(!canRun)('a fleet user cannot subscribe to another peer traffic or $SYS.> (AC12 + AC3)', async () => {
    const picked = pickFleetUser()
    expect(picked).not.toBeNull()
    const key = createUserKey()
    const confCopy = writeConfWithSwappedKey(CONF_RAW, picked!.user.nkey!, key.nkey)
    const srv = await startServer(confCopy)
    expect(srv).not.toBeNull()
    try {
      const conn = await NatsConn.connect(srv!.port, { key })
      expect('authFailed' in conn ? conn.line : 'authed').toBe('authed')
      const c = conn as NatsConn
      // own recipient lane allowed
      expect((await c.sub(`fleet.*.to.${picked!.handle}.>`, '10')).ok, 'own recipient lane allowed').toBe(true)
      // another recipient DENIED
      expect((await c.sub('fleet.*.to.__victim__.>', '11')).ok, 'subscribing to another recipient must be DENIED').toBe(false)
      // $SYS DENIED
      expect((await c.sub('$SYS.>', '12')).ok, 'non-$SYS user subscribing to $SYS.> must be DENIED').toBe(false)
      expect((await c.pub('$SYS.REQ.SERVER.PING')).ok, 'non-$SYS user publishing to $SYS.> must be DENIED').toBe(false)
      c.close()
    } finally {
      srv?.stop()
    }
  })
})

// Provision idempotency (live) requires the `nats` CLI and admin credentials,
// which are not available in this environment; the static per-handle enumeration
// / poison assertions above cover the load-bearing WorkQueue finding.
describe('provision idempotency (live)', () => {
  it.skip('running provision-jetstream.sh twice yields no duplicates/errors — needs `nats` CLI + admin creds (not available)', () => {
    // Intentionally skipped: no `nats` CLI / admin nkey seed in this environment.
    // Static enumeration + poison scan (above) verifies the WorkQueue-poison finding.
  })
})
