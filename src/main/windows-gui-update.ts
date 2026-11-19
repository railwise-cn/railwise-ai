import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import electronUpdater from 'electron-updater'

export class WindowsUpdateCacheError extends Error {
  constructor() {
    super('已下载的 Windows 安装包已丢失或发生变化，请重新下载更新。')
  }
}

/** Keeps electron-updater's feed, download cache and signature verification. */
export class WindowsGuiUpdater extends electronUpdater.NsisUpdater {
  async startVerifiedInstaller(isCurrent: () => boolean = () => true): Promise<void> {
    const cache = this.downloadedUpdateHelper
    const invalidCache = (): WindowsUpdateCacheError => {
      // Recreate the cache reader so the next download checks the on-disk
      // checksum instead of reusing the same-session existence-only fast path.
      if (this.downloadedUpdateHelper === cache && isCurrent()) this.downloadedUpdateHelper = null
      return new WindowsUpdateCacheError()
    }
    const installer = this.installerPath
    const info = cache?.downloadedFileInfo
    if (!cache || !installer || !info || cache.packageFile) {
      throw invalidCache()
    }
    if (!isAbsolute(installer) || extname(installer).toLowerCase() !== '.exe' || basename(installer) !== info.fileName) {
      throw invalidCache()
    }
    let path: string
    try {
      const [resolvedInstaller, resolvedCache, entry] = await Promise.all([
        realpath(installer), realpath(cache.cacheDirForPendingUpdate), lstat(installer)
      ])
      if (!entry.isFile() || dirname(resolvedInstaller) !== resolvedCache) throw new WindowsUpdateCacheError()
      const digest = createHash('sha512')
      for await (const chunk of createReadStream(resolvedInstaller)) digest.update(chunk)
      if (digest.digest('base64') !== info.sha512) throw new WindowsUpdateCacheError()
      path = resolvedInstaller
    } catch {
      throw invalidCache()
    }
    if (cache.downloadedFileInfo !== info || this.installerPath !== installer || !isCurrent()) {
      throw new Error('更新渠道或安装包版本已变化，请重新检查更新。')
    }

    const args = ['--updated', '/S', '--force-run']
    if (this.installDirectory) args.push(`/D=${this.installDirectory}`)
    try {
      await launchWindowsInstaller(path, args, info.isAdminRightsRequired)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !info.isAdminRightsRequired) {
        // The installer can disappear after verification but before CreateProcess.
        const exists = await lstat(path).then(entry => entry.isFile(), () => false)
        if (!exists) throw invalidCache()
      }
      throw error
    }
  }
}

async function launchWindowsInstaller(installer: string, args: string[], requiresElevation: boolean): Promise<void> {
  if (!requiresElevation) {
    try {
      await spawnInstaller(installer, args, false)
      return
    } catch (error) {
      // A spawn error means Windows did not start this process. Ask for UAC
      // only for the same permission errors handled by the NSIS updater.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'UNKNOWN') throw error
    }
  }
  await spawnInstaller(join(process.resourcesPath, 'elevate.exe'), [installer, ...args], true)
}

function spawnInstaller(executable: string, args: string[], elevationHelper: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', reject)
    if (elevationHelper) {
      // The helper exits after opening the elevated installer, unless started
      // with -w. A visible UAC rejection is a handoff failure.
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`Windows 安装器提权未完成（${code ?? signal ?? '未知'}）。`))
      })
    } else {
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    }
  })
}
