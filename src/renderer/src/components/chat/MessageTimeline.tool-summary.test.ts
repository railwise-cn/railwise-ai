import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatBlock, NormalizedThread, ToolBlock } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { MessageTimeline, summarizeToolBlock } from './MessageTimeline'
import { GeneratedFilesPanel, MessageBubble } from './message-timeline-bubbles'
import { ProcessSectionRow } from './message-timeline-process'
import { resolveTimelineWorkspaceRoot } from './use-timeline-stores'

const labels: Record<string, string> = {
  toolActionCommand: 'Ran command',
  toolBuiltinRead: 'Read',
  toolBuiltinWrite: 'Write',
  toolBuiltinEdit: 'Edit',
  toolBuiltinGrep: 'Search',
  toolBuiltinFind: 'Find',
  toolBuiltinLs: 'List',
  toolBuiltinBash: 'Bash'
}

const t = (key: string) => labels[key] ?? (key === 'toolActionCommand' ? 'Ran command' : key)

const activeThread: NormalizedThread = {
  id: 'thr_1',
  title: 'Thread',
  updatedAt: '2026-06-07T00:00:00.000Z',
  model: 'deepseek-chat',
  mode: 'code',
  workspace: '/tmp/project'
}

function toolBlock(overrides: Partial<ToolBlock>): ToolBlock {
  return {
    kind: 'tool',
    id: 'tool_1',
    summary: 'tool',
    status: 'success',
    ...overrides
  }
}

describe('MessageTimeline tool summaries', () => {
  it('uses the rendered thread workspace for artifact actions', () => {
    expect(resolveTimelineWorkspaceRoot(
      { workspace: '/tmp/write-workspace' },
      '/tmp/code-workspace'
    )).toBe('/tmp/write-workspace')
  })

  it('summarizes built-in read/write/edit tools with their file path', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'read: file',
          meta: { toolName: 'read' },
          filePath: '/tmp/readme.md'
        }),
        t
      )
    ).toBe('Read /tmp/readme.md')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'write: file',
          meta: { toolName: 'write' },
          filePath: '/tmp/out.ts'
        }),
        t
      )
    ).toBe('Write /tmp/out.ts')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'edit: file',
          meta: { toolName: 'edit' },
          filePath: '/tmp/app.ts'
        }),
        t
      )
    ).toBe('Edit /tmp/app.ts')
  })

  it('summarizes built-in grep/find with pattern context', () => {
    const grep = summarizeToolBlock(
      toolBlock({
        summary: 'grep: search',
        meta: { toolName: 'grep', pattern: 'needle' },
        filePath: '/tmp/src'
      }),
      t
    )
    expect(grep).toBe('Search needle · /tmp/src')

    const find = summarizeToolBlock(
      toolBlock({
        summary: 'find: files',
        meta: { toolName: 'find', pattern: '*.ts' },
        filePath: '/tmp/src'
      }),
      t
    )
    expect(find).toBe('Find *.ts · /tmp/src')
  })

  it('summarizes built-in ls with its path and bash with its command', () => {
    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'ls: list',
          meta: { toolName: 'ls' },
          filePath: '/tmp/project'
        }),
        t
      )
    ).toBe('List /tmp/project')

    expect(
      summarizeToolBlock(
        toolBlock({
          summary: 'bash: exec',
          toolKind: 'command_execution',
          meta: { toolName: 'bash', command: 'npm test' }
        }),
        t
      )
    ).toBe('Ran command npm test')
  })
})

