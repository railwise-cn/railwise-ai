import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillRuntime } from '../src/skills/skill-runtime.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const SVG_REQUEST = '创建一个完整、独立运行的 HTML 文件，使用 SVG 绘制一只正在骑自行车的鹈鹕，并制作成二维动画。要求鹈鹕和自行车都能清晰辨认，车轮持续转动，鹈鹕的双腿能够自然地踩动踏板，身体、车轮、踏板之间的运动关系合理协调。所有代码都包含在同一个 HTML 文件中，不依赖外部图片或动画素材，打开浏览器即可直接查看动画效果。'
const PROCUREMENT_REQUEST = '使用broswer-skill，帮我去政采云、阳光采购平台等平台去获取一些招标信息，我们主要是做工程测量、工程监测类的业务，所以需要找的是这一类招标信息，并以html形式将获取到的信息给我汇报，每天执行两次，早上九点前一次，下午五点前一次。'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-relevance-')); roots.push(root)
  const skills = [
    ['dingtalk-misc', 'dingtalk-misc', '钉钉原生 HTML 页面、白板绘图与文件创建。使用、创建、文件、完整、独立。'],
    ['dingtalk-minutes', 'dingtalk-minutes', '钉钉 AI 听记，完整逐字稿、会议纪要、行动项、独立文件的创建。Read meeting transcript and minutes.'],
    ['feishu-doc', 'feishu-doc', '飞书文档与文件创建，HTML、会议纪要、完整内容。'],
    ['lark-minutes', 'lark-minutes', 'Lark meeting transcript, minutes and action items.'],
    ['immutable-browser-package', 'browser-skill', 'Operate the logged-in browser and read websites.'],
    ['local-meeting', 'local-meeting', '整理本地会议纪要，提取负责人、期限与待办，不连接平台。'],
    ['control-network-review', 'control-network-review', '轨道控制网平差与 CPIII 观测检查。'],
    ['image-planning', 'image-planning', '图片素材规划和文档插图。'],
    ['code-review', 'code-review', '审阅代码差异并检查风险。'],
    ['generic-noise', 'generic-noise', '使用 创建 文件 完整 独立 HTML create complete independent file use.']
  ]
  for (const [id, name, description] of skills) {
    const path = join(root, id!); await mkdir(path)
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSynthetic guidance only.\n`)
  }
  const runtime = await SkillRuntime.create({ enabled: true, roots: [root], legacySkillMd: true })
  return { runtime, root }
}

describe('automatic Skill relevance before instruction injection', () => {
  it('does not inject platform or browser workflows for the real independent HTML/SVG request', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: SVG_REQUEST, workspace: f.root })
    expect(SVG_REQUEST).toHaveLength(158)
    expect(result.activeSkillIds).toEqual([])
    expect(result.injectedBytes).toBe(0)
  })

  it.each(['使用 创建 文件 完整 独立 HTML', 'Create a complete independent HTML file.', '绘制本地 SVG 动画并在浏览器中查看。', '生成离线HTML，不要使用钉钉，也不要联网。'])('does not infer a platform from generic creation words: %s', async prompt => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt, workspace: f.root })
    expect(result.activeSkillIds).not.toEqual(expect.arrayContaining(['dingtalk-misc', 'dingtalk-minutes', 'feishu-doc', 'lark-minutes', 'immutable-browser-package', 'generic-noise']))
    expect(result.activeSkillIds.some(id => /dingtalk|feishu|lark|browser/.test(id))).toBe(false)
  })

  it('selects the local meeting workflow without treating ordinary minutes as DingTalk', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '整理附件中的本地会议纪要，提取负责人和期限。', workspace: f.root })
    expect(result.activeSkillIds).toContain('local-meeting')
    expect(result.activeSkillIds.some(id => /dingtalk|feishu|lark/.test(id))).toBe(false)
  })

  it.each(['在钉钉查询 AI 听记的完整逐字稿。', 'Read the complete DingTalk meeting transcript.'])('preserves explicit platform context: %s', async prompt => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt, workspace: f.root })
    expect(result.activeSkillIds).toContain('dingtalk-minutes')
    expect(result.activeSkillIds.some(id => /feishu|lark/.test(id))).toBe(false)
  })

  it('distinguishes positive and negated platforms in a mixed request', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '不要使用钉钉，在飞书创建会议纪要文档。', workspace: f.root })
    expect(result.activeSkillIds).toContain('feishu-doc')
    expect(result.activeSkillIds.some(id => id.startsWith('dingtalk'))).toBe(false)
  })

  it('keeps user-selected Skills ahead of automatic applicability filters', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '$dingtalk-misc 解释原生HTML页面的限制。', workspace: f.root })
    expect(result.activations[0]).toMatchObject({ skillId: 'dingtalk-misc', reason: 'explicit:id' })
    expect(result.activeSkillIds).toContain('dingtalk-misc')
  })

  it.each(['$browser-skill', 'BrowserSkill', 'browse skill', 'broswer-skill'])('preserves explicit browser selection for local creation: %s', async selected => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: `${selected} ${SVG_REQUEST}`, workspace: f.root })
    expect(result.activeSkillIds).toContain('immutable-browser-package')
    expect(result.activations[0]?.reason).toMatch(/^explicit:/)
  })

  it.each([
    ['不要使用 BrowserSkill', 'immutable-browser-package'],
    ["don't use $dingtalk-misc", 'dingtalk-misc'],
    ['不要用 browser-skill', 'immutable-browser-package'],
    ['不要使用 @browser-skill', 'immutable-browser-package'],
    ['不要使用 /skill:dingtalk-misc', 'dingtalk-misc'],
    ['不使用 broswer-skill', 'immutable-browser-package'],
    ['Don’t use BrowserSkill.', 'immutable-browser-package']
  ])('respects explicit prohibitions without turning a name into a selection: %s', async (prompt, forbiddenId) => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt, workspace: f.root })
    expect(result.activeSkillIds).not.toContain(forbiddenId)
    expect(result.activations.some(item => item.skillId === forbiddenId)).toBe(false)
  })

  it.each(['而是', '但请', '，改为'])('preserves positive requests after contrast boundaries: %s', async separator => {
    const f = await fixture()
    const explicit = f.runtime.resolveTurn({ prompt: `不要用 $dingtalk-misc${separator}使用 $feishu-doc 创建文档。`, workspace: f.root })
    expect(explicit.activeSkillIds).toContain('feishu-doc')
    expect(explicit.activeSkillIds).not.toContain('dingtalk-misc')
    const inferred = f.runtime.resolveTurn({ prompt: `不要修改${separator}审阅代码差异并检查风险。`, workspace: f.root })
    expect(inferred.activeSkillIds).toContain('code-review')
  })

  it('allows a later positive explicit selection of the same previously prohibited Skill', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: "Don't use $dingtalk-misc for HTML, but use $dingtalk-misc to explain its limitations.", workspace: f.root })
    expect(result.activeSkillIds).toContain('dingtalk-misc')
    expect(result.activations[0]?.reason).toMatch(/^explicit:/)
  })

  it('uses trusted workflow context for a platform confirmation, not a bare preference', async () => {
    const f = await fixture()
    const input = { prompt: '确认，继续。', workspace: f.root, preferredSkillIds: ['dingtalk-minutes'] }
    expect(f.runtime.resolveTurn(input).activeSkillIds).not.toContain('dingtalk-minutes')
    expect(f.runtime.resolveTurn({ ...input, contextPrompt: '在钉钉读取听记逐字稿。' }).activeSkillIds).toContain('dingtalk-minutes')
    const local = f.runtime.resolveTurn({ ...input, prompt: SVG_REQUEST, contextPrompt: '在钉钉读取听记逐字稿。' })
    expect(local.activeSkillIds).toEqual([])
  })

  it('does not carry another platform into a new explicit platform context', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '在飞书创建会议纪要文档。', contextPrompt: '在钉钉读取听记逐字稿。', preferredSkillIds: ['dingtalk-minutes'], workspace: f.root })
    expect(result.activeSkillIds).toContain('feishu-doc')
    expect(result.activeSkillIds.some(id => id.startsWith('dingtalk'))).toBe(false)
  })

  it('does not use old positive platform context against a current prohibition', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '不要使用钉钉，继续处理本地会议纪要。', contextPrompt: '在钉钉读取听记逐字稿。', preferredSkillIds: ['dingtalk-minutes'], workspace: f.root })
    expect(result.activeSkillIds.some(id => id.startsWith('dingtalk'))).toBe(false)
  })

  it('retains both explicitly named platform workflows', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '$dingtalk-minutes 和 $feishu-doc 对比两个平台的纪要能力。', workspace: f.root })
    expect(result.activeSkillIds).toEqual(expect.arrayContaining(['dingtalk-minutes', 'feishu-doc']))
  })

  it('applies platform relevance to declared patterns, file types and preferences, but preserves explicit commands', async () => {
    const f = await fixture(), path = join(f.root, 'platform-template')
    await mkdir(path)
    await writeFile(join(path, 'skill.json'), JSON.stringify({
      id: 'feishu-template', name: 'feishu-template', entry: 'SKILL.md',
      triggers: { commands: ['/platform-template'], promptPatterns: ['创建|create'], fileTypes: ['.md'] }
    }))
    await writeFile(join(path, 'SKILL.md'), '# Synthetic platform template\n\nUse only for Feishu.')
    await f.runtime.refresh(f.root)
    const local = f.runtime.resolveTurn({ prompt: '创建本地会议纪要。', filePaths: ['notes.md'], preferredSkillIds: ['feishu-template'], workspace: f.root })
    expect(local.activeSkillIds).not.toContain('feishu-template')
    expect(f.runtime.resolveTurn({ prompt: '在飞书创建会议纪要。', workspace: f.root }).activeSkillIds).toContain('feishu-template')
    expect(f.runtime.resolveTurn({ prompt: '/platform-template 创建会议纪要。', workspace: f.root }).activations[0]).toMatchObject({ skillId: 'feishu-template', reason: 'command:/platform-template' })
  })

  it('passes trusted continuation context through the production Loop without leaking it into a new local task', async () => {
    const f = await fixture(), requests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'synthetic', model: 'synthetic',
      async *stream(request) {
        requests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, { skillRuntime: f.runtime, tools: [] })
    await bootstrapThread(h, { workspace: f.root, request: { prompt: '在钉钉查询 AI 听记的完整逐字稿。' } })
    await h.loop.runTurn(h.threadId, h.turnId)
    const second = await h.turns.startTurn({ threadId: h.threadId, request: { prompt: '确认，继续。' } })
    await h.loop.runTurn(h.threadId, second.turnId)
    expect((await h.turns.getTurn(h.threadId, second.turnId))?.activeSkillIds).toContain('dingtalk-minutes')
    expect(requests.find(request => request.turnId === second.turnId)?.contextInstructions?.join('\n')).toContain('Active Skill: dingtalk-minutes')
    const third = await h.turns.startTurn({ threadId: h.threadId, request: { prompt: SVG_REQUEST } })
    await h.loop.runTurn(h.threadId, third.turnId)
    const localRequests = requests.filter(request => request.turnId === third.turnId)
    expect(localRequests.length).toBeGreaterThan(0)
    expect((await h.turns.getTurn(h.threadId, third.turnId))?.activeSkillIds).toEqual([])
    for (const request of localRequests) expect(request.contextInstructions?.join('\n') ?? '').not.toContain('Active Skill: dingtalk')
  })

  it('keeps the reported browser spelling ahead of unrelated platform matches', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: PROCUREMENT_REQUEST, workspace: f.root })
    expect(result.activations[0]).toMatchObject({ skillId: 'immutable-browser-package', reason: 'explicit:natural-name' })
    expect(result.activeSkillIds).toContain('immutable-browser-package')
    expect(result.activeSkillIds.some(id => /dingtalk|feishu|lark/.test(id))).toBe(false)
  })

  it('permits relevant platform knowledge without manufacturing a tool allowlist', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '什么是钉钉AI听记的完整逐字稿？', workspace: f.root })
    expect(result.activeSkillIds).toContain('dingtalk-minutes')
    expect(result.allowedToolNames).toBeUndefined()
  })

  it('keeps real engineering language relevant after suppressing generic words', async () => {
    const f = await fixture(), result = f.runtime.resolveTurn({ prompt: '请检查轨道控制网平差和 CPIII 观测结果。', workspace: f.root })
    expect(result.activeSkillIds).toContain('control-network-review')
    expect(result.activeSkillIds.some(id => /dingtalk|feishu|lark/.test(id))).toBe(false)
  })
})
