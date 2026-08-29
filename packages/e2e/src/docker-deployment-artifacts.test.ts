import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '../../..')

describe('relay Docker deployment artifacts', () => {
  it('builds the current workspace packages and uses current runtime variables', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'docker/Dockerfile.relay'), 'utf8')

    expect(dockerfile).toContain('pnpm -F @hangar-bridge/shared build')
    expect(dockerfile).toContain('pnpm -F @hangar-bridge/relay build')
    expect(dockerfile).toContain('pnpm deploy --legacy --filter @hangar-bridge/relay')
    expect(dockerfile).toContain('HANGAR_DATA=/data')
    expect(dockerfile).toContain('ARG HANGAR_BUILD_REVISION=unknown')
    expect(dockerfile).toContain('HANGAR_BUILD_REVISION=${HANGAR_BUILD_REVISION}')
    expect(dockerfile).not.toContain('@claude-mesh/')
    expect(dockerfile).not.toContain('MESH_DATA=')
  })

  it('requires an exact build revision and mounts a read-only peers roster', () => {
    const compose = readFileSync(resolve(repoRoot, 'docker/docker-compose.yml'), 'utf8')

    expect(compose).toMatch(/HANGAR_BUILD_REVISION:\s+["']?\$\{HANGAR_BUILD_REVISION:\?/)
    expect(compose).toContain('HANGAR_PEERS_FILE: /config/peers.json')
    expect(compose).toContain('${HANGAR_PEERS_FILE_HOST:?')
    expect(compose).toContain(':/config/peers.json:ro')
  })
})
