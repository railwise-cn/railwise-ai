import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type WorkWiseSettingsV2
} from '@shared/app-settings'
import { WorkWiseRuntimeProvider } from './managed-runtime'
import { getProvider, resetProviderCacheForTests } from './registry'
import { rendererRuntimeClient } from './runtime-client'
import type { ThreadEventSink } from './types'

function settings(): WorkWiseSettingsV2 {
  return {
    schema: 'workwise.settings',
    version: 2,
    revision: 0,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: defaultManagedRuntimeSettings()
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
    conversation: { viewMode: 'concise' },
    documents: { parsingMode: 'auto', unlimitedOcrServerUrl: '', privateMineruServerUrl: '', allowPrivateServerUploadByWorkspace: {} },
    codePromptPrefix: ''
  }
}

function installDsGui(overrides: Partial<Window['workwise']>): void {
  vi.stubGlobal('window', {
    workwise: {
      getSettings: vi.fn(async () => settings()),
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })),
      startSse: vi.fn(async (_threadId: string, _sinceSeq: number, streamId?: string) => ({
        streamId: streamId ?? 'stream-1'
      })),
      stopSse: vi.fn(async () => true),
      onSseEvent: vi.fn(() => () => undefined),
      onSseEnd: vi.fn(() => () => undefined),
      onSseError: vi.fn(() => () => undefined),
      ...overrides
    }
  })
}

afterEach(() => {
  rendererRuntimeClient.invalidateSettings()
  vi.unstubAllGlobals()
})

