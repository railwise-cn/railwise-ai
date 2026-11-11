import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MANAGED_RUNTIME_DATA_DIR,
  getManagedRuntimeSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import {
  buildManagedRuntimeServeArgs,
  resolveManagedRuntimeExecutable
} from '../resolve-managed-runtime'
import {
  isManagedRuntimeChildRunning,
  getManagedRuntimeActualPort,
  reclaimManagedRuntimePort,
  startManagedRuntimeChild,
  stopManagedRuntimeChildAndWait,
  type StartManagedRuntimeChildOptions
} from '../managed-runtime-process'
import { getManagedRuntimeBaseUrl } from '../runtime-base-url'

const MANAGED_RUNTIME_ID = 'kun' as const
let managedRuntimeStartOptions: StartManagedRuntimeChildOptions = {}

export function configureManagedRuntimeStartOptions(options: StartManagedRuntimeChildOptions): void {
  managedRuntimeStartOptions = { ...options }
}

function appRoot(): string {
  return app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
}

export const managedRuntimeAdapter = {
  id: MANAGED_RUNTIME_ID,

  async resolveExecutable(settings: AppSettingsV1): Promise<string> {
    const runtime = getManagedRuntimeSettings(settings)
    const resolution = resolveManagedRuntimeExecutable(appRoot(), runtime.binaryPath)
    if (resolution.kind === 'node-script') {
      const scriptPath = resolution.args[0] ?? ''
      return runtime.binaryPath.trim()
        ? `Node.js script (${scriptPath})`
        : `Bundled RailWise AI Runtime (${scriptPath})`
    }
    return resolution.command
  },

  ensureRunning(settings: AppSettingsV1): Promise<void> {
    return startManagedRuntimeChild(settings, managedRuntimeStartOptions)
  },

  stopAndWait(options?: { requireCleanExit?: boolean; timeoutMs?: number }): Promise<void> {
    return stopManagedRuntimeChildAndWait(options)
  },

  isChildRunning(): boolean {
    return isManagedRuntimeChildRunning()
  },

  getBaseUrl(settings: AppSettingsV1): string {
    const runtime = getManagedRuntimeSettings(settings)
    return getManagedRuntimeBaseUrl(getManagedRuntimeActualPort() ?? runtime.port)
  },

  reclaimPort(port: number): Promise<{ ok: true } | { ok: false; message: string }> {
    return reclaimManagedRuntimePort(port)
  }
}

export function getRuntimeBaseUrlForSettings(settings: AppSettingsV1): string {
  return managedRuntimeAdapter.getBaseUrl(settings)
}

/** Build the bearer-token authorization header for managed runtime requests. */
export function runtimeAuthHeaders(settings: AppSettingsV1): Headers {
  const runtime = getManagedRuntimeSettings(settings)
  const headers = new Headers()
  const runtimeToken = managedRuntimeStartOptions.runtimeToken?.trim() || runtime.runtimeToken.trim()
  if (runtimeToken) {
    headers.set('Authorization', `Bearer ${runtimeToken}`)
  }
  return headers
}

export type RuntimeRequestInit = {
  method?: string
  body?: BodyInit
  headers?: Record<string, string>
}

export async function runtimeRequestViaHost(
  settings: AppSettingsV1,
  pathAndQuery: string,
  init: RuntimeRequestInit,
  ensureRuntime: (settings: AppSettingsV1) => Promise<void>
): Promise<{ ok: boolean; status: number; body: string }> {
  await ensureRuntime(settings)
  const base = getRuntimeBaseUrlForSettings(settings)
  const pathNorm = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`
  const url = `${base}${pathNorm}`
  const hdrs = runtimeAuthHeaders(settings)
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    hdrs.set(key, value)
  }
  hdrs.set('Accept', 'application/json')
  if (init.body && !hdrs.has('Content-Type')) {
    hdrs.set('Content-Type', 'application/json')
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: hdrs,
    body: init.body,
    signal: AbortSignal.timeout(init.method === 'POST' ? 60_000 : 15_000)
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, body: text }
}

export { buildManagedRuntimeServeArgs, resolveManagedRuntimeExecutable }

/**
 * Default data directory used when the user has not provided one.
 * The path lives under the app user-data directory so packaged
 * installs do not need write access to the install folder.
 */
export function defaultManagedRuntimeDataDir(): string {
  return DEFAULT_MANAGED_RUNTIME_DATA_DIR.replace(/^~(?=$|[\\/])/, homedir())
}
