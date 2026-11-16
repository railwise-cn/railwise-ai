import { describe, expect, it } from 'vitest'
import { chatBlockFromItem, dispatchRuntimeEvent, mergeChatBlocks, threadFromCore } from './runtime-mapper'
import type { CoreRuntimeEventJson, CoreTurnItemJson } from './runtime-contract'
import type { ThreadErrorOptions, ThreadEventSink } from './types'

function makeSink(): ThreadEventSink {
  return {
    onSeq: () => undefined,
    onDeltas: () => undefined,
    onUserMessage: () => undefined,
    onTool: () => undefined,
    onCompaction: () => undefined,
    onApproval: () => undefined,
    onUserInput: () => undefined,
    onUserInputStatus: () => undefined,
    onGoal: () => undefined,
    onTodos: () => undefined,
    onTurnComplete: () => undefined,
    onError: () => undefined
  }
}

describe('thread summary mapping', () => {
  it('restores a capability action from persisted assistant metadata', () => {
    const capabilityCard = {
      threadId: 'thread-original', taskId: 'task-waiting', prompt: '处理钉钉待办',
      capability: { provider: 'dingtalk' as const, status: 'unsupported' as const, message: '请先配置连接器' }
    }
    expect(chatBlockFromItem({
      id: 'item-capability', threadId: 'thread-original', turnId: 'command-message',
      role: 'assistant', status: 'completed', createdAt: '2026-11-10T00:00:00Z',
      kind: 'assistant_text', text: '请先配置连接器', capabilityCard
    })).toMatchObject({ kind: 'assistant', capabilityCard })
  })

  it('preserves runtime message counts and previews for sidebar visibility', () => {
    expect(threadFromCore({
      id: 'thr_history',
      title: 'History',
      messageCount: 3,
      preview: 'latest message',
      model: 'deepseek-v4-pro',
      mode: 'agent',
      status: 'idle',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z'
    })).toMatchObject({
      id: 'thr_history',
      messageCount: 3,
      preview: 'latest message'
    })
  })

  it('keeps missing legacy summary fields undefined', () => {
    const mapped = threadFromCore({
      id: 'thr_legacy',
      title: 'Legacy',
      model: 'deepseek-v4-pro',
      mode: 'agent',
      status: 'idle',
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z'
    })

    expect(mapped.messageCount).toBeUndefined()
    expect(mapped.preview).toBeUndefined()
  })
})

describe('tool-call usage delta mapping', () => {
  it('forwards only the bounded argument character count to live usage', async () => {
    const deltas: Array<{ characters: number; seq?: number; turnId?: string }> = []
    const sink: ThreadEventSink = {
      ...makeSink(),
      onUsageDelta: (characters, seq, turnId) => deltas.push({ characters, seq, turnId })
    }

    await dispatchRuntimeEvent({
      kind: 'tool_call_delta',
      seq: 9,
      timestamp: '2026-08-20T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      callId: 'call_1',
      toolName: 'read_file',
      characterCount: 37
    } as CoreRuntimeEventJson, sink, async () => undefined)

    expect(deltas).toEqual([{ characters: 37, seq: 9, turnId: 'turn_1' }])
  })
})

describe('assistant stream mapping', () => {
  it('does not append completed assistant snapshots after streaming deltas', async () => {
    const deltas: unknown[] = []
    const sink: ThreadEventSink = {
      ...makeSink(),
      onDeltas: (events) => {
        deltas.push(...events)
      }
    }

    await dispatchRuntimeEvent({
      kind: 'assistant_text_delta',
      seq: 1,
      item: {
        id: 'item_answer',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'assistant',
        status: 'running',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'assistant_text',
        text: 'he'
      }
    }, sink, async () => undefined)
    await dispatchRuntimeEvent({
      kind: 'assistant_text_delta',
      seq: 2,
      item: {
        id: 'item_answer',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'assistant',
        status: 'running',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'assistant_text',
        text: 'llo'
      }
    }, sink, async () => undefined)
    await dispatchRuntimeEvent({
      kind: 'item_created',
      seq: 3,
      item: {
        id: 'item_answer',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'assistant',
        status: 'completed',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'assistant_text',
        text: 'hello'
      }
    }, sink, async () => undefined)

    expect(deltas).toEqual([
      { text: 'he', kind: 'agent_message', seq: 1 },
      { text: 'llo', kind: 'agent_message', seq: 2 }
    ])
  })
})