describe('WorkWiseRuntimeProvider', () => {
  it('reports the compatibility id and WorkWise display name', () => {
    const provider = new WorkWiseRuntimeProvider()
    expect(provider.id).toBe('kun')
    expect(provider.displayName).toBe('WorkWise Agent Runtime')
  })

  it('exposes the local HTTP/SSE capabilities', () => {
    const provider = new WorkWiseRuntimeProvider()
    const caps = provider.getCapabilities()
    expect(caps.stream).toBe(true)
    expect(caps.interrupt).toBe(true)
    expect(caps.approvals).toBe(true)
  })

  it('reports invalid runtime JSON responses with a stable error message', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: '{not-json'
      }))
    })
    const provider = new WorkWiseRuntimeProvider()

    await expect(provider.listThreads()).rejects.toThrow(
      'runtime returned an invalid thread list response'
    )
  })

  it('maps WorkWise Runtime thread items into chat blocks', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_1',
          title: 'Demo',
          workspace: '/tmp',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 9,
          turns: [
            {
              id: 'turn_1',
              threadId: 'thr_1',
              status: 'completed',
              prompt: 'hi',
              createdAt: 't0',
              items: [
                {
                  id: 'item_user',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'user',
                  status: 'completed',
                  createdAt: 't0',
                  kind: 'user_message',
                  text: 'hi'
                },
                {
                  id: 'item_answer',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'completed',
                  createdAt: 't1',
                  kind: 'assistant_text',
                  text: 'hello'
                }
              ]
            }
          ]
        })
      }))
    })
    const provider = new WorkWiseRuntimeProvider()
    const detail = await provider.getThreadDetail('thr_1')
    expect(detail.blocks.map((block) => block.kind)).toEqual(['user', 'assistant'])
    expect(detail.latestSeq).toBe(9)
    expect(detail.latestTurnId).toBe('turn_1')
    expect(detail.latestTurnStatus).toBe('completed')
    expect(detail.latestTurnError).toBeUndefined()
    expect(detail.latestUserMessageId).toBe('item_user')
  })

  it('preserves the latest terminal turn error for background completion polling', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_failed',
          title: 'Failed background turn',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 3,
          turns: [{
            id: 'turn_failed',
            threadId: 'thr_failed',
            status: 'failed',
            prompt: 'finish in background',
            createdAt: 't0',
            finishedAt: 't1',
            error: 'max tokens reached',
            items: []
          }]
        })
      }))
    })
    const provider = new WorkWiseRuntimeProvider()

    await expect(provider.getThreadDetail('thr_failed')).resolves.toMatchObject({
      latestTurnId: 'turn_failed',
      latestTurnStatus: 'failed',
      latestTurnError: 'max tokens reached'
    })
  })

  it('coalesces tool_call and tool_result pairs into one tool block on thread load', async () => {
    installDsGui({
      runtimeRequest: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_1',
          title: 'Demo',
          workspace: '/tmp',
          model: 'deepseek-chat',
          mode: 'agent',
          status: 'idle',
          createdAt: 't0',
          updatedAt: 't1',
          latestSeq: 9,
          turns: [
            {
              id: 'turn_1',
              threadId: 'thr_1',
              status: 'completed',
              prompt: 'run echo',
              createdAt: 't0',
              items: [
                {
                  id: 'item_call',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'tool',
                  status: 'pending',
                  createdAt: 't0',
                  kind: 'tool_call',
                  toolName: 'echo',
                  callId: 'call_1',
                  arguments: { text: 'hi' }
                },
                {
                  id: 'item_result',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'tool',
                  status: 'completed',
                  createdAt: 't1',
                  kind: 'tool_result',
                  toolName: 'echo',
                  callId: 'call_1',
                  output: { echoed: 'hi' }
                }
              ]
            }
          ]
        })
      }))
    })
    const provider = new WorkWiseRuntimeProvider()
    const detail = await provider.getThreadDetail('thr_1')
    expect(detail.blocks).toHaveLength(1)
    expect(detail.blocks[0]).toMatchObject({
      kind: 'tool',
      id: 'tool_call_1',
      status: 'success'
    })
  })

  it('posts WorkWise Runtime turn requests and returns the deterministic user item id', async () => {
    const runtimeRequest = vi.fn(async (_path: string, _method?: string, _body?: string) => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_abc', userMessageItemId: 'item_user_real' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()
    const result = await provider.sendUserMessage('thr_1', 'hello')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'hello',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access'
      })
    )
    expect(result.userMessageItemId).toBe('item_user_real')
  })

  it('posts attachment ids with WorkWise Runtime turn requests when provided', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_img', userMessageItemId: 'item_user_img' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'describe this', { attachmentIds: ['att_1'] })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'describe this',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        attachmentIds: ['att_1']
      })
    )
  })

  it('posts path-only workspace references without inlining file content', async () => {
    const runtimeRequest = vi.fn(async (_path: string, _method?: string, _body?: string) => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_ref', userMessageItemId: 'item_user_ref' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'review this', {
      workspaceReferences: [{ path: 'docs/投标.md', kind: 'file' }]
    })

    const requestBody = JSON.parse(runtimeRequest.mock.calls[0]?.[2] as string) as Record<string, unknown>
    expect(requestBody).toMatchObject({
      prompt: 'review this',
      workspaceReferences: [{ path: 'docs/投标.md', kind: 'file' }]
    })
    expect(JSON.stringify(requestBody)).not.toContain('<workspace_file')
  })

  it('posts explicit reasoning effort with WorkWise Runtime turn requests', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_reason', userMessageItemId: 'item_user_reason' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'think harder', {
      model: 'auto',
      providerId: 'provider-b',
      reasoningEffort: 'max'
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'think harder',
        model: 'auto',
        providerId: 'provider-b',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        reasoningEffort: 'max'
      })
    )
  })

  it('posts the selected provider alongside a same-named model for reviews', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true, status: 202,
      body: JSON.stringify({ threadId: 'thr_review', turnId: 'turn_review', userMessageItemId: 'item_review_user', reviewItemId: 'item_review' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()
    const target = { kind: 'custom' as const, instructions: 'Review this synthetic input.' }
    await provider.reviewThread('thr_review', target, { model: 'shared-model', providerId: 'compatible-b' })
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/threads/thr_review/review', 'POST', JSON.stringify({ target, model: 'shared-model', providerId: 'compatible-b' }))
  })

  it('posts GUI plan context with WorkWise Runtime plan turn requests', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_plan', userMessageItemId: 'item_user_plan' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'refine the plan', {
      mode: 'plan',
      displayText: 'Generate implementation plan',
      guiPlan: {
        operation: 'refine',
        workspaceRoot: '/workspace/workwise',
        relativePath: '.workwise/plans/auth.md',
        planId: '/workspace/workwise:.workwise/plans/auth.md',
        sourceRequest: 'Add auth',
        title: 'auth'
      }
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'refine the plan',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        displayText: 'Generate implementation plan',
        mode: 'plan',
        guiPlan: {
          operation: 'refine',
          workspaceRoot: '/workspace/workwise',
          relativePath: '.workwise/plans/auth.md',
          planId: '/workspace/workwise:.workwise/plans/auth.md',
          sourceRequest: 'Add auth',
          title: 'auth'
        }
      })
    )
  })

  it('posts the exact GUI Design context with canvas assistant turns', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 202,
      body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_design', userMessageItemId: 'item_user_design' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.sendUserMessage('thr_1', 'internal canvas prompt', {
      displayText: '把标题改成绿色',
      guiDesign: {
        workspaceRoot: '/workspace/workwise',
        documentId: 'design_1',
        pageId: 'page_1',
        expectedRevision: 7
      }
    })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns',
      'POST',
      JSON.stringify({
        prompt: 'internal canvas prompt',
        approvalPolicy: 'auto',
        sandboxMode: 'danger-full-access',
        displayText: '把标题改成绿色',
        guiDesign: {
          workspaceRoot: '/workspace/workwise',
          documentId: 'design_1',
          pageId: 'page_1',
          expectedRevision: 7
        }
      })
    )
  })

  it('posts interrupt requests with the discard option when requested', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: '{}'
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await provider.interruptTurn('thr_1', 'turn_1', { discard: true })

    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/threads/thr_1/turns/turn_1/interrupt',
      'POST',
      JSON.stringify({ discard: true })
    )
  })

  it('loads runtime diagnostics and uploads image attachments through WorkWise Runtime endpoints', async () => {
    const runtimeRequest = vi.fn(async (path: string) => {
      if (path === '/v1/runtime/info') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            host: '127.0.0.1',
            port: 17878,
            dataDir: '/tmp/kun',
            startedAt: '2024-01-01T00:00:00.000Z',
            capabilities: {
              contractVersion: 1,
              model: {
                id: 'deepseek-chat',
                inputModalities: ['text', 'image'],
                outputModalities: ['text'],
                supportsToolCalling: true,
                messageParts: ['text', 'image_url']
              },
              cli: {
                serve: { status: 'available', enabled: true, available: true },
                run: { status: 'available', enabled: true, available: true },
                chat: { status: 'available', enabled: true, available: true },
                exec: { status: 'available', enabled: true, available: true }
              },
              mcp: { status: 'disabled', enabled: false, available: false, configuredServers: 0, connectedServers: 0, toolCount: 0 },
              web: {
                status: 'available',
                enabled: true,
                available: true,
                fetch: { status: 'available', enabled: true, available: true },
                search: { status: 'disabled', enabled: false, available: false }
              },
              skills: { status: 'disabled', enabled: false, available: false, configuredRoots: 0, discoveredSkills: 0 },
              subagents: { status: 'disabled', enabled: false, available: false, maxParallel: 0, maxChildRuns: 0 },
              attachments: {
                status: 'available',
                enabled: true,
                available: true,
                maxImageBytes: 5242880,
                maxImageDimension: 4096,
                allowedMimeTypes: ['image/png'],
                textFallbackMaxBase64Bytes: 524288,
                textFallbackMaxImageDimension: 1280,
                textFallbackPreferredMimeType: 'image/webp'
              },
              memory: { status: 'disabled', enabled: false, available: false, scopes: ['user'], maxInjectedRecords: 8 }
            }
          })
        }
      }
      if (path === '/v1/runtime/tools') {
        return { ok: true, status: 200, body: JSON.stringify({ providers: [{ id: 'web' }] }) }
      }
      if (path === '/v1/skills') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            skills: [{
              id: 'review',
              name: 'Review',
              description: 'Review changes'
            }]
          })
        }
      }
      if (path === '/v1/attachments') {
        return {
          ok: true,
          status: 201,
          body: JSON.stringify({
            attachment: {
              id: 'att_1',
              name: 'shot.png',
              mimeType: 'image/png',
              byteSize: 3,
              hash: 'hash',
              createdAt: 't0',
              updatedAt: 't0'
            }
          })
        }
      }
      if (path === '/v1/attachments/att_1/content?thread_id=thr_1') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            attachment: {
              id: 'att_1',
              name: 'shot.png',
              mimeType: 'image/png',
              byteSize: 3,
              hash: 'hash',
              createdAt: 't0',
              updatedAt: 't0'
            },
            dataBase64: 'abc'
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await expect(provider.getRuntimeInfo()).resolves.toMatchObject({
      capabilities: { attachments: { available: true } }
    })
    await expect(provider.getToolDiagnostics()).resolves.toMatchObject({
      providers: [{ id: 'web' }]
    })
    await expect(provider.listSkills()).resolves.toEqual([
      expect.objectContaining({
        id: 'review',
        name: 'Review',
        description: 'Review changes'
      })
    ])
    await expect(provider.uploadAttachment({
      name: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'abc',
      textFallback: {
        dataBase64: 'xyz',
        mimeType: 'image/webp',
        byteSize: 2,
        width: 1,
        height: 1,
        wasCompressed: true
      },
      threadId: 'thr_1'
    })).resolves.toMatchObject({ id: 'att_1', name: 'shot.png' })
    await expect(provider.getAttachmentContent('att_1', { threadId: 'thr_1' })).resolves.toMatchObject({
      attachment: { id: 'att_1', mimeType: 'image/png' },
      dataBase64: 'abc'
    })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/attachments',
      'POST',
      JSON.stringify({
        name: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'abc',
        textFallback: {
          dataBase64: 'xyz',
          mimeType: 'image/webp',
          byteSize: 2,
          width: 1,
          height: 1,
          wasCompressed: true
        },
        threadId: 'thr_1'
      })
    )
  })

  it('lists, disables, and deletes memory records through WorkWise Runtime endpoints', async () => {
    const runtimeRequest = vi.fn(async (path: string, method?: string, body?: string) => {
      if (path === '/v1/memory?workspace=%2Ftmp%2Fworkspace&include_deleted=false') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memories: [{
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              workspace: '/tmp/workspace',
              tags: ['tooling'],
              confidence: 0.9,
              createdAt: 't0',
              updatedAt: 't0'
            }]
          })
        }
      }
      if (path === '/v1/memory/mem_1' && method === 'PATCH') {
        expect(body).toBe(JSON.stringify({ disabled: true }))
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memory: {
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              disabledAt: 't1',
              createdAt: 't0',
              updatedAt: 't1'
            }
          })
        }
      }
      if (path === '/v1/memory/mem_1' && method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            memory: {
              id: 'mem_1',
              content: 'Use pnpm',
              scope: 'workspace',
              deletedAt: 't2',
              createdAt: 't0',
              updatedAt: 't2'
            }
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    await expect(provider.listMemories({ workspace: '/tmp/workspace', includeDeleted: false })).resolves.toHaveLength(1)
    await expect(provider.updateMemory('mem_1', { disabled: true })).resolves.toMatchObject({
      id: 'mem_1',
      disabledAt: 't1'
    })
    await expect(provider.deleteMemory('mem_1')).resolves.toMatchObject({
      id: 'mem_1',
      deletedAt: 't2'
    })
  })

  it('calls WorkWise Runtime fork and user-input compatibility endpoints', async () => {
    const runtimeRequest = vi.fn(async (path: string) => ({
      ok: true,
      status: 200,
      body: path.includes('/fork')
        ? JSON.stringify({
            id: 'thr_fork',
            title: 'Forked',
            workspace: '/tmp/workspace',
            model: 'deepseek-chat',
            mode: 'agent',
            status: 'idle',
            forkedFromThreadId: 'thr_parent',
            createdAt: 't0',
            updatedAt: 't1'
          })
        : '{}'
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    const forked = await provider.forkThread('thr_parent')
    await provider.submitUserInputResponse('input_1', [{ id: 'choice', label: 'Yes', value: 'yes' }])
    await provider.cancelUserInput('input_2')

    expect(forked).toMatchObject({ id: 'thr_fork', forkedFromThreadId: 'thr_parent' })
    expect(runtimeRequest).toHaveBeenCalledWith('/v1/threads/thr_parent/fork', 'POST')
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/user-inputs/input_1',
      'POST',
      JSON.stringify({ answers: [{ id: 'choice', label: 'Yes', value: 'yes' }] })
    )
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/user-inputs/input_2',
      'POST',
      JSON.stringify({ cancelled: true })
    )
  })

  it('resumes a session through the WorkWise Runtime HTTP runtime', async () => {
    const runtimeRequest = vi.fn(async () => ({
      ok: true,
      status: 201,
      body: JSON.stringify({ thread_id: 'thr_resumed', session_id: 'sess_1' })
    }))
    installDsGui({ runtimeRequest })
    const provider = new WorkWiseRuntimeProvider()

    const result = await provider.resumeSession('sess_1', { mode: 'plan' })

    expect(result).toEqual({ threadId: 'thr_resumed', sessionId: 'sess_1' })
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/sessions/sess_1/resume-thread',
      'POST',
      JSON.stringify({
        workspace: '/tmp/workspace',
        model: defaultManagedRuntimeSettings().model,
        mode: 'plan'
      })
    )
  })

  it('maps WorkWise Runtime SSE deltas into the thread event sink', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(() => ac.abort()),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn()
    }
    installDsGui({
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'assistant_text_delta',
                seq: 3,
                item: {
                  id: 'item_text',
                  turnId: 'turn_1',
                  threadId: 'thr_1',
                  role: 'assistant',
                  status: 'running',
                  createdAt: 't1',
                  kind: 'assistant_text',
                  text: 'he'
                }
              }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new WorkWiseRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 2, sink, ac.signal)
    expect(sink.onSeq).toHaveBeenCalledWith(3)
    expect(sink.onDeltas).toHaveBeenCalledWith([{ text: 'he', kind: 'agent_message', seq: 3 }])
  })

  it('dispatches SSE batches in sequence order when an earlier batch awaits', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    let releaseReplay!: () => void
    const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve })
    const ac = new AbortController()
    const usage: unknown[] = []
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onReplayReset: vi.fn(() => replayGate),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onUsage: vi.fn((snapshot) => usage.push(snapshot)),
      onTurnComplete: vi.fn(() => ac.abort()),
      onError: vi.fn()
    }
    installDsGui({
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [{ kind: 'replay_reset', seq: 1 }]
          })
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'usage',
                seq: 2,
                threadId: 'thr_1',
                turnId: 'turn_1',
                usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, turns: 1 }
              },
              { kind: 'turn_completed', seq: 3, threadId: 'thr_1', turnId: 'turn_1' }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new WorkWiseRuntimeProvider()
    const subscription = provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
    await vi.waitFor(() => expect(sink.onReplayReset).toHaveBeenCalledWith(1))
    expect(usage).toEqual([])
    releaseReplay()
    await subscription
    expect(usage).toHaveLength(1)
    expect(sink.onTurnComplete).toHaveBeenCalledOnce()
  })

  it('auto-approves approval requests when policy is auto', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(() => ac.abort()),
      onError: vi.fn()
    }
    const autoSettings: WorkWiseSettingsV2 = {
      ...settings(),
      agents: { kun: { ...defaultManagedRuntimeSettings(), approvalPolicy: 'auto' } }
    }
    installDsGui({
      getSettings: vi.fn(async () => autoSettings),
      runtimeRequest,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              { kind: 'approval_requested', seq: 4, approvalId: 'appr_auto', summary: 'Need approval' },
              { kind: 'turn_completed', seq: 5 }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new WorkWiseRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/approvals/appr_auto',
      'POST',
      JSON.stringify({ decision: 'allow' })
    )
    expect(sink.onApproval).not.toHaveBeenCalled()
  })

  it('uses the approval policy from runtime events before falling back to settings', async () => {
    let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    const getSettings = vi.fn(async (): Promise<WorkWiseSettingsV2> => ({
      ...settings(),
      agents: { kun: { ...defaultManagedRuntimeSettings(), approvalPolicy: 'on-request' } }
    }))
    const ac = new AbortController()
    const sink: ThreadEventSink = {
      onSeq: vi.fn(),
      onDeltas: vi.fn(),
      onUserMessage: vi.fn(),
      onTool: vi.fn(),
      onCompaction: vi.fn(),
      onApproval: vi.fn(),
      onUserInput: vi.fn(),
      onUserInputStatus: vi.fn(),
      onGoal: vi.fn(),
      onTodos: vi.fn(),
      onTurnComplete: vi.fn(() => ac.abort()),
      onError: vi.fn()
    }
    installDsGui({
      getSettings,
      runtimeRequest,
      onSseEvent: vi.fn((handler) => {
        onData = handler
        return () => undefined
      }),
      startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
        queueMicrotask(() => {
          onData?.({
            streamId: streamId ?? 'stream-1',
            events: [
              {
                kind: 'approval_requested',
                seq: 4,
                approvalId: 'appr_event_auto',
                approvalPolicy: 'auto',
                summary: 'Need approval'
              },
              { kind: 'turn_completed', seq: 5 }
            ]
          })
        })
        return { streamId: streamId ?? 'stream-1' }
      })
    })
    const provider = new WorkWiseRuntimeProvider()
    await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
    expect(runtimeRequest).toHaveBeenCalledWith(
      '/v1/approvals/appr_event_auto',
      'POST',
      JSON.stringify({ decision: 'allow' })
    )
    expect(getSettings).not.toHaveBeenCalled()
    expect(sink.onApproval).not.toHaveBeenCalled()
  })

  it('renders approval cards for suggest and untrusted policies', async () => {
    for (const policy of ['suggest', 'untrusted'] as const) {
      let onData: ((payload: { streamId: string; events: unknown[] }) => void) | null = null
      const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
      const ac = new AbortController()
      const sink: ThreadEventSink = {
        onSeq: vi.fn(),
        onDeltas: vi.fn(),
        onUserMessage: vi.fn(),
        onTool: vi.fn(),
        onCompaction: vi.fn(),
        onApproval: vi.fn(),
        onUserInput: vi.fn(),
        onUserInputStatus: vi.fn(),
        onGoal: vi.fn(),
        onTodos: vi.fn(),
        onTurnComplete: vi.fn(() => ac.abort()),
        onError: vi.fn()
      }
      const policySettings: WorkWiseSettingsV2 = {
        ...settings(),
        agents: { kun: { ...defaultManagedRuntimeSettings(), approvalPolicy: policy } }
      }
      installDsGui({
        getSettings: vi.fn(async () => policySettings),
        runtimeRequest,
        onSseEvent: vi.fn((handler) => {
          onData = handler
          return () => undefined
        }),
        startSse: vi.fn(async (_threadId, _sinceSeq, streamId) => {
          queueMicrotask(() => {
            onData?.({
              streamId: streamId ?? 'stream-1',
              events: [
                {
                  kind: 'approval_requested',
                  seq: 6,
                  approvalId: `appr_${policy}`,
                  summary: `${policy} approval`
                },
                { kind: 'turn_completed', seq: 7 }
              ]
            })
          })
          return { streamId: streamId ?? 'stream-1' }
        })
      })
      const provider = new WorkWiseRuntimeProvider()
      await provider.subscribeThreadEvents('thr_1', 0, sink, ac.signal)
      expect(sink.onApproval).toHaveBeenCalledWith({
        approvalId: `appr_${policy}`,
        summary: `${policy} approval`,
        toolName: undefined
      })
      expect(runtimeRequest).not.toHaveBeenCalledWith(
        `/v1/approvals/appr_${policy}`,
        'POST',
        expect.any(String)
      )
    }
  })
})

describe('registry', () => {
  it('returns a cached provider for the kun id', () => {
    resetProviderCacheForTests()
    const first = getProvider()
    const second = getProvider()
    expect(first).toBe(second)
  })

})