describe('MessageTimeline WorkWise Runtime runtime metadata smoke', () => {
  beforeEach(() => {
    useChatStore.setState({
      route: 'chat',
      workspaceRoot: '/tmp/project',
      activeThreadId: 'thr_1',
      threads: [activeThread],
      busy: false,
      currentTurnUserId: null,
      turnStartedAtByUserId: {},
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      clawChannels: [],
      activeClawChannelId: ''
    })
  })

  it('enforces the professional surface boundary for direct assistant rendering', () => {
    const block: ChatBlock = {
      kind: 'assistant',
      id: 'assistant_professional',
      text: 'survey_read_context returned contextHash=abc. S1 residual is 0.4 mm and remains below the tolerance.'
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block, professionalSurface: true, language: 'zh-CN' }))

    expect(html).toContain('S1 residual is 0.4 mm')
    expect(html).not.toContain('survey_read_context')
    expect(html).not.toContain('contextHash')
  })

  it('removes internal evidence routing metadata from user messages on the professional surface', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_professional',
      text: [
        '请解释 S1 的结果。',
        '',
        'Selected Survey evidence (reference IDs only, not execution approval): {"projectId":"p","networkId":"n"}',
        'Read these exact legacy selectors using survey_read_context before answering. This selection has no typedEvidence.'
      ].join('\n')
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block, professionalSurface: true, language: 'zh-CN' }))

    expect(html).toContain('请解释 S1 的结果。')
    expect(html).not.toContain('Selected Survey evidence')
    expect(html).not.toContain('survey_read_context')
    expect(html).not.toContain('projectId')
  })

  it('translates generated survey record IDs in professional user questions', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_survey_record_id',
      text: '请解释观测 cosa-in2-6-backsight-reset 的结果。'
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block, professionalSurface: true, language: 'zh-CN' }))

    expect(html).toContain('请解释观测 后视归零方向 的结果。')
    expect(html).not.toContain('cosa-in2-6-backsight-reset')
  })

  it('renders user image attachments as thumbnails instead of attachment chips', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_1',
      text: '为什么图片完全没有识别啊',
      meta: {
        attachmentIds: ['att_1'],
        attachments: [{
          id: 'att_1',
          name: 'image.png',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc'
        }]
      }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/png;base64,abc"')
    expect(html).toContain('为什么图片完全没有识别啊')
    expect(html).not.toContain('Attachments 1')
  })

  it('renders managed Claw prompts as the user-visible message', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_claw',
      text: [
        '[Claw managed instructions]',
        '',
        '[Claw IM agent instructions]',
        '',
        '[Agent name]',
        'kun',
        '',
        '---',
        '[Current user request]',
        '[Feishu / Lark inbound message]',
        'Chat type: p2p',
        'Sender: user-1',
        '',
        'hi'
      ].join('\n')
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('hi')
    expect(html).not.toContain('Claw managed instructions')
    expect(html).not.toContain('Agent name')
    expect(html).not.toContain('Feishu / Lark inbound message')
  })

  it('hides runtime skill, memory, and child-agent metadata on the professional surface', () => {
    const block: ChatBlock = {
      kind: 'user',
      id: 'user_professional_runtime_meta',
      text: '请检查控制网资料。',
      meta: {
        activeSkillIds: ['rail-any-station-control-network'],
        injectedMemoryIds: ['memory-internal-1'],
        child: {
          parentThreadId: 'thread-parent-1',
          parentTurnId: 'turn-parent-1',
          childId: 'child-research-1',
          childLabel: 'research',
          childStatus: 'completed',
          childSeq: 1
        }
      }
    }

    const html = renderToStaticMarkup(createElement(MessageBubble, { block, professionalSurface: true }))

    expect(html).toContain('请检查控制网资料。')
    expect(html).not.toContain('rail-any-station-control-network')
    expect(html).not.toContain('memory-internal-1')
    expect(html).not.toContain('child-research-1')
    expect(html).not.toContain('research')
    expect(html).not.toMatch(/Skills|Memories|Child agent|已启用技能|记忆|子任务/)
  })

  it('hides generated file panels from the professional conversation surface', () => {
    const block = toolBlock({
      meta: {
        generatedFiles: [{
          id: 'deliverable-1',
          name: 'adjustment-report.pdf',
          mimeType: 'application/pdf',
          relativePath: 'deliverables/adjustment-report.pdf'
        }]
      }
    })

    const html = renderToStaticMarkup(createElement(GeneratedFilesPanel, {
      blocks: [block],
      workspaceRoot: '/tmp/project',
      activeThreadId: 'thr_1',
      professionalSurface: true
    }))

    expect(html).toBe('')
  })

  it('does not render runtime blocks when a professional caller passes them directly', () => {
    const blocks: ChatBlock[] = [
      { kind: 'reasoning', id: 'reasoning_1', text: 'internal reasoning with a session ID session-123' },
      toolBlock({ id: 'tool_professional', summary: 'survey_read_context', filePath: '/tmp/project/result.json', meta: { session_id: 'session-123' } }),
      { kind: 'system', id: 'system_1', text: 'Runtime failure', code: 'runtime_internal_code' },
      { kind: 'approval', id: 'approval_1', approvalId: 'approval-request-1', status: 'error', summary: 'Approval payload', toolName: 'survey_adjustment', errorMessage: 'exit code 1' }
    ]

    for (const block of blocks) {
      const html = renderToStaticMarkup(createElement(MessageBubble, { block, professionalSurface: true, language: 'zh-CN' }))
      expect(html).toBe('')
      expect(html).not.toMatch(/survey_read_context|session-123|runtime_internal_code|survey_adjustment|exit code|result\.json/)
    }
  })

  it('renders attachment, Skill, memory, web source, and child-agent chips in bubbles', () => {
    const block: ToolBlock = toolBlock({
      summary: 'web_search: docs',
      meta: {
        attachmentIds: ['att_1'],
        activeSkillIds: ['skill_docs'],
        injectedMemoryIds: ['mem_1'],
        child: {
          childId: 'child_research',
          childLabel: 'research'
        },
        sources: [
          {
            title: 'WorkWise Runtime docs',
            url: 'https://example.com/kun'
          }
        ]
      }
    })

    const html = renderToStaticMarkup(createElement(MessageBubble, { block }))

    expect(html).toContain('Attachments 1')
    expect(html).toContain('Skills 1')
    expect(html).toContain('Memories 1')
    expect(html).toContain('Child agent')
    expect(html).toContain('research')
    expect(html).toContain('Sources 1')
    expect(html).toContain('https://example.com/kun')
  })

  it('renders the same runtime metadata on process timeline rows', () => {
    const block: ChatBlock = toolBlock({
      summary: 'delegate: research',
      meta: {
        attachmentIds: ['att_1'],
        activeSkillIds: ['skill_docs'],
        injectedMemoryIds: ['mem_1'],
        child: {
          childId: 'child_research',
          childLabel: 'research'
        },
        sources: [
          {
            title: 'WorkWise Runtime docs',
            url: 'https://example.com/kun'
          }
        ]
      }
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_1', kind: 'execution', blocks: [block] },
        processing: false,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Attachments 1')
    expect(html).toContain('Skills 1')
    expect(html).toContain('Memories 1')
    expect(html).toContain('Child agent')
    expect(html).toContain('research')
    expect(html).toContain('Sources 1')
  })

  it('keeps running tool calls collapsed by default while showing active status', () => {
    const block: ChatBlock = toolBlock({
      summary: 'read: file',
      status: 'running',
      detail: 'partial tool output while running',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-tool_1', kind: 'execution', blocks: [block] },
        processing: true,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Read')
    expect(html).toContain('/tmp/readme.md')
    expect(html).not.toContain('ds-work-logo')
    expect(html).toContain('ds-shiny-text')
    expect(html).not.toContain('partial tool output while running')
    expect(html).toContain('ds-process-file-reference')
  })

  it('keeps private active reasoning out of concise progress', () => {
    const block: ChatBlock = {
      kind: 'reasoning',
      id: 'live-reasoning',
      text: 'current reasoning summary'
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'reasoning', kind: 'reasoning', blocks: [block] },
        processing: true,
        singleReasoningSection: true,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('ds-shiny-text')
    expect(html).not.toContain('ds-work-logo')
    expect(html).toContain('Thinking')
    expect(html).not.toContain('current reasoning summary')
  })

  it('keeps same-batch tool calls collapsed by default', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const grepBlock: ChatBlock = toolBlock({
      id: 'tool_grep',
      summary: 'grep: search',
      detail: 'grep detail should stay tucked away',
      meta: { toolName: 'grep', pattern: 'needle' },
      filePath: '/tmp/src'
    })

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, grepBlock] },
        processing: false,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('Used 2 tools')
    expect(html).not.toContain('ds-work-stack')
    expect(html).not.toContain('/tmp/readme.md')
    expect(html).not.toContain('needle')
    expect(html).not.toContain('read detail should stay tucked away')
    expect(html).not.toContain('grep detail should stay tucked away')
  })

  it('auto-expands pending request_user_input while keeping other tool details tucked away', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const inputBlock: ChatBlock = {
      kind: 'user_input',
      id: 'ui_1',
      requestId: 'input_1',
      status: 'pending',
      questions: [
        {
          header: 'Dinner',
          id: 'dinner',
          question: 'What should we eat tonight?',
          options: [
            {
              label: 'Noodles',
              description: 'Fast and warm'
            }
          ]
        }
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, inputBlock] },
        processing: true,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('ds-work-stack')
    expect(html).toContain('What should we eat tonight?')
    expect(html).toContain('Noodles')
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('auto-expands pending approvals while keeping other tool details tucked away', () => {
    const readBlock: ChatBlock = toolBlock({
      id: 'tool_read',
      summary: 'read: file',
      detail: 'read detail should stay tucked away',
      meta: { toolName: 'read' },
      filePath: '/tmp/readme.md'
    })
    const approvalBlock: ChatBlock = {
      kind: 'approval',
      id: 'approval_appr_1',
      approvalId: 'appr_1',
      status: 'pending',
      toolName: 'edit',
      summary: 'Run edit(path="/tmp/app.ts")'
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-batch', kind: 'execution', blocks: [readBlock, approvalBlock] },
        processing: true,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('ds-work-stack')
    expect(html).toContain('Run edit(path=&quot;/tmp/app.ts&quot;)')
    expect(html).toMatch(/Approval required|需要审批|approvalTitle/)
    expect(html).toMatch(/Allow|允许|approvalAllow/)
    expect(html).not.toContain('read detail should stay tucked away')
  })

  it('renders request_user_input without options as a freeform answer field', () => {
    const inputBlock: ChatBlock = {
      kind: 'user_input',
      id: 'ui_freeform',
      requestId: 'input_freeform',
      status: 'pending',
      questions: [
        {
          header: 'Input',
          id: 'direction',
          question: '你更想去南方还是北方？',
          options: []
        }
      ]
    }

    const html = renderToStaticMarkup(
      createElement(ProcessSectionRow, {
        section: { id: 'execution-input', kind: 'execution', blocks: [inputBlock] },
        processing: true,
        singleReasoningSection: false,
        viewportRef: { current: null }
      })
    )

    expect(html).toContain('你更想去南方还是北方？')
    expect(html).toContain('<textarea')
    expect(html).not.toContain('userInputOther')
    expect(html).not.toContain('其他')
  })

  it('keeps the live technical timeline collapsed in the default concise view', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user_1',
        text: 'inspect this file'
      },
      toolBlock({
        summary: 'read: file',
        status: 'running',
        detail: 'running timeline detail should stay collapsed',
        meta: { toolName: 'read' },
        filePath: '/tmp/project/src/app.ts'
      })
    ]
    useChatStore.setState({
      busy: true,
      currentTurnUserId: 'user_1',
      turnStartedAtByUserId: { user_1: Date.now() }
    })

    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks,
        liveReasoning: '',
        live: '',
        activeThreadId: 'thr_1',
        runtimeConnection: 'ready',
        onRetryConnection: () => undefined,
        onOpenSettings: () => undefined
      })
    )

    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Read')
    expect(html).not.toContain('/tmp/project/src/app.ts')
    expect(html).not.toContain('running timeline detail should stay collapsed')
  })
})
