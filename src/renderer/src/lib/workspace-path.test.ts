import { describe, expect, it } from 'vitest'
import { isInternalTemporaryWorkspace, normalizeWorkspaceRoot, workspaceRootIdentityKey } from './workspace-path'
import { isLegacyDefaultWorkspacePath } from './legacy-workspace-paths'

describe('workspace path normalization', () => {
  it('keeps an explicitly selected workspace under the system temp root', () => {
    expect(isInternalTemporaryWorkspace('/tmp/workwise-qa/workspace')).toBe(false)
    expect(normalizeWorkspaceRoot('/private/tmp/workwise-qa/workspace')).toBe(
      '/private/tmp/workwise-qa/workspace'
    )
  })

  it('continues to hide known runtime-owned temporary workspaces', () => {
    expect(isInternalTemporaryWorkspace('/tmp/deepseek-tui-updates/tmp/session-1')).toBe(true)
    expect(normalizeWorkspaceRoot('/tmp/deepseek-tui-updates/tmp/session-1')).toBe('')
    expect(isInternalTemporaryWorkspace('/private/var/folders/ab/cd/T/session-1')).toBe(true)
  })

  it('recognizes .workgpt labels without conflating independent directories', () => {
    expect(isLegacyDefaultWorkspacePath('/users/example/.workgpt/default_workspace')).toBe(true)
    const roots = ['.workgpt', '.workwise', '.kun', '.deepseekgui'].map(root => `/users/example/${root}/default_workspace`)
    expect(new Set(roots.map(workspaceRootIdentityKey)).size).toBe(4)
  })
})
