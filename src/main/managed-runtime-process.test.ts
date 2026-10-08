import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureLogger } from './logger'
import { loadOrCreateFlowSecretStoreKey } from './services/flow-secret-store-key'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  isManagedRuntimeInsecure,
  type AppSettingsV1
} from '../shared/app-settings'
import { KunConfigSchema } from '../../kun/src/config/kun-config.js'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/workwise-test-app',
    getPath: () => '/tmp/workwise-test-user-data'
  }
}))

vi.mock('./services/flow-secret-store-key', () => ({
  loadOrCreateFlowSecretStoreKey: vi.fn(async () => 'managed-runtime-test-flow-key')
}))

let tempRoot: string | null = null

function createSettings(binaryPath: string, port = 8899): AppSettingsV1 {
  if (!tempRoot) throw new Error('temp root not initialized')
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: {
        ...defaultManagedRuntimeSettings(port),
        binaryPath,
        dataDir: join(tempRoot, 'runtime-data'),
        autoStart: true
      }
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

function writeScript(name: string, content: string): string {
  if (!tempRoot) throw new Error('temp root not initialized')
  const path = join(tempRoot, name)
  writeFileSync(path, content, 'utf8')
  return path
}

async function readRuntimeLog(): Promise<string> {
  if (!tempRoot) throw new Error('temp root not initialized')
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const logFile = readdirSync(tempRoot).find((entry) => entry.startsWith('runtime-') && entry.endsWith('.log'))
    if (logFile) return readFileSync(join(tempRoot, logFile), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Expected a runtime log file to be created')
}

beforeEach(() => {
  vi.mocked(loadOrCreateFlowSecretStoreKey).mockReset().mockResolvedValue('managed-runtime-test-flow-key')
  tempRoot = mkdtempSync(join(tmpdir(), 'managed-runtime-process-'))
  configureLogger({ dir: tempRoot, enabled: true, retentionDays: 7 })
})

afterEach(async () => {
  const module = await import('./managed-runtime-process')
  await module.stopManagedRuntimeChildAndWait()
  configureLogger({ dir: '', enabled: true, retentionDays: 2 })
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('startManagedRuntimeChild', () => {
  it('waits for the explicit runtime ready marker before resolving', async () => {
    const script = writeScript(
      'ready-child.js',
      [
        "if (process.env.WORKWISE_FLOW_SECRET_STORE_KEY !== 'managed-runtime-test-flow-key') process.exit(31)",
        "setTimeout(() => {",
        "  process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899, message: 'kun runtime listening' }) + '\\n')",
        "}, 50)",
        "setInterval(() => {}, 1_000)"
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    await expect(module.startManagedRuntimeChild(
      createSettings(script),
      { autoInstallBundledAgentPack: false }
    )).resolves.toBeUndefined()
    expect(module.isManagedRuntimeChildRunning()).toBe(true)
    await module.stopManagedRuntimeChildAndWait()
    const logText = await readRuntimeLog()
    expect(logText).toContain('WORKWISE_RUNTIME_READY')
    expect(logText).not.toContain('KUN_READY')
    expect(logText).not.toContain('kun runtime')
    expect(logText).toContain('WorkWise Runtime listening')
    expect(logText).toContain('[runtime pid=')
    expect(logText).toContain('ready marker received on port 8899')
    expect(logText).not.toContain('managed-runtime-test-flow-key')
  })

  it('starts without a Flow key when protected storage is unavailable', async () => {
    vi.mocked(loadOrCreateFlowSecretStoreKey).mockResolvedValueOnce(null)
    const script = writeScript(
      'unavailable-flow-key-child.js',
      [
        "if (process.env.WORKWISE_FLOW_SECRET_STORE_KEY !== '') process.exit(31)",
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        'setInterval(() => {}, 1_000)'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    await expect(module.startManagedRuntimeChild(
      createSettings(script),
      { autoInstallBundledAgentPack: false }
    )).resolves.toBeUndefined()
    expect(module.isManagedRuntimeChildRunning()).toBe(true)
  })

  it('routes host requests through the ephemeral Runtime port reported by a listening child', async () => {
    const script = writeScript(
      'ephemeral-ready-child.js',
      [
        "const { createServer } = require('node:http')",
        "const portIndex = process.argv.indexOf('--port')",
        "if (portIndex < 0 || process.argv[portIndex + 1] !== '0') process.exit(32)",
        "const server = createServer((req, res) => {",
        "  res.setHeader('content-type', 'application/json')",
        "  res.end(JSON.stringify({ status: 'ok', service: 'kun', path: req.url }))",
        '})',
        "server.listen(0, '127.0.0.1', () => {",
        "  const address = server.address()",
        "  process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: address.port }) + '\\n')",
        '})'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    const settings = createSettings(script, 8899)
    await expect(module.startManagedRuntimeChild(
      settings,
      {
        candidateRoot: tempRoot!,
        homeDir: join(tempRoot!, 'home'),
        workwiseHome: join(tempRoot!, 'home', '.workwise'),
        mcpConfigPath: join(tempRoot!, 'home', '.workwise', 'mcp.json'),
        autoInstallBundledAgentPack: false,
        autoInstallBundledSpecialistSkills: false,
        skillRoots: []
      }
    )).resolves.toBeUndefined()
    const actualPort = module.getManagedRuntimeActualPort()
    expect(actualPort).toEqual(expect.any(Number))
    expect(actualPort).not.toBe(8899)

    const { runtimeRequestViaHost } = await import('./runtime/managed-runtime-adapter')
    await expect(runtimeRequestViaHost(
      settings,
      '/health',
      { method: 'GET' },
      async () => undefined
    )).resolves.toMatchObject({
      ok: true,
      status: 200,
      body: JSON.stringify({ status: 'ok', service: 'kun', path: '/health' })
    })

    await module.stopManagedRuntimeChildAndWait()
    expect(module.getManagedRuntimeActualPort()).toBeNull()
  })

  it('does not route fixed-port production through a mismatched ready-marker port', async () => {
    const script = writeScript(
      'fixed-port-mismatch-child.js',
      [
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 43129 }) + '\\n')",
        'setInterval(() => {}, 1_000)'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    await expect(module.startManagedRuntimeChild(
      createSettings(script, 8899),
      { autoInstallBundledAgentPack: false }
    )).resolves.toBeUndefined()
    expect(module.getManagedRuntimeActualPort()).toBeNull()
  })

  it('clears the actual Runtime port when the child exits unexpectedly', async () => {
    const script = writeScript(
      'ephemeral-exit-child.js',
      [
        "const portIndex = process.argv.indexOf('--port')",
        "if (portIndex < 0 || process.argv[portIndex + 1] !== '0') process.exit(33)",
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 43128 }) + '\\n')",
        'setTimeout(() => process.exit(0), 25)'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    await expect(module.startManagedRuntimeChild(
      createSettings(script, 8899),
      {
        candidateRoot: tempRoot!,
        homeDir: join(tempRoot!, 'home'),
        workwiseHome: join(tempRoot!, 'home', '.workwise'),
        mcpConfigPath: join(tempRoot!, 'home', '.workwise', 'mcp.json'),
        autoInstallBundledAgentPack: false,
        autoInstallBundledSpecialistSkills: false,
        skillRoots: []
      }
    )).resolves.toBeUndefined()
    expect(module.getManagedRuntimeActualPort()).toBe(43128)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(module.getManagedRuntimeActualPort()).toBeNull()
  })

  it('rejects when the child exits before reporting ready', async () => {
    const script = writeScript(
      'exit-child.js',
      [
        "process.stderr.write('bind failed on port 8899\\n')",
        'setTimeout(() => process.exit(23), 20)'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    await expect(module.startManagedRuntimeChild(
      createSettings(script),
      { autoInstallBundledAgentPack: false }
    )).rejects.toThrow(
      /WorkWise Runtime exited during startup with code 23[\s\S]*bind failed on port 8899/
    )
    expect(module.isManagedRuntimeChildRunning()).toBe(false)
    await module.stopManagedRuntimeChildAndWait()
    const logText = await readRuntimeLog()
    expect(logText).toContain('bind failed on port 8899')
    expect(logText).toContain('exited with code 23')
  })

  it('passes a process-scoped Flow key to an isolated candidate Runtime', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const script = writeScript(
      'candidate-flow-key-child.js',
      [
        "if (process.env.WORKWISE_FLOW_SECRET_STORE_KEY !== 'candidate-flow-key') process.exit(31)",
        "process.stdout.write('KUN_READY ' + JSON.stringify({ service: 'kun', mode: 'serve', port: 8899 }) + '\\n')",
        'setInterval(() => {}, 1_000)'
      ].join('\n')
    )
    const module = await import('./managed-runtime-process')
    const candidateHome = join(tempRoot, 'home')
    await expect(module.startManagedRuntimeChild(createSettings(script), {
      candidateRoot: tempRoot,
      homeDir: candidateHome,
      workwiseHome: join(candidateHome, '.workwise'),
      mcpConfigPath: join(candidateHome, '.workwise', 'mcp.json'),
      autoInstallBundledAgentPack: false,
      autoInstallBundledSpecialistSkills: false,
      skillRoots: [],
      flowSecretStoreKey: 'candidate-flow-key'
    })).resolves.toBeUndefined()
    expect(module.isManagedRuntimeChildRunning()).toBe(true)
  })
})

describe('reclaimManagedRuntimePort', () => {
  it('reports a port as unavailable when another listener owns it', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const address = server.address() as AddressInfo
      const module = await import('./managed-runtime-process')

      await expect(module.reclaimManagedRuntimePort(address.port)).resolves.toEqual({
        ok: false,
        message: `port ${address.port} is in use`
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('allows non-positive ports so WorkWise Runtime can request an ephemeral port', async () => {
    const module = await import('./managed-runtime-process')

    await expect(module.reclaimManagedRuntimePort(0)).resolves.toEqual({ ok: true })
  })
})

describe('resolveManagedRuntimeDataDir', () => {
  it('forces candidate runs into the guarded approval and sandbox policy', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const module = await import('./managed-runtime-process')
    const settings = createSettings('/tmp/fake-kun-child.js')
    settings.agents.kun.approvalPolicy = 'auto'
    settings.agents.kun.sandboxMode = 'danger-full-access'
    settings.agents.kun.insecure = true

    const candidate = module.resolveManagedRuntimeForStart(settings, true, 'candidate-runtime-token')
    expect(candidate).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      insecure: false,
      runtimeToken: 'candidate-runtime-token'
    })
    expect(isManagedRuntimeInsecure(candidate)).toBe(false)
    expect(module.resolveManagedRuntimeForStart(settings, false)).toMatchObject({
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      insecure: true
    })
  })

  it('expands Windows-style home-relative data directories', async () => {
    const module = await import('./managed-runtime-process')

    expect(module.resolveManagedRuntimeDataDir({ dataDir: '~\\deepseek\\kun' })).toBe(join(homedir(), 'deepseek', 'kun'))
  })

  it('does not expand non-home tilde prefixes', async () => {
    const module = await import('./managed-runtime-process')

    expect(module.resolveManagedRuntimeDataDir({ dataDir: '~other\\kun' })).toBe('~other\\kun')
  })

  it('expands candidate runtime data under the explicitly supplied home', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const module = await import('./managed-runtime-process')
    const candidateHome = join(tempRoot, 'candidate-home')

    expect(module.resolveManagedRuntimeDataDir(
      { dataDir: '~/.workwise/runtime' },
      candidateHome
    )).toBe(join(candidateHome, '.workwise', 'runtime'))
  })

  it('rejects candidate Runtime paths outside the candidate root before spawning', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const script = writeScript('never-started.js', 'setInterval(() => {}, 1_000)')
    const module = await import('./managed-runtime-process')

    await expect(module.startManagedRuntimeChild(createSettings(script), {
      candidateRoot: join(tempRoot, 'candidate'),
      homeDir: homedir(),
      workwiseHome: join(tempRoot, 'candidate', 'home', '.workwise'),
      autoInstallBundledAgentPack: false,
      autoInstallBundledSpecialistSkills: false,
      skillRoots: []
    })).rejects.toThrow('candidate Runtime home must stay inside WORKWISE_CANDIDATE_ROOT')
    expect(module.isManagedRuntimeChildRunning()).toBe(false)
  })
})

describe('syncManagedRuntimeConfig', () => {
  it('adds common npm and npx lookup directories to the MCP runtime PATH', async () => {
    const module = await import('./managed-runtime-process')
    const resolved = module.resolveMcpToolPath({ PATH: '/custom/bin' } as NodeJS.ProcessEnv)
    const entries = resolved.split(delimiter)

    expect(entries[0]).toBe('/custom/bin')
    expect(entries).toContain(dirname(process.execPath))
    if (process.platform !== 'win32') {
      expect(entries).toEqual(expect.arrayContaining([
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin'
      ]))
    }
  })

  it('creates GUI-managed config with attachments enabled for image paste/upload', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, {
      ...defaultManagedRuntimeSettings(),
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro'
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.serve.storage).toMatchObject({ backend: 'hybrid' })
    expect(parsed.serve.tokenEconomy).toMatchObject({
      enabled: false,
      compressToolDescriptions: true,
      compressToolResults: true,
      conciseResponses: true,
      historyHygiene: {
        maxToolResultLines: 320,
        maxToolResultBytes: 32768,
        maxToolResultTokens: 8000,
        maxToolArgumentStringBytes: 8192,
        maxToolArgumentStringTokens: 2000,
        maxArrayItems: 80
      }
    })
    expect(parsed.contextCompaction).toMatchObject({
      defaultSoftThreshold: 16000,
      defaultHardThreshold: 24000,
      summaryMode: 'heuristic'
    })
    expect(parsed.models.profiles['deepseek-flash']).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      inputModalities: ['text', 'image'],
      supportsToolCalling: true,
      messageParts: ['text', 'image_url']
    })
    expect(parsed.models.profiles['deepseek-v4-pro']).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      contextCompaction: {
        softThreshold: 980_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.models.profiles['deepseek-v4-flash']).toMatchObject({
      aliases: ['deepseek-chat', 'deepseek-reasoner'],
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      contextCompaction: {
        softThreshold: 980_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.models.profiles['deepseek-v4-flash-vision-exp']).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      messageParts: ['text', 'image_url']
    })
    expect(parsed.runtime.toolStorm).toMatchObject({ enabled: true, windowSize: 8, threshold: 3 })
    expect(parsed.runtime.toolArgumentRepair).toMatchObject({ maxStringBytes: 524288 })
    expect(parsed.capabilities.attachments).toMatchObject({ enabled: true })
    expect(parsed.capabilities.attachments.allowedMimeTypes ?? [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp'
    ]).toContain('image/gif')
    expect(parsed.capabilities.web).toMatchObject({
      enabled: true,
      fetchEnabled: true,
      searchEnabled: true,
      provider: 'deepseek-responses'
    })
    expect(parsed.capabilities.mcp.search).toMatchObject({ enabled: false, mode: 'auto' })
    expect(parsed.capabilities.imageGen).toEqual({
      enabled: false,
      protocol: 'openai-images',
      timeoutMs: 180000
    })
  })

  it('adds GIF only to the historical default attachment MIME list', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        attachments: {
          enabled: true,
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp']
        }
      }
    }))
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.attachments.allowedMimeTypes).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif'
    ])
  })

  it('preserves a custom attachment MIME list without adding GIF', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        attachments: {
          enabled: true,
          allowedMimeTypes: ['image/png']
        }
      }
    }))
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.attachments.allowedMimeTypes).toEqual(['image/png'])
  })

  it('writes the image generation capability and omits cleared fields', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./managed-runtime-process')
    const runtime = {
      ...defaultManagedRuntimeSettings(),
      imageGeneration: {
        enabled: true,
        providerId: '',
        protocol: 'openai-images' as const,
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'sk-image-test',
        model: 'Kwai-Kolors/Kolors',
        defaultSize: '',
        timeoutMs: 240000
      }
    }

    await module.syncManagedRuntimeConfig(tempRoot, runtime)

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.imageGen).toEqual({
      enabled: true,
      protocol: 'openai-images',
      baseUrl: 'https://api.siliconflow.cn/v1',
      apiKey: 'sk-image-test',
      model: 'Kwai-Kolors/Kolors',
      timeoutMs: 240000
    })
    expect(KunConfigSchema.safeParse(parsed).success).toBe(true)

    // Clearing the key in GUI settings must remove it from config.json.
    await module.syncManagedRuntimeConfig(tempRoot, {
      ...runtime,
      imageGeneration: { ...runtime.imageGeneration, apiKey: '' }
    })
    const cleared = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect('apiKey' in cleared.capabilities.imageGen).toBe(false)
  })

  it('keeps the config stable across repeated syncs with imageGen configured', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./managed-runtime-process')
    const runtime = {
      ...defaultManagedRuntimeSettings(),
      imageGeneration: {
        enabled: true,
        providerId: '',
        protocol: 'openai-images' as const,
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: 'sk-image-test',
        model: 'Kwai-Kolors/Kolors',
        defaultSize: '1024x1024',
        timeoutMs: 180000
      }
    }

    await module.syncManagedRuntimeConfig(tempRoot, runtime)
    const firstText = readFileSync(configPath, 'utf8')
    const firstMtime = statSync(configPath).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 25))

    // If the capability sanitizer strips imageGen from the existing config,
    // every sync rewrites the file and restarts WorkWise Runtime in a loop.
    await module.syncManagedRuntimeConfig(tempRoot, runtime)
    expect(readFileSync(configPath, 'utf8')).toBe(firstText)
    expect(statSync(configPath).mtimeMs).toBe(firstMtime)
  })

  it('adds the built-in schedule MCP server to WorkWise Runtime runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./managed-runtime-process')
    const settings = createSettings('/tmp/fake-kun-child.js')
    settings.schedule.internal.port = 9788
    settings.schedule.internal.secret = 'top-secret'

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
      scheduleMcp: {
        settings,
        launch: {
          appPath: '/tmp/workwise-test-app',
          execPath: '/tmp/electron',
          isPackaged: false
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(true)
    expect(parsed.capabilities.mcp.servers.gui_schedule).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: '/tmp/electron',
      args: [
        '/tmp/workwise-test-app/out/main/claw-schedule-mcp-node-entry.js',
        '--gui-schedule-mcp-server',
        '--base-url',
        'http://127.0.0.1:9788',
        '--secret',
        'top-secret'
      ],
      env: {
        ELECTRON_RUN_AS_NODE: '1'
      },
      trustScope: 'user'
    })
  })

  it('adds GUI project and configured global skill roots to WorkWise Runtime runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const module = await import('./managed-runtime-process')
    const originalCodexHome = process.env.CODEX_HOME
    const settings = createSettings('/tmp/fake-kun-child.js')
    const workspaceRoot = join(tempRoot, 'workspace')
    const extraRoot = join(tempRoot, 'extra-skills')
    const codexHome = join(tempRoot, 'codex-home')
    settings.workspaceRoot = workspaceRoot
    settings.claw.skills.extraDirs = [extraRoot]
    mkdirSync(join(workspaceRoot, '.codex', 'skills'), { recursive: true })
    mkdirSync(join(codexHome, 'skills'), { recursive: true })
    process.env.CODEX_HOME = codexHome

    try {
      await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
        scheduleMcp: {
          settings,
          launch: {
            appPath: '/tmp/workwise-test-app',
            execPath: '/tmp/electron',
            isPackaged: false
          }
        }
      })
    } finally {
      if (originalCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = originalCodexHome
    }

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.skills.enabled).toBe(true)
    expect(parsed.capabilities.skills.legacySkillMd).toBe(true)
    expect(parsed.capabilities.skills.roots).toEqual(expect.arrayContaining([
      join(workspaceRoot, '.codex', 'skills'),
      join(codexHome, 'skills'),
      extraRoot
    ]))
  })

  it('writes GUI-managed MCP search settings without removing existing servers', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      legacyTopLevelFlag: true,
      contextCompaction: {
        modelProfiles: {
          'custom-model': {
            contextWindowTokens: 128000
          }
        }
      },
      models: {
        profiles: {
          'user-model': {
            contextWindowTokens: 96000,
            contextCompaction: {
              softThreshold: 86000
            }
          },
          'deepseek-v4-pro': {
            contextCompaction: {
              softThreshold: 970000
            }
          }
        }
      },
      runtime: {
        customRuntimeFlag: true,
        toolStorm: {
          customStormFlag: 'keep'
        }
      },
      serve: {
        legacyServeFlag: true,
        tokenEconomy: {
          customTokenEconomyFlag: 'keep',
          historyHygiene: {
            customHistoryFlag: true
          }
        }
      },
      capabilities: {
        mcp: {
          enabled: true,
          servers: {
            github: {
              transport: 'stdio',
              command: 'github-mcp',
              trustScope: 'user'
            }
          }
        },
        web: {
          enabled: true,
          fetchEnabled: true
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, {
      ...defaultManagedRuntimeSettings(),
      storage: {
        backend: 'hybrid',
        sqlitePath: '/tmp/kun-index.sqlite3'
      },
      contextCompaction: {
        defaultSoftThreshold: 32000,
        defaultHardThreshold: 64000,
        summaryMode: 'model',
        summaryTimeoutMs: 30000,
        summaryMaxTokens: 1600,
        summaryInputMaxBytes: 131072
      },
      runtimeTuning: {
        toolStorm: {
          enabled: false,
          windowSize: 12,
          threshold: 4
        },
        toolArgumentRepair: {
          maxStringBytes: 262144
        }
      },
      mcpSearch: {
        enabled: true,
        mode: 'search',
        autoThresholdToolCount: 12,
        topKDefault: 4,
        topKMax: 9,
        minScore: 0.2
      },
      tokenEconomy: {
        enabled: true,
        compressToolDescriptions: false,
        compressToolResults: true,
        conciseResponses: false,
        historyHygiene: {
          maxToolResultLines: 100,
          maxToolResultBytes: 16384,
          maxToolResultTokens: 4000,
          maxToolArgumentStringBytes: 4096,
          maxToolArgumentStringTokens: 1000,
          maxArrayItems: 40
        }
      }
    }, {
      mcpConfigPath: join(tempRoot, 'empty-mcp.json')
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(KunConfigSchema.safeParse(parsed).success).toBe(true)
    expect(parsed.legacyTopLevelFlag).toBeUndefined()
    expect(parsed.serve.legacyServeFlag).toBeUndefined()
    expect(parsed.serve.storage).toMatchObject({
      backend: 'hybrid',
      sqlitePath: '/tmp/kun-index.sqlite3'
    })
    expect(parsed.serve.tokenEconomy).toMatchObject({
      enabled: true,
      compressToolDescriptions: false,
      compressToolResults: true,
      conciseResponses: false,
      historyHygiene: {
        maxToolResultLines: 100,
        maxToolResultBytes: 16384,
        maxToolResultTokens: 4000,
        maxToolArgumentStringBytes: 4096,
        maxToolArgumentStringTokens: 1000,
        maxArrayItems: 40
      }
    })
    expect(parsed.serve.tokenEconomy.customTokenEconomyFlag).toBeUndefined()
    expect(parsed.serve.tokenEconomy.historyHygiene.customHistoryFlag).toBeUndefined()
    expect(parsed.contextCompaction).toMatchObject({
      defaultSoftThreshold: 32000,
      defaultHardThreshold: 64000,
      summaryMode: 'model',
      summaryTimeoutMs: 30000,
      summaryMaxTokens: 1600,
      summaryInputMaxBytes: 131072
    })
    expect(parsed.contextCompaction.modelProfiles['custom-model']).toMatchObject({
      contextWindowTokens: 128000
    })
    expect(parsed.models.profiles['user-model']).toMatchObject({
      contextWindowTokens: 96000,
      contextCompaction: {
        softThreshold: 86000
      }
    })
    expect(parsed.models.profiles['deepseek-v4-pro']).toMatchObject({
      contextWindowTokens: 1_000_000,
      contextCompaction: {
        softThreshold: 970_000,
        hardThreshold: 990_000
      }
    })
    expect(parsed.runtime.toolStorm).toMatchObject({
      enabled: false,
      windowSize: 12,
      threshold: 4
    })
    expect(parsed.runtime.toolStorm.customStormFlag).toBeUndefined()
    expect(parsed.runtime.customRuntimeFlag).toBeUndefined()
    expect(parsed.runtime.toolArgumentRepair).toMatchObject({ maxStringBytes: 262144 })
    expect(parsed.capabilities.attachments).toMatchObject({ enabled: true })
    expect(parsed.capabilities.mcp.servers.github.command).toBe('github-mcp')
    expect(parsed.capabilities.web.fetchEnabled).toBe(true)
    expect(parsed.capabilities.mcp.search).toMatchObject({
      enabled: true,
      mode: 'search',
      autoThresholdToolCount: 12,
      topKDefault: 4,
      topKMax: 9,
      minScore: 0.2
    })
  })

  it('imports GUI-managed MCP servers into runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const mcpConfigPath = join(tempRoot, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify({
      servers: {
        'stata-mcp': {
          command: 'uvx',
          args: ['stata-mcp'],
          env: {
            STATA_CLI: 'D:\\stata\\StataMP-64.exe'
          },
          enabled: true,
          disabled: false
        },
        'docs-mcp': {
          url: 'https://mcp.example.test/mcp',
          headers: {
            Authorization: 'Bearer docs-token'
          }
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
      mcpConfigPath
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(true)
    expect(parsed.capabilities.mcp.servers['stata-mcp']).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'uvx',
      args: ['stata-mcp'],
      env: {
        STATA_CLI: 'D:\\stata\\StataMP-64.exe'
      },
      trustScope: 'user'
    })
    const pathEnvKey = process.platform === 'win32' ? 'Path' : 'PATH'
    const stataEnv = parsed.capabilities.mcp.servers['stata-mcp'].env as Record<string, string>
    expect(stataEnv[pathEnvKey].split(delimiter)).toContain(dirname(process.execPath))
    if (process.platform !== 'win32') {
      expect(stataEnv[pathEnvKey].split(delimiter)).toEqual(expect.arrayContaining([
        '/opt/homebrew/bin',
        '/usr/local/bin'
      ]))
    }
    expect(parsed.capabilities.mcp.servers['docs-mcp']).toMatchObject({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.test/mcp',
      headers: {
        Authorization: 'Bearer docs-token'
      },
      trustScope: 'user'
    })
  })

  it('merges MCP V2 runtime snapshots without writing credential values to config', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const mcpConfigPath = join(tempRoot, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify({ servers: {} }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
      mcpConfigPath,
      mcpV2Servers: {
        'secure-docs': {
          enabled: true,
          transport: 'streamable-http',
          url: 'https://mcp.example.test/mcp',
          headers: { Authorization: '${WORKWISE_MCP_SECRET_ABC123}' },
          trustScope: 'user',
          trustedWorkspaceRoots: [],
          timeoutMs: 30_000
        }
      }
    })

    const content = readFileSync(configPath, 'utf8')
    expect(content).not.toContain('runtime-only-secret')
    expect(JSON.parse(content).capabilities.mcp.servers['secure-docs']).toMatchObject({
      headers: { Authorization: '${WORKWISE_MCP_SECRET_ABC123}' }
    })
  })

  it('normalizes legacy recommended MCP configs before importing them into runtime capabilities', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    const mcpConfigPath = join(tempRoot, 'mcp.json')
    writeFileSync(mcpConfigPath, JSON.stringify({
      servers: {
        puppeteer: {
          command: 'puppeteer',
          args: ['-y', '@modelcontextprotocol/server-puppeteer']
        },
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/project'],
          trustScope: 'workspace',
          trustedWorkspaceRoots: ['/path/to/project']
        },
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}'
          }
        },
        'brave-search': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-brave-search'],
          env: {
            BRAVE_API_KEY: '${BRAVE_API_KEY}'
          }
        },
        slack: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
          env: {
            SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}',
            SLACK_TEAM_ID: '${SLACK_TEAM_ID}'
          }
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
      mcpConfigPath
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.servers.puppeteer).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer']
    })
    expect(parsed.capabilities.mcp.servers.filesystem).toMatchObject({
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/project']
    })
    expect(parsed.capabilities.mcp.servers.github).toMatchObject({
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github']
    })
    expect(parsed.capabilities.mcp.servers['brave-search']).toMatchObject({
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search']
    })
    expect(parsed.capabilities.mcp.servers.slack).toMatchObject({
      enabled: false,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack']
    })
  })

  it('replaces unparsable historical WorkWise Runtime config with a valid GUI-managed config', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, '{ legacy config', 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    expect(KunConfigSchema.safeParse(parsed).success).toBe(true)
  })

  it('does not enable MCP when the capability is explicitly disabled', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        mcp: {
          enabled: false
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings(), {
      scheduleMcp: {
        settings: createSettings('/tmp/fake-kun-child.js'),
        launch: {
          appPath: '/tmp/workwise-test-app',
          execPath: '/tmp/electron',
          isPackaged: false
        }
      }
    })

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.mcp.enabled).toBe(false)
    expect(parsed.capabilities.mcp.servers.gui_schedule).toMatchObject({
      transport: 'stdio',
      command: '/tmp/electron',
      args: [
        '/tmp/workwise-test-app/out/main/claw-schedule-mcp-node-entry.js',
        '--gui-schedule-mcp-server',
        '--base-url',
        'http://127.0.0.1:8788'
      ],
      env: {
        ELECTRON_RUN_AS_NODE: '1'
      }
    })
  })

  it('does not override an explicitly disabled attachment capability', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        attachments: {
          enabled: false,
          maxImageBytes: 1024
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.attachments).toMatchObject({
      enabled: false,
      maxImageBytes: 1024
    })
  })

  it('does not override explicitly disabled web fetch capability', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const configPath = join(tempRoot, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      capabilities: {
        web: {
          enabled: false,
          fetchEnabled: false,
          searchEnabled: true,
          provider: 'custom-search'
        }
      }
    }), 'utf8')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, defaultManagedRuntimeSettings())

    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as any
    expect(parsed.capabilities.web).toMatchObject({
      enabled: false,
      fetchEnabled: false,
      searchEnabled: true,
      provider: 'custom-search'
    })
  })

  it('does not enable DeepSeek Responses search for a third-party provider', async () => {
    if (!tempRoot) throw new Error('temp root not initialized')
    const module = await import('./managed-runtime-process')

    await module.syncManagedRuntimeConfig(tempRoot, {
      ...defaultManagedRuntimeSettings(),
      baseUrl: 'https://third-party.example/v1',
      model: 'deepseek-v4-pro'
    })

    const parsed = JSON.parse(readFileSync(join(tempRoot, 'config.json'), 'utf8')) as any
    expect(parsed.capabilities.web.searchEnabled).not.toBe(true)
    expect(parsed.capabilities.web.provider).not.toBe('deepseek-responses')
  })
})
