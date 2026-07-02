import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { installLifecycleShutdown } from './lifecycle.ts'

function harness() {
  const stdin = new EventEmitter()
  const proc = new EventEmitter()
  const exit = vi.fn()
  const cleanup = vi.fn()
  const onShutdown = vi.fn()
  installLifecycleShutdown({
    stdin: stdin as unknown as Pick<import('node:stream').Readable, 'on'>,
    proc: proc as unknown as Pick<NodeJS.Process, 'on'>,
    exit,
    cleanup,
    onShutdown,
  })
  return { stdin, proc, exit, cleanup, onShutdown }
}

describe('installLifecycleShutdown', () => {
  it('exits(0) + cleans up on stdin end (parent death)', () => {
    const h = harness()
    h.stdin.emit('end')
    expect(h.onShutdown).toHaveBeenCalledWith('stdin_end')
    expect(h.cleanup).toHaveBeenCalledOnce()
    expect(h.exit).toHaveBeenCalledWith(0)
  })

  it('exits(0) on stdin close', () => {
    const h = harness()
    h.stdin.emit('close')
    expect(h.onShutdown).toHaveBeenCalledWith('stdin_close')
    expect(h.exit).toHaveBeenCalledWith(0)
  })

  it('exits(0) on SIGTERM and SIGINT', () => {
    const term = harness()
    term.proc.emit('SIGTERM')
    expect(term.exit).toHaveBeenCalledWith(0)

    const int = harness()
    int.proc.emit('SIGINT')
    expect(int.exit).toHaveBeenCalledWith(0)
  })

  it('shuts down exactly once even if multiple triggers fire', () => {
    const h = harness()
    h.stdin.emit('end')
    h.stdin.emit('close')
    h.proc.emit('SIGTERM')
    expect(h.exit).toHaveBeenCalledTimes(1)
    expect(h.cleanup).toHaveBeenCalledTimes(1)
    expect(h.onShutdown).toHaveBeenCalledTimes(1)
  })

  it('flows stdin via resume() so EOF is actually detected', () => {
    const stdin = Object.assign(new EventEmitter(), { resume: vi.fn() })
    installLifecycleShutdown({
      stdin: stdin as unknown as Pick<import('node:stream').Readable, 'on'>,
      proc: new EventEmitter() as unknown as Pick<NodeJS.Process, 'on'>,
      exit: vi.fn(),
    })
    expect(stdin.resume).toHaveBeenCalledOnce()
  })

  it('still exits if cleanup throws', () => {
    const stdin = new EventEmitter()
    const exit = vi.fn()
    installLifecycleShutdown({
      stdin: stdin as unknown as Pick<import('node:stream').Readable, 'on'>,
      proc: new EventEmitter() as unknown as Pick<NodeJS.Process, 'on'>,
      exit,
      cleanup: () => { throw new Error('boom') },
    })
    stdin.emit('end')
    expect(exit).toHaveBeenCalledWith(0)
  })
})