describe('todo event mapping', () => {
  it('surfaces thread todo updates through the event sink', async () => {
    const events: unknown[] = []
    const sink: ThreadEventSink = {
      ...makeSink(),
      onTodos: (event) => {
        events.push(event)
      }
    }

    await dispatchRuntimeEvent({
      kind: 'todos_updated',
      seq: 4,
      timestamp: '2026-06-04T00:00:00.000Z',
      threadId: 'thr_1',
      todos: {
        threadId: 'thr_1',
        updatedAt: '2026-06-04T00:00:00.000Z',
        items: [{
          id: 'todo_1',
          content: 'Wire todo panel',
          status: 'completed',
          createdAt: '2026-06-04T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z'
        }]
      }
    }, sink, async () => undefined)

    expect(events).toEqual([{
      threadId: 'thr_1',
      createdAt: '2026-06-04T00:00:00.000Z',
      todos: {
        threadId: 'thr_1',
        updatedAt: '2026-06-04T00:00:00.000Z',
        items: [expect.objectContaining({ content: 'Wire todo panel', status: 'completed' })]
      }
    }])
  })
})

describe('attachment evidence event mapping', () => {
  it('surfaces ready and failed evidence states through the event sink', async () => {
    const evidenceEvents: unknown[] = []
    const sink = {
      ...makeSink(),
      onAttachmentEvidence: (event: unknown) => evidenceEvents.push(event)
    } as ThreadEventSink

    await dispatchRuntimeEvent({
      kind: 'attachment_evidence_ready',
      seq: 5,
      timestamp: '2026-08-18T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      attachmentId: 'att_1',
      status: 'ready'
    } as CoreRuntimeEventJson, sink, async () => undefined)
    await dispatchRuntimeEvent({
      kind: 'attachment_evidence_failed',
      seq: 6,
      timestamp: '2026-08-18T00:00:01.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      attachmentId: 'att_2',
      status: 'failed',
      message: 'analysis unavailable'
    } as CoreRuntimeEventJson, sink, async () => undefined)

    expect(evidenceEvents).toEqual([
      {
        attachmentId: 'att_1',
        status: 'ready',
        createdAt: '2026-08-18T00:00:00.000Z'
      },
      {
        attachmentId: 'att_2',
        status: 'failed',
        createdAt: '2026-08-18T00:00:01.000Z',
        message: 'analysis unavailable'
      }
    ])
  })
})

describe('review mapping', () => {
  const reviewItem: CoreTurnItemJson = {
    id: 'item_review_1',
    turnId: 'turn_1',
    threadId: 'thr_1',
    role: 'assistant',
    status: 'completed',
    createdAt: '2026-06-04T00:00:00.000Z',
    kind: 'review',
    title: 'Review current changes',
    target: { kind: 'uncommittedChanges' },
    reviewText: 'No review findings.',
    output: {
      findings: [],
      overallCorrectness: 'patch is correct',
      overallExplanation: 'No blocking issues found.',
      overallConfidenceScore: 0.75
    }
  }

  it('maps persisted review items to review blocks', () => {
    const block = chatBlockFromItem(reviewItem)
    expect(block).toMatchObject({
      kind: 'review',
      id: 'item_review_1',
      title: 'Review current changes',
      status: 'success',
      output: {
        overallCorrectness: 'patch is correct'
      }
    })
  })

  it('surfaces review item updates through the event sink', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onReview: (event) => {
        captured = event
      }
    }

    await dispatchRuntimeEvent({
      kind: 'item_updated',
      seq: 7,
      item: reviewItem
    }, sink, async () => undefined)

    expect(captured).toMatchObject({
      itemId: 'item_review_1',
      status: 'success',
      reviewText: 'No review findings.'
    })
  })
})

