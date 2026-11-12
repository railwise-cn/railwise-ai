import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  consumeInteractiveCredentialHelperAccess,
  credentialHelperExecutable,
  credentialHelperEnvironment,
  credentialHelperLaunch,
  credentialHelperProcessConfig,
  credentialHelperUserDataPath,
  credentialHelperReadyPid,
  credentialHelperTimeoutMs,
  createCredentialHelperWatchdog,
  createCredentialHelperRequestScheduler,
  IM_CREDENTIAL_HELPER_TIMEOUT_MS,
  IM_CREDENTIAL_HELPER_INTERACTIVE_TIMEOUT_MS,
  imCredentialHelperSocketBase,
  isCredentialHelperAuthorizationFailure,
  isInteractiveImCredentialHelperProcess,
  isImCredentialHelperProcess,
  killCredentialHelperPid,
  killCredentialHelperProcessTree,
  requestInteractiveCredentialHelperAccess
} from './im-credential-helper'
import { DEFAULT_CREDENTIAL_OPERATION_TIMEOUT_MS } from './im-credential-service'

describe('IM credential helper', () => {
  it('recognizes only the dedicated helper process argument', () => {
    expect(isImCredentialHelperProcess(['WorkWise', '--im-credential-helper'])).toBe(true)
    expect(isImCredentialHelperProcess(['WorkWise', '--other-mode'])).toBe(false)
  })

  it('activates Keychain authorization only for one explicitly requested helper', () => {
    expect(isInteractiveImCredentialHelperProcess([
      'WorkWise', '--im-credential-helper', '--im-credential-helper-interactive'
    ])).toBe(true)
    expect(isInteractiveImCredentialHelperProcess(['WorkWise', '--im-credential-helper'])).toBe(false)
    requestInteractiveCredentialHelperAccess()
    expect(consumeInteractiveCredentialHelperAccess()).toBe(true)
    expect(consumeInteractiveCredentialHelperAccess()).toBe(false)
  })

  it('identifies authorization timeouts and denials without treating transport failures as prompts', () => {
    expect(isCredentialHelperAuthorizationFailure(Object.assign(new Error('timeout'), {
      code: 'credential_helper_timeout'
    }))).toBe(true)
    expect(isCredentialHelperAuthorizationFailure(Object.assign(new Error('denied'), {
      code: 'credential_helper_access_denied'
    }))).toBe(true)
    expect(isCredentialHelperAuthorizationFailure(Object.assign(new Error('socket'), {
      code: 'credential_helper_socket'
    }))).toBe(false)
  })

  it('transfers credential payloads through a local socket without logging them or adding them to argv', async () => {
    const source = await readFile(new URL('./im-credential-helper.ts', import.meta.url), 'utf8')
    expect(source).toContain('socket.write(`${encodeMessage({ operation: request.operation, value: request.value })}\\n`)')
    expect(source).toContain('socket must remain inside its private root')
    expect(source).not.toContain('console.')
    expect(source).not.toMatch(/helperArgs\([^)]*(value|secret|request)/)
  })

  it('uses a short socket root on macOS even when candidate userData is deeply nested', () => {
    expect(imCredentialHelperSocketBase('darwin', '/a/very/long/system/temp/path')).toBe('/tmp')
    const longestExpectedSocket = '/tmp/workwise-im-2147483647-123456789abc/ch-1234567890abcdef.sock'
    expect(Buffer.byteLength(longestExpectedSocket)).toBeLessThan(104)
  })

  it('bounds non-interactive Keychain authorization without failing immediately', () => {
    expect(IM_CREDENTIAL_HELPER_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
    expect(IM_CREDENTIAL_HELPER_TIMEOUT_MS).toBeLessThan(DEFAULT_CREDENTIAL_OPERATION_TIMEOUT_MS)
  })

  it.each([false, true])('uses the same parent/child deadline and permits watchdog cancellation (interactive=%s)', (interactive) => {
    vi.useFakeTimers()
    const exitProcess = vi.fn()
    const timeout = credentialHelperTimeoutMs(interactive)
    expect(timeout).toBe(interactive ? IM_CREDENTIAL_HELPER_INTERACTIVE_TIMEOUT_MS : IM_CREDENTIAL_HELPER_TIMEOUT_MS)
    expect(timeout).toBe(interactive ? 120_000 : 30_000)
    const watchdog = createCredentialHelperWatchdog(exitProcess, interactive)
    try {
      vi.advanceTimersByTime(timeout - 1_001)
      expect(exitProcess).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exitProcess).toHaveBeenCalledWith(1)
      const cancelledExit = vi.fn()
      const cancelledWatchdog = createCredentialHelperWatchdog(cancelledExit, interactive)
      clearTimeout(cancelledWatchdog)
      vi.advanceTimersByTime(timeout)
      expect(cancelledExit).not.toHaveBeenCalled()
    } finally {
      clearTimeout(watchdog)
      vi.useRealTimers()
    }
  })

  it('forwards only required process state and candidate paths to the helper', () => {
    const env = credentialHelperEnvironment({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: '/private/tmp/candidate/old/WorkWise',
      DEEPSEEK_API_KEY: 'must-not-be-forwarded'
    })
    expect(env).toMatchObject({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate',
      WORKWISE_STARTUP_TRACE: '0'
    })
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY')
    expect(env).not.toHaveProperty('WORKWISE_CANDIDATE_CREDENTIAL_HELPER')
  })

  it('selects a stable candidate helper without forwarding its override to the child', () => {
    const config = credentialHelperProcessConfig({
      HOME: '/Users/tester',
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: '/private/tmp/candidate/authorized/WorkWise',
      DEEPSEEK_API_KEY: 'must-not-be-forwarded'
    }, '/private/tmp/candidate/current/WorkWise')

    expect(config.executable).toBe('/private/tmp/candidate/authorized/WorkWise')
    expect(config.env).not.toHaveProperty('WORKWISE_CANDIDATE_CREDENTIAL_HELPER')
    expect(config.env).not.toHaveProperty('DEEPSEEK_API_KEY')
  })

  it('derives candidate helper data from the isolated environment instead of Electron defaults', () => {
    expect(credentialHelperUserDataPath({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate',
      WORKWISE_CANDIDATE_USER_DATA: '/private/tmp/candidate/user-data'
    }, '/Users/tester/Library/Application Support/WorkWise')).toBe(
      '/private/tmp/candidate/user-data/credential-helper'
    )
    expect(credentialHelperUserDataPath({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate'
    }, '/Users/tester/Library/Application Support/WorkWise')).toBe(
      '/private/tmp/candidate/user-data/credential-helper'
    )
    expect(credentialHelperUserDataPath({}, '/Users/tester/Library/Application Support/WorkWise')).toBe(
      '/Users/tester/Library/Application Support/WorkWise/credential-helper'
    )
  })

  it('accepts only a valid helper ready PID and can reap that exact process', () => {
    expect(credentialHelperReadyPid({ type: 'ready', pid: 4242 })).toBe(4242)
    expect(credentialHelperReadyPid({ type: 'ready', pid: 1 })).toBeUndefined()
    expect(credentialHelperReadyPid({ type: 'result', pid: 4242 })).toBeUndefined()

    const killProcess = vi.fn()
    killCredentialHelperPid(4242, killProcess as typeof process.kill)
    expect(killProcess).toHaveBeenCalledWith(4242, 'SIGKILL')
  })

  it('uses LaunchServices only for a packaged macOS candidate helper', () => {
    const args = ['--im-credential-helper', '--user-data-dir=/private/tmp/candidate/user-data/credential-helper']
    const candidate = credentialHelperLaunch({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate'
    }, '/Users/tester/Documents/Candidates/WorkWise IM Recovery Candidate.app/Contents/MacOS/WorkWise IM Recovery Candidate', args, 'darwin', true)
    expect(candidate).toEqual({
      command: '/usr/bin/open',
      args: [
        '-n',
        '-W',
        '/Users/tester/Documents/Candidates/WorkWise IM Recovery Candidate.app',
        '--args',
        ...args,
        '--workwise-candidate-env-file=/private/tmp/candidate/candidate.env'
      ]
    })
    expect(credentialHelperLaunch({}, '/Applications/WorkWise.app/Contents/MacOS/WorkWise', args, 'darwin', true)).toEqual({
      command: '/Applications/WorkWise.app/Contents/MacOS/WorkWise',
      args
    })
    expect(credentialHelperLaunch({ WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: '/private/tmp/candidate' }, '/candidate/WorkWise', args, 'win32', true)).toEqual({
      command: '/candidate/WorkWise',
      args
    })
  })

  it('reaps a single-use helper after both successful and failed responses', async () => {
    const source = await readFile(new URL('./im-credential-helper.ts', import.meta.url), 'utf8')
    const finishStart = source.indexOf('const finish = (error?: Error, value?: string): void => {')
    const finishEnd = source.indexOf("server.once('error'", finishStart)
    const finishSource = source.slice(finishStart, finishEnd)

    expect(finishSource).toContain('killCredentialHelperProcessTree(child)')
    expect(finishSource).not.toContain('if (error) killCredentialHelperProcessTree(child)')
  })

  it('allows a stable credential helper only inside an explicit candidate root', () => {
    expect(credentialHelperExecutable({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/workwise-candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: '/private/tmp/workwise-candidate/previous/WorkWise'
    }, '/current/WorkWise')).toBe('/private/tmp/workwise-candidate/previous/WorkWise')
    expect(credentialHelperExecutable({
      WORKWISE_CANDIDATE: '0',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/workwise-candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: '/private/tmp/workwise-candidate/previous/WorkWise'
    }, '/current/WorkWise')).toBe('/current/WorkWise')
    expect(() => credentialHelperExecutable({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/workwise-candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: '/Applications/WorkWise.app/Contents/MacOS/WorkWise'
    }, '/current/WorkWise')).toThrow('must remain inside WORKWISE_CANDIDATE_ROOT')
    expect(() => credentialHelperExecutable({
      WORKWISE_CANDIDATE: '1',
      WORKWISE_CANDIDATE_ROOT: '/private/tmp/workwise-candidate',
      WORKWISE_CANDIDATE_CREDENTIAL_HELPER: 'relative/WorkWise'
    }, '/current/WorkWise')).toThrow('must be absolute')
  })

  it('keeps macOS Safe Storage outside the GUI main process', async () => {
    const source = await readFile(new URL('./im-credential-service.ts', import.meta.url), 'utf8')
    expect(source).toContain('encrypt: encryptStringWithCredentialHelper')
    expect(source).toContain('decrypt: decryptStringWithCredentialHelper')
  })

  it('starts the credential-only Electron helper without graphics processes', async () => {
    const source = await readFile(new URL('./im-credential-helper.ts', import.meta.url), 'utf8')
    const disableAt = source.indexOf('app.disableHardwareAcceleration()')
    const readyAt = source.indexOf('await app.whenReady()')
    expect(disableAt).toBeGreaterThan(0)
    expect(readyAt).toBeGreaterThan(disableAt)
    expect(source).toContain("app.commandLine.appendSwitch('disable-gpu')")
    expect(source).toContain("app.commandLine.appendSwitch('disable-software-rasterizer')")
    expect(source).toContain('app.focus({ steal: true })')
  })

  it('uses asynchronous Safe Storage calls so the helper watchdog remains responsive', async () => {
    const source = await readFile(new URL('./im-credential-helper.ts', import.meta.url), 'utf8')
    expect(source).toContain('await safeStorage.isAsyncEncryptionAvailable()')
    expect(source).not.toContain('safeStorage.isEncryptionAvailable(')
    expect(source).toContain('credentialHelperTimeoutMs(interactive)\n      )')
    expect(source).toContain('await safeStorage.encryptStringAsync(')
    expect(source).toContain('await safeStorage.decryptStringAsync(')
    expect(source).not.toContain('safeStorage.encryptString(')
    expect(source).not.toContain('safeStorage.decryptString(')
  })

  it('serializes different helper requests and shares identical in-flight requests', async () => {
    let active = 0
    let maxActive = 0
    const releases: Array<() => void> = []
    const runRequest = vi.fn(async (request: { operation: 'encrypt' | 'decrypt'; value: string }) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolveRequest) => releases.push(resolveRequest))
      active -= 1
      return request.value
    })
    const schedule = createCredentialHelperRequestScheduler(runRequest)

    const first = schedule({ operation: 'decrypt', value: 'cipher-a' })
    const duplicate = schedule({ operation: 'decrypt', value: 'cipher-a' })
    const second = schedule({ operation: 'decrypt', value: 'cipher-b' })
    await vi.waitFor(() => expect(runRequest).toHaveBeenCalledTimes(1))
    expect(first).toBe(duplicate)

    releases.shift()?.()
    await first
    await vi.waitFor(() => expect(runRequest).toHaveBeenCalledTimes(2))
    expect(maxActive).toBe(1)
    releases.shift()?.()
    await expect(second).resolves.toBe('cipher-b')
  })

  it('separates interactive retries from background in-flight work while deduplicating the same intent', async () => {
    const releases: Array<() => void> = []
    const runRequest = vi.fn(async (request: { operation: 'decrypt' | 'encrypt'; value: string; interactive?: boolean }) => {
      await new Promise<void>(resolve => releases.push(resolve))
      return String(request.interactive)
    })
    const schedule = createCredentialHelperRequestScheduler(runRequest)
    const background = schedule({ operation: 'decrypt', value: 'synthetic-cipher', interactive: false })
    const interactive = schedule({ operation: 'decrypt', value: 'synthetic-cipher', interactive: true })
    const duplicateInteractive = schedule({ operation: 'decrypt', value: 'synthetic-cipher', interactive: true })
    expect(interactive).not.toBe(background)
    expect(duplicateInteractive).toBe(interactive)
    await vi.waitFor(() => expect(runRequest).toHaveBeenCalledTimes(1))
    expect(runRequest.mock.calls[0][0].interactive).toBe(false)
    releases.shift()?.()
    await background
    await vi.waitFor(() => expect(runRequest).toHaveBeenCalledTimes(2))
    expect(runRequest.mock.calls[1][0].interactive).toBe(true)
    releases.shift()?.()
    await expect(interactive).resolves.toBe('true')
  })

  it('captures legacy interaction intent at enqueue time and keeps it off the socket protocol', async () => {
    const source = await readFile(new URL('./im-credential-helper.ts', import.meta.url), 'utf8')
    const scheduledRead = source.slice(source.indexOf('async function requestCredentialHelper('), source.indexOf('export function createCredentialHelperRequestScheduler('))
    expect(scheduledRead).not.toContain('consumeInteractiveCredentialHelperAccess()')
    expect(source.match(/const interactive = options\?\.interactive \?\? consumeInteractiveCredentialHelperAccess\(\)/g)).toHaveLength(2)
    expect(source).toContain('socket.write(`${encodeMessage({ operation: request.operation, value: request.value })}')
  })

  it('kills the complete detached helper process group on timeout', () => {
    const killGroup = vi.fn()
    const killChild = vi.fn()
    killCredentialHelperProcessTree({
      exitCode: null,
      signalCode: null,
      pid: 4242,
      kill: killChild
    }, 'darwin', killGroup as typeof process.kill)

    expect(killGroup).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(killChild).not.toHaveBeenCalled()
  })

  it('falls back to the direct helper when process-group cleanup is unavailable', () => {
    const killChild = vi.fn()
    killCredentialHelperProcessTree({
      exitCode: null,
      signalCode: null,
      pid: 4242,
      kill: killChild
    }, 'darwin', (() => {
      throw new Error('missing process group')
    }) as typeof process.kill)

    expect(killChild).toHaveBeenCalledWith('SIGKILL')
  })
})
