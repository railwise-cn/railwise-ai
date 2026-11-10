import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../../agent/types'
import { buildSidebarWorkspaceGroups, ThreadRenameDialog } from './SidebarProjectsSection'

function thread(overrides: Partial<NormalizedThread> & Pick<NormalizedThread, 'id' | 'workspace'>): NormalizedThread {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? '2026-06-01T00:00:00.000Z',
    model: overrides.model ?? 'reasonix',
    mode: overrides.mode ?? 'agent',
    workspace: overrides.workspace,
    ...(overrides.messageCount !== undefined ? { messageCount: overrides.messageCount } : {}),
    ...(overrides.preview ? { preview: overrides.preview } : {}),
    ...(overrides.archived !== undefined ? { archived: overrides.archived } : {})
  }
}

describe('SidebarProjectsSection groups', () => {
  it('keeps remembered code workspaces visible even when the runtime lists only one workspace', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [thread({ id: 'reasonix-current', workspace: '/Users/zxy/project-a' })],
      activeThreadId: 'reasonix-current',
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      workspaceRoots: [
        '/Users/zxy/project-a',
        '/Users/zxy/project-b',
        '/Users/zxy/project-c'
      ]
    })

    expect(groups.map(([workspace]) => workspace)).toEqual([
      '/Users/zxy/project-a',
      '/Users/zxy/project-b',
      '/Users/zxy/project-c'
    ])
    expect(groups[1]?.[1]).toEqual([])
    expect(groups[2]?.[1]).toEqual([])
  })

  it('does not show registry-only empty workspaces while searching or viewing archives', () => {
    const base = {
      threads: [thread({ id: 'reasonix-current', workspace: '/Users/zxy/project-a' })],
      activeThreadId: 'reasonix-current',
      workspaceRoot: '/Users/zxy/project-a',
      workspaceRoots: ['/Users/zxy/project-b']
    }

    expect(
      buildSidebarWorkspaceGroups({
        ...base,
        searchQuery: 'project',
        showArchived: false
      }).map(([workspace]) => workspace)
    ).toEqual(['/Users/zxy/project-a'])

    expect(
      buildSidebarWorkspaceGroups({
        ...base,
        searchQuery: '',
        showArchived: true
      }).map(([workspace]) => workspace)
    ).toEqual(['/Users/zxy/project-a'])
  })

  it('shows the default workspace while filtering write workspaces from code project groups', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [
        thread({ id: 'code-current', workspace: '/Users/zxy/project-a' }),
        thread({ id: 'default-code', workspace: '/Users/zxy/.deepseekgui/default_workspace' }),
        thread({ id: 'write-assistant', workspace: '~/.deepseekgui/write_workspace' })
      ],
      activeThreadId: 'code-current',
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      workspaceRoots: [
        '/Users/zxy/project-a',
        '/Users/zxy/.deepseekgui/default_workspace',
        '~/.deepseekgui/write_workspace'
      ]
    })

    expect(groups.map(([workspace]) => workspace)).toEqual([
      '/Users/zxy/project-a',
      '/Users/zxy/.deepseekgui/default_workspace'
    ])
    expect(groups[1]?.[1].map((item) => item.id)).toEqual(['default-code'])
  })

  it('keeps unverified legacy paths separate instead of hiding independent user history', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [
        thread({ id: 'default-short', workspace: '~/.deepseekgui/default_workspace' }),
        thread({ id: 'default-absolute', workspace: 'C:\\Users\\zxy\\.deepseekgui\\default_workspace' })
      ],
      activeThreadId: null,
      searchQuery: '',
      showArchived: false,
      workspaceRoot: 'C:\\Users\\zxy\\.deepseekgui\\default_workspace',
      workspaceRoots: [
        '~/.deepseekgui/default_workspace',
        'C:\\Users\\zxy\\.deepseekgui\\default_workspace'
      ]
    })

    expect(groups).toHaveLength(2)
    expect(groups[0]?.[0]).toBe('C:\\Users\\zxy\\.deepseekgui\\default_workspace')
    expect(groups[0]?.[1].map((item) => item.id)).toEqual(['default-absolute'])
    expect(groups[1]?.[1].map((item) => item.id)).toEqual(['default-short'])
  })

  it('merges only verified directory aliases while retaining every chat', () => {
    const canonicalRoot = '/users/example/.workwise/default_workspace'
    const legacy = '/users/example/.workgpt/default_workspace'
    const independent = '/users/example/.kun/default_workspace'
    const groups = buildSidebarWorkspaceGroups({
      threads: [thread({ id: 'a', workspace: canonicalRoot }), thread({ id: 'b', workspace: legacy }), thread({ id: 'c', workspace: independent })],
      activeThreadId: null, searchQuery: '', showArchived: false, workspaceRoot: canonicalRoot,
      workspaceRoots: [legacy, canonicalRoot, independent], aliases: [{ path: legacy, canonicalRoot }]
    })
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual([canonicalRoot, expect.arrayContaining([expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })])])
    expect(groups[1]?.[0]).toBe(independent)
  })

  it('hides known empty shells while preserving the active empty thread and real history', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [
        ...Array.from({ length: 7 }, (_, index) => thread({
          id: `empty-${index}`,
          title: 'Design duplicate',
          workspace: '/Users/zxy/project-a',
          messageCount: 0
        })),
        thread({
          id: 'real-history',
          title: 'Design duplicate',
          workspace: '/Users/zxy/project-a',
          messageCount: 3,
          preview: 'real message'
        }),
        thread({
          id: 'active-empty',
          title: 'New chat',
          workspace: '/Users/zxy/project-a',
          messageCount: 0
        })
      ],
      activeThreadId: 'active-empty',
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      workspaceRoots: ['/Users/zxy/project-a']
    })

    expect(groups[0]?.[1].map((item) => item.id)).toEqual(['real-history', 'active-empty'])
  })

  it('keeps legacy threads visible when the runtime omitted summary fields', () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [thread({ id: 'legacy', workspace: '/Users/zxy/project-a' })],
      activeThreadId: null,
      searchQuery: '',
      showArchived: false,
      workspaceRoot: '/Users/zxy/project-a',
      workspaceRoots: ['/Users/zxy/project-a']
    })

    expect(groups[0]?.[1].map((item) => item.id)).toEqual(['legacy'])
  })
})

describe('ThreadRenameDialog', () => {
  it('renders an in-app rename form with the current thread title prefilled', () => {
    const html = renderToStaticMarkup(
      createElement(ThreadRenameDialog, {
        state: {
          thread: thread({
            id: 'thr_rename',
            title: 'Build rename dialog',
            workspace: '/Users/zxy/project-a'
          }),
          value: 'Build rename dialog',
          submitting: false
        },
        onClose: vi.fn(),
        onValueChange: vi.fn(),
        onSubmit: vi.fn(),
        t: (key: string) => key
      })
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('sidebarThreadRename')
    expect(html).toContain('value="Build rename dialog"')
    expect(html).toContain('type="submit" disabled=""')
  })
})
