import { describe, expect, it } from 'vitest'
import {
  buildMcpConfig,
  customMcpConfigFragment,
  fallbackPluginMonogram,
  mcpConfigHasServer,
  mcpMarketplaceItemsFromConfigAndDiagnostics,
  mcpRuntimeErrorHint,
  mergeMcpJsonConfig,
  skillMarketplaceItemsFromDiscoveredSkills
} from './PluginMarketplaceView'

describe('PluginMarketplaceView icon fallbacks', () => {
  it('always produces a visible two-character fallback for missing icon values', () => {
    const base = { id: 'missing-icon', name: 'Survey Tools' } as any
    expect(fallbackPluginMonogram(base)).toBe('SU')
    expect(fallbackPluginMonogram({ ...base, name: '测量工具' })).toBe('测量')
    expect(fallbackPluginMonogram({ ...base, name: '!!!', id: '!!!' })).toBe('RW')
  })
})

describe('PluginMarketplaceView MCP config helpers', () => {
  it('merges recommended MCP servers into JSON config without dropping existing fields', () => {
    const existing = JSON.stringify({
      timeouts: { read_timeout: 120 },
      servers: {
        gui_schedule: { command: '/Applications/WorkWise.app' }
      }
    })

    const merged = mergeMcpJsonConfig(
      existing,
      buildMcpConfig('playwright', 'npx', ['-y', '@playwright/mcp@latest'])
    )
    const parsed = JSON.parse(merged.text) as Record<string, any>

    expect(merged.alreadyExists).toBe(false)
    expect(parsed.timeouts).toEqual({ read_timeout: 120 })
    expect(parsed.servers.gui_schedule).toEqual({ command: '/Applications/WorkWise.app' })
    expect(parsed.servers.playwright).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      trustScope: 'user'
    })
    expect(mcpConfigHasServer(merged.text, 'playwright')).toBe(true)
  })

  it('detects duplicate MCP servers instead of appending old-style snippets', () => {
    const fragment = buildMcpConfig('context7', 'npx', ['-y', '@upstash/context7-mcp@latest'])
    const first = mergeMcpJsonConfig('', fragment)
    const second = mergeMcpJsonConfig(first.text, fragment)

    expect(first.alreadyExists).toBe(false)
    expect(second.alreadyExists).toBe(true)
    expect(JSON.parse(second.text).servers.context7).toMatchObject({ command: 'npx' })
  })

  it('accepts custom JSON as either a single server or a WorkWise Runtime config fragment', () => {
    expect(customMcpConfigFragment(
      'docs',
      '{"transport":"stdio","command":"npx","args":["-y","docs-mcp"]}',
      {}
    )).toEqual({
      servers: {
        docs: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'docs-mcp']
        }
      }
    })

    expect(customMcpConfigFragment(
      'github',
      '{"capabilities":{"mcp":{"servers":{"github":{"transport":"stdio","command":"github-mcp"}}}}}',
      {}
    )).toEqual({
      servers: {
        github: {
          transport: 'stdio',
          command: 'github-mcp'
        }
      }
    })
  })

  it('detects MCP servers from full WorkWise Runtime capability config', () => {
    const content = JSON.stringify({
      capabilities: {
        mcp: {
          servers: {
            github: {
              transport: 'stdio',
              command: 'github-mcp'
            }
          }
        }
      }
    })

    expect(mcpConfigHasServer(content, 'github')).toBe(true)
  })

  it('turns configured MCP servers into personal marketplace items', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      '{"servers":{"docs":{"transport":"stdio","command":"docs-mcp"}}}',
      null,
      {
        configured: 'Configured',
        connected: 'Connected',
        error: 'Error',
        disabled: 'Disabled',
        authRequired: 'Needs authorization'
      }
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'docs',
        kind: 'mcp',
        group: 'personal',
        title: 'docs',
        description: expect.stringContaining('docs-mcp'),
        sourceLabel: 'Configured',
        statusTone: 'default'
      })
    ])
  })

  it('overlays MCP runtime diagnostics onto configured marketplace items', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          github: {
            transport: 'stdio',
            command: 'github-mcp'
          },
          disabled_docs: {
            transport: 'stdio',
            command: 'docs-mcp',
            enabled: false
          }
        }
      }),
      {
        mcpServers: [
          { id: 'github', status: 'connected', toolCount: 12 },
          { id: 'bad', status: 'error', lastError: 'missing token' }
        ]
      },
      {
        configured: 'Configured',
        connected: 'Connected',
        error: 'Error',
        disabled: 'Disabled',
        authRequired: 'Needs authorization'
      }
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'bad',
        sourceLabel: 'Error',
        statusTone: 'error',
        description: expect.stringContaining('missing token')
      }),
      expect.objectContaining({
        id: 'disabled_docs',
        sourceLabel: 'Disabled',
        statusTone: 'warning'
      }),
      expect.objectContaining({
        id: 'github',
        sourceLabel: 'Connected',
        statusTone: 'success',
        description: expect.stringContaining('github-mcp')
      })
    ])
  })

  it('marks invalid Brave tokens as needing reauthorization', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      '{"servers":{"brave-search":{"transport":"stdio","command":"npx"}}}',
      {
        mcpServers: [
          {
            id: 'brave-search',
            status: 'error',
            authRequired: true,
            lastError: 'SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid'
          }
        ]
      },
      {
        configured: 'Configured',
        connected: 'Connected',
        error: 'Error',
        disabled: 'Disabled',
        authRequired: 'Needs authorization'
      }
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'brave-search',
        sourceLabel: 'Needs authorization',
        statusTone: 'warning',
        description: expect.stringContaining('SUBSCRIPTION_TOKEN_INVALID')
      })
    ])
  })

  it('maps closed MCP subprocess errors to actionable hints', () => {
    const t = (key: string): string => key

    expect(mcpRuntimeErrorHint('MCP error 32000: connection closed', 'github', t)).toBe(
      'pluginMcpRuntimeHintGithub'
    )
    expect(mcpRuntimeErrorHint('MCP error 32000: connection closed', 'filesystem', t)).toBe(
      'pluginMcpRuntimeHintFilesystem'
    )
    expect(mcpRuntimeErrorHint('spawn npx ENOENT', 'filesystem', t)).toBe(
      'pluginMcpRuntimeHintNode'
    )
    expect(mcpRuntimeErrorHint('Chromium download failed', 'puppeteer', t)).toBe(
      'pluginMcpRuntimeHintPuppeteer'
    )
    expect(mcpRuntimeErrorHint('SUBSCRIPTION_TOKEN_INVALID', 'brave-search', t)).toBe(
      'pluginMcpRuntimeHintBrave'
    )
    expect(mcpRuntimeErrorHint('MCP error 32000: connection closed', undefined, t)).toBe(
      'pluginMcpRuntimeHintNode'
    )
  })
})

