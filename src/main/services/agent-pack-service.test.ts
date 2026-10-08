import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterAuditedAgentPackAssets, installBundledAgentPack } from './agent-pack-service'

describe('agent-pack-service', () => {
  // These cases exercise the full atomic recursive pack replacement (100 assets).
  // Under the desktop-wide forked suite, concurrent filesystem work can exceed
  // Vitest's 5 s default; keep a bounded, test-local budget so cleanup cannot
  // race an in-flight install after a timeout.
  const BUNDLED_PACK_INSTALL_TIMEOUT_MS = 30_000
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'workwise-agent-pack-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('installs the bundled metro monitoring agent pack into a Codex layout', async () => {
    const codexRoot = join(tempRoot, 'codex')

    const installed = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    expect(installed.rootPath).toBe(codexRoot)
    expect(installed.installedAssets).toBe(100)
    expect(installed.counts).toMatchObject({
      agent: 11,
      command: 18,
      lib: 1,
      skill: 25,
      template: 11,
      theme: 1,
      tool: 33
    })
    expect(installed.manifestPath).toBe(
      join(codexRoot, '.workwise-agent-packs', 'metro-monitoring-agent-pack.json')
    )
    expect(await readFile(join(codexRoot, 'agents', 'data_analyst.md'), 'utf8'))
      .toContain('数据')
    expect(await readFile(join(codexRoot, 'skills', 'monitoring-design', 'SKILL.md'), 'utf8'))
      .toContain('监测')
    expect(await readFile(join(codexRoot, 'skills', 'di-bao-monitoring', 'SKILL.md'), 'utf8'))
      .toContain('地铁')
    expect(await readFile(join(codexRoot, 'prompts', 'daily-report.md'), 'utf8'))
      .toContain('日报')
    expect(await readFile(join(codexRoot, 'tools', 'cross_section.ts'), 'utf8'))
      .toContain('cross')
    expect(await readFile(join(codexRoot, 'lib', 'os_api.ts'), 'utf8'))
      .toContain('fetch')
    expect(await readFile(join(codexRoot, 'templates', 'monthly-monitor-report.json'), 'utf8'))
      .toContain('monthly')

    const source = JSON.parse(
      await readFile(join(codexRoot, 'skills', 'monitoring-design', '.workwise-agent-pack-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled-agent-pack',
      id: 'metro-monitoring-agent-pack',
      kind: 'skill',
      name: 'monitoring-design',
      version: '1.2.34'
    })
    const fileSource = JSON.parse(
      await readFile(join(codexRoot, 'agents', 'data_analyst.md.workwise-agent-pack-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(fileSource).toMatchObject({
      type: 'bundled-agent-pack',
      id: 'metro-monitoring-agent-pack',
      kind: 'agent',
      name: 'data_analyst',
      version: '1.2.34'
    })
  })

  it('excludes blocked or missing Skill audit entries while retaining non-Skill assets', () => {
    const assets = [
      { kind: 'skill' as const, name: 'allowed', dir: 'assets/skill/allowed', target: 'allowed' },
      { kind: 'skill' as const, name: 'blocked', dir: 'assets/skill/blocked', target: 'blocked' },
      { kind: 'skill' as const, name: 'missing', dir: 'assets/skill/missing', target: 'missing' },
      { kind: 'tool' as const, name: 'tool', dir: 'assets/tool/tool.ts', target: 'tool.ts' }
    ]
    const audit = new Map([
      ['allowed', { packaged: true, status: 'available' }],
      ['blocked', { packaged: false, status: 'blocked', reason: 'license review failed' }]
    ])
    expect(filterAuditedAgentPackAssets(assets, audit).map((asset) => `${asset.kind}/${asset.name}`)).toEqual([
      'skill/allowed',
      'tool/tool'
    ])
  })

  it('does not overwrite a user-created asset with the same name', async () => {
    const codexRoot = join(tempRoot, 'codex-conflict')
    const existingSkill = join(codexRoot, 'skills', 'monitoring-design')
    await mkdir(existingSkill, { recursive: true })
    await writeFile(join(existingSkill, 'SKILL.md'), '# Custom monitoring skill\n', 'utf8')

    const installed = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })

    expect(installed).toEqual({
      ok: false,
      message: 'Agent pack asset "skill/monitoring-design" already exists and is not managed by this pack.'
    })
    expect(await readFile(join(existingSkill, 'SKILL.md'), 'utf8')).toBe('# Custom monitoring skill\n')
  })

  it('updates assets previously installed from the same bundled agent pack', async () => {
    const codexRoot = join(tempRoot, 'codex-update')
    const firstInstall = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })
    expect(firstInstall.ok).toBe(true)
    const managedSkill = join(codexRoot, 'skills', 'monitoring-design', 'SKILL.md')
    await writeFile(managedSkill, '# stale managed copy\n', 'utf8')

    const secondInstall = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })

    expect(secondInstall.ok).toBe(true)
    expect(await readFile(managedSkill, 'utf8')).not.toBe('# stale managed copy\n')
  }, BUNDLED_PACK_INSTALL_TIMEOUT_MS)

  it('can upgrade a WORKWISE bundled skill into the bundled agent pack', async () => {
    const codexRoot = join(tempRoot, 'codex-legacy-bundled')
    const legacySkill = join(codexRoot, 'skills', 'di-bao-monitoring')
    await mkdir(legacySkill, { recursive: true })
    await writeFile(join(legacySkill, 'SKILL.md'), '# legacy bundled skill\n', 'utf8')
    await writeFile(join(legacySkill, '.workgpt-skill-source.json'), JSON.stringify({
      type: 'bundled',
      id: 'di-bao-monitoring',
      autoUpdate: false
    }), 'utf8')

    const installed = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })

    expect(installed.ok).toBe(true)
    expect(await readFile(join(legacySkill, 'SKILL.md'), 'utf8')).toContain('地铁')
    const source = JSON.parse(
      await readFile(join(legacySkill, '.workwise-agent-pack-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled-agent-pack',
      id: 'metro-monitoring-agent-pack',
      kind: 'skill',
      name: 'di-bao-monitoring'
    })
  }, BUNDLED_PACK_INSTALL_TIMEOUT_MS)

  it('removes obsolete assets from an earlier managed pack layout', async () => {
    const codexRoot = join(tempRoot, 'codex-obsolete')
    const oldAgentDir = join(codexRoot, 'agents', 'data_analyst')
    await mkdir(oldAgentDir, { recursive: true })
    await writeFile(join(oldAgentDir, 'data_analyst.md'), '# old directory layout\n', 'utf8')
    await writeFile(join(oldAgentDir, '.workgpt-agent-pack-source.json'), JSON.stringify({
      type: 'bundled-agent-pack',
      id: 'metro-monitoring-agent-pack',
      kind: 'agent',
      name: 'data_analyst',
      version: '0.1.0'
    }), 'utf8')
    const manifestDir = join(codexRoot, '.workgpt-agent-packs')
    await mkdir(manifestDir, { recursive: true })
    await writeFile(join(manifestDir, 'metro-monitoring-agent-pack.json'), JSON.stringify({
      type: 'bundled-agent-pack',
      id: 'metro-monitoring-agent-pack',
      assets: [
        {
          kind: 'agent',
          name: 'data_analyst',
          destination: oldAgentDir,
          targetKind: 'directory'
        }
      ]
    }), 'utf8')

    const installed = await installBundledAgentPack({
      id: 'metro-monitoring-agent-pack',
      rootPath: codexRoot
    })

    expect(installed.ok).toBe(true)
    expect(existsSync(oldAgentDir)).toBe(false)
    expect(existsSync(join(codexRoot, 'agents', 'data_analyst.md'))).toBe(true)
  }, BUNDLED_PACK_INSTALL_TIMEOUT_MS)
})