describe('create_plan tool mapping', () => {
  it('surfaces turn failure messages from WorkWise Runtime lifecycle events', async () => {
    let capturedError: string | null = null
    let capturedErrorOptions: ThreadErrorOptions | null = null
    let capturedRuntimeError: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onRuntimeError: (event) => {
        capturedRuntimeError = event
      },
      onError: (error, options) => {
        capturedError = error.message
        capturedErrorOptions = options ?? null
      }
    }

    await dispatchRuntimeEvent({
      kind: 'turn_failed',
      seq: 8,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      message: 'model stream exploded'
    }, sink, async () => undefined)

    expect(capturedRuntimeError).toMatchObject({
      itemId: 'runtime_error_turn_1',
      message: 'model stream exploded',
      severity: 'error'
    })
    expect(JSON.parse(capturedError ?? '{}')).toMatchObject({
      message: 'model stream exploded',
      severity: 'error'
    })
    expect(capturedErrorOptions).toEqual({
      terminal: true,
      terminalReason: 'error',
      threadId: 'thr_1',
      turnId: 'turn_1'
    })
  })

  it('routes live error items to runtime error timeline events without fatal stream errors', async () => {
    let fatalCalled = false
    let capturedRuntimeError: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onRuntimeError: (event) => {
        capturedRuntimeError = event
      },
      onError: () => {
        fatalCalled = true
      }
    }

    await dispatchRuntimeEvent({
      kind: 'item_created',
      seq: 9,
      timestamp: '2024-01-01T00:00:00.000Z',
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'item_error_1',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'system',
        status: 'failed',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'error',
        message: 'Authorization: Bearer secret-token failed',
        code: 'stream_read_error',
        details: { token: 'secret-token' }
      }
    }, sink, async () => undefined)

    expect(fatalCalled).toBe(false)
    expect(capturedRuntimeError).toMatchObject({
      itemId: 'item_error_1',
      message: 'Authorization=<redacted> failed',
      code: 'stream_read_error',
      details: { token: 'secret-token' }
    })
  })

  it('maps a successful create_plan result to a tool block with plan metadata', () => {
    const item: CoreTurnItemJson = {
      id: 'item_plan_1',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      finishedAt: '2024-01-01T00:00:01.000Z',
      kind: 'tool_result',
      toolName: 'create_plan',
      callId: 'call_plan_1',
      output: {
        plan_id: 'plan_login',
        workspace_root: '/tmp/ws',
        relative_path: '.deepseekgui/plan/login.md',
        absolute_path: '/tmp/ws/.deepseekgui/plan/login.md',
        operation: 'draft',
        saved_at: '2024-01-01T00:00:01.000Z',
        content_hash: 'deadbeefcafef00d',
        byte_size: 42,
        source_request: 'Add login',
        title: 'Login flow'
      }
    }
    const block = chatBlockFromItem(item)
    expect(block).not.toBeNull()
    if (block && block.kind === 'tool') {
      expect(block.status).toBe('success')
      expect(block.meta?.toolName).toBe('create_plan')
      expect(block.meta?.plan).toMatchObject({
        plan_id: 'plan_login',
        workspace_root: '/tmp/ws',
        relative_path: '.deepseekgui/plan/login.md',
        operation: 'draft',
        byte_size: 42
      })
    }
  })

  it('maps a failed create_plan result to an error tool block', () => {
    const item: CoreTurnItemJson = {
      id: 'item_plan_err',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'failed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'create_plan',
      callId: 'call_plan_err',
      isError: true,
      output: { error: 'plan_relative_path must be a direct Markdown file under .deepseekgui/plan' }
    }
    const block = chatBlockFromItem(item)
    if (block && block.kind === 'tool') {
      expect(block.status).toBe('error')
      expect(block.meta?.plan).toMatchObject({ error: expect.stringContaining('direct Markdown') })
    } else {
      throw new Error('expected tool block')
    }
  })

  it('lifts tool_result output attachments into tool block meta', () => {
    const item: CoreTurnItemJson = {
      id: 'item_img_1',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'generate_image',
      callId: 'call_img_1',
      output: {
        files: [{
          relativePath: '.deepseekgui-images/img-1.png',
          workspaceRoot: '/'
        }],
        attachments: [
          {
            id: 'att_abc',
            name: 'img-1.png',
            mimeType: 'image/png',
            width: 1024,
            height: 576,
            dataUrl: 'data:image/png;base64,aW1hZ2U='
          },
          {
            id: 'att_html',
            name: 'unsafe.html',
            mimeType: 'text/html',
            previewUrl: 'data:text/html;base64,PHNjcmlwdD4='
          },
          { id: '   ' },
          'not-an-object',
          { name: 'missing-id.png' }
        ],
        endpoint: 'generations'
      }
    }
    const block = chatBlockFromItem(item)
    expect(block).not.toBeNull()
    if (block && block.kind === 'tool') {
      expect(block.meta?.attachments).toEqual([
        {
          id: 'att_abc',
          name: 'img-1.png',
          mimeType: 'image/png',
          width: 1024,
          height: 576,
          previewUrl: 'data:image/png;base64,aW1hZ2U='
        },
        { id: 'att_html', name: 'unsafe.html', mimeType: 'text/html' }
      ])
      expect(block.meta?.generatedFiles).toEqual([
        {
          relativePath: '.deepseekgui-images/img-1.png'
        }
      ])
    } else {
      throw new Error('expected tool block')
    }
  })

  it('omits meta attachments when tool_result output has none worth showing', () => {
    const item: CoreTurnItemJson = {
      id: 'item_img_2',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'generate_image',
      callId: 'call_img_2',
      output: { attachments: 'nope' }
    }
    const block = chatBlockFromItem(item)
    if (block && block.kind === 'tool') {
      expect(block.meta?.attachments).toBeUndefined()
    } else {
      throw new Error('expected tool block')
    }
  })

  it('surfaces create_plan tool events through the event sink', () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onTool: (event) => {
        captured = event
      }
    }
    const event: CoreRuntimeEventJson = {
      kind: 'item_completed',
      seq: 5,
      item: {
        id: 'item_plan_sink',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'tool',
        status: 'completed',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'tool_result',
        toolName: 'create_plan',
        callId: 'call_plan_sink',
        output: {
          plan_id: 'plan_x',
          workspace_root: '/tmp/ws',
          relative_path: '.deepseekgui/plan/x.md',
          operation: 'refine',
          saved_at: '2024-01-01T00:00:01.000Z'
        }
      }
    }
    void dispatchRuntimeEvent(event, sink, async () => undefined)
    const capturedTool = captured as { meta?: { plan?: { plan_id?: string; operation?: string } } } | null
    expect(capturedTool).not.toBeNull()
    expect(capturedTool?.meta?.plan?.plan_id).toBe('plan_x')
    expect(capturedTool?.meta?.plan?.operation).toBe('refine')
  })
})

