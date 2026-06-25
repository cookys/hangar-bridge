import { hostname, homedir } from 'node:os'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInit } from './init.ts'
import { writeProjectMcpJson } from '../mcp-registration.ts'

const HANDLE_REGEX = /^[a-z][a-z0-9_-]{0,31}$/

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
  name: string
  relayUrl: string
  handle?: string
  configDir?: string
  dir?: string
  force?: boolean
  mcpServerName?: string
}

export async function runInitProject(opts: InitProjectOpts): Promise<void> {
  const name = opts.name
  // Validate project name against path traversal and character rules
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || !/^[A-Za-z0-9._-]+$/.test(name)) {
    console.error("Error: Project name must only contain alphanumeric characters, dots, underscores, and dashes, and cannot be '.' or '..' or contain path separators.")
    process.exit(2)
  }

  const handle = deriveHandle(name, opts.handle)

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

  const projectRoot = resolve(opts.dir ?? process.cwd())

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
    try {
      chmodSync(projectConfigDir, 0o700)
    } catch { /* Windows fallback */ }

    try {
      chmodSync(join(projectConfigDir, 'audit'), 0o700)
    } catch { /* Windows fallback */ }

    try {
      chmodSync(join(projectConfigDir, 'config.json'), 0o600)
    } catch { /* Windows fallback */ }

    // Write project-scoped .mcp.json
    writeProjectMcpJson({
      dir: projectRoot,
      configDir: projectConfigDir,
      ...(opts.mcpServerName !== undefined ? { mcpServerName: opts.mcpServerName } : {})
    })

    console.log(`OK project-scoped MCP registration written to ${join(projectRoot, '.mcp.json')}`)
  } finally {
    // Restore original config dir env
    if (originalConfigDir !== undefined) {
      process.env.HANGAR_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.HANGAR_CONFIG_DIR
    }
  }
}
