import i18n from '../i18n'
import { isLegacyDefaultWorkspacePath } from './legacy-workspace-paths'
import { workspaceRootIdentityKey } from './workspace-path'

const LABELS_KEY = 'railwise.workspace-labels.v1'
export const WORKSPACE_LABELS_CHANGED = 'railwise:workspace-labels-changed'

function savedLabels(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LABELS_KEY) ?? '{}')
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0 && entry[1].length <= 80))
      : {}
  } catch { return {} }
}

/** A local display preference; never renames a directory or rewrites chat history. */
export function setWorkspaceDisplayLabel(paths: string[], label: string): void {
  const value = label.trim()
  if (!value || value.length > 80 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Workspace name must contain 1–80 printable characters.')
  const labels = savedLabels()
  for (const path of paths) if (workspaceRootIdentityKey(path)) labels[workspaceRootIdentityKey(path)] = value
  localStorage.setItem(LABELS_KEY, JSON.stringify(labels))
  window.dispatchEvent(new Event(WORKSPACE_LABELS_CHANGED))
}

const DEFAULT_WORKSPACE_LABEL = 'default'

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// 新旧两代默认工作区路径都按 “default” 标签展示(老安装在迁移完成前
// 仍会持有 ~/.deepseekgui 形式的路径)。
function isDefaultWorkspacePath(path: string): boolean {
  const normalized = normalizePathForMatch(path)
  return normalized === '~/.workwise/default_workspace'
    || normalized.endsWith('/.workwise/default_workspace')
    || isLegacyDefaultWorkspacePath(normalized)
}

export function workspaceLabelFromPath(path: string): string {
  const p = path?.trim() ?? ''
  if (!p) return i18n.t('common:workingDirectory')
  const custom = savedLabels()[workspaceRootIdentityKey(p)]
  if (custom) return custom
  if (isDefaultWorkspacePath(p)) return DEFAULT_WORKSPACE_LABEL
  const normalized = p.replace(/[/\\]+$/, '')
  const parts = normalized.split(/[/\\]/)
  const base = parts[parts.length - 1]
  return base || i18n.t('common:workingDirectory')
}