describe('user input mapping', () => {
  it('maps structured user-input items without inventing submit-only options', () => {
    const item: CoreTurnItemJson = {
      id: 'item_input_1',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'user_input',
      inputId: 'input_1',
      prompt: 'Pick one',
      questions: [
        {
          header: 'Decision',
          id: 'choice',
          question: 'Pick one',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' }
          ]
        }
      ]
    }
    const block = chatBlockFromItem(item)
    expect(block).toMatchObject({
      kind: 'user_input',
      questions: [
        {
          header: 'Decision',
          id: 'choice',
          question: 'Pick one',
          options: [
            { label: 'Yes', description: 'Continue' },
            { label: 'No', description: 'Stop' }
          ]
        }
      ]
    })
  })

  it('surfaces structured user-input requests from runtime events', async () => {
    let request: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onUserInput: (payload) => {
        request = payload
      }
    }
    await dispatchRuntimeEvent(
      {
        kind: 'user_input_requested',
        seq: 7,
        itemId: 'item_input_2',
        inputId: 'input_2',
        prompt: 'Choose',
        questions: [
          {
            header: 'Mode',
            id: 'mode',
            question: 'Choose',
            options: [{ label: 'Fast', description: 'Use the faster path' }]
          }
        ]
      },
      sink,
      async () => undefined
    )
    expect(request).toMatchObject({
      itemId: 'item_input_2',
      requestId: 'input_2',
      questions: [
        {
          header: 'Mode',
          id: 'mode',
          question: 'Choose',
          options: [{ label: 'Fast', description: 'Use the faster path' }]
        }
      ]
    })
  })

  it('does not emit duplicate user-input cards from generic item events', async () => {
    let called = false
    const sink: ThreadEventSink = {
      ...makeSink(),
      onUserInput: () => {
        called = true
      }
    }
    await dispatchRuntimeEvent(
      {
        kind: 'item_created',
        seq: 8,
        item: {
          id: 'item_input_dup',
          turnId: 'turn_1',
          threadId: 'thr_1',
          role: 'tool',
          status: 'pending',
          createdAt: '2024-01-01T00:00:00.000Z',
          kind: 'user_input',
          inputId: 'input_dup',
          prompt: 'Choose'
        }
      },
      sink,
      async () => undefined
    )
    expect(called).toBe(false)
  })
})

