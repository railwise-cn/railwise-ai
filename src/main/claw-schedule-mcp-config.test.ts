import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  buildSyncedClawScheduleMcpJson,
  clawScheduleMcpSettingsChanged,
  removeLegacyClawScheduleTomlConfig,
  resolveClawScheduleMcpCommand,
  resolveClawScheduleMcpNodeEntryPath,
  resolveRuntimeConfigPath,
  resolveRuntimeMcpJsonPath,
  restoreManagedScheduleMcpEnvironment,
  syncClawScheduleMcpConfig,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import { McpConfigService } from './services/mcp-config-service'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

function createSettings(patch: Partial<AppSettingsV1['schedule']['internal']> = {}): AppSettingsV1 {
  const claw = defaultClawSettings()
  const schedule = defaultScheduleSettings()
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: defaultManagedRuntimeSettings()
    },
    workspaceRoot: '/tmp/workspace',
    log: {
      enabled: true,
      retentionDays: 2
    },
    notifications: {
      turnComplete: true
    },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    schedule: {
      ...schedule,
      internal: {
        ...schedule.internal,
        ...patch
      }
    },
    guiUpdate: {
      channel: 'stable'
    },
    codePromptPrefix: '',
    claw: {
      ...claw,
      enabled: true,
      im: {
        ...claw.im,
        enabled: true,
        port: 8787,
        secret: ''
      }
    }
  }
}

const launch: ClawScheduleMcpLaunchConfig = {
  appPath: '/Applications/WorkWise.app',
  execPath: '/Applications/WorkWise.app/Contents/MacOS/WorkWise',
  isPackaged: false
}

