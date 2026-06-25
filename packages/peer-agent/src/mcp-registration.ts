import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export function ensureMcpRegistered(): void {
  const path = join(homedir(), '.claude.json')
  let json: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    catch { json = {} }
  }
  const mcpServers = (json.mcpServers as Record<string, unknown> | undefined) ?? {}
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = {
    command: process.execPath,
    args: [resolve(join(here, 'index.js'))]
  }
  if (JSON.stringify(mcpServers['hangar-bridge-peers']) === JSON.stringify(entry)) return
  mcpServers['hangar-bridge-peers'] = entry
  json.mcpServers = mcpServers
  writeFileSync(path, JSON.stringify(json, null, 2))
}

export interface WriteProjectMcpJsonOpts {
  dir: string
  configDir: string
  serverName: string
}

export function writeProjectMcpJson(opts: WriteProjectMcpJsonOpts): void {
  const path = join(opts.dir, '.mcp.json')
  let json: Record<string, any> = {}
  if (existsSync(path)) {
    try {
      json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    } catch {
      json = {}
    }
  }
  const mcpServers = (json.mcpServers as Record<string, any> | undefined) ?? {}
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = {
    command: process.execPath,
    args: [resolve(join(here, 'index.js'))],
    env: {
      HANGAR_CONFIG_DIR: resolve(opts.configDir)
    }
  }
  mcpServers[opts.serverName] = entry
  json.mcpServers = mcpServers
  writeFileSync(path, JSON.stringify(json, null, 2))
}