describe('approval mapping', () => {
  it('keeps durable approval consumption records out of ordinary chat bubbles', () => {
    expect(chatBlockFromItem({id:'delivery-control',threadId:'task-thread',turnId:'turn',role:'system',kind:'approval',status:'allowed',approvalId:'approval',toolName:'request_host_shell',summary:'已允许本次操作',createdAt:'2026-11-13T00:00:00Z',taskInputId:'input',sourceRequestId:'approval'})).toBeNull()
    expect(chatBlockFromItem({id:'user',threadId:'task-thread',turnId:'turn',role:'user',kind:'user_message',status:'completed',text:'请保留这条正常输入',createdAt:'2026-11-13T00:00:00Z'})).toMatchObject({kind:'user',text:'请保留这条正常输入'})
  })

  it('does not emit duplicate approval cards from generic item events', async () => {
    let called = false
    const sink: ThreadEventSink = {
      ...makeSink(),
      onApproval: () => {
        called = true
      }
    }
    await dispatchRuntimeEvent(
      {
        kind: 'item_created',
        seq: 9,
        item: {
          id: 'item_approval_dup',
          turnId: 'turn_1',
          threadId: 'thr_1',
          role: 'tool',
          status: 'pending',
          createdAt: '2024-01-01T00:00:00.000Z',
          kind: 'approval',
          approvalId: 'appr_1',
          toolName: 'shell',
          summary: 'Approval required'
        }
      },
      sink,
      async () => undefined
    )
    expect(called).toBe(false)
  })
})

describe('tool block merging', () => {
  it('coalesces tool_call and tool_result items for the same call id into one block', () => {
    const blocks = mergeChatBlocks([
      chatBlockFromItem({
        id: 'item_call',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'tool',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00.000Z',
        kind: 'tool_call',
        toolName: 'echo',
        callId: 'call_1',
        arguments: { text: 'hi' }
      })!,
      chatBlockFromItem({
        id: 'item_result',
        turnId: 'turn_1',
        threadId: 'thr_1',
        role: 'tool',
        status: 'completed',
        createdAt: '2024-01-01T00:00:01.000Z',
        kind: 'tool_result',
        toolName: 'echo',
        callId: 'call_1',
        output: { echoed: 'hi' }
      })!
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      kind: 'tool',
      id: 'tool_call_1',
      status: 'success'
    })
  })
})

