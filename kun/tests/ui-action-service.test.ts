import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeAssistantTextItem } from '../src/domain/item.js'
import { fingerprintDshUiBlock, parseDshUiBlocks } from '../src/contracts/dsh-ui.js'
import { UI_ACTION_TTL_MS, UiActionService } from '../src/services/ui-action-service.js'
import { buildHarness } from './http-server-test-harness.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { FileThreadStore } from '../src/adapters/file/file-thread-store.js'

const SELECT_CARD = '```dsh-ui\n{"id":"filters","root":{"id":"layout","type":"col","children":[{"id":"kind","type":"select","label":"Kind","name":"kind","actionId":"choose-kind","options":[{"label":"One","value":"one"},{"label":"Two","value":"two"}]}]}}\n```'
const PASSWORD_CARD = '```dsh-ui\n{"id":"secret","root":{"id":"layout","type":"col","children":[{"id":"password","type":"input","label":"Password","name":"password","actionId":"set-password","inputType":"password"}]}}\n```'
const PLAINTEXT_SECRET_CARD = '```dsh-ui\n{"id":"secret","root":{"id":"layout","type":"col","children":[{"id":"token-field","type":"input","label":"Token","name":"token","actionId":"set-token","inputType":"text"}]}}\n```'

async function seededActionCard(card = SELECT_CARD, options: { messageCreatedAt?: string; now?: number } = {}) {
  const h = buildHarness()
  await h.threadService.create(
    { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
    { id: 'thr_ui_action', title: 'UI action' }
  )
  const { turnId } = await h.turnService.startTurn({
    threadId: 'thr_ui_action',
    request: { prompt: 'Show controls' }
  })
  const [block] = parseDshUiBlocks(card)
  if (!block) throw new Error('expected valid UI card')
  const message = makeAssistantTextItem({
    id: 'item_card',
    turnId,
    threadId: 'thr_ui_action',
    text: 'Choose one.',
    uiBlocks: [block],
    status: 'completed'
  })
  await h.turnService.applyItem(
    'thr_ui_action',
    options.messageCreatedAt ? { ...message, createdAt: options.messageCreatedAt } : message
  )
  await h.turnService.finishTurn({ threadId: 'thr_ui_action', turnId, status: 'completed' })
  return {
    h,
    block,
    service: new UiActionService({
      sessionStore: h.sessionStore,
      turns: h.turnService,
      now: () => options.now ?? Date.now()
    })
  }
}

describe('UiActionService', () => {
  it.each(['explicit', 'legacy', 'removed'] as const)('keeps the source model identity for %s UI action turns and tasks', async scenario => {
    const root = await mkdtemp(join(tmpdir(), 'kun-ui-routing-'))
    const route = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', endpointFormat: 'chat_completions' as const, model: 'provider-default' }
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1', port: 0, dataDir: root, runtimeToken: 'synthetic-token', ...route,
      modelProviders: [{ ...route, id: 'a' }, { ...route, id: 'b' }], defaultModelProviderId: 'a',
      approvalPolicy: 'on-request', sandboxMode: 'workspace-write', tokenEconomyMode: false,
      insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({})
    })
    try {
      const store = new FileThreadStore({ dataDir: root })
      const thread = await runtime.threadService.create({ workspace: root, model: 'legacy-model', mode: 'agent' })
      const source = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'Show synthetic controls.', model: 'shared-model', providerId: 'b', reasoningEffort: 'max' } })
      const [block] = parseDshUiBlocks(SELECT_CARD)
      await runtime.turnService.applyItem(thread.id, makeAssistantTextItem({ id: 'source-card', threadId: thread.id, turnId: source.turnId, text: 'Choose.', uiBlocks: [block!], status: 'completed' }))
      await runtime.turnService.finishTurn({ threadId: thread.id, turnId: source.turnId, status: 'completed' })
      if (scenario !== 'explicit') {
        const stored = (await store.get(thread.id))!
        await store.upsert({ ...stored, turns: stored.turns.map(turn => turn.id !== source.turnId ? turn : { ...turn, providerId: scenario === 'removed' ? 'removed-provider' : undefined, model: scenario === 'legacy' ? undefined : turn.model }) })
      }
      const request = { messageId: 'source-card', blockId: block!.id, actionId: 'choose-kind', specFingerprint: fingerprintDshUiBlock(block!), value: 'two', idempotencyKey: 'ui-source-selection' }
      const before = await store.get(thread.id)
      const execute = () => runtime.uiActionService!.execute({ threadId: thread.id, request })
      if (scenario === 'removed') {
        await expect(execute()).rejects.toMatchObject({ code: 'model_provider_unavailable' })
        expect((await store.get(thread.id))?.turns).toEqual(before?.turns)
        return
      }
      const started = await execute()
      const expected = { model: scenario === 'legacy' ? 'legacy-model' : 'shared-model', providerId: scenario === 'legacy' ? 'a' : 'b', reasoningEffort: 'max' }
      expect(await runtime.turnService.getTurn(thread.id, started.turnId)).toMatchObject(expected)
      expect(runtime.taskRepository?.findActiveByThread(thread.id)).toMatchObject(expected)
      expect(await execute()).toEqual(started)
    } finally {
      await runtime.shutdown?.()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates a persisted select action, audits it, and deduplicates concurrent retries', async () => {
    const { h, block, service } = await seededActionCard()
    const request = {
      messageId: 'item_card',
      blockId: block.id,
      actionId: 'choose-kind',
      specFingerprint: fingerprintDshUiBlock(block),
      value: 'two',
      idempotencyKey: 'ui-action-click-1'
    }

    const [first, duplicate] = await Promise.all([
      service.execute({ threadId: 'thr_ui_action', request }),
      service.execute({ threadId: 'thr_ui_action', request })
    ])

    expect(duplicate).toEqual(first)
    const items = await h.sessionStore.loadItems('thr_ui_action')
    expect(items.filter((item) => item.kind === 'ui_action')).toMatchObject([
      {
        threadId: 'thr_ui_action',
        messageId: 'item_card',
        blockId: 'filters',
        actionId: 'choose-kind',
        value: 'two'
      }
    ])
    const events = await h.sessionStore.loadEventsSince('thr_ui_action', 0)
    expect(events.some((event) => event.kind === 'ui_action')).toBe(true)
    const turn = await h.turnService.getTurn('thr_ui_action', first.turnId)
    expect(turn?.items.map((item) => item.kind)).toEqual(['ui_action'])
    expect(turn?.prompt).toBe('')
    expect(turn?.uiAction).toMatchObject({
      messageId: 'item_card',
      blockId: 'filters',
      actionId: 'choose-kind',
      nodeType: 'select',
      fieldName: 'kind',
      value: 'two'
    })
  })

  it('rejects stale, mismatched, and secret-bearing actions without leaking their values', async () => {
    const { h, block, service } = await seededActionCard(PASSWORD_CARD)
    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'set-password',
        specFingerprint: fingerprintDshUiBlock(block),
        password: 'do-not-persist-this-secret',
        idempotencyKey: 'ui-action-password-1'
      }
    })).rejects.toThrow(/password/i)

    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'set-password',
        specFingerprint: '0'.repeat(16),
        idempotencyKey: 'ui-action-stale-1'
      }
    })).rejects.toThrow(/stale|fingerprint/i)

    const persisted = JSON.stringify({
      items: await h.sessionStore.loadItems('thr_ui_action'),
      events: await h.sessionStore.loadEventsSince('thr_ui_action', 0)
    })
    expect(persisted).not.toContain('do-not-persist-this-secret')
  })

  it('rejects credential-shaped input names even when inputType says text', async () => {
    const { h, block, service } = await seededActionCard(PLAINTEXT_SECRET_CARD)
    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'set-token',
        specFingerprint: fingerprintDshUiBlock(block),
        value: 'must-not-persist-this-token',
        idempotencyKey: 'ui-action-token-1'
      }
    })).rejects.toMatchObject({ code: 'ui_action_unavailable' })

    const persisted = JSON.stringify({
      items: await h.sessionStore.loadItems('thr_ui_action'),
      events: await h.sessionStore.loadEventsSince('thr_ui_action', 0)
    })
    expect(persisted).not.toContain('must-not-persist-this-token')
  })

  it('rejects an action addressed to a different thread', async () => {
    const { block, service } = await seededActionCard()

    await expect(service.execute({
      threadId: 'thr_wrong_thread',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'choose-kind',
        specFingerprint: fingerprintDshUiBlock(block),
        value: 'one',
        idempotencyKey: 'ui-action-wrong-thread'
      }
    })).rejects.toMatchObject({ code: 'ui_action_not_found' })
  })

  it('rejects reusing an idempotency key for a different persisted action value', async () => {
    const { block, service } = await seededActionCard()
    const request = {
      messageId: 'item_card',
      blockId: block.id,
      actionId: 'choose-kind',
      specFingerprint: fingerprintDshUiBlock(block),
      value: 'one',
      idempotencyKey: 'ui-action-conflict-1'
    }
    await service.execute({ threadId: 'thr_ui_action', request })

    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: { ...request, value: 'two' }
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects reusing a UI action idempotency key for a generic Turn', async () => {
    const { h, block, service } = await seededActionCard()
    const idempotencyKey = 'ui-action-to-turn-conflict-1'
    await service.execute({
      threadId: 'thr_ui_action',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'choose-kind',
        specFingerprint: fingerprintDshUiBlock(block),
        value: 'one',
        idempotencyKey
      }
    })

    await expect(h.turnService.startTurn({
      threadId: 'thr_ui_action',
      request: { prompt: 'must not replace the action', idempotencyKey }
    })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects an expired persisted card before starting a Turn', async () => {
    const now = Date.parse('2026-08-18T12:00:00.000Z')
    const { block, service } = await seededActionCard(SELECT_CARD, {
      now,
      messageCreatedAt: new Date(now - UI_ACTION_TTL_MS - 1).toISOString()
    })

    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: {
        messageId: 'item_card',
        blockId: block.id,
        actionId: 'choose-kind',
        specFingerprint: fingerprintDshUiBlock(block),
        value: 'one',
        idempotencyKey: 'ui-action-expired-1'
      }
    })).rejects.toMatchObject({ code: 'ui_action_expired' })
  })

  it('rejects replaying the same persisted action with a new idempotency key', async () => {
    const { block, service } = await seededActionCard()
    const request = {
      messageId: 'item_card',
      blockId: block.id,
      actionId: 'choose-kind',
      specFingerprint: fingerprintDshUiBlock(block),
      value: 'one',
      idempotencyKey: 'ui-action-first-key'
    }
    await service.execute({ threadId: 'thr_ui_action', request })

    await expect(service.execute({
      threadId: 'thr_ui_action',
      request: { ...request, idempotencyKey: 'ui-action-second-key' }
    })).rejects.toMatchObject({ code: 'ui_action_consumed' })
  })

  it('atomically accepts only one concurrent click when idempotency keys differ', async () => {
    const { h, block, service } = await seededActionCard()
    const request = {
      messageId: 'item_card',
      blockId: block.id,
      actionId: 'choose-kind',
      specFingerprint: fingerprintDshUiBlock(block),
      value: 'two'
    }

    const results = await Promise.allSettled([
      service.execute({
        threadId: 'thr_ui_action',
        request: { ...request, idempotencyKey: 'ui-action-race-a' }
      }),
      service.execute({
        threadId: 'thr_ui_action',
        request: { ...request, idempotencyKey: 'ui-action-race-b' }
      })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'ui_action_consumed' } }
    ])
    const items = await h.sessionStore.loadItems('thr_ui_action')
    expect(items.filter((item) => item.kind === 'ui_action')).toHaveLength(1)
  })
})
