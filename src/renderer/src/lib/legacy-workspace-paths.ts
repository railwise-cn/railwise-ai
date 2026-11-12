/** Read-only workspace aliases kept through the 0.3.x migration window. */
const legacyRoots = ['/.workgpt/', '/.kun/', '/.deepseekgui/'] as const

export function isLegacyDefaultWorkspacePath(normalized: string): boolean {
  return legacyRoots.some((root) =>
    normalized === `~${root}default_workspace` || normalized.endsWith(`${root}default_workspace`)
  )
}

export function isLegacyClawWorkspacePath(normalized: string): boolean {
  return legacyRoots.some((root) => normalized.includes(`${root}claw/`))
}

export function isLegacyWriteWorkspacePath(normalized: string): boolean {
  return legacyRoots.some((root) =>
    normalized === `~${root}write_workspace` || normalized.endsWith(`${root}write_workspace`)
  )
}