describe('streaming runtime status events', () => {
  it('surfaces tool-call ready events as running tool cards', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onTool: (event) => {
        captured = event
      }
    }

    await dispatchRuntimeEvent(
      {
        kind: 'tool_call_ready',
        seq: 20,
        itemId: 'item_tool_turn_1_call_read',
        callId: 'call_read',
        toolName: 'read',
        readyCount: 2
      },
      sink,
      async () => undefined
    )

    expect(captured).toMatchObject({
      itemId: 'tool_call_read',
      summary: 'read',
      status: 'running',
      toolKind: 'tool_call',
      meta: {
        sourceItemId: 'item_tool_turn_1_call_read',
        callId: 'call_read',
        toolName: 'read',
        readyCount: 2,
        runtimeStatus: 'tool_call_ready'
      }
    })
  })

  it('surfaces tool-result upload waits as runtime status events', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onRuntimeStatus: (event) => {
        captured = event
      }
    }

    await dispatchRuntimeEvent(
      {
        kind: 'tool_result_upload_wait',
        seq: 21,
        timestamp: '2026-06-03T10:00:00.000Z',
        threadId: 'thr_1',
        turnId: 'turn_1',
        status: 'waiting',
        toolResultCount: 3
      },
      sink,
      async () => undefined
    )

    expect(captured).toMatchObject({
      kind: 'tool_result_upload_wait',
      itemId: 'runtime_status_turn_1_tool_upload_wait',
      turnId: 'turn_1',
      createdAt: '2026-06-03T10:00:00.000Z',
      toolResultCount: 3
    })
  })

	  it('surfaces tool catalog drift as a runtime status event', async () => {
	    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onRuntimeStatus: (event) => {
        captured = event
      }
    }

    await dispatchRuntimeEvent(
      {
        kind: 'tool_catalog_changed',
        seq: 22,
        timestamp: '2026-06-03T10:00:01.000Z',
        threadId: 'thr_1',
        turnId: 'turn_1',
        fingerprint: 'fp_next',
        toolCount: 12,
        message: 'Tool catalog changed'
      },
      sink,
      async () => undefined
    )

	    expect(captured).toMatchObject({
	      kind: 'tool_catalog_changed',
	      itemId: 'runtime_status_tool_catalog_fp_next',
	      turnId: 'turn_1',
	      createdAt: '2026-06-03T10:00:01.000Z',
	      message: 'Tool catalog changed'
	    })
	  })

	  it('surfaces storm suppression as a runtime status event', async () => {
	    let captured: unknown = null
	    const sink: ThreadEventSink = {
	      ...makeSink(),
	      onRuntimeStatus: (event) => {
	        captured = event
	      }
	    }

	    await dispatchRuntimeEvent(
	      {
	        kind: 'tool_storm_suppressed',
	        seq: 23,
	        timestamp: '2026-06-03T10:00:02.000Z',
	        threadId: 'thr_1',
	        turnId: 'turn_1',
	        itemId: 'item_call_read_storm',
	        callId: 'call_read',
	        toolName: 'read',
	        message: 'read repeated the same arguments'
	      },
	      sink,
	      async () => undefined
	    )

	    expect(captured).toMatchObject({
	      kind: 'tool_storm_suppressed',
	      itemId: 'item_call_read_storm',
	      turnId: 'turn_1',
	      createdAt: '2026-06-03T10:00:02.000Z',
	      callId: 'call_read',
	      toolName: 'read',
	      message: 'read repeated the same arguments'
	    })
	  })
	})

