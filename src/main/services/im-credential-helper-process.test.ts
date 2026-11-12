import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, safeStorage } from 'electron'
import { imCredentialHelperSocketBase, runImCredentialHelperProcess } from './im-credential-helper'

vi.mock('electron', () => ({
  app: {
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    whenReady: vi.fn(async () => undefined),
    dock: { show: vi.fn() },
    focus: vi.fn(),
    exit: vi.fn()
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => { throw new Error('Synchronous protected-storage access is forbidden in the helper.') }),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value: string) => Buffer.from(value)),
    decryptStringAsync: vi.fn(async () => ({ result: 'synthetic-existing-secret', shouldReEncrypt: false }))
  }
}))
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: vi.fn()
}))

const originalArgv = process.argv
const ciphertext = Buffer.from('synthetic-old-ciphertext')
let responses: Array<{ type?: string; ok?: boolean; value?: string }>
let socket: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  responses = []
  vi.stubEnv('WORKWISE_CANDIDATE', '0')
  const root = join(imCredentialHelperSocketBase(), 'workwise-im-123-abcdef123456')
  process.argv = ['RailWise AI', '--im-credential-helper', '--im-credential-helper-interactive', `--im-credential-helper-socket-root=${root}`, `--im-credential-helper-socket=${root}/request.sock`]
  socket = Object.assign(new EventEmitter(), {
    write: vi.fn(() => {
      queueMicrotask(() => socket.emit('data', Buffer.from(Buffer.from(JSON.stringify({ operation: 'decrypt', value: ciphertext.toString('base64') })).toString('base64') + '\n')))
    }),
    end: vi.fn((data: string, done: () => void) => {
      responses.push(JSON.parse(Buffer.from(data.trim(), 'base64').toString()))
      done()
    })
  })
  vi.mocked(createConnection).mockReturnValue(socket as never)
  vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true)
})

afterEach(() => {
  process.argv = originalArgv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('credential helper production process entry', () => {
  it('keeps the event loop responsive during async availability and reads the original ciphertext after user authorization', async () => {
    let finishAvailability!: (value: boolean) => void
    vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockImplementationOnce(() => new Promise(resolve => { finishAvailability = resolve }))
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const original = Buffer.from(ciphertext)
    const pending = runImCredentialHelperProcess()
    await vi.waitFor(() => expect(finishAvailability).toBeTypeOf('function'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(app.focus).toHaveBeenCalledWith({ steal: true })
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 119_000)
    const watchdog = timer.mock.results.find((_result, index) => timer.mock.calls[index][1] === 119_000)?.value
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
    finishAvailability(true)
    await pending
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledExactlyOnceWith(original)
    expect(ciphertext).toEqual(original)
    expect(responses).toEqual([{ ok: true, value: Buffer.from('synthetic-existing-secret').toString('base64') }])
    expect(app.exit).toHaveBeenCalledWith(0)
    expect(clear).toHaveBeenCalledWith(watchdog)
  })

  it.each(['unavailable', 'rejected'])('closes the response and clears its watchdog after async availability is %s', async mode => {
    const original = Buffer.from(ciphertext)
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    if (mode === 'rejected') vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockRejectedValueOnce(new Error('synthetic denied'))
    else vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValueOnce(false)
    await runImCredentialHelperProcess()
    expect(responses).toEqual([{ ok: false }])
    expect(socket.end).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled()
    expect(ciphertext).toEqual(original)
    expect(clear).toHaveBeenCalled()
  })
})
