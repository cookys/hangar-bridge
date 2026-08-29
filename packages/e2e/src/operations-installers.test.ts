import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')

describe('operations installer regressions', () => {
  it.each([
    'packages/operations/claude-config/install-mcp.test.sh',
    'packages/operations/systemd/install-relay.test.sh',
  ])('%s passes in an isolated fake HOME', script => {
    const env = script.includes('/systemd/')
      ? { ...process.env, PATH: '/usr/bin:/bin' }
      : process.env
    const output = execFileSync('bash', [resolve(repoRoot, script)], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      timeout: 30_000,
    })

    expect(output).toContain('PASS:')
  })
})
