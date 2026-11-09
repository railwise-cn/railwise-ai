import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_WEIXIN_BRIDGE_RPC_URL,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings
} from '../shared/app-settings'
import { DEFAULT_GUI_UPDATE_CHANNEL } from '../shared/gui-update'
import {
  JsonSettingsStore,
  LegacySettingsSourceConflictError,
  resolveWorkwiseHome,
  SettingsRevisionConflictError
} from './settings-store'

async function writeIsolatedSettings(userDataDir: string, locale: 'en' | 'zh' = 'en'): Promise<{
  workwiseHome: string
  writeRoot: string
}> {
  const workwiseHome = join(userDataDir, '.workwise')
  const writeRoot = join(workwiseHome, 'write_workspace')
  await writeFile(
    join(userDataDir, 'workwise-settings.json'),
    JSON.stringify({
      schema: 'workwise.settings',
      version: 2,
      revision: 0,
      locale,
      workspaceRoot: join(workwiseHome, 'default_workspace'),
      write: {
        defaultWorkspaceRoot: writeRoot,
        activeWorkspaceRoot: writeRoot,
        workspaces: [writeRoot]
      }
    }),
    'utf8'
  )
  return { workwiseHome, writeRoot }
}

describe('JsonSettingsStore', () => {
  it('keeps formal data under the runtime home unless an isolated root is explicit', () => {
    const formalHome = '/Users/workwise-formal'
    const candidateHome = '/private/tmp/workwise-candidate/home/.workwise'

    expect(resolveWorkwiseHome(undefined, formalHome)).toBe(join(formalHome, '.workwise'))
    expect(resolveWorkwiseHome(candidateHome, formalHome)).toBe(candidateHome)
  })

  it('writes new settings with the WorkWise V2 envelope', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-v2-'))
    const workwiseHome = join(userDataDir, '.workwise')
    const store = new JsonSettingsStore(userDataDir, { workwiseHome })

    const loaded = await store.load()
    const persisted = JSON.parse(await readFile(join(userDataDir, 'workwise-settings.json'), 'utf8'))

    expect(loaded).toMatchObject({ schema: 'workwise.settings', version: 2, revision: 0 })
    expect(persisted).toMatchObject({ schema: 'workwise.settings', version: 2, revision: 0 })
    expect(loaded.conversation).toEqual({ viewMode: 'concise' })
    expect(loaded.documents).toEqual({
      parsingMode: 'auto',
      unlimitedOcrServerUrl: '',
      privateMineruServerUrl: '',
      allowPrivateServerUploadByWorkspace: {}
    })
    expect(loaded.workspaceRoot).toBe(join(workwiseHome, 'default_workspace'))
    expect(loaded.write.defaultWorkspaceRoot).toBe(join(workwiseHome, 'write_workspace'))
    expect(loaded.write.activeWorkspaceRoot).toBe(join(workwiseHome, 'write_workspace'))
  })

  it('serializes concurrent patches and rejects stale revisions without changing state', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-revision-'))
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const initial = await store.load()

    const [first, second] = await Promise.all([
      store.patch({ locale: 'zh' }, initial.revision),
      store.patch({ theme: 'dark' })
    ])

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    await expect(store.patch({ locale: 'en' }, 0)).rejects.toBeInstanceOf(SettingsRevisionConflictError)
    const current = await store.load()
    expect(current).toMatchObject({ revision: 2, locale: 'zh', theme: 'dark' })
  })

  it('preserves terminal notification filters across a partial toggle patch', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-notifications-'))
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    await store.load()
    await store.patch({
      notifications: {
        turnTerminal: {
          enabled: true,
          kinds: ['error', 'waiting_approval'],
          suppressActiveThread: true,
          include: ['project-*'],
          exclude: ['*secret*']
        }
      }
    })

    const updated = await store.patch({
      notifications: { turnTerminal: { enabled: false } }
    })

    expect(updated.notifications).toEqual({
      turnComplete: false,
      turnTerminal: {
        enabled: false,
        kinds: ['error', 'waiting_approval'],
        suppressActiveThread: true,
        include: ['project-*'],
        exclude: ['*secret*']
      }
    })
  })

  it('records a read-only V1 import and leaves the legacy source unchanged', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-migrate-'))
    const legacyPath = join(userDataDir, 'workgpt-settings.json')
    const legacyRaw = JSON.stringify({ version: 1, locale: 'zh' })
    await writeFile(legacyPath, legacyRaw, 'utf8')
    const workwiseHome = join(userDataDir, '.workwise')
    const store = new JsonSettingsStore(userDataDir, { workwiseHome })

    const loaded = await store.load()
    const manifest = JSON.parse(await readFile(join(workwiseHome, 'migrations', 'v2.json'), 'utf8'))

    expect(loaded).toMatchObject({ schema: 'workwise.settings', version: 2, locale: 'zh' })
    expect(manifest).toMatchObject({
      schema: 'workwise.migration',
      version: 2,
      sourcePath: legacyPath,
      targetPath: join(userDataDir, 'workwise-settings.json')
    })
    expect(await readFile(legacyPath, 'utf8')).toBe(legacyRaw)
  })

  it('persists the previous managed WeChat bridge port migration for V2 settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-weixin-port-'))
    await writeIsolatedSettings(userDataDir)
    const settingsPath = join(userDataDir, 'workwise-settings.json')
    const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
    raw.claw = {
      im: {
        weixinBridgeUrl: 'http://127.0.0.1:18791/api/v1/admin/rpc'
      }
    }
    await writeFile(settingsPath, JSON.stringify(raw), 'utf8')

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      claw: { im: { weixinBridgeUrl: string } }
    }

    expect(loaded.claw.im.weixinBridgeUrl).toBe(DEFAULT_WEIXIN_BRIDGE_RPC_URL)
    expect(persisted.claw.im.weixinBridgeUrl).toBe(DEFAULT_WEIXIN_BRIDGE_RPC_URL)
  })

  it('persists revision-safe conversation and document preferences', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-workbench-'))
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const initial = await store.load()

    const updated = await store.patch({
      conversation: { viewMode: 'developer' },
      documents: {
        parsingMode: 'accurate',
        privateMineruServerUrl: 'https://mineru.example.test',
        allowPrivateServerUploadByWorkspace: { '/tmp/workspace': true }
      }
    }, initial.revision)

    expect(updated.revision).toBe(initial.revision + 1)
    expect(updated.conversation.viewMode).toBe('developer')
    expect(updated.documents).toMatchObject({
      parsingMode: 'accurate',
      privateMineruServerUrl: 'https://mineru.example.test',
      allowPrivateServerUploadByWorkspace: { '/tmp/workspace': true }
    })
    await expect(store.patch({ conversation: { viewMode: 'standard' } }, initial.revision))
      .rejects.toBeInstanceOf(SettingsRevisionConflictError)
  })

  it('defaults GUI updates to the stable channel for new settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.guiUpdate.channel).toBe(DEFAULT_GUI_UPDATE_CHANNEL)
    expect(loaded.agents.kun.approvalPolicy).toBe(DEFAULT_APPROVAL_POLICY)
    expect(loaded.appBehavior).toEqual({
      openAtLogin: false,
      startMinimized: false,
      closeToTray: false
    })
  })

  it('creates a default write workspace with welcome.md', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const { workwiseHome } = await writeIsolatedSettings(userDataDir)

    const store = new JsonSettingsStore(userDataDir, { workwiseHome })
    const loaded = await store.load()

    expect(loaded.write.defaultWorkspaceRoot).toContain('.workwise')
    expect(loaded.write.workspaces).toContain(loaded.write.defaultWorkspaceRoot)
    expect(loaded.write.inlineCompletion.enabled).toBe(true)
    expect(loaded.write.inlineCompletion.retrievalEnabled).toBe(true)
    expect(loaded.write.inlineCompletion.longCompletionEnabled).toBe(true)
    expect(loaded.provider.baseUrl).toBe('https://api.deepseek.com')
    expect(loaded.write.inlineCompletion.apiKey).toBe('')
    expect(loaded.write.inlineCompletion.baseUrl).toBe('')
    expect(loaded.write.inlineCompletion.inheritModel).toBe(true)
    expect(loaded.write.inlineCompletion.model).toBe('deepseek-flash')
    expect(loaded.write.inlineCompletion.longMaxTokens).toBe(256)
    expect(await readFile(join(loaded.write.defaultWorkspaceRoot, 'welcome.md'), 'utf8')).toContain('Welcome to Write')
  })

  it('migrates saved scheduled and Claw models only for the built-in DeepSeek provider', async () => {
    const loadSettings = async (providerId: string) => {
      const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-model-migration-'))
      await writeFile(join(userDataDir, 'workwise-settings.json'), JSON.stringify({
        schema: 'workwise.settings',
        version: 2,
        revision: 0,
        agents: { kun: { providerId } },
        schedule: {
          model: 'deepseek-v4-pro',
          tasks: [{ model: 'deepseek-v4-flash' }]
        },
        claw: {
          im: { model: 'deepseek-v4-pro' },
          channels: [{ id: 'channel-1', provider: 'feishu', model: 'deepseek-v4-flash' }]
        }
      }), 'utf8')
      return new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') }).load()
    }

    const official = await loadSettings('deepseek')
    expect(official.schedule.model).toBe('deepseek-flash')
    expect(official.schedule.tasks[0].model).toBe('deepseek-flash')
    expect(official.claw.im.model).toBe('deepseek-flash')
    expect(official.claw.channels[0].model).toBe('deepseek-flash')

    const custom = await loadSettings('custom-provider')
    expect(custom.schedule.model).toBe('deepseek-v4-pro')
    expect(custom.schedule.tasks[0].model).toBe('deepseek-v4-flash')
    expect(custom.claw.im.model).toBe('deepseek-v4-pro')
    expect(custom.claw.channels[0].model).toBe('deepseek-v4-flash')
  })

  it('localizes the default welcome document for a Chinese first launch', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-zh-welcome-'))
    const writeRoot = join(userDataDir, 'write')
    await writeFile(
      join(userDataDir, 'workwise-settings.json'),
      JSON.stringify({
        schema: 'workwise.settings',
        version: 2,
        revision: 0,
        locale: 'zh',
        write: {
          defaultWorkspaceRoot: writeRoot,
          activeWorkspaceRoot: writeRoot,
          workspaces: [writeRoot]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()
    const welcome = await readFile(join(loaded.write.defaultWorkspaceRoot, 'welcome.md'), 'utf8')

    expect(welcome).toContain('欢迎使用 RailWise AI 写作台')
    expect(welcome).toContain('本地编辑和导出不依赖 AI')
  })

  it('translates an untouched welcome document when the first-run locale changes', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-welcome-transition-'))
    const { workwiseHome } = await writeIsolatedSettings(userDataDir)
    const store = new JsonSettingsStore(userDataDir, { workwiseHome })
    const initial = await store.load()

    expect(await readFile(join(initial.write.defaultWorkspaceRoot, 'welcome.md'), 'utf8'))
      .toContain('Welcome to Write')

    const localized = await store.patch({ locale: 'zh' }, initial.revision)
    const welcome = await readFile(join(localized.write.defaultWorkspaceRoot, 'welcome.md'), 'utf8')

    expect(welcome).toContain('欢迎使用 RailWise AI 写作台')
    expect(welcome).not.toContain('Welcome to Write')
  })

  it('preserves a customized welcome document when the locale changes', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'workwise-settings-custom-welcome-'))
    const { workwiseHome } = await writeIsolatedSettings(userDataDir)
    const store = new JsonSettingsStore(userDataDir, { workwiseHome })
    const initial = await store.load()
    const welcomePath = join(initial.write.defaultWorkspaceRoot, 'welcome.md')
    await writeFile(welcomePath, '# 我的工作说明\n', 'utf8')

    await store.patch({ locale: 'zh' }, initial.revision)

    expect(await readFile(welcomePath, 'utf8')).toBe('# 我的工作说明\n')
  })

  it('preserves the pro write completion model', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        write: {
          inlineCompletion: {
            model: 'deepseek-v4-pro'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.write.inlineCompletion.inheritModel).toBe(false)
    expect(loaded.write.inlineCompletion.model).toBe('deepseek-v4-pro')
  })

  it('treats legacy flash defaults as inherited until the user explicitly overrides them', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        write: {
          inlineCompletion: {
            model: 'deepseek-v4-flash'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.write.inlineCompletion.inheritModel).toBe(true)
    expect(loaded.write.inlineCompletion.model).toBe('deepseek-v4-flash')
  })

  it('migrates legacy deepseek.autoStart=false into WorkWise Runtime', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const workspaceRoot = join(userDataDir, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        workspaceRoot,
        deepseek: {
          autoStart: false
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.agents.kun.autoStart).toBe(false)
  })

  it('migrates existing WorkWise Runtime credentials into General provider settings', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        agents: {
          kun: {
            apiKey: 'sk-existing',
            baseUrl: 'https://runtime.example/v1'
          }
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-existing')
    expect(loaded.provider.baseUrl).toBe('https://runtime.example/v1')
    expect(loaded.agents.kun.apiKey).toBe('')
    expect(loaded.agents.kun.baseUrl).toBe('')
  })

  it('keeps custom model providers when migrated settings are reloaded', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    const provider = defaultModelProviderSettings()

    await writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        agentProvider: 'deepseek-runtime',
        provider: {
          apiKey: 'sk-default',
          baseUrl: 'https://api.deepseek.com',
          providers: [
            ...provider.providers,
            {
              id: 'custom-provider-2',
              name: 'Custom Provider',
              apiKey: 'sk-custom',
              baseUrl: 'https://custom.example/v1',
              endpointFormat: 'messages',
              models: ['custom-model']
            }
          ]
        },
        agents: {
          kun: {
            ...defaultManagedRuntimeSettings(),
            providerId: 'custom-provider-2',
            model: 'custom-model'
          }
        }
      }),
      'utf8'
    )

    const firstStore = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const firstLoaded = await firstStore.load()

    expect(firstLoaded.provider.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom-provider-2',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'messages',
          models: ['custom-model']
        })
      ])
    )
    expect(firstLoaded.agents.kun.providerId).toBe('custom-provider-2')
    await firstStore.save(firstLoaded)

    const secondStore = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const secondLoaded = await secondStore.load()

    expect(secondLoaded.provider.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'custom-provider-2',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'messages',
          models: ['custom-model']
        })
      ])
    )
    expect(secondLoaded.agents.kun.providerId).toBe('custom-provider-2')
  })

  it('loads settings from the legacy lowercase userData directory and writes them into the current path', async () => {
    const supportRoot = await mkdtemp(join(tmpdir(), 'ds-gui-settings-compat-'))
    const legacyUserDataDir = join(supportRoot, 'deepseek-gui')
    const currentUserDataDir = join(supportRoot, 'WorkWise')
    const currentSettingsPath = join(currentUserDataDir, 'workwise-settings.json')

    await mkdir(legacyUserDataDir, { recursive: true })
    await writeFile(
      join(legacyUserDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        provider: {
          apiKey: 'sk-legacy-provider'
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(currentUserDataDir, {
      workwiseHome: join(currentUserDataDir, '.workwise')
    })
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-legacy-provider')
    expect(await readFile(currentSettingsPath, 'utf8')).toContain('sk-legacy-provider')
  })

  it.each(['WorkWise', 'workwise', 'RailWise AI', 'RailWise-AI'])('recognizes settings from the %s profile without changing the source', async name => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-settings-alias-'))
    try {
      const source = join(root, name)
      const target = join(root, 'CurrentProfile')
      await mkdir(source)
      const raw = JSON.stringify({ version: 1, provider: { apiKey: 'local-test-key' } })
      await writeFile(join(source, 'workwise-settings.json'), raw)
      const loaded = await new JsonSettingsStore(target, { workwiseHome: join(target, '.workwise') }).load()
      expect(loaded.provider.apiKey).toBe('local-test-key')
      expect(await readFile(join(source, 'workwise-settings.json'), 'utf8')).toBe(raw)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('does not bypass a multiple-profile conflict through the settings compatibility reader', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-settings-conflict-'))
    try {
      for (const name of ['WorkWise', 'RailWise AI']) {
        await mkdir(join(root, name))
        await writeFile(join(root, name, 'workwise-settings.json'), JSON.stringify({ version: 1, workspaceRoot: join(root, name, 'workspace') }))
      }
      const target = join(root, 'CurrentProfile')
      const store = new JsonSettingsStore(target, { workwiseHome: join(target, '.workwise') })
      await expect(store.load()).rejects.toBeInstanceOf(LegacySettingsSourceConflictError)
      await expect(store.load()).rejects.toMatchObject({ code: 'legacy_profile_conflict', sourcePaths: expect.arrayContaining([join(root, 'WorkWise'), join(root, 'RailWise AI')]) })
      expect(await readdir(root)).not.toContain('CurrentProfile')
      await mkdir(target)
      await writeFile(join(target, 'workgpt-settings.json'), '{"version":1,"locale":"en"}')
      expect((await store.load()).locale).toBe('en')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('creates the configured code workspace on load', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const workspaceRoot = join(userDataDir, 'missing-workspace')

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        workspaceRoot
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.workspaceRoot).toBe(workspaceRoot)
    expect((await stat(workspaceRoot)).isDirectory()).toBe(true)
  })

  it('migrates legacy deepseek-runtime agentProvider to WorkWise Runtime', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        agentProvider: 'deepseek-runtime',
        deepseek: { port: 8787 }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.agents.kun.port).toBe(8787)
  })

  it('backs up invalid JSON and replaces it with defaults', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    await writeFile(settingsPath, '{ invalid json', 'utf8')

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()
    const files = await readdir(userDataDir)
    const backupName = files.find((file) => file.startsWith('deepseek-gui-settings.invalid-'))

    expect(loaded.workspaceRoot.length).toBeGreaterThan(0)
    expect(backupName).toBeTruthy()
    expect(await readFile(join(userDataDir, backupName ?? ''), 'utf8')).toBe('{ invalid json')
    // 兜底默认值写进新文件名;旧文件保留原状(已经另有 invalid 备份)。
    const replaced = await readFile(join(userDataDir, 'workwise-settings.json'), 'utf8')
    expect(() => JSON.parse(replaced)).not.toThrow()
  })

  it('loads the legacy file name inside the current userData dir and re-saves it under the new name', async () => {
    // userData 整目录迁移后的常见形态:目录已经叫 WorkWise Runtime,里面还是旧文件名。
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({ version: 1, provider: { apiKey: 'sk-migrated' } }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()

    expect(loaded.provider.apiKey).toBe('sk-migrated')
    const rewritten = await readFile(join(userDataDir, 'workwise-settings.json'), 'utf8')
    expect(rewritten).toContain('sk-migrated')
    // 旧文件保留,回滚老版本时仍可读。
    expect(await readFile(join(userDataDir, 'deepseek-gui-settings.json'), 'utf8')).toContain('sk-migrated')
  })

  it('throws for non-recoverable read errors', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'deepseek-gui-settings.json')
    await mkdir(settingsPath, { recursive: true })

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })

    await expect(store.load()).rejects.toThrow(/Failed to read settings file/)
  })

  it('merges WorkWise Runtime settings patches', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    await store.load()

    const saved = await store.patch({
      agents: {
        kun: {
          model: 'deepseek-reasoner',
          approvalPolicy: 'on-request'
        }
      }
    })

    expect(saved.agents.kun.model).toBe('deepseek-reasoner')
    expect(saved.agents.kun.approvalPolicy).toBe('on-request')
  })

  it('merges desktop behavior patches without keeping invalid startup state', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    await store.load()

    const enabled = await store.patch({
      appBehavior: {
        openAtLogin: true,
        startMinimized: true,
        closeToTray: true
      }
    })
    const disabled = await store.patch({
      appBehavior: {
        openAtLogin: false
      }
    })

    expect(enabled.appBehavior).toEqual({
      openAtLogin: true,
      startMinimized: true,
      closeToTray: true
    })
    expect(disabled.appBehavior).toEqual({
      openAtLogin: false,
      startMinimized: false,
      closeToTray: true
    })
  })

  it('omits agentProvider when writing normalized settings to disk', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))
    const settingsPath = join(userDataDir, 'workwise-settings.json')
    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    await store.load()
    await store.patch({
      agents: {
        kun: {
          model: 'deepseek-chat'
        }
      }
    })

    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>

    expect('agentProvider' in persisted).toBe(false)
    expect(persisted.agents).toEqual(
      expect.objectContaining({
        kun: expect.objectContaining({ model: 'deepseek-chat' })
      })
    )
  })

  it('folds legacy Claw thread ids into the single WorkWise Runtime mapping', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        claw: {
          channels: [
            {
              id: 'channel-1',
              provider: 'feishu',
              label: 'Feishu Agent',
              threadId: 'thr_codewhale',
              agentThreadIds: { reasonix: '2026-06-01T01:00:00.000Z' },
              conversations: [
                {
                  id: 'conversation-1',
                  chatId: 'chat-1',
                  latestMessageId: 'message-1',
                  localThreadId: 'thr_conversation_codewhale',
                  agentThreadIds: { reasonix: '2026-06-01T02:00:00.000Z' }
                }
              ]
            }
          ]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()
    const channel = loaded.claw.channels[0]
    const conversation = channel?.conversations[0]
    const expectedClawRoot = join(userDataDir, '.workwise', 'claw')

    expect(channel?.threadId).toBe('thr_codewhale')
    expect(conversation?.localThreadId).toBe('thr_conversation_codewhale')
    expect(channel?.workspaceRoot.startsWith(expectedClawRoot)).toBe(true)
    expect(conversation?.workspaceRoot.startsWith(expectedClawRoot)).toBe(true)
  })

  it('seeds Reasonix-only Claw conversations into the canonical thread id', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-'))

    await writeFile(
      join(userDataDir, 'deepseek-gui-settings.json'),
      JSON.stringify({
        version: 1,
        claw: {
          channels: [
            {
              id: 'channel-1',
              provider: 'feishu',
              label: 'Feishu Agent',
              agentThreadIds: { reasonix: 'reasonix-channel' },
              conversations: [
                {
                  id: 'conversation-1',
                  chatId: 'chat-1',
                  latestMessageId: 'message-1',
                  localThreadId: '',
                  agentThreadIds: { reasonix: 'reasonix-conversation' }
                }
              ]
            }
          ]
        }
      }),
      'utf8'
    )

    const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
    const loaded = await store.load()
    const channel = loaded.claw.channels[0]
    const conversation = channel?.conversations[0]

    expect(channel?.threadId).toBe('reasonix-channel')
    expect(conversation?.localThreadId).toBe('reasonix-conversation')
  })

  it('saves settings atomically (no .tmp file left on success)', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ds-gui-settings-atomic-'))

    try {
      const store = new JsonSettingsStore(userDataDir, { workwiseHome: join(userDataDir, '.workwise') })
      const loaded = await store.load()
      await store.save(loaded)

      // Final file is present and non-empty.
      const finalContents = await readFile(
        join(userDataDir, 'workwise-settings.json'),
        'utf8'
      )
      expect(finalContents.length).toBeGreaterThan(0)

      // No .tmp leftover from the atomic write.
      const entries = await readdir(userDataDir)
      expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([])
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })
})
