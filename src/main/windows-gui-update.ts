import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import electronUpdater from 'electron-updater'

/** Keeps electron-updater's feed, download cache and signature verification. */
export class WindowsGuiUpdater extends electronUpdater.NsisUpdater {
  async startVerifiedInstaller(isCurrent: () => boolean = () => true): Promise<void> {
    const cache = this.downloadedUpdateHelper
    const installer = this.installerPath
    const info = cache?.downloadedFileInfo
    if (!cache || !installer || !info || cache.packageFile) {
      throw new Error('无法确认已下载的 Windows 安装包，请重新下载更新。')
    }
    if (!isAbsolute(installer) || extname(installer).toLowerCase() !== '.exe' || basename(installer) !== info.fileName) {
      throw new Error('Windows 更新安装包的路径无效。')
    }
    const [resolvedInstaller, resolvedCache, entry] = await Promise.all([
      realpath(installer), realpath(cache.cacheDirForPendingUpdate), lstat(installer)
    ])
    if (!entry.isFile() || dirname(resolvedInstaller) !== resolvedCache) {
      throw new Error('Windows 更新安装包已移出已校验的缓存目录。')
    }
    const digest = createHash('sha512')
    for await (const chunk of createReadStream(resolvedInstaller)) digest.update(chunk)
    if (digest.digest('base64') !== info.sha512 || cache.downloadedFileInfo !== info || this.installerPath !== installer || !isCurrent()) {
      throw new Error('Windows 更新安装包已变化，请重新下载更新。')
    }

    const args = ['--updated', '/S', '--force-run']
    if (this.installDirectory) args.push(`/D=${this.installDirectory}`)
    await launchWindowsInstaller(resolvedInstaller, args, info.isAdminRightsRequired)
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
