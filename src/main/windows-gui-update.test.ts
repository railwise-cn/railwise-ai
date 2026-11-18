import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowsGuiUpdater } from './windows-gui-update'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('electron-updater', () => ({ default: { NsisUpdater: class {} } }))

describe('Windows verified installer handoff', () => {
  let directory: string
  let installer: string
  let cache: string
  const fileName = 'RailWise AI 安装包.exe'
  const content = 'stand-in installer bytes'
  const sha512 = createHash('sha512').update(content).digest('base64')

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'railwise-update-'))
    cache = join(directory, 'pending')
    installer = join(cache, fileName)
    await mkdir(cache)
    await writeFile(installer, content)
    spawn.mockReset()
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  function updater(isAdminRightsRequired = false): WindowsGuiUpdater {
    return Object.assign(new WindowsGuiUpdater(), {
      installerPath: installer,
      downloadedUpdateHelper: { cacheDirForPendingUpdate: cache, downloadedFileInfo: { fileName, sha512, isAdminRightsRequired } }
    })
  }

  function child() {
    return Object.assign(new EventEmitter(), { unref: vi.fn() })
  }

  it('waits for the actual spawn and sends silent NSIS update arguments separately', async () => {
    const process = child()
    spawn.mockReturnValue(process)
    const update = updater()
    update.installDirectory = join(directory, '应用 目录')
    let acknowledged = false
    const result = update.startVerifiedInstaller().then(() => { acknowledged = true })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    expect(spawn).toHaveBeenCalledWith(expect.stringContaining(fileName), ['--updated', '/S', '--force-run', `/D=${update.installDirectory}`], {
      detached: true, stdio: 'ignore', shell: false
    })
    expect(acknowledged).toBe(false)
    process.emit('spawn')
    await result
    expect(process.unref).toHaveBeenCalledOnce()
  })

  it('rejects a replaced installer and does not attempt launch', async () => {
    await writeFile(installer, 'different bytes')
    await expect(updater().startVerifiedInstaller()).rejects.toThrow('安装包已变化')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns a missing executable as a failure without opening or repeating the process', async () => {
    const process = child()
    spawn.mockImplementation(() => {
      queueMicrotask(() => process.emit('error', Object.assign(new Error('missing file'), { code: 'ENOENT' })))
      return process
    })
    await expect(updater().startVerifiedInstaller()).rejects.toThrow('missing file')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('surfaces rejected elevation instead of treating the helper spawn as installation handoff', async () => {
    vi.stubGlobal('process', Object.assign(Object.create(process), { resourcesPath: directory }))
    const elevation = child()
    spawn.mockImplementation(() => {
      queueMicrotask(() => elevation.emit('exit', 1223, null))
      return elevation
    })
    await expect(updater(true).startVerifiedInstaller()).rejects.toThrow('提权未完成')
    expect(spawn).toHaveBeenCalledWith(join(directory, 'elevate.exe'), [expect.stringContaining(fileName), '--updated', '/S', '--force-run'], expect.objectContaining({ shell: false }))
  })
})