describe('WorkWise Runtime extension metadata mapping', () => {
  it('maps turn disclosure metadata onto user messages', () => {
    const block = chatBlockFromItem({
      id: 'item_user_meta',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'user',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'user_message',
      text: 'look at this',
      displayText: 'Inspect attached image',
      attachmentIds: ['att_1'],
      activeSkillIds: ['skill_review'],
      injectedMemoryIds: ['mem_1'],
      skillInjectionBytes: 128
    })
    expect(block).toMatchObject({
      kind: 'user',
      meta: {
        displayText: 'Inspect attached image',
        attachmentIds: ['att_1'],
        activeSkillIds: ['skill_review'],
        injectedMemoryIds: ['mem_1'],
        skillInjectionBytes: 128
      }
    })
  })

  it('maps a validated Design canvas command without exposing it as assistant text', () => {
    const block = chatBlockFromItem({
      id: 'item_design_command',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'design_apply_canvas_commands',
      toolKind: 'tool_call',
      callId: 'call_design',
      output: {
        ok: true,
        designCanvasCommand: {
          schema: 'workwise.design.command',
          version: 1,
          idempotencyKey: 'turn-1-command-1',
          workspaceRoot: '/tmp/workwise-design',
          documentId: 'design_1',
          pageId: 'page_1',
          expectedRevision: 3,
          operations: [
            {
              kind: 'add',
              element: {
                id: 'el_agent_1',
                type: 'rect',
                x: 20,
                y: 20,
                w: 100,
                h: 80,
                rotation: 0,
                zIndex: 0
              }
            }
          ]
        }
      }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      meta: {
        designCanvasCommand: {
          schema: 'workwise.design.command',
          idempotencyKey: 'turn-1-command-1',
          expectedRevision: 3
        }
      }
    })
  })

  it('surfaces web citations and child metadata through tool events', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onTool: (event) => {
        captured = event
      }
    }
    await dispatchRuntimeEvent(
      {
        kind: 'item_completed',
        seq: 12,
        child: {
          parentThreadId: 'thr_1',
          parentTurnId: 'turn_1',
          childId: 'child_research',
          childLabel: 'research',
          childStatus: 'completed',
          childSeq: 2
        },
        item: {
          id: 'item_web',
          turnId: 'turn_1',
          threadId: 'thr_1',
          role: 'tool',
          status: 'completed',
          createdAt: '2024-01-01T00:00:00.000Z',
          kind: 'tool_result',
          toolName: 'web_search',
          callId: 'call_web',
          output: {
            query: 'kun mcp',
            sources: [
              {
                sourceId: 'src_1',
                title: 'Docs',
                url: 'https://example.com/docs',
                retrievedAt: '2024-01-01T00:00:00.000Z'
              }
            ]
          }
        }
      },
      sink,
      async () => undefined
    )
    expect(captured).toMatchObject({
      meta: {
        child: { childId: 'child_research', childLabel: 'research' },
        sources: [{ title: 'Docs', url: 'https://example.com/docs' }]
      }
    })
  })
})

describe('usage event mapping', () => {
  it('does not infer cache hit rate from cachedTokens-only usage events', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onUsage: (usage) => {
        captured = usage
      }
    }

    await dispatchRuntimeEvent(
      {
        kind: 'usage',
        seq: 12,
        usage: {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cachedTokens: 42,
          turns: 1
        }
      },
      sink,
      async () => undefined
    )

    expect(captured).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      cachedTokens: 0,
      cacheMissTokens: 0,
      cacheHitRate: null,
      turns: 1
    })
  })

  it('derives cache hit rate only from explicit hit and miss usage counters', async () => {
    let captured: unknown = null
    const sink: ThreadEventSink = {
      ...makeSink(),
      onUsage: (usage) => {
        captured = usage
      }
    }

    await dispatchRuntimeEvent(
      {
        kind: 'usage',
        seq: 13,
        usage: {
          promptTokens: 100,
          completionTokens: 5,
          totalTokens: 105,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          tokenEconomySavingsTokens: 4096,
          tokenEconomySavingsUsd: 0.0018,
          tokenEconomySavingsCny: 0.0126,
          turns: 1
        }
      },
      sink,
      async () => undefined
    )

    expect(captured).toMatchObject({
      inputTokens: 100,
      outputTokens: 5,
      totalTokens: 105,
      cachedTokens: 80,
      cacheMissTokens: 20,
      cacheHitRate: 0.8,
      tokenEconomySavingsTokens: 4096,
      tokenEconomySavingsUsd: 0.0018,
      tokenEconomySavingsCny: 0.0126,
      turns: 1
    })
  })
})

