import { copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  ALL_MEMBER_CAPS,
  DEFAULT_GROUP_ID,
  GROUP_ID_REGEX,
  type MemberCap,
} from '@hangar-bridge/shared'
import { loadPeersFile, type LoadedPeersFile } from '../auth/peers-file.ts'

interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

interface CliOpts {
  now?: () => number
}

interface ParsedArgs {
  peers: string
  write: boolean
  group: string
}

type JsonObject = Record<string, unknown>

const defaultIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

function defaultPeersPath(): string {
  return process.env.HANGAR_PEERS_FILE
    ?? join(homedir(), '.config', 'hangar-bridge', 'peers.json')
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { peers: defaultPeersPath(), write: false, group: DEFAULT_GROUP_ID }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') {
      parsed.write = true
      continue
    }
    if (arg === '--peers') {
      const value = argv[i + 1]
      if (!value) throw new Error('--peers requires a path')
      parsed.peers = value
      i += 1
      continue
    }
    if (arg === '--group') {
      const value = argv[i + 1]
      if (!value) throw new Error('--group requires an id')
      parsed.group = value
      i += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (!GROUP_ID_REGEX.test(parsed.group)) throw new Error(`invalid group id: ${parsed.group}`)
  return parsed
}

function loadPeersFileWithoutLegacyLog(path: string): LoadedPeersFile {
  const originalWrite = process.stdout.write
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return loadPeersFile(path)
  } finally {
    process.stdout.write = originalWrite
  }
}

function readJsonObject(path: string): JsonObject {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('peers file must be a JSON object')
  }
  return raw as JsonObject
}

function legacyEntry(raw: JsonObject, handle: string): JsonObject {
  const entry = raw[handle]
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`legacy peer '${handle}' is not an object`)
  }
  return entry as JsonObject
}

function buildV2Document(loaded: LoadedPeersFile, raw: JsonObject, group: string): JsonObject {
  const peers: JsonObject = {}
  const members: JsonObject = {}
  for (const peer of loaded.peers) {
    const original = legacyEntry(raw, peer.handle)
    const nextPeer: JsonObject = {
      secret_sha256_hex: peer.secret_sha256_hex,
      default_group: group,
    }
    if (Object.prototype.hasOwnProperty.call(original, 'display_name')) {
      nextPeer.display_name = peer.display_name
    }
    if (Object.prototype.hasOwnProperty.call(original, 'subjects')) {
      nextPeer.subjects = {
        owned: peer.subjects.owned.slice(),
        interest: peer.subjects.interest.slice(),
      }
    }
    peers[peer.handle] = nextPeer
    members[peer.handle] = { caps: (ALL_MEMBER_CAPS as readonly MemberCap[]).slice() }
  }
  return {
    peers,
    groups: {
      [group]: {
        description: 'migrated single group',
        history: 'all',
        members,
      },
    },
  }
}

function assertWrittenStrict(path: string, original: LoadedPeersFile): void {
  const loaded = loadPeersFileWithoutLegacyLog(path)
  if (loaded.mode !== 'strict') throw new Error('written peers file did not reload in strict mode')
  const writtenPeers = new Map(loaded.peers.map(peer => [peer.handle, peer.secret_sha256_hex]))
  for (const peer of original.peers) {
    if (writtenPeers.get(peer.handle) !== peer.secret_sha256_hex) {
      throw new Error(`written peers file did not preserve hash for ${peer.handle}`)
    }
  }
}

export function peersGroupsInit(argv: readonly string[], io: CliIo = defaultIo, opts: CliOpts = {}): void {
  const args = parseArgs(argv)
  const loaded = loadPeersFileWithoutLegacyLog(args.peers)
  if (loaded.mode === 'strict') {
    io.stdout('peers.json is already v2 (strict); nothing to do\n')
    return
  }

  const raw = readJsonObject(args.peers)
  const doc = buildV2Document(loaded, raw, args.group)
  const json = `${JSON.stringify(doc, null, 2)}\n`
  const epoch = Math.floor((opts.now?.() ?? Date.now()) / 1000)

  if (!args.write) {
    io.stdout(json)
    io.stderr(`dry-run: pass --write to replace ${args.peers} (a .bak.${epoch} copy is kept)\n`)
    return
  }

  const backupPath = `${args.peers}.bak.${epoch}`
  copyFileSync(args.peers, backupPath)
  chmodSync(backupPath, 0o600)
  writeFileSync(args.peers, json, { mode: 0o600 })
  chmodSync(args.peers, 0o600)
  assertWrittenStrict(args.peers, loaded)
  io.stdout(`wrote ${args.peers} (v2, ${loaded.peers.length} peers in group ${args.group}); backup ${backupPath}\n`)
}
