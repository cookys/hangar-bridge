#!/usr/bin/env node
import { loadEnvFiles } from '@hangar-bridge/shared'
import { ensureMcpRegistered } from './mcp-registration.ts'
import { argValue } from './cli/args.ts'
import type { InitProjectOpts } from './cli/init-project.ts'

loadEnvFiles()

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv
  if (cmd === 'init-project') {
    const name = args[0]
    const relayUrl = argValue(args, '--relay') ?? process.env.HANGAR_RELAY
    const handle = argValue(args, '--handle')
    const configDirOpt = argValue(args, '--config-dir')
    const dir = argValue(args, '--dir') ?? process.cwd()
    const force = args.includes('--force')
    const mcpServerName = argValue(args, '--mcp-server-name')

    if (!name || name.startsWith('--') || !relayUrl) {
      console.error('usage: hangar-bridge init-project <name> --relay <url> [--handle <handle>] [--config-dir <dir>] [--dir <project-root>] [--force] [--mcp-server-name <name>]')
      process.exit(2)
    }

    const { runInitProject } = await import('./cli/init-project.ts')
    const opts: InitProjectOpts = {
      name,
      relayUrl: relayUrl,
      ...(handle !== undefined ? { handle } : {}),
      ...(configDirOpt !== undefined ? { configDir: configDirOpt } : {}),
      ...(dir !== undefined ? { dir } : {}),
      ...(force !== undefined ? { force } : {}),
      ...(mcpServerName !== undefined ? { mcpServerName } : {})
    }
    await runInitProject(opts)
    return
  }
  if (cmd === 'init') {
    const handle = argValue(args, '--handle') ?? process.env.HOSTNAME
    const relayUrl = argValue(args, '--relay') ?? process.env.HANGAR_RELAY
    const force = args.includes('--force')
    if (!handle || !relayUrl) {
      console.error('usage: hangar-bridge init --handle <name> --relay <url> [--force]')
      process.exit(2)
    }
    const { runInit } = await import('./cli/init.ts')
    runInit({ handle, relayUrl, force })
    ensureMcpRegistered()
    console.log('OK MCP server entry added to ~/.claude.json under "hangar-bridge-peers"')
    return
  }
  if (cmd === 'respond') {
    const { runRespond } = await import('./cli/respond.ts')
    await runRespond(args)
    return
  }
  if (cmd === 'send') {
    const { runSend } = await import('./cli/send.ts')
    await runSend(args)
    return
  }
  console.error('commands: init, init-project, respond, send')
  process.exit(2)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