describe('skillMarketplaceItemsFromDiscoveredSkills', () => {
  it('turns discovered project and global skills into personal marketplace items', () => {
    const items = skillMarketplaceItemsFromDiscoveredSkills([
      {
        id: 'openspec-apply-change',
        name: 'Openspec Apply Change',
        description: 'Implement tasks from an OpenSpec change.',
        root: '/workspace/.codex/skills/openspec-apply-change',
        entryPath: '/workspace/.codex/skills/openspec-apply-change/SKILL.md',
        scope: 'project',
        legacy: true
      },
      {
        id: 'remotion-best-practices',
        name: 'Remotion Best Practices',
        description: 'Best practices for Remotion.',
        root: '/Users/demo/.agents/skills/remotion-best-practices',
        entryPath: '/Users/demo/.agents/skills/remotion-best-practices/SKILL.md',
        scope: 'global',
        legacy: true
      }
    ], { project: 'Project', global: 'Global', github: 'GitHub', bundled: 'Built-in' })

    expect(items).toEqual([
      expect.objectContaining({
        id: 'openspec-apply-change',
        group: 'personal',
        title: 'Openspec Apply Change',
        sourceLabel: 'Project'
      }),
      expect.objectContaining({
        id: 'remotion-best-practices',
        group: 'personal',
        title: 'Remotion Best Practices',
        sourceLabel: 'Global'
      })
    ])
  })

  it('labels managed GitHub and bundled skills by source', () => {
    const items = skillMarketplaceItemsFromDiscoveredSkills([
      {
        id: 'di-bao-monitoring',
        name: 'Di-bao Monitoring',
        description: 'Railwise monitoring.',
        root: '/workspace/.agents/skills/di-bao-monitoring',
        entryPath: '/workspace/.agents/skills/di-bao-monitoring/SKILL.md',
        scope: 'project',
        legacy: true,
        source: {
          type: 'github',
          owner: 'railwise-cn',
          repo: 'di-bao-monitoring-skill',
          path: 'skill/di-bao-monitoring',
          ref: 'main',
          installedSha: 'abc123',
          autoUpdate: true
        }
      },
      {
        id: 'operational-monitoring',
        name: 'Operational Monitoring',
        description: 'Operational monitoring.',
        root: '/workspace/.agents/skills/operational-monitoring',
        entryPath: '/workspace/.agents/skills/operational-monitoring/SKILL.md',
        scope: 'project',
        legacy: true,
        source: {
          type: 'bundled',
          id: 'operational-monitoring',
          autoUpdate: false
        }
      }
    ], { project: 'Project', global: 'Global', github: 'GitHub', bundled: 'Built-in' })

    expect(items).toEqual([
      expect.objectContaining({
        id: 'di-bao-monitoring',
        sourceLabel: 'GitHub',
        statusTone: 'success',
        sourceUrl: 'https://github.com/railwise-cn/di-bao-monitoring-skill/tree/main/skill/di-bao-monitoring'
      }),
      expect.objectContaining({
        id: 'operational-monitoring',
        sourceLabel: 'Built-in',
        statusTone: 'success'
      })
    ])
  })
})
