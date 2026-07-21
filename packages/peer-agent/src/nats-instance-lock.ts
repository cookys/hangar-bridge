import {
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { defaultNatsInstanceLockPath } from './paths.ts'

export interface NatsInstanceGuard {
  acquire(): void
  release(): void
}

interface LockOwner {
  pid: number
  nonce: string
  handle: string
  started_at: string
}

function isAlreadyExists(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'EEXIST'
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * NATS tasks are addressed to a handle-level durable consumer, not an MCP session.
 * Until session-addressed routing exists, one live peer-agent per local handle is a
 * correctness requirement: otherwise a result can be consumed by the wrong session.
 *
 * An atomic directory provides a dependency-free process lock. A well-formed lock
 * owned by a dead PID is reclaimed once; malformed locks fail closed for operator
 * inspection instead of deleting an unknown path.
 */
export class FileNatsInstanceGuard implements NatsInstanceGuard {
  private readonly nonce = randomBytes(16).toString('hex')
  private held = false

  constructor(
    private readonly handle: string,
    private readonly lockPath = defaultNatsInstanceLockPath(handle),
  ) {}

  acquire(): void {
    if (this.held) return
    mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.lockPath, { mode: 0o700 })
        const owner: LockOwner = {
          pid: process.pid,
          nonce: this.nonce,
          handle: this.handle,
          started_at: new Date().toISOString(),
        }
        writeFileSync(this.ownerPath(), JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
        this.held = true
        return
      } catch (err) {
        if (!isAlreadyExists(err)) throw err
        const owner = this.readOwner()
        if (!owner || owner.handle !== this.handle) {
          throw new Error(`NATS instance lock is malformed; inspect ${this.lockPath}`)
        }
        if (processIsAlive(owner.pid)) {
          throw new Error(
            `NATS peer-agent for handle ${this.handle} is already running (pid ${owner.pid}); ` +
            'one live MCP session per NATS handle is currently supported',
          )
        }
        this.removeOwnedLock(owner)
      }
    }
    throw new Error(`could not acquire NATS instance lock: ${this.lockPath}`)
  }

  release(): void {
    if (!this.held) return
    const owner = this.readOwner()
    if (owner?.pid === process.pid && owner.nonce === this.nonce && owner.handle === this.handle) {
      this.removeOwnedLock(owner)
    }
    this.held = false
  }

  private ownerPath(): string {
    return join(this.lockPath, 'owner.json')
  }

  private readOwner(): LockOwner | null {
    try {
      const value = JSON.parse(readFileSync(this.ownerPath(), 'utf8')) as Partial<LockOwner>
      if (
        typeof value.pid !== 'number'
        || typeof value.nonce !== 'string'
        || typeof value.handle !== 'string'
        || typeof value.started_at !== 'string'
      ) return null
      return value as LockOwner
    } catch {
      return null
    }
  }

  private removeOwnedLock(owner: LockOwner): void {
    const current = this.readOwner()
    if (!current || current.pid !== owner.pid || current.nonce !== owner.nonce) {
      throw new Error(`NATS instance lock changed while being reclaimed: ${this.lockPath}`)
    }
    unlinkSync(this.ownerPath())
    rmdirSync(this.lockPath)
  }
}
