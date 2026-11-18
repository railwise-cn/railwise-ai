import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { buildSkillResourceToolProvider } from '../src/adapters/tool/skill-resource-tool-provider.js'
import type { ModelClient } from '../src/ports/model-client.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

const videoPrompt = '使用Video ShotCraft技能，帮我做一个视频，介绍一下宁波睿威工程技术有限公司，相关信息你可去官网上查找。 www.railwise.cn'
const videoId = 'f'.repeat(64)
const reference = 'references/pipeline.md'
const referenceText = '读取官网后再确定分镜方案。'
const toolName = 'read_skill_resource'

describe('activated Skill resource reads', () => {
  let base: string
  let workspace: string
  let packageRoot: string
  let videoRoot: string
  let runtime: SkillRuntime
  let host: LocalToolHost
  let context: ToolHostContext

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'kun-skill-resource-'))
    workspace = join(base, '中文 workspace')
    packageRoot = join(base, 'installed')
    videoRoot = join(packageRoot, videoId)
    const other = join(packageRoot, 'other')
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(join(videoRoot, 'references'), { recursive: true }),
      mkdir(join(other, 'references'), { recursive: true })
    ])
    await Promise.all([
      writeFile(join(videoRoot, 'SKILL.md'), '---\nname: video-shotcraft\n---\nRead references/pipeline.md.'),
      writeFile(join(videoRoot, reference), referenceText),
      writeFile(join(other, 'SKILL.md'), '---\nname: other\n---\nForeign Skill.'),
      writeFile(join(other, reference), 'foreign reference')
    ])
    runtime = await SkillRuntime.create({ enabled: true, roots: [packageRoot], legacySkillMd: true })
    const resolution = runtime.resolveTurn({ prompt: videoPrompt, workspace })
    context = {
      threadId: 'thread',
      turnId: 'turn',
      workspace,
      sandboxMode: 'read-only',
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: vi.fn(async () => 'deny' as const),
      activeSkillIds: resolution.activeSkillIds,
      activeSkillResources: resolution.activeSkillResources
    }
    host = new LocalToolHost({ registry: new CapabilityRegistry([buildSkillResourceToolProvider()]) })
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  function read(path: string, scope: ToolHostContext = context, skillId = videoId, offset = 0) {
    return host.execute({ toolName, callId: 'read-skill', arguments: { skill_id: skillId, path, offset_bytes: offset } }, scope)
  }

  it('advertises and dispatches using the real ordinary chat Skill activation', async () => {
    let requests = 0
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        if (requests++ === 0) {
          expect(request.tools.map(tool => tool.name)).toContain(toolName)
          expect(request.contextInstructions?.join('\n')).toContain('Read relative Skill references with read_skill_resource')
          yield {
            kind: 'tool_call_complete',
            callId: 'read-reference',
            toolName,
            arguments: { skill_id: videoId, path: reference }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { skillRuntime: runtime, tools: [...buildSkillResourceToolProvider().tools] })
    await bootstrapThread(h, { workspace, request: { prompt: videoPrompt, sandboxMode: 'read-only' } })
    await h.loop.runTurn(h.threadId, h.turnId)
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.activeSkillIds).toEqual([videoId])
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      toolName,
      isError: false,
      output: expect.objectContaining({ path: reference, content: referenceText, next_offset_bytes: null })
    }))
  })

  it('returns bounded UTF-8 pages in a read-only workspace without approval', async () => {
    const content = 'x'.repeat(24 * 1024 - 1) + '测绘中文'
    await writeFile(join(videoRoot, reference), content)
    const first = await read('references\\pipeline.md')
    expect(first.item).toMatchObject({ isError: false, output: { content: 'x'.repeat(24 * 1024 - 1), next_offset_bytes: 24 * 1024 - 1 } })
    const next = await read(reference, context, videoId, 24 * 1024 - 1)
    expect(next.item).toMatchObject({ isError: false, output: { content: '测绘中文', next_offset_bytes: null } })
    expect(context.awaitApproval).not.toHaveBeenCalled()
  })

  it('rejects traversal, absolute, hidden and foreign paths', async () => {
    for (const path of ['../other/references/pipeline.md', 'references\\..\\SKILL.md', join(videoRoot, reference),
      'references/.secrets', 'references/pipeline.md:stream', 'references/nul.txt']) {
      expect((await read(path)).item).toMatchObject({ isError: true, output: { code: 'skill_resource_path' } })
    }
    expect((await read(reference, context, 'other')).item).toMatchObject({ isError: true, output: { code: 'skill_resource_scope' } })
    expect(await host.listTools({ ...context, activeSkillIds: [] })).toEqual([])
    expect(await host.listTools({ ...context, sandboxMode: 'external-sandbox' })).toEqual([])
    expect(await host.listTools({ ...context, allowedProviderIds: ['builtin'] })).toEqual([])
    expect(await host.listTools({ ...context, allowedToolNames: ['read'] })).toEqual([])
  })

  it('rejects cross-package directory links and hardlinked files', async () => {
    const otherReferences = join(packageRoot, 'other', 'references')
    await symlink(otherReferences, join(videoRoot, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    await link(join(otherReferences, 'pipeline.md'), join(videoRoot, 'references', 'foreign.md'))
    expect((await read('external/pipeline.md')).item).toMatchObject({ isError: true, output: { code: 'skill_resource_unavailable' } })
    expect((await read('references/foreign.md')).item).toMatchObject({ isError: true, output: { code: 'skill_resource_unavailable' } })
  })

  it('keeps local Skill reads in the owning workspace and retains the installed fallback', async () => {
    const local = join(workspace, '.agents', 'skills', videoId)
    await mkdir(join(local, 'references'), { recursive: true })
    await writeFile(join(local, 'SKILL.md'), '---\nname: video-shotcraft\n---\nUse the local reference.')
    await writeFile(join(local, reference), 'local-only reference')
    await runtime.refresh(workspace)
    const localResolution = runtime.resolveTurn({ prompt: videoPrompt, workspace })
    expect((await read(reference, { ...context, ...localResolution })).item).toMatchObject({
      isError: false, output: { content: 'local-only reference' }
    })
    const otherWorkspace = join(base, 'other workspace')
    await mkdir(otherWorkspace)
    // A concurrent turn can resolve before the current workspace scan finishes.
    const globalResolution = runtime.resolveTurn({ prompt: videoPrompt, workspace: otherWorkspace })
    expect((await read(reference, { ...context, workspace: otherWorkspace, ...globalResolution })).item).toMatchObject({
      isError: false, output: { content: referenceText }
    })
  })

  it('binds a current turn to its own directory when a Skill root is refreshed', async () => {
    const replacement = join(base, 'replacement', videoId)
    await mkdir(join(replacement, 'references'), { recursive: true })
    await writeFile(join(replacement, 'SKILL.md'), '---\nname: video-shotcraft\n---\nRelease new.')
    await writeFile(join(replacement, reference), 'new reference')
    await runtime.updateConfiguration({ enabled: true, roots: [replacement], legacySkillMd: true })
    expect((await read(reference)).item).toMatchObject({ isError: false, output: { content: referenceText } })
    const next = runtime.resolveTurn({ prompt: videoPrompt, workspace })
    expect((await read(reference, { ...context, ...next })).item).toMatchObject({ isError: false, output: { content: 'new reference' } })
    await rename(videoRoot, join(base, 'removed'))
    await rename(replacement, videoRoot)
    expect((await read(reference)).item).toMatchObject({ isError: true, output: { code: 'skill_resource_unavailable' } })
  })
})
