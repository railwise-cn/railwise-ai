export const MANAGED_RUNTIME_SHUTDOWN_REQUEST = {
  type: 'railwise:runtime-shutdown',
  version: 1
} as const

export const MANAGED_RUNTIME_SHUTDOWN_READY = {
  type: 'railwise:runtime-shutdown-ready',
  version: 1
} as const

function matchesManagedRuntimeMessage(value: unknown, expected: { readonly type: string; readonly version: number }): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const message = value as Record<string, unknown>
  return Object.keys(message).length === 2 &&
    Object.hasOwn(message, 'type') && message.type === expected.type &&
    Object.hasOwn(message, 'version') && message.version === expected.version
}

export function isManagedRuntimeShutdownRequest(value: unknown): value is typeof MANAGED_RUNTIME_SHUTDOWN_REQUEST {
  return matchesManagedRuntimeMessage(value, MANAGED_RUNTIME_SHUTDOWN_REQUEST)
}

export function isManagedRuntimeShutdownReady(value: unknown): value is typeof MANAGED_RUNTIME_SHUTDOWN_READY {
  return matchesManagedRuntimeMessage(value, MANAGED_RUNTIME_SHUTDOWN_READY)
}
