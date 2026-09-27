import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { TaskController } from './task-controller.js'
import { TaskRunRepository } from './task-run-repository.js'
import { RuntimeSpanService } from './runtime-span-service.js'
import { makeAssistantTextItem, makeToolResultItem } from '../domain/item.js'

const cleanup: string[] = []
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(prompt = '完成可靠性测试。') {
  const root = await mkdtemp(join(tmpdir(), 'workwise-task-controller-'))
  cleanup.push(root)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({
    id: 'thread_reliability',
    title: 'reliability',
    workspace: root,
    model: 'fixture'
  })
  await threadStore.upsert(thread)
  let now = '2026-07-18T00:00:00.000Z'
  const spans = new RuntimeSpanService(repository, () => now)
  const controller = new TaskController({
    repository,
    threadStore,
    sessionStore,
    nowIso: () => now,
    ownerId: 'test-runtime',
    spans
  })
  const task = controller.ensureTask({
    thread,
    turnId: 'turn_reliability',
    request: { prompt }
  })
  return {
    root,
    thread,
    threadStore,
    repository,
    sessionStore,
    spans,
    controller,
    task,
    setNow(value: string) { now = value }
  }
}

describe('TaskController reliability boundaries', () => {
  it('captures the selected Agent model and bounded budget in a new task', async () => {
    const { repository, controller, thread, threadStore } = await fixture()
    const selectedThread = {
      ...thread,
      id: 'thread_agent_policy',
      agentId: 'review',
      agentProfile: {
        id: 'review', name: 'Review', role: '审查', color: '#f59e0b',
        systemPrompt: '只读审查。', model: 'review-model',
        toolAllowlist: ['read'], mcpAllowlist: [], trustLevel: 'read-only' as const,
        budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostUsd: 2 }, revision: 1
      },
      costBudgetUsd: 1
    }
    await threadStore.upsert(selectedThread)
    const task = controller.ensureTask({
      thread: selectedThread,
      turnId: 'turn_agent_policy',
      request: { prompt: '审查当前实现。' }
    })
    expect(task).toMatchObject({
      agentId: 'review',
      model: 'review-model',
      budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostUsd: 1 }
    })
    repository.close()
  })

  it('starts a fresh answer task when failure feedback follows an unfinished file task', async () => {
    const { repository, controller, task, thread } = await fixture(
      '请创建并交付 workwise-download-test.txt 文件。'
    )
    repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'stalled',
      stalledReason: '文件交付失败。',
      updatedAt: '2026-07-18T00:01:00.000Z'
    }))

    const feedbackTask = controller.ensureTask({
      thread,
      turnId: 'turn_download_feedback',
      request: { prompt: 'TXT 无法下载' }
    })

    expect(feedbackTask.id).not.toBe(task.id)
    expect(feedbackTask).toMatchObject({
      activeTurnId: 'turn_download_feedback',
      goal: 'TXT 无法下载',
      status: 'queued',
      acceptance: { kind: 'answer', requiredNodeKinds: ['deliver'] }
    })
    expect(repository.get(task.id)).toMatchObject({
      status: 'cancelled',
      stalledReason: '用户发起了新的请求，旧任务已停止。'
    })
    repository.close()
  })

  it('keeps an unfinished file task when the user explicitly asks to continue', async () => {
    const { repository, controller, task, thread } = await fixture(
      '请创建并交付 workwise-download-test.txt 文件。'
    )
    const stalled = repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'stalled',
      stalledReason: '等待继续。',
      updatedAt: '2026-07-18T00:01:00.000Z'
    }))

    const resumed = controller.ensureTask({
      thread,
      turnId: 'turn_continue',
      request: { prompt: '同意，继续推进。' }
    })

    expect(resumed.id).toBe(task.id)
    expect(resumed).toMatchObject({
      activeTurnId: 'turn_continue',
      acceptance: stalled.acceptance,
      status: 'stalled'
    })
    expect(repository.list({ threadId: thread.id })).toHaveLength(1)
    repository.close()
  })

  it('replans repeated no-progress attempts and stalls with a recoverable checkpoint', async () => {
    const { repository, controller, task } = await fixture()
    let lastKind = ''
    for (let attempt = 0; attempt < 7; attempt += 1) {
      controller.beginAttempt(task.threadId, 'turn_reliability')
      lastKind = controller.recordAttemptFailure(
        task.threadId,
        'turn_reliability',
        'network_unavailable',
        'network unavailable'
      )?.kind ?? ''
    }

    const stored = repository.get(task.id)
    expect(lastKind).toBe('stalled')
    expect(stored).toMatchObject({ status: 'stalled', replans: 2, attempts: 7 })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_replanned')).toHaveLength(1)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_stalled')).toHaveLength(1)
    expect(repository.latestCheckpoint(task.id)?.resumeSummary).toBe('network unavailable')
    repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it.each([undefined, 'Historical stalled reason'])('clears obsolete reasons after resumed completion while preserving failure history (legacy reason: %s)', async legacyReason => {
    const { repository, controller, sessionStore, task } = await fixture('What is 2 + 3?')
    try {
      for (let attempt = 0; attempt < 7; attempt += 1) {
        controller.beginAttempt(task.threadId, 'turn_reliability')
        controller.recordAttemptFailure(task.threadId, 'turn_reliability', 'network_unavailable', 'network unavailable')
      }
      const stalled = repository.get(task.id)!
      expect(stalled.status).toBe('stalled')
      const resumed = controller.prepareResume(task.id, stalled.revision)
      expect(resumed.waitingReason).toBeTruthy()
      controller.beginAttempt(task.threadId, 'turn_reliability')
      if (legacyReason) {
        const running = repository.get(task.id)!
        repository.update(task.id, running.revision, current => ({ ...current, stalledReason: legacyReason }))
      }
      await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
        id: 'item_resumed_answer', threadId: task.threadId, turnId: 'turn_reliability', text: '2 + 3 = 5.', status: 'completed'
      }))
      const history = repository.events(task.id)
      const decision = await controller.assessCandidate(task.threadId, 'turn_reliability')
      expect(decision).toMatchObject({ kind: 'completed', task: { status: 'completed' } })
      const completed = repository.get(task.id)!
      expect(completed.waitingReason).toBeUndefined()
      expect(completed.stalledReason).toBeUndefined()
      expect(repository.events(task.id).slice(0, history.length)).toEqual(history)
      expect(repository.events(task.id).filter(event => event.kind === 'task_stalled')).toHaveLength(1)
      expect(repository.events(task.id).filter(event => event.kind === 'task_completed')).toHaveLength(1)
    } finally {
      repository.close()
    }
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('fails at a hard attempt budget without ever writing a completion event', async () => {
    const { repository, controller, task } = await fixture()
    let decision
    for (let attempt = 0; attempt < 8; attempt += 1) {
      controller.beginAttempt(task.threadId, 'turn_reliability')
      decision = controller.recordAttemptFailure(
        task.threadId,
        'turn_reliability',
        `fixture_${attempt}`,
        `different failure ${attempt}`
      )
    }

    expect(decision?.kind).toBe('failed')
    expect(repository.get(task.id)?.status).toBe('failed')
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_failed')).toHaveLength(1)
    repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('fails a depleted web search immediately instead of silently retrying it', async () => {
    const { repository, controller, task } = await fixture('今天 AI 圈有哪些资讯？')
    controller.beginAttempt(task.threadId, 'turn_reliability')

    const decision = controller.recordAttemptFailure(
      task.threadId,
      'turn_reliability',
      'web_access_exhausted',
      '在线搜索连续失败，无法核实当前资讯。'
    )

    expect(decision).toMatchObject({ kind: 'failed', task: { status: 'failed', attempts: 1 } })
    expect(repository.events(task.id).filter((event) => event.kind === 'attempt_retrying')).toHaveLength(0)
    repository.close()
  })

  it('does not complete a task from an assistant reply that explicitly reports unverified web failure', async () => {
    const { repository, sessionStore, controller, task } = await fixture('今天宁波的天气怎么样？')
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_web_failure',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '实时网页获取失败，所以目前无法核实宁波今天的准确天气信息。请稍后重试。',
      status: 'completed'
    }))
    controller.beginAttempt(task.threadId, 'turn_reliability')

    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({
      kind: 'failed',
      task: { status: 'failed' },
      reason: expect.stringContaining('web_access_exhausted')
    })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    repository.close()
  })

  it('enforces the duration budget and recovers an expired running lease after restart', async () => {
    const { repository, controller, task, setNow } = await fixture()
    const constrained = repository.update(task.id, task.revision, (current) => ({
      ...current,
      budget: { ...current.budget, maxDurationMs: 1 },
      revision: current.revision
    }))
    controller.beginAttempt(constrained.threadId, 'turn_reliability')
    setNow('2026-07-18T00:00:01.000Z')
    const exhausted = controller.recordAttemptFailure(
      constrained.threadId,
      'turn_reliability',
      'temporary',
      'temporary failure'
    )
    expect(exhausted?.task.nodes[0]?.errorCode).toBe('duration_budget_exhausted')

    repository.close()

    const recovery = await fixture()
    recovery.controller.beginAttempt(recovery.task.threadId, 'turn_reliability')
    recovery.setNow('2026-07-18T00:02:00.000Z')
    const recovered = recovery.controller.reconcileStartup()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ status: 'retrying' })
    expect(recovery.repository.latestCheckpoint(recovery.task.id)?.resumeSummary).toContain('自动续跑')
    recovery.repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('records task, turn, and artifact validation spans without storing the absolute artifact path', async () => {
    const { root, repository, sessionStore, spans, controller, task } = await fixture(
      '请生成并交付 result.md Markdown 文件。'
    )
    await writeFile(join(root, 'result.md'), '# Verified deliverable\n', 'utf8')
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_tool_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_write',
      toolName: 'write',
      output: { path: join(root, 'result.md') }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'Markdown 文档已生成并交付。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({ kind: 'completed' })

    const diagnostics = spans.diagnostics(task.id)
    expect(diagnostics.spans.map((span) => span.kind)).toEqual(
      expect.arrayContaining(['task', 'turn', 'validation'])
    )
    expect(diagnostics.spans.every((span) => !JSON.stringify(span).includes(root))).toBe(true)
    expect(diagnostics.spans.find((span) => span.kind === 'validation')).toMatchObject({
      status: 'ok',
      attributes: { format: 'md', valid: true }
    })
    repository.close()
  })

  it('validates a workspace artifact whose absolute path is printed by a successful shell tool', async () => {
    const { root, repository, sessionStore, controller, task } = await fixture(
      '请创建并交付 result.txt 文件。'
    )
    const artifactPath = join(root, 'result.txt')
    await writeFile(artifactPath, 'verified shell deliverable', 'utf8')
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_shell_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_shell',
      toolName: 'bash',
      toolKind: 'command_execution',
      output: {
        command: "printf 'verified shell deliverable' > result.txt",
        cwd: root,
        exit_code: 0,
        output: `verified shell deliverable\n${artifactPath}\n`,
        full_output_path: join(root, 'runtime', 'shell-output', 'bash_call.log')
      }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_shell_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'TXT 文件已创建并验证。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'completed',
        task: {
          status: 'completed',
          artifacts: [{ relativePath: 'result.txt', validation: 'valid' }]
        }
      })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(1)
    repository.close()
  })

  it('validates a recent relative artifact claimed after a successful shell tool', async () => {
    const { root, repository, sessionStore, controller, task } = await fixture(
      '请创建并交付 result.txt 文件。'
    )
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    await writeFile(join(root, 'result.txt'), 'verified relative shell deliverable', 'utf8')
    const finishedAt = new Date(Date.now() + 1_000).toISOString()
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_relative_shell_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_relative_shell',
      toolName: 'bash',
      toolKind: 'command_execution',
      output: {
        command: "printf 'verified relative shell deliverable' > result.txt",
        cwd: root,
        exit_code: 0,
        started_at: startedAt,
        finished_at: finishedAt,
        output: 'bytes: 35\nMATCH\n35\n',
        full_output_path: join(root, 'runtime', 'shell-output', 'bash_call.log')
      }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_relative_shell_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'TXT 文件 result.txt 已创建并验证。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'completed',
        task: {
          status: 'completed',
          artifacts: [{ relativePath: 'result.txt', validation: 'valid' }]
        }
      })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(1)
    repository.close()
  })

  it('waits for provider configuration instead of retrying a blocked file task', async () => {
    const { repository, sessionStore, controller, task } = await fixture(
      '请使用 Document Illustrator 生成并插入一张章节头图文件。'
    )
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_provider_blocked',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '图片生成能力未配置，无法继续。请到设置 → 图片生成配置提供商、模型和凭据后重试。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'waiting_user',
        task: {
          status: 'waiting_user',
          attempts: 1,
          waitingReason: expect.stringContaining('配置可用的图片生成提供商')
        }
      })

    expect(repository.events(task.id).filter((event) => event.kind === 'attempt_retrying')).toHaveLength(0)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_waiting_user')).toHaveLength(1)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    expect(repository.latestCheckpoint(task.id)?.resumeSummary).toContain('配置可用的图片生成提供商')
    repository.close()
  })
})
