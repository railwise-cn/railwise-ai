function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function workspaceRootIdentityKey(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  const normalized = normalizePathForMatch(trimmed)
  // Matching legacy names alone does not prove two directories are aliases.
  // Keep distinct user content visible until a verified migration links them.
  return normalized
}

export function isInternalTemporaryWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return (
    /\/deepseek-tui-updates\/tmp(?:\/|$)/.test(normalized)
    || /^\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /^\/private\/var\/folders\/[^/]+\/[^/]+\/t(?:\/|$)/.test(normalized)
    || /\/appdata\/local\/temp(?:\/|$)/.test(normalized)
  )
}

export function isClawWorkspacePath(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return normalized.includes('/.workwise/claw/') || isLegacyClawWorkspacePath(normalized)
}

export function isInternalWriteWorkspace(path?: string): boolean {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return false
  const normalized = normalizePathForMatch(trimmed)
  return normalized === '~/.workwise/write_workspace'
    || normalized.endsWith('/.workwise/write_workspace')
    || isLegacyWriteWorkspacePath(normalized)
}

export function normalizeWorkspaceRoot(path?: string): string {
  const trimmed = path?.trim() ?? ''
  if (!trimmed) return ''
  if (isInternalTemporaryWorkspace(trimmed)) return ''
  return trimmed
}
import {
  isLegacyClawWorkspacePath,
  isLegacyDefaultWorkspacePath,
  isLegacyWriteWorkspacePath
} from './legacy-workspace-paths'
