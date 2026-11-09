import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contextBundleHash,
  SourceEventIdempotencyConflictError,
  TaskContextRepository,
  TaskContextRevisionConflictError
} from './task-context-repository.js'
import type { ContextBundle, HandoffPacket, TaskSourceRule, TaskSubscription } from '../contracts/task-context.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function repository(): Promise<TaskContextRepository> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-task-context-'))
  roots.push(root)
  return new TaskContextRepository(join(root, 'task-context.sqlite3'), { inlineLimitBytes: 8 })
}

function bundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  const value = {
    schemaVersion: 1 as const,
    id: 'bundle_1',
    taskId: 'task_1',
    workspaceRoot: '/tmp/project',
    documents: [{ path: 'report.md', revision: '3', workspaceRoot: '/tmp/project' }],
    objects: [],
    memoryIds: [],
    evidence: ['source:report.md'],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    revision: 0,
    ...overrides
  }
  return { ...value, contentHash: contextBundleHash(value) }
}

function handoff(overrides: Partial<HandoffPacket> = {}): HandoffPacket {
  return {
    schemaVersion: 1,
    id: 'handoff_1',
    fromTaskId: 'task_1',
    conclusion: 'Draft is ready for review.',
    evidence: ['source:report.md'],
    artifactIds: ['artifact_1'],
    completedOperationIds: ['operation_1'],
    remaining: ['confirm the date'],
    blockers: [],
    authority: { workspaceRoot: '/tmp/project', externalTargets: [] },
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    revision: 0,
    ...overrides
  }
}

function subscription(overrides: Partial<TaskSubscription> = {}): TaskSubscription {
  return {
    schemaVersion: 1,
    id: 'subscription_1',
    workerId: 'worker_1',
    source: 'pr',
    enabled: true,
    mode: 'record_only',
    allowedFields: ['subject', 'labels'],
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    revision: 0,
    ...overrides
  }
}

const rules: TaskSourceRule[] = [{
  id: 'rule_pr_review', enabled: true, sources: ['pr'], eventTypes: ['review_submitted'],
  subjectIncludes: ['railwise'], labelsAny: [], workspaceRoots: ['/tmp/project'], maxPayloadBytes: 1_000, mode: 'record_only'
}]

describe('TaskContextRepository', () => {
  it('round-trips inline and spilled context objects and protects object integrity', async () => {
    const store = await repository()
    const inline = store.putContextObject({ kind: 'note', data: 'short' })
    const spilled = store.putContextObject({ kind: 'document', data: 'a long context object' })
    expect(inline.storage).toBe('inline')
    expect(spilled.storage).toBe('spill')
    expect(store.readContextObject(inline).toString()).toBe('short')
    expect(store.readContextObject(spilled).toString()).toBe('a long context object')
    expect(() => store.readContextObject({ ...inline, sha256: '0'.repeat(64) })).toThrow(/identity|integrity/)
    store.close()
  })

  it('persists versioned bundles and handoffs with optimistic revisions', async () => {
    const store = await repository()
    const first = store.saveContextBundle(bundle())
    expect(first.revision).toBe(0)
    const second = store.saveContextBundle(bundle({ evidence: ['source:report.md', 'source:data.csv'], updatedAt: first.updatedAt }), first.revision)
    expect(second.revision).toBe(1)
    expect(() => store.saveContextBundle(bundle(), first.revision)).toThrow(TaskContextRevisionConflictError)
    expect(store.listContextBundles('task_1')).toHaveLength(1)
    const savedHandoff = store.saveHandoffPacket(handoff())
    expect(store.listHandoffPackets('task_1')[0]?.id).toBe(savedHandoff.id)
    store.close()
  })

  it('screens before persistence, deduplicates source events, and matches multiple subscriptions', async () => {
    const store = await repository()
    store.saveSubscription(subscription())
    store.saveSubscription(subscription({ id: 'subscription_2', workerId: 'worker_2', mode: 'route', filter: { ...rules[0], id: 'subscription_rule' } }))
    const input = { source: 'pr' as const, idempotencyKey: 'pr:42', externalEventId: '42', eventType: 'review_submitted', subject: 'RailWise review', labels: ['urgent'], workspaceRoot: '/tmp/project', payload: { body: 'please review' } }
    const first = store.ingestSourceEvent(input, rules)
    expect(first.created).toBe(true)
    expect(first.event.status).toBe('screened')
    expect(first.subscriptions.map(item => item.workerId).sort()).toEqual(['worker_1', 'worker_2'])
    const replay = store.ingestSourceEvent(input, rules)
    expect(replay.created).toBe(false)
    expect(replay.event.id).toBe(first.event.id)
    expect(() => store.ingestSourceEvent({ ...input, payload: { body: 'changed' } }, rules)).toThrow(SourceEventIdempotencyConflictError)
    const rejected = store.ingestSourceEvent({ ...input, idempotencyKey: 'pr:43', subject: 'unrelated' }, rules)
    expect(rejected.event.status).toBe('rejected')
    expect(rejected.subscriptions).toHaveLength(0)
    store.close()
  })

  it('marks a screened event consumed only after an explicit queue transition', async () => {
    const store = await repository()
    const result = store.ingestSourceEvent({ source: 'manual', idempotencyKey: 'manual:1', payload: {} }, [{ id: 'manual', enabled: true, sources: ['manual'], mode: 'route', eventTypes: [], subjectIncludes: [], labelsAny: [], workspaceRoots: [], maxPayloadBytes: 100 }])
    expect(() => store.markSourceEventConsumed(result.event.id)).toThrow(/cannot be consumed/)
    const queued = store.markSourceEventQueued(result.event.id)
    expect(store.markSourceEventConsumed(queued.id).status).toBe('consumed')
    store.close()
  })
})

