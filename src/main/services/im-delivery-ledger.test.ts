import { describe, expect, it } from 'vitest'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImDeliveryLedger } from './im-delivery-ledger'

describe('ImDeliveryLedger', () => {
  it('persists per-operation outcomes and a restartable Runtime outbox without replaying unknown sends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-im-outbox-'))
    const path = join(root, 'messages.sqlite')
    let ledger = new ImDeliveryLedger(path)
    const record = ledger.receive({ provider: 'feishu', accountId: 'app', channelId: 'channel', remoteMessageId: 'input', chatId: 'chat',
      senderId: 'sender', threadId: 'remote', prompt: 'synthetic', payloadJson: '{}', idempotencyKey: 'input' })
    ledger.markResultReady(record.id, '{}', { threadId: 'thread', turnId: 'turn' })
    ledger.markDelivering(record.id)
    expect(ledger.beginDeliveryOperation(record.id, 'outbound:upload', 'upload', 'a'.repeat(64)).created).toBe(true)
    ledger.finishDeliveryOperation('outbound:upload', 'succeeded', 'file-key')
    ledger.beginDeliveryOperation(record.id, 'outbound:send', 'send', 'b'.repeat(64))
    ledger.close()
    ledger = new ImDeliveryLedger(path)
    expect(ledger.beginDeliveryOperation(record.id, 'outbound:upload', 'upload', 'a'.repeat(64))).toMatchObject({ created: false, operation: { status: 'succeeded', remoteOperationId: 'file-key' } })
    expect(ledger.beginDeliveryOperation(record.id, 'outbound:send', 'send', 'b'.repeat(64))).toMatchObject({ created: false, operation: { status: 'started' } })
    expect(() => ledger.beginDeliveryOperation(record.id, 'outbound:send', 'send', 'c'.repeat(64))).toThrow('another request')
    ledger.finishDeliveryOperation('outbound:send', 'outcome_unknown')
    ledger.markDeliveryUnknown(record.id, 'response lost')
    expect(ledger.listRecoverable('2099-01-01T00:00:00.000Z')).toEqual([])
    const pending = ledger.pendingRuntimeObservations()
    expect(pending.map(item => item.observation.status)).toEqual(['started', 'succeeded', 'started', 'outcome_unknown'])
    for (const item of pending) expect(item.observation).toMatchObject({ purpose: 'assistant_reply', runtimeThreadId: 'thread', runtimeTurnId: 'turn' })
    expect(JSON.stringify(pending)).not.toContain('synthetic')
    ledger.acknowledgeRuntimeObservation(pending[0].id, 'wrong-hash')
    expect(ledger.pendingRuntimeObservations()).toHaveLength(4)
    ledger.acknowledgeRuntimeObservation(pending[0].id, pending[0].fingerprint)
    expect(ledger.pendingRuntimeObservations()).toHaveLength(3)
    ledger.close()
  })
  it('restricts the ledger directory and database to the current user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-permissions-'))
    const directory = join(root, 'communication')
    const databasePath = join(directory, 'messages.sqlite3')
    const ledger = new ImDeliveryLedger(databasePath)

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600)
    }
    ledger.close()
  })

  it('deduplicates an inbound provider message and exposes stable idempotency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const input = {
      provider: 'weixin' as const,
      accountId: 'account-1',
      channelId: 'channel-1',
      remoteMessageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'sender-1',
      threadId: 'remote-thread-1',
      prompt: 'hello',
      payloadJson: '{"text":"hello"}',
      idempotencyKey: 'im:weixin:account-1:message-1'
    }
    const first = ledger.receive(input)
    const second = ledger.receive(input)
    expect(second.id).toBe(first.id)
    expect(ledger.getByIdempotencyKey(input.idempotencyKey)?.id).toBe(first.id)
    expect(ledger.integrityCheck()).toBe(true)
    expect(ledger.counts('weixin', 'account-1')).toEqual({ pending: 1, processing: 0, delivery: 0 })
    expect(() => ledger.close()).not.toThrow()
    expect(() => ledger.close()).not.toThrow()
  })

  it('recovers non-terminal jobs after an expired worker lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-recovery-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-1'
    })
    ledger.update(message.id, { status: 'turn_started', leaseRunId: 'old-run', leaseUntil: '2000-01-01T00:00:00.000Z' })
    expect(ledger.listRecoverable('2026-01-01T00:00:00.000Z')).toHaveLength(1)
    ledger.close()
  })

  it('allows only one worker to claim the same inbound message lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-claim-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'weixin', accountId: 'account-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:weixin:account-1:message-1'
    })
    expect(ledger.claim(message.id, 'worker-1', 60_000, '2026-01-01T00:00:00.000Z')?.leaseRunId).toBe('worker-1')
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:00:01.000Z')).toBeUndefined()
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:01:01.000Z')?.leaseRunId).toBe('worker-2')
    ledger.close()
  })

  it('does not let an expired worker overwrite the replacement worker state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-stale-owner-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'weixin', accountId: 'account-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:weixin:account-1:message-1'
    })
    ledger.claim(message.id, 'worker-old', 1_000, '2026-01-01T00:00:00.000Z')
    expect(ledger.claim(message.id, 'worker-new', 60_000, '2026-01-01T00:00:02.000Z')?.leaseRunId)
      .toBe('worker-new')

    expect(ledger.markResultReady(
      message.id,
      '{"ok":true,"reply":"stale"}',
      undefined,
      '2026-01-01T00:00:02.000Z',
      'worker-old'
    )).toBeUndefined()
    expect(ledger.getById(message.id)).toMatchObject({
      status: 'turn_starting',
      leaseRunId: 'worker-new'
    })
    ledger.close()
  })

  it('clears the owned lease on delivery and never regresses the terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-terminal-transition-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'weixin', accountId: 'account-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:weixin:account-1:message-1'
    })
    const claimed = ledger.claim(message.id, 'worker-1', 60_000, '2026-01-01T00:00:00.000Z')
    expect(claimed).toBeDefined()
    expect(ledger.markResultReady(
      message.id,
      '{"ok":true,"reply":"done"}',
      undefined,
      '2026-01-01T00:00:01.000Z',
      'worker-1'
    )?.status).toBe('result_ready')
    expect(ledger.markDelivering(message.id, '2026-01-01T00:00:02.000Z', 'worker-1')?.status)
      .toBe('delivering')
    expect(ledger.markDelivered(message.id, '2026-01-01T00:00:03.000Z', 'worker-1')).toMatchObject({
      status: 'delivered',
      leaseRunId: undefined,
      leaseUntil: undefined
    })

    expect(ledger.markResultReady(
      message.id,
      '{"ok":true,"reply":"stale"}',
      undefined,
      '2026-01-01T00:00:04.000Z'
    )).toBeUndefined()
    expect(ledger.getById(message.id)).toMatchObject({
      status: 'delivered',
      resultJson: '{"ok":true,"reply":"done"}'
    })
    ledger.close()
  })

  it('keeps an active worker lease fresh so recovery cannot take over a live Turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-renew-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'long running', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-1'
    })
    ledger.claim(message.id, 'worker-1', 60_000, '2026-01-01T00:00:00.000Z')

    expect(ledger.renewLease(message.id, 'worker-1', 60_000, '2026-01-01T00:00:30.000Z'))
      .toMatchObject({ leaseRunId: 'worker-1', leaseUntil: '2026-01-01T00:01:30.000Z' })
    expect(ledger.listRecoverable('2026-01-01T00:01:00.000Z')).toEqual([])
    ledger.close()
  })

  it('allows the original owner to renew after expiry until another owner claims it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-renew-expired-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'long running', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-1'
    })
    ledger.claim(message.id, 'worker-1', 1_000, '2026-01-01T00:00:00.000Z')

    expect(ledger.renewLease(message.id, 'worker-1', 60_000, '2026-01-01T00:00:02.000Z'))
      .toMatchObject({ leaseRunId: 'worker-1', leaseUntil: '2026-01-01T00:01:02.000Z' })
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:00:30.000Z')).toBeUndefined()
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:01:03.000Z')?.leaseRunId).toBe('worker-2')
    expect(ledger.renewLease(message.id, 'worker-1', 60_000, '2026-01-01T00:01:04.000Z')).toBeUndefined()
    ledger.close()
  })

  it('does not mark a result delivered until provider delivery succeeds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-delivery-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'weixin', accountId: 'account-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:weixin:account-1:message-1'
    })
    ledger.claim(message.id, 'worker-1', 60_000, '2026-01-01T00:00:00.000Z')
    expect(ledger.markResultReady(message.id, '{"ok":true,"reply":"done"}', undefined, '2026-01-01T00:00:01.000Z')?.status)
      .toBe('result_ready')
    expect(ledger.markDelivering(message.id, '2026-01-01T00:00:02.000Z')?.status).toBe('delivering')
    expect(ledger.markDeliveryRetry(message.id, 'network', 5_000, '2026-01-01T00:00:03.000Z')).toMatchObject({
      status: 'result_ready',
      retryCount: 1,
      nextAttemptAt: '2026-01-01T00:00:08.000Z'
    })
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:00:07.000Z')).toBeUndefined()
    expect(ledger.claim(message.id, 'worker-2', 60_000, '2026-01-01T00:00:08.000Z')?.status).toBe('result_ready')
    expect(ledger.markDelivered(message.id, '2026-01-01T00:00:09.000Z')).toMatchObject({
      status: 'delivered',
      leaseRunId: undefined,
      nextAttemptAt: undefined
    })
    ledger.close()
  })

  it('stops retrying a permanently failed provider delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-terminal-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-1',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-1'
    })
    ledger.markResultReady(message.id, '{"ok":true,"reply":"done"}')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      ledger.markDeliveryRetry(message.id, 'permission denied', 1_000, `2026-01-01T00:00:0${attempt}.000Z`)
    }
    expect(ledger.getById(message.id)).toMatchObject({ status: 'delivery_failed', retryCount: 8 })
    expect(ledger.claim(message.id, 'worker-final', 60_000, '2027-01-01T00:00:00.000Z')).toBeUndefined()
    expect(ledger.listRecoverable('2027-01-01T00:00:00.000Z')).toEqual([])
    expect(ledger.counts('feishu', 'app-1')).toEqual({ pending: 0, processing: 0, delivery: 0 })
    ledger.close()
  })

  it('keeps a delivered Runtime failure distinct from a successful result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-runtime-failure-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-timeout',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'slow task', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-timeout'
    })
    ledger.markResultReady(message.id, JSON.stringify({ ok: false, failureReason: 'timeout', reply: 'timed out' }))

    expect(ledger.markFailed(message.id, 'timed out')).toMatchObject({
      status: 'failed',
      errorMessage: 'timed out',
      resultJson: JSON.stringify({ ok: false, failureReason: 'timeout', reply: 'timed out' }),
      leaseRunId: undefined,
      nextAttemptAt: undefined
    })
    expect(ledger.listRecoverable('2027-01-01T00:00:00.000Z')).toEqual([])
    ledger.close()
  })

  it('never reclaims a terminal failed message as a new Runtime Turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-failed-'))
    const ledger = new ImDeliveryLedger(join(root, 'communication.sqlite3'))
    const message = ledger.receive({
      provider: 'weixin', accountId: 'account-1', channelId: 'channel-1', remoteMessageId: 'message-failed',
      chatId: 'chat-1', senderId: 'sender-1', threadId: 'thread-1', prompt: 'hello', payloadJson: '{}',
      idempotencyKey: 'im:weixin:account-1:message-failed'
    })
    ledger.update(message.id, {
      status: 'failed',
      errorMessage: 'Runtime rejected the turn',
      leaseRunId: null,
      leaseUntil: null
    })

    expect(ledger.claim(message.id, 'worker-retry', 60_000, '2027-01-01T00:00:00.000Z')).toBeUndefined()
    expect(ledger.listRecoverable('2027-01-01T00:00:00.000Z')).toEqual([])
    expect(ledger.counts('weixin', 'account-1')).toEqual({ pending: 0, processing: 0, delivery: 0 })
    ledger.close()
  })

  it('redacts old terminal payloads, deletes expired terminal rows, and preserves active work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-ledger-retention-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    const now = Date.parse('2026-08-15T00:00:00.000Z')
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60_000).toISOString()
    const thirtyOneDaysAgo = new Date(now - 31 * 24 * 60 * 60_000).toISOString()
    const terminalToRedact = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-redact',
      chatId: 'chat-1', senderId: 'sender-secret', threadId: '', prompt: 'sensitive prompt',
      payloadJson: JSON.stringify({ text: 'sensitive payload' }), idempotencyKey: 'im:feishu:app-1:message-redact',
      now: eightDaysAgo
    })
    ledger.markResultReady(terminalToRedact.id, JSON.stringify({ ok: true, reply: 'stable replay' }), undefined, eightDaysAgo)
    ledger.markDelivered(terminalToRedact.id, eightDaysAgo)

    const terminalToDelete = ledger.receive({
      provider: 'feishu', accountId: 'app-1', channelId: 'channel-1', remoteMessageId: 'message-delete',
      chatId: 'chat-1', senderId: 'sender-old', threadId: '', prompt: 'expired prompt', payloadJson: '{}',
      idempotencyKey: 'im:feishu:app-1:message-delete', now: thirtyOneDaysAgo
    })
    ledger.markResultReady(
      terminalToDelete.id,
      JSON.stringify({ ok: true, reply: 'expired result' }),
      undefined,
      thirtyOneDaysAgo
    )
    ledger.markDelivered(terminalToDelete.id, thirtyOneDaysAgo)

    const active = ledger.receive({
      provider: 'weixin', accountId: 'wx-1', channelId: 'channel-wx', remoteMessageId: 'message-active',
      chatId: 'chat-wx', senderId: 'sender-active', threadId: '', prompt: 'must survive',
      payloadJson: JSON.stringify({ text: 'must survive' }), idempotencyKey: 'im:weixin:wx-1:message-active',
      now: thirtyOneDaysAgo
    })

    expect(ledger.prune(new Date(now).toISOString())).toEqual({ redacted: 1, deleted: 1, skipped: false })
    expect(ledger.getById(terminalToRedact.id)).toMatchObject({
      prompt: '',
      payloadJson: '{}',
      senderId: '',
      resultJson: JSON.stringify({ ok: true, reply: 'stable replay' }),
      status: 'delivered'
    })
    expect(ledger.getById(terminalToDelete.id)).toBeUndefined()
    expect(ledger.getById(active.id)).toMatchObject({
      prompt: 'must survive',
      senderId: 'sender-active',
      status: 'received'
    })
    expect(ledger.prune(new Date(now + 60_000).toISOString())).toEqual({ redacted: 0, deleted: 0, skipped: true })
    ledger.close()
  })
})
