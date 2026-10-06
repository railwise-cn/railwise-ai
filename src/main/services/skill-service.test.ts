import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledPackageV1 } from '../../shared/marketplace'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import {
  discoverInstalledPluginSkillRoots,
  installBundledSkill,
  installGithubSkill,
  listGuiSkills
} from './skill-service'
import { inspectPackageDirectory } from './package-installation-service'

const originalFetch = globalThis.fetch
const originalCodexHome = process.env.CODEX_HOME
const originalGithubToken = process.env.GITHUB_TOKEN
const originalGhToken = process.env.GH_TOKEN

describe('skill-service', () => {
  // PPT Master is a 13 MiB, 450+ file audited bundle. During the desktop-wide
  // forked run, concurrent filesystem work can exceed Vitest's 5 s default.
  // Keep the longer budget local to this recursive install case so a timeout
  // cannot race afterEach cleanup against an in-flight copy.
  const PPT_MASTER_INSTALL_TIMEOUT_MS = 30_000
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gui-skills-'))
    process.env.CODEX_HOME = join(tempRoot, 'codex-home')
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = originalGithubToken
    if (originalGhToken === undefined) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = originalGhToken
    vi.restoreAllMocks()
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('discovers project Codex skills from the active workspace', async () => {
    const workspaceRoot = join(tempRoot, 'workspace')
    const skillRoot = join(workspaceRoot, '.codex', 'skills', 'openspec-apply-change')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: openspec-apply-change',
      'description: Implement tasks from an OpenSpec change.',
      '---',
      '',
      'Implement tasks from an OpenSpec change.'
    ].join('\n'), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'openspec-apply-change',
      name: 'Openspec Apply Change',
      description: 'Implement tasks from an OpenSpec change.',
      scope: 'project'
    }))
  })

  it('discovers only integrity-verified Skills from installed WorkWise plugins', async () => {
    const pluginRoot = join(tempRoot, 'installed-plugin')
    const skillRoot = join(pluginRoot, 'skills', 'market-skill')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# Marketplace Skill\n')
    await writeFile(join(pluginRoot, 'workwise.catalog.json'), JSON.stringify({
      components: [{ type: 'skill' }]
    }))
    const inspection = await inspectPackageDirectory(pluginRoot)
    const record = {
      artifact: { location: pluginRoot, sha256: inspection.sha256 }
    } as InstalledPackageV1

    await expect(discoverInstalledPluginSkillRoots([record])).resolves.toEqual([
      join(pluginRoot, 'skills')
    ])

    await writeFile(join(skillRoot, 'SKILL.md'), '# Tampered Marketplace Skill\n')
    await expect(discoverInstalledPluginSkillRoots([record])).resolves.toEqual([])
  })

  it('discovers trusted Codex template plugins with bounded reference presentations', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-plugin-template')
    const pluginSkillRoot = join(
      process.env.CODEX_HOME!,
      'plugins',
      'cache',
      'openai-curated-remote',
      'openai-templates',
      '0.1.0',
      'skills',
      'artifact-template-team-alignment'
    )
    await mkdir(join(pluginSkillRoot, 'assets'), { recursive: true })
    await writeFile(join(pluginSkillRoot, 'SKILL.md'), [
      '---',
      'name: artifact-template-team-alignment',
      'description: Team alignment presentation template.',
      '---'
    ].join('\n'), 'utf8')
    await writeFile(join(pluginSkillRoot, 'assets', 'reference.pptx'), Buffer.alloc(2 * 1024 * 1024))

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'artifact-template-team-alignment',
      scope: 'global'
    }))
    expect(result.validationErrors).not.toContainEqual(expect.objectContaining({ root: pluginSkillRoot }))
  })

  it('keeps the strict 1 MiB limit for workspace Skills', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-oversized')
    const skillRoot = join(workspaceRoot, '.agents', 'skills', 'oversized-workspace-skill')
    await mkdir(join(skillRoot, 'assets'), { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# Oversized workspace skill', 'utf8')
    await writeFile(join(skillRoot, 'assets', 'reference.pptx'), Buffer.alloc(2 * 1024 * 1024))

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).not.toContainEqual(expect.objectContaining({ id: 'oversized-workspace-skill' }))
    expect(result.validationErrors).toContainEqual(expect.objectContaining({
      root: skillRoot,
      message: expect.stringContaining('file exceeds 1 MiB: assets/reference.pptx')
    }))
  })

  it('keeps legacy SKILL.md entries with Chinese frontmatter names distinct', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-cn')
    const skillRoot = join(workspaceRoot, '.agents', 'skills')
    const tddRoot = join(skillRoot, 'tdd')
    const reviewRoot = join(skillRoot, 'code-review')
    await mkdir(tddRoot, { recursive: true })
    await mkdir(reviewRoot, { recursive: true })
    await writeFile(join(tddRoot, 'SKILL.md'), [
      '---',
      'name: 测试驱动开发(TDD)',
      'description: 用测试先行推进实现。',
      '---',
      '',
      '# TDD',
      '',
      '先写失败测试，再实现。'
    ].join('\n'), 'utf8')
    await writeFile(join(reviewRoot, 'SKILL.md'), [
      '---',
      'name: 代码审查',
      'description: 检查回归风险。',
      '---',
      '',
      '# Review',
      '',
      '关注正确性和测试。'
    ].join('\n'), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const projectSkills = result.skills.filter((skill) => skill.root.startsWith(skillRoot))
    expect(projectSkills).toHaveLength(2)
    expect(projectSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tdd',
        name: '测试驱动开发(TDD)',
        description: '用测试先行推进实现。'
      }),
      expect.objectContaining({
        id: 'code-review',
        name: '代码审查',
        description: '检查回归风险。'
      })
    ]))
    expect(projectSkills.map((skill) => skill.id)).not.toContain('skill')
  })

  it('downgrades untrusted legacy source metadata that requests automatic updates', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-managed')
    const skillRoot = join(workspaceRoot, '.agents', 'skills', 'di-bao-monitoring')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: di-bao-monitoring',
      'description: Railwise monitoring.',
      '---',
      '',
      '# Di-bao'
    ].join('\n'), 'utf8')
    await writeFile(join(skillRoot, '.workgpt-skill-source.json'), JSON.stringify({
      type: 'github',
      owner: 'railwise-cn',
      repo: 'di-bao-monitoring-skill',
      path: 'skill/di-bao-monitoring',
      ref: 'main',
      installedSha: 'abc123',
      autoUpdate: true
    }), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'di-bao-monitoring',
      source: {
        type: 'github',
        owner: 'railwise-cn',
        repo: 'di-bao-monitoring-skill',
        path: 'skill/di-bao-monitoring',
        ref: 'main',
        installedSha: 'abc123',
        autoUpdate: false
      }
    }))
  })

  it('defaults migrated third-party GitHub sources to manual updates and preserves source metadata', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-migrated-manual-update')
    const skillRoot = join(workspaceRoot, '.agents', 'skills', 'third-party-skill')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), '# Third-party Skill\n', 'utf8')
    await writeFile(join(skillRoot, '.workgpt-skill-source.json'), JSON.stringify({
      type: 'github',
      owner: 'third-party',
      repo: 'third-party-skill',
      path: 'skills/third-party',
      ref: 'release',
      installedSha: 'abc123',
      includePaths: ['SKILL.md', 'references']
    }), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'third-party-skill',
      source: {
        type: 'github',
        owner: 'third-party',
        repo: 'third-party-skill',
        path: 'skills/third-party',
        ref: 'release',
        installedSha: 'abc123',
        autoUpdate: false,
        includePaths: ['SKILL.md', 'references']
      }
    }))
  })

  it('installs the bundled operational monitoring skill with its assets', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'operational-monitoring'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    expect(installed.path).toBe(join(skillInstallRoot, 'operational-monitoring', 'SKILL.md'))
    expect(await readFile(join(skillInstallRoot, 'operational-monitoring', 'references', 'monitoring-scheme.md'), 'utf8'))
      .toContain('监测实施方案')
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'operational-monitoring', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled',
      id: 'operational-monitoring',
      autoUpdate: false
    })

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'operational-monitoring',
      source: {
        type: 'bundled',
        id: 'operational-monitoring',
        autoUpdate: false
      }
    }))
  })

  it('installs the bundled Railwise di-bao monitoring skill with its assets', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled-dibao')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'di-bao-monitoring'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    expect(installed.path).toBe(join(skillInstallRoot, 'di-bao-monitoring', 'SKILL.md'))
    expect(await readFile(join(skillInstallRoot, 'di-bao-monitoring', 'assets', 'daily-report-template.md'), 'utf8'))
      .toContain('日报')
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'di-bao-monitoring', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled',
      id: 'di-bao-monitoring',
      autoUpdate: false
    })
  })

  it('installs the bundled tender master skill with agent, references, and local QA scripts', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled-tender-master')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'tender-master'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    const installedRoot = join(skillInstallRoot, 'tender-master')
    const skill = await readFile(join(installedRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('招投标编制专家')
    expect(skill).toContain('技术参数、实质性要求和验收条件必须')
    expect(skill).not.toContain('\uFFFD')
    expect(await readFile(join(installedRoot, 'agents', 'tender-agent.md'), 'utf8'))
      .toContain('九步流程顺序锁死')
    expect(await readFile(join(installedRoot, 'references', 'prompt-and-riskledger.md'), 'utf8'))
      .toContain('不能把“必须≥500TB”弱化')
    expect(existsSync(join(installedRoot, 'scripts', 'bid_quality_check.py'))).toBe(true)
    expect(existsSync(join(installedRoot, 'scripts', 'build_docx.py'))).toBe(true)
    expect(existsSync(join(installedRoot, 'README.md'))).toBe(false)

    const source = JSON.parse(
      await readFile(join(installedRoot, '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled',
      id: 'tender-master',
      autoUpdate: false
    })

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'tender-master',
      source: {
        type: 'bundled',
        id: 'tender-master',
        autoUpdate: false
      }
    }))
  })

  it('installs the audited MIT document illustrator without third-party credential scripts', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled-document-illustrator')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'document-illustrator'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    const installedRoot = join(skillInstallRoot, 'document-illustrator')
    const skill = await readFile(join(installedRoot, 'SKILL.md'), 'utf8')
    expect(skill).toContain('文档配图助手')
    expect(skill).toContain('任何读取、建目录或写计划之前')
    expect(skill).toContain('不要创建 `illustrations/`')
    expect(skill).toContain('WorkWise 已配置的图片生成能力')
    expect(skill).not.toContain('GEMINI_API_KEY')
    expect(existsSync(join(installedRoot, 'LICENSE'))).toBe(true)
    expect(await readFile(join(installedRoot, 'references', 'upstream.md'), 'utf8'))
      .toContain('8344815d407cc25cc04c327557f36ed839f0aaef')
    expect(existsSync(join(installedRoot, 'scripts'))).toBe(false)
    expect(existsSync(join(installedRoot, '.env'))).toBe(false)

    const source = JSON.parse(
      await readFile(join(installedRoot, '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'bundled',
      id: 'document-illustrator',
      autoUpdate: false
    })

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'document-illustrator',
      source: {
        type: 'bundled',
        id: 'document-illustrator',
        autoUpdate: false
      }
    }))
  })

  it('installs bundled GitHub-managed writing skills with automatic updates disabled', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled-writing')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'ai-flavor-remover'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    expect(await readFile(join(skillInstallRoot, 'ai-flavor-remover', 'SKILL.md'), 'utf8'))
      .toContain('WorkWise Skill 包装')
    expect(await readFile(join(skillInstallRoot, 'ai-flavor-remover', 'README.md'), 'utf8'))
      .toContain('AI 味去除')
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'ai-flavor-remover', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'github',
      owner: 'hylarucoder',
      repo: 'ai-flavor-remover',
      path: '',
      ref: 'main',
      autoUpdate: false,
      includePaths: ['README.md'],
      overlaySkillId: 'ai-flavor-remover'
    })

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'ai-flavor-remover',
      source: expect.objectContaining({
        type: 'github',
        owner: 'hylarucoder',
        repo: 'ai-flavor-remover',
        includePaths: ['README.md'],
        overlaySkillId: 'ai-flavor-remover'
      })
    }))
  })

  it('installs the bundled PPT Master slim skill with WorkWise overlay files', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-bundled-ppt-master')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'ppt-master'
    })

    expect(installed.ok).toBe(true)
    if (!installed.ok) return
    const installedRoot = join(skillInstallRoot, 'ppt-master')
    expect(await readFile(join(installedRoot, 'SKILL.md'), 'utf8'))
      .toContain('PPT Master')
    expect(await readFile(join(installedRoot, 'requirements.txt'), 'utf8'))
      .not.toMatch(/^pandoc\b|^\s*pandoc[>=]/im)
    // doc_to_md.py may mention pandoc as an optional fallback for legacy formats,
    // but WorkWise does not install or require it.
    expect(existsSync(join(installedRoot, 'scripts', 'confirm_ui', 'server.py'))).toBe(true)
    expect(existsSync(join(installedRoot, 'scripts', 'confirm_ui', 'static', 'index.html'))).toBe(true)
    expect(existsSync(join(installedRoot, 'scripts', 'docs', 'confirm_ui.md'))).toBe(true)
    expect(existsSync(join(installedRoot, 'scripts', 'svg_editor', 'static', 'index.html'))).toBe(true)
    // 保持 v4.3 官方目录结构；图标大包不分发，只保留说明。
    expect(existsSync(join(installedRoot, 'templates', 'charts', 'charts_index.json'))).toBe(true)
    expect(existsSync(join(installedRoot, 'templates', 'layouts', 'layouts_index.json'))).toBe(true)
    expect(existsSync(join(installedRoot, 'templates', 'icons', 'README.md'))).toBe(true)
    expect(existsSync(join(installedRoot, 'templates', 'icons', 'app-window.svg'))).toBe(false)
    expect(existsSync(join(installedRoot, 'projects', 'README.md'))).toBe(true)
    expect(existsSync(join(installedRoot, 'examples', 'README.md'))).toBe(true)
    // 精选轻量示例：只保留设计规格、锁文件与 svg_output，排除 images/svg_final/exports/sources。
    expect(existsSync(join(
      installedRoot,
      'examples',
      'ppt169_kubernetes_blueprint_2026',
      'design_spec.md'
    ))).toBe(true)
    expect(existsSync(join(
      installedRoot,
      'examples',
      'ppt169_kubernetes_blueprint_2026',
      'svg_output'
    ))).toBe(true)
    expect(existsSync(join(
      installedRoot,
      'examples',
      'ppt169_kubernetes_blueprint_2026',
      'images'
    ))).toBe(false)
    expect(existsSync(join(
      installedRoot,
      'examples',
      'ppt169_kubernetes_blueprint_2026',
      'svg_final'
    ))).toBe(false)
    expect(existsSync(join(
      installedRoot,
      'examples',
      'ppt169_kubernetes_blueprint_2026',
      'exports'
    ))).toBe(false)
    const source = JSON.parse(
      await readFile(join(installedRoot, '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(existsSync(join(installedRoot, '.workgpt-skill-source.json'))).toBe(false)
    // v4.3 curated slim bundle: autoUpdate disabled, overlay preserved
    expect(source).toMatchObject({
      type: 'github',
      owner: 'hugohe3',
      repo: 'ppt-master',
      path: 'skills/ppt-master',
      autoUpdate: false,
      overlaySkillId: 'ppt-master'
    })

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'ppt-master',
      name: 'PPT Master 4.3.0',
      description: expect.stringContaining('presentation workflow'),
      source: expect.objectContaining({
        type: 'github',
        owner: 'hugohe3',
        repo: 'ppt-master',
        path: 'skills/ppt-master',
        ref: 'v4.3.0',
        installedSha: '51cb529d00638097e70fd3e9d865a0bf061b5e19',
        autoUpdate: false,
        overlaySkillId: 'ppt-master'
      })
    }))
  }, PPT_MASTER_INSTALL_TIMEOUT_MS)

  it('prefers bundled skills unpacked beside app.asar in packaged apps', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-packaged-bundled')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const resourcesPath = join(tempRoot, 'packaged-resources')
    const cwd = join(tempRoot, 'empty-cwd')
    const unpackedSkill = join(resourcesPath, 'app.asar.unpacked', 'src', 'asset', 'skills', 'packaged-skill')
    const archivedSkill = join(resourcesPath, 'app.asar', 'src', 'asset', 'skills', 'packaged-skill')
    await mkdir(unpackedSkill, { recursive: true })
    await mkdir(archivedSkill, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(unpackedSkill, 'SKILL.md'), '# Unpacked Skill\n', 'utf8')
    await writeFile(join(archivedSkill, 'SKILL.md'), '# Archived Skill\n', 'utf8')

    const originalCwd = process.cwd()
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: resourcesPath
    })
    process.chdir(cwd)
    try {
      const installed = await installBundledSkill(skillInstallRoot, {
        id: 'packaged-skill'
      })

      expect(installed.ok).toBe(true)
      if (!installed.ok) return
      expect(await readFile(join(skillInstallRoot, 'packaged-skill', 'SKILL.md'), 'utf8'))
        .toBe('# Unpacked Skill\n')
    } finally {
      process.chdir(originalCwd)
      if (originalResourcesPath) {
        Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
      } else {
        Reflect.deleteProperty(process, 'resourcesPath')
      }
    }
  })

  it('does not overwrite a user-created skill with the same bundled name', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-conflict')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const existingSkill = join(skillInstallRoot, 'operational-monitoring')
    await mkdir(existingSkill, { recursive: true })
    await writeFile(join(existingSkill, 'SKILL.md'), '# Custom skill\n', 'utf8')

    const installed = await installBundledSkill(skillInstallRoot, {
      id: 'operational-monitoring'
    })

    expect(installed).toEqual({
      ok: false,
      message: 'Skill "operational-monitoring" already exists and is not managed by this source.'
    })
    expect(await readFile(join(existingSkill, 'SKILL.md'), 'utf8')).toBe('# Custom skill\n')
  })

  it('installs a GitHub managed skill recursively and records source metadata', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-github')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const skillMarkdown = [
      '---',
      'name: di-bao-monitoring',
      'description: Railwise monitoring.',
      '---',
      '',
      '# Di-bao'
    ].join('\n')
    const referenceMarkdown = '# Reference\n'
    const commitSha = 'b'.repeat(40)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/commits/main')) {
        return jsonResponse({ sha: commitSha })
      }
      if (url === `https://api.github.com/repos/railwise-cn/di-bao-monitoring-skill/contents/skill/di-bao-monitoring/references?ref=${commitSha}`) {
        return jsonResponse([
          {
            name: 'guide.md',
            path: 'skill/di-bao-monitoring/references/guide.md',
            type: 'file',
            size: referenceMarkdown.length,
            download_url: 'https://evil.example/guide.md'
          }
        ])
      }
      if (url === `https://api.github.com/repos/railwise-cn/di-bao-monitoring-skill/contents/skill/di-bao-monitoring?ref=${commitSha}`) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skill/di-bao-monitoring/SKILL.md',
            type: 'file',
            size: skillMarkdown.length,
            download_url: 'https://evil.example/SKILL.md'
          },
          {
            name: 'references',
            path: 'skill/di-bao-monitoring/references',
            type: 'dir'
          }
        ])
      }
      if (url === `https://raw.githubusercontent.com/railwise-cn/di-bao-monitoring-skill/${commitSha}/skill/di-bao-monitoring/SKILL.md`) {
        return new Response(skillMarkdown)
      }
      if (url === `https://raw.githubusercontent.com/railwise-cn/di-bao-monitoring-skill/${commitSha}/skill/di-bao-monitoring/references/guide.md`) {
        return new Response(referenceMarkdown)
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const installed = await installGithubSkill(skillInstallRoot, {
      owner: 'railwise-cn',
      repo: 'di-bao-monitoring-skill',
      path: 'skill/di-bao-monitoring',
      ref: 'main',
      autoUpdate: true
    })

    expect(installed).toEqual({
      ok: true,
      path: join(skillInstallRoot, 'di-bao-monitoring', 'SKILL.md'),
      sha: commitSha,
      updated: true
    })
    expect(await readFile(join(skillInstallRoot, 'di-bao-monitoring', 'references', 'guide.md'), 'utf8'))
      .toBe(referenceMarkdown)
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'di-bao-monitoring', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'github',
      owner: 'railwise-cn',
      repo: 'di-bao-monitoring-skill',
      path: 'skill/di-bao-monitoring',
      ref: 'main',
      installedSha: commitSha,
      autoUpdate: false
    })
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls[0]).toContain('/commits/main')
    expect(requestedUrls.slice(1).length).toBeGreaterThan(0)
    expect(requestedUrls.slice(1).every((url) => url.includes(commitSha))).toBe(true)
    expect(requestedUrls.slice(1).every((url) => !url.includes('/main/'))).toBe(true)
  })

  it.each([
    ['omitted', undefined],
    ['explicitly requested', true]
  ] as const)('forces third-party GitHub Skill automatic updates off when autoUpdate is %s', async (_policy, autoUpdate) => {
    const workspaceRoot = join(tempRoot, 'workspace-github-manual-update')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const skillMarkdown = '# Manual update Skill\n'
    const commitSha = 'c'.repeat(40)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/commits/main')) {
        return jsonResponse({ sha: commitSha })
      }
      if (url === `https://api.github.com/repos/third-party/manual-update-skill/contents/skills/manual-update?ref=${commitSha}`) {
        return jsonResponse([
          {
            name: 'SKILL.md',
            path: 'skills/manual-update/SKILL.md',
            type: 'file',
            size: skillMarkdown.length,
            download_url: 'https://evil.example/SKILL.md'
          }
        ])
      }
      if (url === `https://raw.githubusercontent.com/third-party/manual-update-skill/${commitSha}/skills/manual-update/SKILL.md`) {
        return new Response(skillMarkdown)
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const installed = await installGithubSkill(skillInstallRoot, {
      owner: 'third-party',
      repo: 'manual-update-skill',
      path: 'skills/manual-update',
      ref: 'main',
      ...(autoUpdate === undefined ? {} : { autoUpdate })
    })

    expect(installed.ok).toBe(true)
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'manual-update', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'github',
      owner: 'third-party',
      repo: 'manual-update-skill',
      ref: 'main',
      installedSha: commitSha,
      autoUpdate: false
    })
  })

  it('installs a GitHub managed skill from selected paths with a bundled overlay', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-github-overlay')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const readmeMarkdown = '# AI 味去除\n'
    const commitSha = 'd'.repeat(40)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/commits/main')) {
        return jsonResponse({ sha: commitSha })
      }
      if (url === `https://api.github.com/repos/hylarucoder/ai-flavor-remover/contents/README.md?ref=${commitSha}`) {
        return jsonResponse({
          name: 'README.md',
          path: 'README.md',
          type: 'file',
          size: readmeMarkdown.length,
          download_url: 'https://evil.example/README.md'
        })
      }
      if (url === `https://raw.githubusercontent.com/hylarucoder/ai-flavor-remover/${commitSha}/README.md`) {
        return new Response(readmeMarkdown)
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const installed = await installGithubSkill(skillInstallRoot, {
      owner: 'hylarucoder',
      repo: 'ai-flavor-remover',
      path: '',
      ref: 'main',
      skillName: 'ai-flavor-remover',
      includePaths: ['README.md'],
      overlaySkillId: 'ai-flavor-remover',
      autoUpdate: true
    })

    expect(installed).toEqual({
      ok: true,
      path: join(skillInstallRoot, 'ai-flavor-remover', 'SKILL.md'),
      sha: commitSha,
      updated: true
    })
    expect(await readFile(join(skillInstallRoot, 'ai-flavor-remover', 'README.md'), 'utf8'))
      .toBe(readmeMarkdown)
    expect(await readFile(join(skillInstallRoot, 'ai-flavor-remover', 'SKILL.md'), 'utf8'))
      .toContain('WorkWise Skill 包装')
    const source = JSON.parse(
      await readFile(join(skillInstallRoot, 'ai-flavor-remover', '.workwise-skill-source.json'), 'utf8')
    ) as Record<string, unknown>
    expect(source).toMatchObject({
      type: 'github',
      owner: 'hylarucoder',
      repo: 'ai-flavor-remover',
      path: '',
      ref: 'main',
      installedSha: commitSha,
      autoUpdate: false,
      includePaths: ['README.md'],
      overlaySkillId: 'ai-flavor-remover'
    })
  })

  it('downloads GitHub files through the pinned Contents API raw media endpoint', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-github-private')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const commitSha = 'a'.repeat(40)
    const skillMarkdown = '# Private Skill\n'
    process.env.GITHUB_TOKEN = 'private-token'
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/commits/main')) return jsonResponse({ sha: commitSha })
      if (url === `https://api.github.com/repos/private-owner/private-repo/contents/skills/private-skill?ref=${commitSha}`) {
        return jsonResponse([{
          name: 'SKILL.md',
          path: 'skills/private-skill/SKILL.md',
          type: 'file',
          size: skillMarkdown.length,
          download_url: 'https://evil.example/private-skill/SKILL.md'
        }])
      }
      if (url === `https://api.github.com/repos/private-owner/private-repo/contents/skills/private-skill/SKILL.md?ref=${commitSha}`) {
        return new Response(skillMarkdown, { status: 200 })
      }
      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const installed = await installGithubSkill(skillInstallRoot, {
      owner: 'private-owner',
      repo: 'private-repo',
      path: 'skills/private-skill',
      ref: 'main'
    })

    expect(installed).toMatchObject({ ok: true, sha: commitSha, updated: true })
    expect(await readFile(join(skillInstallRoot, 'private-skill', 'SKILL.md'), 'utf8')).toBe(skillMarkdown)
    const fileRequest = requests.find((request) => request.url.endsWith(`/contents/skills/private-skill/SKILL.md?ref=${commitSha}`))
    expect(fileRequest).toBeDefined()
    expect(new Headers(fileRequest?.init?.headers).get('Accept')).toBe('application/vnd.github.raw+json')
    expect(new Headers(fileRequest?.init?.headers).get('Authorization')).toBe('Bearer private-token')
    expect(requests.every((request) => request.url.startsWith('https://api.github.com/'))).toBe(true)
  })

  it('rejects a malformed GitHub commit response before downloading Skill files', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-github-invalid-sha')
    const skillInstallRoot = join(workspaceRoot, '.agents', 'skills')
    const requests: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/commits/main')) return jsonResponse({ sha: 'sha-not-immutable' })
      return new Response('unexpected file request', { status: 500, statusText: 'Unexpected' })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const installed = await installGithubSkill(skillInstallRoot, {
      owner: 'owner',
      repo: 'repo',
      path: 'skills/example',
      ref: 'main'
    })

    expect(installed).toMatchObject({ ok: false })
    expect(requests).toHaveLength(1)
  })

  function createSettings(workspaceRoot: string): AppSettingsV1 {
    return {
      version: 1,
      locale: 'en',
      theme: 'system',
      uiFontScale: 'small',
      provider: defaultModelProviderSettings(),
      agents: { kun: defaultManagedRuntimeSettings() },
      workspaceRoot,
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

  function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
})
