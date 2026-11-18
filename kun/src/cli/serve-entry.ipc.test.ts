import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isManagedRuntimeShutdownReady,
  MANAGED_RUNTIME_SHUTDOWN_READY,
  MANAGED_RUNTIME_SHUTDOWN_REQUEST
} from '../contracts/managed-runtime-ipc.js'

async function launchServe(connected: boolean) {
  vi.resetModules()
  const close = vi.fn<() => Promise<void>>()
  const child = Object.assign(new EventEmitter(), {
    argv: ['node', 'kun', 'serve', '--port', '0'],
    env: {},
    connected,
    send: connected ? vi.fn() : undefined,
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
    exit: vi.fn()
  })
  vi.doMock('node:process', () => ({ default: child }))
  vi.doMock('./serve.js', () => ({
    SERVE_USAGE: '',
    ServeExitCode: { ok: 0, runtime: 1 },
    parseServeOptionsSafe: () => ({ ok: true, options: {} })
  }))
  vi.doMock('./agent-cli.js', () => ({
    KUN_CLI_USAGE: '',
    runAgentCommand: vi.fn(),
    splitKunCliCommand: () => ({ command: 'serve', args: ['--port', '0'] })
  }))
  vi.doMock('../server/runtime-factory.js', () => ({
    startKunServe: async () => ({
      host: '127.0.0.1',
      port: 10793,
      runtime: { info: () => ({ pid: 123 }) },
      close
    })
  }))
  await import('./serve-entry.js')
  await vi.waitFor(() => expect(child.stdout.write).toHaveBeenCalled())
  const marker = child.stdout.write.mock.calls[0]![0] as string
  expect(JSON.parse(marker.slice('KUN_READY '.length))).toMatchObject({ ipcShutdown: connected })
  if (connected) {
    expect(child.send).toHaveBeenCalledExactlyOnceWith(MANAGED_RUNTIME_SHUTDOWN_READY, expect.any(Function))
    expect(child.send!.mock.invocationCallOrder[0]!).toBeLessThan(child.stdout.write.mock.invocationCallOrder[0]!)
  }
  return { child, close }
}

afterEach(() => {
  vi.doUnmock('node:process')
  vi.doUnmock('./serve.js')
  vi.doUnmock('./agent-cli.js')
  vi.doUnmock('../server/runtime-factory.js')
  vi.resetModules()
})

describe('managed Runtime serve shutdown', () => {
  it('accepts the exact request on parent IPC and exits after a single close', async () => {
    const { child, close } = await launchServe(true)
    let completeClose!: () => void
    close.mockImplementation(() => new Promise(resolve => { completeClose = resolve }))
    child.emit('message', { ...MANAGED_RUNTIME_SHUTDOWN_REQUEST, extra: true })
    child.emit('message', { ...MANAGED_RUNTIME_SHUTDOWN_REQUEST, version: '1' })
    expect(close).not.toHaveBeenCalled()

    child.emit('message', MANAGED_RUNTIME_SHUTDOWN_REQUEST)
    child.emit('message', MANAGED_RUNTIME_SHUTDOWN_REQUEST)
    child.emit('SIGTERM')
    expect(close).toHaveBeenCalledOnce()
    expect(child.exit).not.toHaveBeenCalled()

    completeClose()
    await vi.waitFor(() => expect(child.exit).toHaveBeenCalledWith(0))
    for (const event of ['message', 'SIGTERM', 'SIGINT']) expect(child.listenerCount(event)).toBe(0)
  })

  it('accepts only the exact readiness message and retains stdout startup if its IPC send fails', async () => {
    const { child, close } = await launchServe(true)
    expect(isManagedRuntimeShutdownReady(MANAGED_RUNTIME_SHUTDOWN_READY)).toBe(true)
    expect(isManagedRuntimeShutdownReady(MANAGED_RUNTIME_SHUTDOWN_REQUEST)).toBe(false)
    expect(isManagedRuntimeShutdownReady({ ...MANAGED_RUNTIME_SHUTDOWN_READY, retry: true })).toBe(false)
    const [, reportFailure] = child.send!.mock.calls[0]!
    reportFailure(new Error('controlled IPC send failure'))
    expect(child.stderr.write).toHaveBeenCalledWith(expect.stringContaining('controlled IPC send failure'))
    expect(child.stdout.write).toHaveBeenCalledWith(expect.stringContaining('KUN_READY '))
    close.mockResolvedValue(undefined)
    child.emit('message', MANAGED_RUNTIME_SHUTDOWN_REQUEST)
    await vi.waitFor(() => expect(child.exit).toHaveBeenCalledWith(0))
  })

  it('reports cleanup failure on signal without advertising IPC on a standalone launch', async () => {
    const { child, close } = await launchServe(false)
    close.mockRejectedValue(new Error('controlled cleanup failure'))
    expect(child.send).toBeUndefined()
    expect(child.listenerCount('message')).toBe(0)
    child.emit('SIGINT')
    await vi.waitFor(() => expect(child.exit).toHaveBeenCalledWith(1))
    expect(child.stderr.write).toHaveBeenCalledWith(expect.stringContaining('controlled cleanup failure'))
    expect(close).toHaveBeenCalledOnce()
  })
})