describe('claw schedule MCP config', () => {
  it('uses the WorkWise MCP config by default', () => {
    expect(resolveRuntimeConfigPath()).toBe(join(homedir(), '.workwise', 'mcp.json'))
    expect(resolveRuntimeMcpJsonPath()).toBe(resolveRuntimeConfigPath())
  })

  it('writes the gui_schedule server to the WorkWise Runtime MCP JSON config shape', () => {
    const settings = createSettings({ port: 9787, secret: 'top-secret' })
    const synced = buildSyncedClawScheduleMcpJson(
      {
        timeouts: { connect_timeout: 1 },
        servers: {
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp'],
            env: {},
            url: null
          }
        }
      },
      settings,
      launch
    )

    expect(synced.servers).toMatchObject({
      context7: {
        command: 'npx'
      },
      gui_schedule: {
        command: resolveClawScheduleMcpCommand(launch),
        args: [
          resolveClawScheduleMcpNodeEntryPath(launch),
          '--gui-schedule-mcp-server',
          '--base-url',
          'http://127.0.0.1:9787',
          '--secret',
          'top-secret'
        ],
        env: {
          ELECTRON_RUN_AS_NODE: '1'
        },
        url: null,
        enabled: true
      }
    })
    expect(synced.timeouts).toEqual({ connect_timeout: 1 })
  })

  it('restores the managed Electron launch flag after legacy-to-V2 migration without inheriting legacy environment secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-schedule-mcp-refresh-'))
    const settings = createSettings({ port: 9787, secret: 'synthetic-local-secret' })
    const legacyPath = join(root, 'mcp.json')
    const manifestPath = join(root, 'mcp-v2.json')
    const legacy = buildSyncedClawScheduleMcpJson({ servers: {
      ordinary: { command: 'node', args: ['ordinary.js'], env: { ELECTRON_RUN_AS_NODE: '1', API_TOKEN: 'must-not-migrate' } }
    } }, settings, launch)
    const servers = legacy.servers as Record<string, Record<string, unknown>>
    servers.gui_schedule!.env = { ELECTRON_RUN_AS_NODE: '1', API_TOKEN: 'must-not-migrate' }
    await writeFile(legacyPath, JSON.stringify(legacy))
    const service = new McpConfigService({ manifestPath, legacyPath, credentialRoot: join(root, 'credentials'),
      encryption: { available: () => false, encrypt: () => { throw new Error('No credentials expected') }, decrypt: () => { throw new Error('No credentials expected') }, storage: 'session' } })
    try {
      const sources = await service.list()
      const snapshot = await service.runtimeSnapshot()
      expect(snapshot.servers.gui_schedule!.env).toEqual({})
      const refreshed = restoreManagedScheduleMcpEnvironment(snapshot, sources, settings, launch)
      expect(refreshed.servers.gui_schedule).toEqual({ ...snapshot.servers.gui_schedule, env: { ELECTRON_RUN_AS_NODE: '1' } })
      expect(refreshed.servers.ordinary!.env).toEqual({})
      expect(refreshed.environment).toEqual({})
      expect(snapshot.servers.gui_schedule!.env).toEqual({})
      expect(await readFile(manifestPath, 'utf8')).not.toContain('must-not-migrate')
      expect(JSON.stringify(refreshed)).not.toContain('must-not-migrate')
      expect(await readFile(legacyPath, 'utf8')).toBe(JSON.stringify(legacy))
      expect(restoreManagedScheduleMcpEnvironment(refreshed, sources, settings, launch)).toEqual(refreshed)

      for (const replacement of [
        { source: 'user' as const },
        { scope: 'workspace' as const, workspaceRoot: '/synthetic' },
        { command: 'untrusted-launcher' },
        { args: [...sources.find(source => source.id === 'gui_schedule')!.args!, '--eval', 'untrusted'] },
        { credentialRef: { id: 'unrelated-reference', storage: 'session' as const } }
      ]) {
        const untrusted = sources.map(source => source.id === 'gui_schedule' ? { ...source, ...replacement } : source)
        expect(restoreManagedScheduleMcpEnvironment(snapshot, untrusted, settings, launch)).toBe(snapshot)
      }
      for (const replacement of [{ command: 'untrusted-launcher' }, { args: ['other-entry.js'] }, { trustScope: 'workspace' }, { enabled: false }]) {
        const changed = { ...snapshot, servers: { ...snapshot.servers, gui_schedule: { ...snapshot.servers.gui_schedule, ...replacement } } }
        expect(restoreManagedScheduleMcpEnvironment(changed, sources, settings, launch)).toBe(changed)
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses the macOS Electron helper for real app bundle paths', () => {
    expect(resolveClawScheduleMcpCommand(launch, 'darwin')).toBe(
      '/Applications/WorkWise.app/Contents/Frameworks/WorkWise Helper.app/Contents/MacOS/WorkWise Helper'
    )
    expect(resolveClawScheduleMcpCommand({
      appPath: '/tmp/workwise-test-app',
      execPath: '/tmp/electron',
      isPackaged: false
    }, 'darwin')).toBe('/tmp/electron')
  })

  it('removes legacy config.toml claw_schedule blocks without touching other MCP servers', () => {
    const cleaned = removeLegacyClawScheduleTomlConfig(
      [
        'provider = "deepseek"',
        '',
        '[mcp_servers.context7]',
        'command = "npx"',
        '',
        '[mcp_servers.claw_schedule]',
        'command = "old"',
        'args = []',
        '',
        '# WorkWise plugin:mcp:claw-schedule START',
        '[mcp_servers.claw_schedule]',
        'command = "electron"',
        'args = []',
        '# WorkWise plugin:mcp:claw-schedule END',
        '',
        '[providers.deepseek]',
        'api_key = ""'
      ].join('\n')
    )

    expect(cleaned).toContain('[mcp_servers.context7]')
    expect(cleaned).toContain('[providers.deepseek]')
    expect(cleaned).not.toContain('[mcp_servers.claw_schedule]')
    expect(cleaned).not.toContain('WorkWise plugin:mcp:claw-schedule')
  })

  it('does not rewrite config.toml text when there is no legacy claw_schedule block', () => {
    const current = [
      'provider = "deepseek"',
      '',
      '[mcp_servers.context7]',
      'command = "npx"',
      '',
      ''
    ].join('\n')

    expect(removeLegacyClawScheduleTomlConfig(current)).toBe(current)
  })

  it('syncs mcp.json and cleans the old config.toml entry on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ds-gui-mcp-'))
    const kunDir = join(root, '.kun')
    const configTomlPath = join(kunDir, 'config.toml')
    const mcpJsonPath = join(kunDir, 'mcp.json')
    await mkdir(kunDir, { recursive: true })
    await writeFile(
      configTomlPath,
      [
        'provider = "deepseek"',
        '',
        '# WorkWise plugin:mcp:claw-schedule START',
        '[mcp_servers.claw_schedule]',
        'command = "electron"',
        'args = []',
        '# WorkWise plugin:mcp:claw-schedule END',
        ''
      ].join('\n'),
      'utf8'
    )
    await writeFile(
      mcpJsonPath,
      JSON.stringify({
        servers: {
          existing: {
            command: '/bin/echo',
            args: ['ok'],
            env: {},
            url: null
          }
        }
      }),
      'utf8'
    )

    await syncClawScheduleMcpConfig(createSettings(), launch, { configTomlPath, mcpJsonPath })

    const toml = await readFile(configTomlPath, 'utf8')
    const json = JSON.parse(await readFile(mcpJsonPath, 'utf8')) as Record<string, unknown>

    expect(toml).toBe('provider = "deepseek"\n')
    expect(json).toMatchObject({
      servers: {
        existing: {
          command: '/bin/echo'
        },
        gui_schedule: {
          command: resolveClawScheduleMcpCommand(launch),
          args: [
            resolveClawScheduleMcpNodeEntryPath(launch),
            '--gui-schedule-mcp-server',
            '--base-url',
            'http://127.0.0.1:8788'
          ],
          env: {
            ELECTRON_RUN_AS_NODE: '1'
          }
        }
      }
    })
  })

  it('migrates old claw_schedule JSON entries to gui_schedule', () => {
    const synced = buildSyncedClawScheduleMcpJson(
      {
        servers: {
          claw_schedule: {
            command: 'old',
            args: ['--claw-schedule-mcp-server']
          }
        }
      },
      createSettings(),
      launch
    )

    expect((synced.servers as Record<string, unknown>).claw_schedule).toBeUndefined()
    expect(synced.servers).toMatchObject({
      gui_schedule: {
        command: resolveClawScheduleMcpCommand(launch),
        env: {
          ELECTRON_RUN_AS_NODE: '1'
        }
      }
    })
  })

  it('requests a runtime restart when the MCP launch arguments change', () => {
    expect(clawScheduleMcpSettingsChanged(createSettings(), createSettings())).toBe(false)
    expect(clawScheduleMcpSettingsChanged(createSettings(), createSettings({ port: 9876 }))).toBe(true)
    expect(clawScheduleMcpSettingsChanged(createSettings(), createSettings({ secret: 'abc' }))).toBe(true)
  })
})
