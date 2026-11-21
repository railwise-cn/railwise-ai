import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

describe('SkillRuntime', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kun-skills-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads manifests, legacy SKILL.md packages, and validation diagnostics', async () => {
    await writeSkill('review', {
      name: 'Review Skill',
      description: 'Review changes in the current workspace',
      version: '1.0.0',
      entry: 'REVIEW.md',
      triggers: { commands: ['/review'] }
    }, 'Review instructions')
    await mkdir(join(root, 'legacy'), { recursive: true })
    await writeFile(join(root, 'legacy', 'SKILL.md'), '# Legacy\n\nLegacy instructions', 'utf8')
    await mkdir(join(root, 'bad'), { recursive: true })
    await writeFile(join(root, 'bad', 'skill.json'), JSON.stringify({ id: 'bad' }), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['legacy', 'review-skill'])
    expect(diagnostics.skills.find((skill) => skill.id === 'review-skill')).toMatchObject({
      description: 'Review changes in the current workspace',
      version: '1.0.0'
    })
    expect(diagnostics.skills.find((skill) => skill.id === 'legacy')?.legacy).toBe(true)
    expect(diagnostics.validationErrors[0]?.message).toMatch(/expected string/i)
  })

  it('uses Chinese legacy frontmatter names for diagnostics without changing folder ids', async () => {
    const skillRoot = join(root, 'tdd')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: 测试驱动开发(TDD)',
      'description: 用测试先行推进实现。',
      '---',
      '',
      '# TDD',
      '',
      '先写失败测试，再实现。'
    ].join('\n'), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills).toContainEqual(expect.objectContaining({
      id: 'tdd',
      name: '测试驱动开发(TDD)',
      description: '用测试先行推进实现。',
      legacy: true
    }))
  })

  it('matches legacy Skills from Chinese descriptions without requiring /skill syntax', async () => {
    await writeLegacySkill('monitoring-design', [
      '---',
      'name: monitoring-design',
      'description: "工程监测方案设计专业技能包。"',
      '---',
      '',
      '# 监测方案设计',
      '',
      '用于常规监测方案起草。'
    ].join('\n'))
    await writeLegacySkill('di-bao-monitoring', [
      '---',
      'name: di-bao-monitoring',
      'description: "用于轨道交通控制保护区/地铁保护区第三方监测成果编制：资料清单、方案、日报周报月报、预警报警消警。适用于地保监测。"',
      '---',
      '',
      '# 地保监测综合 Skill',
      '',
      '当用户说“写地保监测方案”时，先建立项目资料卡；资料不足时使用占位符继续起草。'
    ].join('\n'))

    const runtime = await createRuntime()
    const resolution = runtime.resolveTurn({
      prompt: '我要写一份地保监测的方案',
      workspace: root
    })

    expect(resolution.activations[0]).toMatchObject({
      skillId: 'di-bao-monitoring'
    })
    expect(resolution.activeSkillIds).toContain('di-bao-monitoring')
    expect(resolution.instructions.join('\n')).toContain('地保监测综合 Skill')
  })

  it('treats a natural PPT Master name as explicit and carries it into a confirmation turn', async () => {
    await writeLegacySkill('ppt-master', [
      '---',
      'name: ppt-master',
      'description: "生成和导出 PPT 的专业工作流 Skill。"',
      '---',
      '',
      '# PPT Master',
      '',
      '最终必须调用受控工具导出 PPTX。'
    ].join('\n'))
    const runtime = await createRuntime()

    const first = runtime.resolveTurn({
      prompt: '请使用 PPT Master，基于当前文档生成一份演示文稿。',
      workspace: root
    })
    const continued = runtime.resolveTurn({
      prompt: '确认可以，开始执行。',
      workspace: root,
      preferredSkillIds: first.activeSkillIds
    })

    expect(first.activations[0]).toMatchObject({
      skillId: 'ppt-master',
      reason: 'explicit:natural-name'
    })
    expect(first.instructions[0]).toContain(`Skill root: ${join(root, 'ppt-master')}`)
    expect(continued.activations[0]).toMatchObject({
      skillId: 'ppt-master',
      reason: 'continuation:previous-turn'
    })
  })

  it('injects a budgeted excerpt when a matched Skill is larger than the instruction budget', async () => {
    await writeLegacySkill('di-bao-monitoring', [
      '---',
      'name: di-bao-monitoring',
      'description: "用于地保监测方案、日报周报月报和评审回复。"',
      '---',
      '',
      '# 地保监测综合 Skill',
      '',
      '资料不足时保留 {{占位符}}，不要停在追问。',
      '',
      'x'.repeat(20_000)
    ].join('\n'))

    const runtime = await createRuntime({ instructionBudgetBytes: 2_000 })
    const resolution = runtime.resolveTurn({
      prompt: '帮我写地保监测方案',
      workspace: root
    })

    expect(resolution.activeSkillIds).toEqual(['di-bao-monitoring'])
    expect(resolution.injectedBytes).toBeLessThanOrEqual(2_000)
    expect(resolution.instructions[0]).toContain('Skill entry is larger than the per-turn injection budget.')
    expect(resolution.instructions[0]).toContain('资料不足时保留 {{占位符}}')
    expect(resolution.instructions[0]).toContain('[Skill excerpt truncated]')
  })

  it('keeps skill.json manifests with Chinese names from collapsing to one id', async () => {
    await writeSkill('review-cn', {
      name: '代码审查',
      triggers: { commands: ['/review-cn'] }
    }, 'review instructions')
    await writeSkill('requirements-cn', {
      name: '需求分析',
      triggers: { commands: ['/requirements-cn'] }
    }, 'requirements instructions')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['代码审查', '需求分析'])
    expect(diagnostics.validationErrors).toEqual([])
  })

  it('matches triggers deterministically and respects injection budgets', async () => {
    await writeSkill('big', {
      id: 'big',
      name: 'Big',
      priority: 10,
      triggers: { promptPatterns: ['typescript'] }
    }, 'x'.repeat(2_000))
    await writeSkill('small', {
      id: 'small',
      name: 'Small',
      triggers: { fileTypes: ['.ts'] }
    }, 'small instructions')
    const runtime = await createRuntime({ instructionBudgetBytes: 600 })

    const resolution = runtime.resolveTurn({
      prompt: 'Please handle TypeScript in src/app.ts',
      workspace: root
    })

    expect(resolution.activations.map((activation) => activation.skillId)).toEqual(['big', 'small'])
    expect(resolution.activeSkillIds).toEqual(['big'])
    expect(resolution.injectedBytes).toBeLessThanOrEqual(600)
    expect(resolution.instructions[0]).toContain('Skill entry is larger than the per-turn injection budget.')
  })

  it('injects allowed tool constraints and blocks omitted tools', async () => {
    await writeSkill('readonly', {
      id: 'readonly',
      name: 'Readonly',
      triggers: { commands: ['/readonly'] },
      allowedTools: ['read']
    }, 'Use read only')
    await writeSkill('mutating', {
      id: 'mutating',
      name: 'Mutating',
      triggers: { commands: ['/mutating'] },
      allowedTools: ['bash']
    }, 'Use bash')
    const runtime = await createRuntime()
    const resolution = runtime.resolveTurn({
      prompt: '/readonly inspect',
      workspace: root
    })

    expect(resolution.allowedToolNames).toEqual(['read'])
    expect(runtime.diagnostics().lastInjection?.blockedToolNames).toEqual(['bash'])

    const readTool = LocalToolHost.defineTool({
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [readTool, bashTool] }
      ])
    })
    const context = {
      threadId: 'thr',
      turnId: 'turn',
      workspace: root,
      approvalPolicy: 'auto' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const,
      allowedToolNames: resolution.allowedToolNames
    }

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['read'])
    await expect(
      host.execute({ callId: 'call_1', toolName: 'bash', arguments: {} }, context)
    ).rejects.toThrow(/active tool policy/)
  })

  it('refreshes Skill roots without recreating the runtime', async () => {
    const runtime = await createRuntime()
    expect(runtime.count()).toBe(0)

    await writeSkill('new-skill', {
      id: 'new',
      name: 'New',
      triggers: { commands: ['/new'] }
    }, 'new instructions')
    await runtime.refresh()

    expect(runtime.count()).toBe(1)
    expect(runtime.resolveTurn({ prompt: '/new run', workspace: root }).activeSkillIds).toEqual(['new'])
  })

  it('discovers a newly installed workspace Skill and prefers it over a global duplicate', async () => {
    await writeLegacySkill('ppt-master', [
      '---',
      'name: ppt-master',
      'description: "global copy"',
      '---',
      '',
      'GLOBAL PPT MASTER'
    ].join('\n'))
    const runtime = await createRuntime()
    const workspace = join(root, 'workspace')
    const localSkillRoot = join(workspace, '.agents', 'skills', 'ppt-master')
    await mkdir(localSkillRoot, { recursive: true })
    await writeFile(join(localSkillRoot, 'SKILL.md'), [
      '---',
      'name: ppt-master',
      'description: "workspace copy"',
      '---',
      '',
      'WORKSPACE PPT MASTER'
    ].join('\n'), 'utf8')

    await runtime.refresh(workspace)
    const resolution = runtime.resolveTurn({
      prompt: '请使用 PPT Master。',
      workspace
    })

    expect(resolution.instructions.join('\n')).toContain('WORKSPACE PPT MASTER')
    expect(resolution.instructions.join('\n')).not.toContain('GLOBAL PPT MASTER')
  })

  it('injects active Skills into AgentLoop context and turn metadata', async () => {
    await writeSkill('review', {
      id: 'review',
      name: 'Review',
      triggers: { promptPatterns: ['review'] },
      allowedTools: ['read']
    }, 'Always inspect the diff first.')
    const skillRuntime = await createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [
        LocalToolHost.defineTool({
          name: 'read',
          description: 'read',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        }),
        LocalToolHost.defineTool({
          name: 'bash',
          description: 'bash',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        })
      ]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: 'please review this change' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect(seenRequest?.contextInstructions?.[0]).toContain('Always inspect the diff first.')
    expect(seenRequest?.tools.map((tool) => tool.name)).toEqual(['read'])
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.activeSkillIds).toEqual(['review'])
    expect(turn?.skillInjectionBytes).toBeGreaterThan(0)
  })

  it('validates a structured selection, persists its name, proves activation, and rejects an unavailable Skill', async () => {
    const id = '0123456789abcdef'.repeat(4)
    await writeLegacySkill(id, '---\nname: video-shotcraft\n---\nFollow the video production workflow.')
    const skillRuntime = await createRuntime()
    const requests: ModelRequest[] = []
    const h = makeHarness({
      provider: 'fixture', model: 'fixture',
      async *stream(request) {
        requests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }, {
      skillRuntime,
      skillSelection: {
        callableCapabilities: async (_, thread) => skillRuntime.callableSkills(thread.workspace, new Set()).map(choice => ({ choice })),
        validateSkillSelection: (prompt, workspace, selectedIds) => skillRuntime.validateSlashSelection(prompt, workspace, selectedIds)
      }
    })
    const request = { prompt: '请生成视频', capabilityReferences: [{ kind: 'skill' as const, id }] }
    await bootstrapThread(h, { workspace: root, request })
    const getUserItem = async () => (await h.sessionStore.loadItems(h.threadId)).find(item => item.kind === 'user_message')
    expect(await getUserItem()).toMatchObject({ text: request.prompt, skillSelections: [{ id, name: 'Video Shotcraft' }] })
    expect(await getUserItem()).not.toHaveProperty('activeSkillIds')
    await h.loop.runTurn(h.threadId, h.turnId)
    expect(requests[0]?.contextInstructions?.join('\n')).toContain('Follow the video production workflow.')
    expect(await getUserItem()).toMatchObject({ text: request.prompt, activeSkillIds: [id] })
    expect(await h.sessionStore.loadEventsSince(h.threadId, 0)).toContainEqual(expect.objectContaining({
      kind: 'item_updated', item: expect.objectContaining({ kind: 'user_message', activeSkillIds: [id] })
    }))
    const requestsBeforeDisabling = requests.length
    await skillRuntime.updateConfiguration({ enabled: false, roots: [root], legacySkillMd: true, revision: 1 })
    await expect(h.turns.startTurn({ threadId: h.threadId, request })).rejects.toMatchObject({ code: 'capability_reference_unavailable' })
    expect(requests).toHaveLength(requestsBeforeDisabling)
  })

  it('keeps the previous turn Skills active for a short confirmation turn', async () => {
    await writeLegacySkill('ppt-master', [
      '---',
      'name: ppt-master',
      'description: "生成和导出 PPT 的专业工作流 Skill。"',
      '---',
      '',
      '# PPT Master',
      '',
      '最终成果必须是 PPTX。'
    ].join('\n'))
    const skillRuntime = await createRuntime()
    const requests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        requests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { skillRuntime })
    await bootstrapThread(h, {
      workspace: root,
      request: { prompt: '请使用 PPT Master，先给我页数和风格建议，等我确认。' }
    })
    await h.loop.runTurn(h.threadId, h.turnId)

    const second = await h.turns.startTurn({
      threadId: h.threadId,
      request: { prompt: '确认可以，开始执行。' }
    })
    h.turnId = second.turnId
    await h.loop.runTurn(h.threadId, h.turnId)

    expect(requests).toHaveLength(2)
    expect(requests[1]?.contextInstructions?.join('\n')).toContain('Active Skill: ppt-master (ppt-master)')
    const secondTurn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(secondTurn?.activeSkillIds).toContain('ppt-master')
  })

  async function createRuntime(options: Parameters<typeof SkillRuntime.create>[1] = {}) {
    const config = KunCapabilitiesConfig.parse({
      skills: {
        enabled: true,
        roots: [root],
        legacySkillMd: true
      }
    })
    return SkillRuntime.create(config.skills, options)
  }

  async function writeSkill(
    folder: string,
    manifest: Record<string, unknown>,
    entry: string
  ): Promise<void> {
    const dir = join(root, folder)
    await mkdir(dir, { recursive: true })
    const entryName = typeof manifest.entry === 'string' ? manifest.entry : 'SKILL.md'
    await writeFile(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    await writeFile(join(dir, entryName), entry, 'utf8')
  }

  async function writeLegacySkill(folder: string, entry: string): Promise<void> {
    const dir = join(root, folder)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), entry, 'utf8')
  }
})
