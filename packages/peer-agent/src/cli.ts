#!/usr/bin/env node
import { loadEnvFiles } from '@hangar-bridge/shared'
import { ensureMcpRegistered } from './mcp-registration.ts'

loadEnvFiles()

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv
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
  console.error('commands: init, respond, send')
  process.exit(2)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
