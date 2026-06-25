import { hostname, homedir } from 'node:os'
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runInit } from './init.ts'
import { writeProjectMcpJson } from '../mcp-registration.ts'

const HANDLE_REGEX = /^[a-z][a-z0-9_-]{0,31}$/
const PROJECT_NAME_REGEX = /^[A-Za-z0-9._-]+$/

export function deriveHandle(name: string, override?: string): string {
  if (override) {
    if (!HANDLE_REGEX.test(override)) {
      console.error(`Error: Handle "${override}" is invalid. Handles must match ${HANDLE_REGEX}.`)
      process.exit(2)
    }
    return override
  }

  // Derive handle: ${hostname()}-${name}
  const raw = `${hostname()}-${name}`.toLowerCase()
  let sanitized = raw.replace(/[^a-z0-9_-]/g, '-')
  // Collapse repeated dashes
  sanitized = sanitized.replace(/-+/g, '-')

  // Must start with [a-z], if not, prefix 'h'
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = 'h' + sanitized
  }

  // Truncate to 32 chars
  sanitized = sanitized.slice(0, 32)

  // Verify against regex
  if (!HANDLE_REGEX.test(sanitized)) {
    console.error(`Error: Derived handle "${sanitized}" is invalid. Please specify a valid handle using --handle.`)
    process.exit(2)
  }

  return sanitized
}

export interface InitProjectOpts {
  name?: string
  relayUrl: string
  handle?: string
  configDir?: string
  dir?: string
  force?: boolean
  serverName?: string
  peersFile?: string
}

export function parseProjectNameFromGitRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim()
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed)
  if (ssh?.[1] && ssh[2]) return `${ssh[1]}-${ssh[2]}`

  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() !== 'github.com') return undefined
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined
    return `${parts[0]}-${parts[1].replace(/\.git$/i, '')}`
  } catch {
    return undefined
  }
}

export function deriveProjectName(projectRoot: string, override?: string): string {
  if (override) return override

  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const fromRemote = parseProjectNameFromGitRemote(remoteUrl)
    if (fromRemote) return fromRemote
  } catch {
    // Fall back to the local directory name when git or origin is unavailable.
  }

  return basename(projectRoot)
}

export function validateProjectName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || !PROJECT_NAME_REGEX.test(name)) {
    console.error("Error: Project name must only contain alphanumeric characters, dots, underscores, and dashes, and cannot be '.' or '..' or contain path separators.")
    process.exit(2)
  }
}

function chmodRequired(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'ENOTSUP')) return
    throw err
  }
}

function suggestedDistinctName(name: string): string {
  return `${name}-laptop`
}

function abortCollision(name: string, handle: string, reason: string): never {
  throw new Error(
    `${reason} for handle "${handle}". Choose a distinct identity with --name ${suggestedDistinctName(name)} or --handle ${handle}-laptop.`
  )
}

function findReadablePeersFile(peersFile?: string): string | undefined {
  const candidates = [
    peersFile,
    process.env.HANGAR_PEERS_FILE,
    join(homedir(), '.config', 'hangar-bridge', 'peers.json'),
  ].filter((path): path is string => path !== undefined)

  return candidates.find(path => {
    try {
      readFileSync(resolve(path), 'utf8')
      return true
    } catch {
      return false
    }
  })
}

function assertNoCollision(opts: { name: string; handle: string; projectConfigDir: string; force?: boolean; peersFile?: string }): void {
  if (existsSync(opts.projectConfigDir) && !opts.force) {
    abortCollision(opts.name, opts.handle, `Project config directory already exists at ${opts.projectConfigDir}`)
  }

  const readablePeersFile = findReadablePeersFile(opts.peersFile)
  if (!readablePeersFile) {
    console.warn(
      `WARNING: no readable relay peers.json was provided via --peers-file; manually verify that handle "${opts.handle}" is not already registered before restarting the relay.`
    )
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resolve(readablePeersFile), 'utf8'))
  } catch {
    console.warn(
      `WARNING: relay peers.json at ${readablePeersFile} is not readable; manually verify that handle "${opts.handle}" is not already registered before restarting the relay.`
    )
    return
  }

  if (parsed && typeof parsed === 'object' && opts.handle in parsed) {
    abortCollision(opts.name, opts.handle, `Relay peers.json already contains an entry`)
  }
}

export async function runInitProject(opts: InitProjectOpts): Promise<void> {
  const projectRoot = resolve(opts.dir ?? process.cwd())
  const name = deriveProjectName(projectRoot, opts.name)
  validateProjectName(name)

  const handle = deriveHandle(name, opts.handle)
  const serverName = opts.serverName ?? `hangar-bridge-peers-${name}`

  // Resolve config directory
  let projectConfigDir: string
  if (opts.configDir) {
    projectConfigDir = resolve(opts.configDir)
  } else {
    const configRoot = process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, 'hangar-bridge')
      : join(homedir(), '.config', 'hangar-bridge')
    projectConfigDir = join(configRoot, 'projects', name)
  }

  assertNoCollision({
    name,
    handle,
    projectConfigDir,
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.peersFile !== undefined ? { peersFile: opts.peersFile } : {}),
  })

  // Temporarily override HANGAR_CONFIG_DIR so runInit writes to the project directory
  const originalConfigDir = process.env.HANGAR_CONFIG_DIR
  process.env.HANGAR_CONFIG_DIR = projectConfigDir

  try {
    // Run core initialization
    runInit({
      relayUrl: opts.relayUrl,
      handle,
      ...(opts.force !== undefined ? { force: opts.force } : {})
    })

    // Explicitly set directory and file modes
    chmodRequired(projectConfigDir, 0o700)
    chmodRequired(join(projectConfigDir, 'audit'), 0o700)
    chmodRequired(join(projectConfigDir, 'config.json'), 0o600)

    // Write project-scoped .mcp.json
    writeProjectMcpJson({
      dir: projectRoot,
      configDir: projectConfigDir,
      serverName,
    })

    console.log(`OK project-scoped MCP registration written to ${join(projectRoot, '.mcp.json')}`)
    console.log(`Launch Claude Code with: claude --dangerously-load-development-channels server:${serverName}`)
  } finally {
    // Restore original config dir env
    if (originalConfigDir !== undefined) {
      process.env.HANGAR_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.HANGAR_CONFIG_DIR
    }
  }
}
