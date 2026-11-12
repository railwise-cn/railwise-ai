import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import type { DingTalkDesktopResult } from '../../shared/workwise-api'

const execFileAsync = promisify(execFile)
const DINGTALK_BUNDLE_ID = '5ZSL2CJU2T.com.dingtalk.mac'

type DesktopDependencies = {
  platform: string
  home: string
  exists: (path: string) => boolean
  readBundleId: (path: string) => Promise<string>
  registeredApplication: () => Promise<{ path: string }>
  openPath: (path: string) => Promise<string>
}

const dependencies: DesktopDependencies = {
  platform: process.platform,
  home: homedir(),
  exists: existsSync,
  readBundleId: async (path) => {
    const result = await execFileAsync('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')
    ], { timeout: 5_000, maxBuffer: 16 * 1024 })
    return result.stdout.trim()
  },
  registeredApplication: () => app.getApplicationInfoForProtocol('dingtalk://'),
  openPath: (path) => shell.openPath(path)
}

/** Open the installed desktop client. Connector credentials are managed separately. */
export async function openDingTalkDesktop(
  deps: DesktopDependencies = dependencies
): Promise<DingTalkDesktopResult> {
  if (deps.platform !== 'darwin' && deps.platform !== 'win32') {
    return { ok: false, code: 'unsupported', message: 'Open the DingTalk desktop app from your system application menu.' }
  }

  let target: string | undefined
  try {
    if (deps.platform === 'darwin') {
      target = ['/Applications/DingTalk.app', join(deps.home, 'Applications', 'DingTalk.app')].find(deps.exists)
      if (!target) {
        const registered = await deps.registeredApplication().catch(() => undefined)
        if (registered?.path.endsWith('.app') && deps.exists(registered.path)) target = registered.path
      }
      if (target && await deps.readBundleId(target) !== DINGTALK_BUNDLE_ID) {
        return { ok: false, code: 'invalid_app', message: 'The installed app could not be identified as the DingTalk desktop client.' }
      }
    } else {
      const registered = await deps.registeredApplication().catch(() => undefined)
      if (registered && win32.isAbsolute(registered.path) && deps.exists(registered.path)) {
        if (win32.basename(registered.path).toLowerCase() !== 'dingtalk.exe') {
          return { ok: false, code: 'invalid_app', message: 'The registered app could not be identified as the DingTalk desktop client.' }
        }
        target = registered.path
      }
    }

    if (!target) {
      return { ok: false, code: 'not_installed', message: 'DingTalk desktop was not found. Install it or open it once from your system application menu, then retry.' }
    }
    const error = await deps.openPath(target)
    if (error) {
      return { ok: false, code: 'open_failed', message: 'The system could not open DingTalk. Open it from your system application menu and retry.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, code: 'open_failed', message: 'The system could not open DingTalk. Open it from your system application menu and retry.' }
  }
}