describe('tool presentation inference', () => {
  it('prefers explicit toolKind from WorkWise Runtime over local heuristics', () => {
    const block = chatBlockFromItem({
      id: 'item_explicit_kind',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'custom_tool',
      toolKind: 'command_execution',
      callId: 'call_explicit',
      output: { path: '/tmp/should-not-force-file-kind', command: 'echo hi' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'echo hi' }
    })
  })

  it('uses the explicit command_execution kind and preserves the command string', () => {
    const block = chatBlockFromItem({
      id: 'item_shell',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_call',
      toolName: 'shell',
      toolKind: 'command_execution',
      callId: 'call_shell',
      arguments: { command: 'npm test' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'npm test', toolName: 'shell' }
    })
  })

  it('surfaces bash session metadata on command blocks', () => {
    const block = chatBlockFromItem({
      id: 'item_bash_session',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'bash',
      toolKind: 'command_execution',
      callId: 'call_bash',
      output: {
        command: 'npm run dev',
        session_id: 'bash_abc123',
        status: 'running',
        pid: 1234,
        shell: 'bash',
        cwd: '/tmp/app'
      }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: {
        command: 'npm run dev',
        session_id: 'bash_abc123',
        status: 'running',
        pid: 1234,
        shell: 'bash',
        cwd: '/tmp/app'
      }
    })
  })

  it('uses the explicit file_change kind and surfaces the path', () => {
    const block = chatBlockFromItem({
      id: 'item_file',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write_file',
      toolKind: 'file_change',
      callId: 'call_file',
      output: { path: '/tmp/demo.ts', bytes_written: 12 }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'file_change',
      filePath: '/tmp/demo.ts'
    })
  })

  it('classifies built-in write/edit tools as file_change by name when toolKind is omitted', () => {
    const block = chatBlockFromItem({
      id: 'item_write_builtin',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write',
      callId: 'call_write',
      output: { path: '/tmp/demo.ts', bytes_written: 12 }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'file_change',
      filePath: '/tmp/demo.ts'
    })
  })

  it('surfaces a successfully written document as a deliverable file', () => {
    const block = chatBlockFromItem({
      id: 'item_write_document',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write',
      callId: 'call_write_document',
      output: {
        path: '/tmp/宁波睿威产品介绍文档.md',
        relative_path: '宁波睿威产品介绍文档.md',
        bytes_written: 28_000
      }
    })

    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'file_change',
      meta: {
        generatedFiles: [
          {
            name: '宁波睿威产品介绍文档.md',
            relativePath: '宁波睿威产品介绍文档.md',
            absolutePath: '/tmp/宁波睿威产品介绍文档.md',
            byteSize: 28_000
          }
        ]
      }
    })
  })

  it('does not present ordinary source-code edits as downloadable deliverables', () => {
    const block = chatBlockFromItem({
      id: 'item_write_source',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'write',
      callId: 'call_write_source',
      output: { path: '/tmp/app.ts', relative_path: 'app.ts', bytes_written: 120 }
    })

    expect(block).toMatchObject({ kind: 'tool', toolKind: 'file_change' })
    if (block?.kind === 'tool') expect(block.meta?.generatedFiles).toBeUndefined()
  })

  it('classifies built-in bash by name as command_execution when toolKind is omitted', () => {
    const block = chatBlockFromItem({
      id: 'item_bash_builtin',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'bash',
      callId: 'call_bash',
      output: { command: 'pwd', output: '/tmp' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'pwd', toolName: 'bash' }
    })
  })

  it('falls back to payload shape when legacy items omit toolKind', () => {
    const block = chatBlockFromItem({
      id: 'item_legacy',
      turnId: 'turn_1',
      threadId: 'thr_1',
      role: 'tool',
      status: 'completed',
      createdAt: '2024-01-01T00:00:00.000Z',
      kind: 'tool_result',
      toolName: 'future_tool',
      callId: 'call_legacy',
      output: { command: 'npm test', path: '/tmp/demo.ts' }
    })
    expect(block).toMatchObject({
      kind: 'tool',
      toolKind: 'command_execution',
      meta: { command: 'npm test' }
    })
  })
})
