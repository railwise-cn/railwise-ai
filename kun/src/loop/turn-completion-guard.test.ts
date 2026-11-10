import { describe, expect, it } from 'vitest'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAssistantTextItem, makeToolResultItem } from '../domain/item.js'
import {
  hasSuccessfulFileDeliverable,
  completionIntentText,
  incompleteTurnContinuationInstruction,
  looksLikeExternalCapabilityBlockedReply,
  looksLikeProgressOnlyReply,
  looksLikeWebAccessFailureReply,
  promptRequiresExternalEffect,
  promptRequiresFileDeliverable,
  requiredFileExtensionsForPrompt,
  toolCanProveExternalEffect
} from './turn-completion-guard.js'

describe('turn completion guard', () => {
  it('detects explicit Chinese and English file deliverables', () => {
    expect(promptRequiresFileDeliverable('形成一份针对宁波睿威的产品介绍文档')).toBe(true)
    expect(promptRequiresFileDeliverable('Please create a DOCX report and save it.')).toBe(true)
    expect(promptRequiresFileDeliverable('解释一下这段代码')).toBe(false)
    expect(promptRequiresFileDeliverable('请只输出四个普通相对路径，不要使用 Markdown 链接。')).toBe(false)
    expect(promptRequiresFileDeliverable('请输出文件名和下载链接')).toBe(false)
    expect(promptRequiresFileDeliverable('Please output the relative paths as Markdown links.')).toBe(false)
  })

  it('detects external side-effect requests separately from prose answers', () => {
    expect(promptRequiresExternalEffect('连接钉钉并自动审批我的待办事项。')).toBe(true)
    expect(promptRequiresExternalEffect('请在飞书发送一条项目通知。')).toBe(true)
    expect(promptRequiresExternalEffect('解释一下钉钉审批流程。')).toBe(false)
    expect(promptRequiresExternalEffect('如何在飞书发送一条项目通知？')).toBe(false)
    expect(toolCanProveExternalEffect('dingtalk_approval')).toBe(true)
    expect(toolCanProveExternalEffect('send_message')).toBe(true)
    expect(toolCanProveExternalEffect('read')).toBe(false)
  })

  it('uses only marked user requests for file-delivery intent', () => {
    const prompt = [
      '[写作上下文]',
      '当前文件: qa-ppt-source.md',
      '',
      '[RailWise 知识库检索结果]',
      '[RailWise 1] AI监测报告生成工具',
      '生成报告的参考资料。',
      '',
      '[用户请求]',
      '基于知识库生成最多 6 项巡检清单。不要生成文件，不要调用工具。'
    ].join('\n')

    expect(completionIntentText(prompt)).toBe(
      '基于知识库生成最多 6 项巡检清单。不要生成文件，不要调用工具。'
    )
    expect(promptRequiresFileDeliverable(prompt)).toBe(false)
    expect(requiredFileExtensionsForPrompt(prompt)).toBeUndefined()
  })

  it('keeps positive delivery clauses that follow an unrelated or different negation', () => {
    expect(promptRequiresFileDeliverable('不要调用工具，生成 PPT 文件。')).toBe(true)
    expect(promptRequiresFileDeliverable('不要生成 HTML 文件；请生成 PPTX 文件。')).toBe(true)
    expect(promptRequiresFileDeliverable('不要只输出文字，请生成 PPT 文件。')).toBe(true)
    expect(promptRequiresFileDeliverable('Do not call tools; generate a PPTX file.')).toBe(true)
    expect(promptRequiresFileDeliverable('Do not generate an HTML file; generate a PPTX file.')).toBe(true)
  })

  it('preserves prior marked delivery intent across a confirmation turn', () => {
    const workflowPrompt = [
      '[写作上下文]\n当前文件: source.md\n\n[用户请求]\n请生成一份 PPT 演示文稿。',
      '[写作上下文]\n当前文件: source.md\n\n[用户请求]\n确认，开始执行。'
    ].join('\n')

    expect(completionIntentText(workflowPrompt)).toContain('请生成一份 PPT 演示文稿。')
    expect(completionIntentText(workflowPrompt)).toContain('确认，开始执行。')
    expect(promptRequiresFileDeliverable(workflowPrompt)).toBe(true)
    expect(requiredFileExtensionsForPrompt(workflowPrompt)).toEqual(['ppt', 'pptx'])
  })

  it('does not treat a contextual file name as a delivery request', () => {
    expect(promptRequiresFileDeliverable(
      '[写作上下文]\n当前文件: current.md\n\n[用户请求]\n总结当前内容。'
    )).toBe(false)
  })

  it('distinguishes a progress announcement from a delivered result', () => {
    expect(looksLikeProgressOnlyReply('资料够了。现在开始撰写完整文档。')).toBe(true)
    expect(looksLikeProgressOnlyReply('我来帮你查一下今天 AI 圈的资讯。让我搜索一下最新的动态。')).toBe(true)
    expect(looksLikeProgressOnlyReply('我帮你查询后汇报一下。')).toBe(true)
    expect(looksLikeProgressOnlyReply('文档已完成并保存到 workspace/report.md。')).toBe(false)
    expect(looksLikeProgressOnlyReply('今天 AI 圈有三条重要动态：V4 Pro 发布、Agent 工具链更新和新的开源模型。')).toBe(false)
  })

  it('distinguishes a missing external capability from an incomplete deliverable', () => {
    expect(looksLikeExternalCapabilityBlockedReply(
      '图片生成能力未配置，无法继续。请到设置 → 图片生成配置提供商、模型和凭据后重试。'
    )).toBe(true)
    expect(looksLikeExternalCapabilityBlockedReply(
      'Image generation is not configured, so I cannot continue. Configure an image provider in Settings.'
    )).toBe(true)
    expect(looksLikeExternalCapabilityBlockedReply(
      '图片生成能力尚未配置，但我会先创建目录并继续编写配图计划。'
    )).toBe(false)
    expect(looksLikeExternalCapabilityBlockedReply(
      '文档尚未生成，我现在继续处理。'
    )).toBe(false)
  })

  it('recognizes an explicit unverified live-web failure as a failed result', () => {
    const degradedWeatherReply = [
      '宁波天气查询结果如下：温度约 30℃，天气现象多云。',
      '本轮 web_search 成功返回了上述结果片段，但我随后尝试用 web_fetch 直接抓取源页面做交叉核验，全部抓取失败。',
      '因此我无法确认当前天气数据已通过源页面核实，请稍后重试。'
    ].join('\n')

    expect(looksLikeWebAccessFailureReply(degradedWeatherReply)).toBe(true)
    expect(looksLikeProgressOnlyReply(degradedWeatherReply)).toBe(false)
    expect(looksLikeWebAccessFailureReply(
      'Web search failed, so I could not verify today weather information.'
    )).toBe(true)
    expect(looksLikeWebAccessFailureReply(
      '已根据成功的联网搜索整理宁波今天的天气，并附上可核验来源。'
    )).toBe(false)
  })

  it('recognizes a successful document write in the current turn', () => {
    const items = [
      makeToolResultItem({
        id: 'result_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_1',
        toolName: 'write',
        toolKind: 'file_change',
        output: { path: '/tmp/report.md', relative_path: 'report.md' }
      })
    ]
    expect(hasSuccessfulFileDeliverable(items, 'turn_1')).toBe(true)
  })

  it('recognizes an absolute deliverable path printed by a successful shell tool', () => {
    const items = [
      makeToolResultItem({
        id: 'result_shell',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_shell',
        toolName: 'bash',
        toolKind: 'command_execution',
        output: {
          command: "printf 'fixture' > deliverable.txt",
          cwd: '/tmp/workspace',
          exit_code: 0,
          output: 'fixture\n/tmp/workspace/deliverable.txt\n',
          full_output_path: '/tmp/runtime/shell-output/bash_call.log'
        }
      })
    ]

    expect(hasSuccessfulFileDeliverable(items, 'turn_1', '请创建 TXT 文件。')).toBe(true)
  })

  it('does not treat a file name mentioned only in shell command or stdout as a deliverable', () => {
    const items = [
      makeToolResultItem({
        id: 'result_shell',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_shell',
        toolName: 'bash',
        toolKind: 'command_execution',
        output: {
          command: "printf 'fixture' > deliverable.txt",
          cwd: '/tmp/workspace',
          exit_code: 0,
          output: 'created deliverable.txt\n',
          full_output_path: '/tmp/runtime/shell-output/bash_call.log'
        }
      })
    ]

    expect(hasSuccessfulFileDeliverable(items, 'turn_1', '请创建 TXT 文件。')).toBe(false)
  })

  it('recognizes a recent workspace file claimed after a successful shell write', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workwise-shell-deliverable-'))
    const deliverablePath = join(workspace, 'feishu-attachment.txt')
    const startedAt = new Date(Date.now() - 1_000)
    await writeFile(deliverablePath, 'exact content')
    const finishedAt = new Date(Date.now() + 1_000)
    const items = [
      makeToolResultItem({
        id: 'result_shell',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_shell',
        toolName: 'bash',
        toolKind: 'command_execution',
        output: {
          cwd: workspace,
          exit_code: 0,
          output: 'bytes: 13\nMATCH\n',
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString()
        }
      }),
      makeAssistantTextItem({
        id: 'assistant_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        text: '已创建文件：`feishu-attachment.txt`，内容已校验。',
        status: 'completed'
      })
    ]

    expect(hasSuccessfulFileDeliverable(items, 'turn_1', '请创建 TXT 文件。')).toBe(true)
  })

  it('does not accept a historical workspace file after an unrelated successful command', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workwise-old-shell-deliverable-'))
    const deliverablePath = join(workspace, 'historical.txt')
    await writeFile(deliverablePath, 'old content')
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z')
    await utimes(deliverablePath, oldTimestamp, oldTimestamp)
    const items = [
      makeToolResultItem({
        id: 'result_shell',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_shell',
        toolName: 'bash',
        toolKind: 'command_execution',
        output: {
          cwd: workspace,
          exit_code: 0,
          output: 'done\n',
          started_at: '2026-08-17T00:00:00.000Z',
          finished_at: '2026-08-17T00:00:01.000Z'
        }
      }),
      makeAssistantTextItem({
        id: 'assistant_1',
        threadId: 'thread_1',
        turnId: 'turn_1',
        text: '历史文件 `historical.txt` 已存在。',
        status: 'completed'
      })
    ]

    expect(hasSuccessfulFileDeliverable(items, 'turn_1', '请创建 TXT 文件。')).toBe(false)
  })

  it('does not accept HTML as completion when the user requested a PPT', () => {
    const htmlItems = [
      makeToolResultItem({
        id: 'result_html',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_html',
        toolName: 'write',
        toolKind: 'file_change',
        output: { path: 'slides.html' }
      })
    ]
    const pptxItems = [
      makeToolResultItem({
        id: 'result_pptx',
        threadId: 'thread_1',
        turnId: 'turn_1',
        callId: 'call_pptx',
        toolName: 'ppt_master_export',
        output: { generatedFiles: [{ relativePath: 'slides.pptx' }] }
      })
    ]
    const prompt = '请使用 PPT Master 生成一份演示文稿。'

    expect(hasSuccessfulFileDeliverable(htmlItems, 'turn_1', prompt)).toBe(false)
    expect(hasSuccessfulFileDeliverable(pptxItems, 'turn_1', prompt)).toBe(true)
    expect(incompleteTurnContinuationInstruction({
      requiresFileDeliverable: true,
      hasFileDeliverable: false,
      previousAssistantText: '',
      requiredFileExtensions: ['ppt', 'pptx']
    })).toContain('HTML, an outline, or a preview alone does not satisfy')
  })

  it('keeps PPT as the required output when HTML is the source format', () => {
    expect(requiredFileExtensionsForPrompt('请把这个 HTML 页面转换成 PPT。')).toEqual(['ppt', 'pptx'])
    expect(requiredFileExtensionsForPrompt('Create a self-contained HTML presentation.')).toBeUndefined()
  })

  it('builds recovery guidance for incomplete delivery and progress-only replies', () => {
    expect(incompleteTurnContinuationInstruction({
      requiresFileDeliverable: true,
      hasFileDeliverable: false,
      previousAssistantText: ''
    })).toContain('has not produced one yet')
    expect(incompleteTurnContinuationInstruction({
      requiresFileDeliverable: false,
      hasFileDeliverable: false,
      previousAssistantText: '让我继续整理资料。'
    })).toContain('progress announcement')
  })
})
