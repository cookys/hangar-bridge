import { readFileSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { ulid } from 'ulid'
import {
  ALL_MEMBER_CAPS,
  DEFAULT_GROUP_ID,
  GROUP_HISTORY,
  GROUP_ID_REGEX,
  HANGAR_TEAM_ID,
  HANDLE_REGEX,
  INTEREST_REGEX,
  MEMBER_CAPS,
  NAMESPACE_REGEX,
  SINCE_ALL,
  newMessageId,
  type GroupHistory,
  type MemberCap,
} from '@hangar-bridge/shared'
import type { Db } from '../db/db.ts'
import { logJson } from '../logger.ts'

// owned = namespaces (bare first-tokens) this peer may publish/subscribe to.
// interest = optional default narrowing patterns (exact or trailing '>').
// Regexes single-sourced from @hangar-bridge/shared (no divergent copies).
const SubjectsSchema = z.object({
  owned: z.array(z.string().regex(NAMESPACE_REGEX)).default([]),
  interest: z.array(z.string().regex(INTEREST_REGEX)).default([]),
})

const PeerEntrySchema = z.object({
  secret_sha256_hex: z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars (SHA-256)'),
  display_name: z.string().min(1).max(128).optional(),
  subjects: SubjectsSchema.optional(),
})
const StrictPeerEntrySchema = PeerEntrySchema.extend({
  default_group: z.string().regex(GROUP_ID_REGEX),
}).strict()
const GroupMemberSchema = z.object({
  caps: z.array(z.enum(MEMBER_CAPS)).optional(),
}).strict()
const GroupEntrySchema = z.object({
  description: z.string().default(''),
  history: z.enum(GROUP_HISTORY).default('since_join'),
  members: z.record(z.string().regex(HANDLE_REGEX), GroupMemberSchema),
}).strict()
export const PeersFileSchema = z.record(z.string().regex(HANDLE_REGEX), PeerEntrySchema)
export const PeersFileV2Schema = z.object({
  peers: z.record(z.string().regex(HANDLE_REGEX), StrictPeerEntrySchema),
  groups: z.record(z.string().regex(GROUP_ID_REGEX), GroupEntrySchema),
}).strict()
export type PeersFile = z.infer<typeof PeersFileSchema>

export interface PeerEntry {
  handle: string
  secret_sha256_hex: string
  display_name: string
  subjects: { owned: string[]; interest: string[] }
  default_group: string
}

export interface GroupEntry {
  id: string
  description: string
  history: GroupHistory
  members: Array<{ handle: string; caps: MemberCap[] }>
}

export interface LoadedPeersFile {
  mode: 'legacy' | 'strict'
  peers: PeerEntry[]
  groups: GroupEntry[]
}

export interface SeedDiff {
  mode: 'legacy' | 'strict'
  removed_handles: string[]
  shrunk: Array<{ handle: string; group: string; reason: 'removed' | 'caps' | 'group_deleted' }>
  grown: Array<{ handle: string; group: string }>
}

function normalizePeer(handle: string, entry: z.infer<typeof PeerEntrySchema>, defaultGroup: string): PeerEntry {
  return {
    handle,
    secret_sha256_hex: entry.secret_sha256_hex,
    display_name: entry.display_name ?? handle,
    subjects: entry.subjects ?? { owned: [], interest: [] },
    default_group: defaultGroup,
  }
}

function legacyLoaded(parsed: PeersFile, warn: boolean): LoadedPeersFile {
  const peers = Object.entries(parsed).map(([handle, entry]) => normalizePeer(handle, entry, DEFAULT_GROUP_ID))
  if (warn) logJson('warn', 'peers.legacy_mode', { peers: peers.length })
  return {
    mode: 'legacy',
    peers,
    groups: [{
      id: DEFAULT_GROUP_ID,
      description: 'migrated single group',
      history: 'all',
      members: peers.map(peer => ({ handle: peer.handle, caps: ALL_MEMBER_CAPS.slice() })),
    }],
  }
}

export function loadPeersFile(path: string): LoadedPeersFile {
  if (!existsSync(path)) {
    throw new Error(
      `peers file not found at ${path}. ` +
      `Generate it from each peer's ~/.config/hangar-bridge/secret: ` +
      `for each peer, SHA-256 the secret and write {handle: {secret_sha256_hex}} to this file (mode 0600).`
    )
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('peers file must be a JSON object')
  }
  if (!Object.prototype.hasOwnProperty.call(raw, 'peers')) {
    return legacyLoaded(PeersFileSchema.parse(raw), true)
  }
  const parsed = PeersFileV2Schema.parse(raw)
  const peers = Object.entries(parsed.peers).map(([handle, entry]) => normalizePeer(handle, entry, entry.default_group))
  const peerHandles = new Set(peers.map(peer => peer.handle))
  const memberships = new Map<string, Set<string>>()
  const groups: GroupEntry[] = Object.entries(parsed.groups).map(([id, group]) => {
    const members = Object.entries(group.members).map(([handle, member]) => {
      if (!peerHandles.has(handle)) throw new Error(`group member '${handle}' is not in peers`)
      if (!memberships.has(handle)) memberships.set(handle, new Set())
      memberships.get(handle)!.add(id)
      return { handle, caps: member.caps ?? ALL_MEMBER_CAPS.slice() }
    })
    return { id, description: group.description, history: group.history, members }
  })
  for (const peer of peers) {
    const groupsForPeer = memberships.get(peer.handle)
    if (!groupsForPeer || groupsForPeer.size === 0) throw new Error(`peer '${peer.handle}' is not in any group`)
    if (!groupsForPeer.has(peer.default_group)) throw new Error(`default_group for '${peer.handle}' is not one of its memberships`)
  }
  return { mode: 'strict', peers, groups }
}

function normalizeLoaded(peers: LoadedPeersFile | PeerEntry[]): LoadedPeersFile {
  if (Array.isArray(peers)) {
    const legacy: PeersFile = Object.fromEntries(peers.map(peer => [peer.handle, {
      secret_sha256_hex: peer.secret_sha256_hex,
      display_name: peer.display_name,
      subjects: peer.subjects,
    }]))
    return legacyLoaded(legacy, false)
  }
  return peers
}

type MembershipSnapshot = Map<string, Map<string, string>>

function snapshotMemberships(db: Db): MembershipSnapshot {
  const rows = db.prepare('SELECT group_id, handle, caps_json FROM group_member ORDER BY group_id, handle').all() as Array<{
    group_id: string; handle: string; caps_json: string
  }>
  const result: MembershipSnapshot = new Map()
  for (const row of rows) {
    if (!result.has(row.group_id)) result.set(row.group_id, new Map())
    result.get(row.group_id)!.set(row.handle, row.caps_json)
  }
  return result
}

function computeDiff(mode: 'legacy' | 'strict', before: MembershipSnapshot, after: MembershipSnapshot, removedHandles: string[]): SeedDiff {
  const beforeGroups = new Set(before.keys())
  const afterGroups = new Set(after.keys())
  const shrunk: SeedDiff['shrunk'] = []
  const grown: SeedDiff['grown'] = []
  for (const [group, beforeMembers] of before) {
    const afterMembers = after.get(group)
    for (const [handle, capsJson] of beforeMembers) {
      if (!afterMembers?.has(handle)) {
        shrunk.push({ handle, group, reason: afterGroups.has(group) ? 'removed' : 'group_deleted' })
      } else if (afterMembers.get(handle) !== capsJson) {
        shrunk.push({ handle, group, reason: 'caps' })
      }
    }
  }
  for (const [group, afterMembers] of after) {
    const beforeMembers = before.get(group)
    for (const handle of afterMembers.keys()) {
      if (!beforeMembers?.has(handle) && !beforeGroups.has(group)) {
        grown.push({ handle, group })
      } else if (!beforeMembers?.has(handle)) {
        grown.push({ handle, group })
      }
    }
  }
  return {
    mode,
    removed_handles: removedHandles.sort(),
    shrunk: shrunk.sort((a, b) => `${a.group}:${a.handle}:${a.reason}`.localeCompare(`${b.group}:${b.handle}:${b.reason}`)),
    grown: grown.sort((a, b) => `${a.group}:${a.handle}`.localeCompare(`${b.group}:${b.handle}`)),
  }
}

export function computeStrictSignals(db: Db): { strict: boolean; signals: string[] } {
  const signals: string[] = []
  const nonDefaultGroup = db.prepare('SELECT 1 AS x FROM peer_group WHERE id != ? LIMIT 1').get(DEFAULT_GROUP_ID)
  if (nonDefaultGroup) signals.push('non_default_group')
  const humanOutsideDefault = db.prepare(`
    SELECT 1 AS x
    FROM human h
    WHERE h.team_id=? AND h.disabled_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM group_member gm WHERE gm.group_id=? AND gm.handle=h.handle
      )
    LIMIT 1
  `).get(HANGAR_TEAM_ID, DEFAULT_GROUP_ID)
  if (humanOutsideDefault) signals.push('enabled_human_not_in_default_group')
  const defaultGroup = db.prepare('SELECT history FROM peer_group WHERE id=?').get(DEFAULT_GROUP_ID) as { history: string } | undefined
  if (defaultGroup && defaultGroup.history !== 'all') signals.push('default_history_not_all')
  const allCapsJson = JSON.stringify(ALL_MEMBER_CAPS)
  const narrowedDefault = db.prepare(`
    SELECT 1 AS x FROM group_member
    WHERE group_id=? AND (caps_json != ? OR since_msg_id != ?)
    LIMIT 1
  `).get(DEFAULT_GROUP_ID, allCapsJson, SINCE_ALL)
  if (narrowedDefault) signals.push('default_membership_narrowed')
  return { strict: signals.length > 0, signals }
}

/**
 * Replaces upstream's pair-code flow. Reads peers.json at relay startup and
 * upserts `human` + `token` rows so the bearer middleware can lookup by hash
 * exactly as before. The pre-seeded `team('hangar')` row is provided by the
 * schema (D10 stub posture).
 *
 * Idempotent: re-running with the same peers leaves the DB unchanged; rotating
 * a peer's secret updates that peer's token_hash and revokes the old token.
 */
export function seedPeers(db: Db, peers: LoadedPeersFile | PeerEntry[], now: Date = new Date()): SeedDiff {
  const loaded = normalizeLoaded(peers)
  const nowIso = now.toISOString()
  let diff: SeedDiff = { mode: loaded.mode, removed_handles: [], shrunk: [], grown: [] }
  const tx = db.transaction(() => {
    if (loaded.mode === 'legacy' && computeStrictSignals(db).strict) {
      throw new Error('groups_section_removed')
    }
    const before = snapshotMemberships(db)
    for (const peer of loaded.peers) {
      const hash = Buffer.from(peer.secret_sha256_hex, 'hex')
      const existingHuman = db.prepare(
        "SELECT id FROM human WHERE team_id=? AND handle=?"
      ).get(HANGAR_TEAM_ID, peer.handle) as { id: string } | undefined

      const humanId = existingHuman?.id ?? `h_${ulid()}`
      // Re-seed overwrites subjects so removing a namespace from peers.json +
      // re-seed REVOKES it. The owned-set is read once per SSE connection (M1), so
      // revocation takes effect on the next connection; in-flight streams pick it up
      // on reconnect (a relay restart, the documented re-seed path, drops all streams).
      const subjectsJson = JSON.stringify({ ...(peer.subjects ?? { owned: [], interest: [] }), default_group: peer.default_group })
      if (!existingHuman) {
        db.prepare(
          "INSERT INTO human(id,team_id,handle,display_name,subjects,created_at,last_active_at) VALUES (?,?,?,?,?,?,?)"
        ).run(humanId, HANGAR_TEAM_ID, peer.handle, peer.display_name, subjectsJson, nowIso, nowIso)
      } else {
        db.prepare(
          "UPDATE human SET display_name=?, subjects=?, disabled_at=NULL WHERE id=?"
        ).run(peer.display_name, subjectsJson, humanId)
      }

      const existingToken = db.prepare(
        "SELECT id, token_hash FROM token WHERE human_id=? AND revoked_at IS NULL"
      ).get(humanId) as { id: string; token_hash: Buffer } | undefined

      if (!existingToken || !existingToken.token_hash.equals(hash)) {
        if (existingToken) {
          db.prepare("UPDATE token SET revoked_at=? WHERE id=?").run(nowIso, existingToken.id)
        }
        db.prepare(
          "INSERT INTO token(id,human_id,token_hash,label,tier,created_at) VALUES (?,?,?,?,?,?)"
        ).run(`tk_${ulid()}`, humanId, hash, 'shared-secret', 'admin', nowIso)
      }
    }

    if (loaded.mode === 'legacy') {
      db.prepare(`
        INSERT OR IGNORE INTO peer_group(id, team_id, description, history, created_at)
        VALUES (?, ?, 'migrated single group', 'all', ?)
      `).run(DEFAULT_GROUP_ID, HANGAR_TEAM_ID, nowIso)
      const allCapsJson = JSON.stringify(ALL_MEMBER_CAPS)
      db.prepare(`
        INSERT INTO group_member(group_id, handle, caps_json, member_since, since_msg_id)
        SELECT ?, h.handle, ?, ?, ?
        FROM human h
        WHERE h.team_id=? AND h.disabled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM group_member gm WHERE gm.group_id=? AND gm.handle=h.handle
          )
      `).run(DEFAULT_GROUP_ID, allCapsJson, nowIso, SINCE_ALL, HANGAR_TEAM_ID, DEFAULT_GROUP_ID)
      db.prepare('UPDATE group_member SET caps_json=? WHERE group_id=?').run(allCapsJson, DEFAULT_GROUP_ID)
    } else {
      const desiredGroups = new Set(loaded.groups.map(group => group.id))
      const desiredPairs = new Set<string>()
      for (const group of loaded.groups) {
        db.prepare(`
          INSERT INTO peer_group(id, team_id, description, history, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            team_id=excluded.team_id,
            description=excluded.description,
            history=excluded.history
        `).run(group.id, HANGAR_TEAM_ID, group.description, group.history, nowIso)
        for (const member of group.members) {
          desiredPairs.add(`${group.id}\0${member.handle}`)
          const existing = db.prepare(
            'SELECT 1 AS x FROM group_member WHERE group_id=? AND handle=?'
          ).get(group.id, member.handle)
          const capsJson = JSON.stringify(member.caps)
          if (existing) {
            db.prepare('UPDATE group_member SET caps_json=? WHERE group_id=? AND handle=?')
              .run(capsJson, group.id, member.handle)
          } else {
            const sinceMsgId = group.history === 'all' ? SINCE_ALL : newMessageId()
            db.prepare(`
              INSERT INTO group_member(group_id, handle, caps_json, member_since, since_msg_id)
              VALUES (?, ?, ?, ?, ?)
            `).run(group.id, member.handle, capsJson, nowIso, sinceMsgId)
          }
        }
      }
      const existingMemberships = db.prepare('SELECT group_id, handle FROM group_member').all() as Array<{ group_id: string; handle: string }>
      for (const membership of existingMemberships) {
        if (!desiredPairs.has(`${membership.group_id}\0${membership.handle}`)) {
          db.prepare('DELETE FROM group_member WHERE group_id=? AND handle=?').run(membership.group_id, membership.handle)
        }
      }
      const existingGroups = db.prepare('SELECT id FROM peer_group').all() as Array<{ id: string }>
      for (const group of existingGroups) {
        if (!desiredGroups.has(group.id)) db.prepare('DELETE FROM peer_group WHERE id=?').run(group.id)
      }

      const peerHandles = new Set(loaded.peers.map(peer => peer.handle))
      const vanished = db.prepare(
        'SELECT id, handle FROM human WHERE team_id=? AND disabled_at IS NULL ORDER BY handle'
      ).all(HANGAR_TEAM_ID) as Array<{ id: string; handle: string }>
      const removedHandles: string[] = []
      for (const human of vanished) {
        if (peerHandles.has(human.handle)) continue
        removedHandles.push(human.handle)
        db.prepare('UPDATE human SET disabled_at=? WHERE id=?').run(nowIso, human.id)
        db.prepare('UPDATE token SET revoked_at=? WHERE human_id=? AND revoked_at IS NULL').run(nowIso, human.id)
        db.prepare('DELETE FROM group_member WHERE handle=?').run(human.handle)
        db.prepare(`
          INSERT INTO audit_log(team_id, at, actor_human_id, event, detail_json)
          VALUES (?, ?, NULL, 'peer.removed', ?)
        `).run(HANGAR_TEAM_ID, nowIso, JSON.stringify({ handle: human.handle }))
      }
      diff.removed_handles = removedHandles
    }
    diff = computeDiff(loaded.mode, before, snapshotMemberships(db), diff.removed_handles)
  })
  tx()
  return diff
}
