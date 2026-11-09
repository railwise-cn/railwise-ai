import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FlowRepository } from './repository.js'

const MAX_BODY_BYTES = 1024 * 1024
const REPLAY_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT = 60

export interface FlowSecretStore { set(key: string, secret: Buffer): Promise<void>; get(key: string): Promise<Buffer | null> }

export class EncryptedFileFlowSecretStore implements FlowSecretStore {
  constructor(private readonly root: string, private readonly master: Buffer) { if (master.length !== 32) throw new Error('Flow secret-store key must be 32 bytes') }
  async set(key: string, secret: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.master, iv); const encrypted = Buffer.concat([cipher.update(secret), cipher.final()])
    await writeFile(join(this.root, `${safeKey(key)}.json`), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') }), { mode: 0o600 })
  }
  async get(key: string): Promise<Buffer | null> {
    try { const stored = JSON.parse(await readFile(join(this.root, `${safeKey(key)}.json`), 'utf8')) as { iv: string; tag: string; encrypted: string }; const decipher = createDecipheriv('aes-256-gcm', this.master, Buffer.from(stored.iv, 'base64')); decipher.setAuthTag(Buffer.from(stored.tag, 'base64')); return Buffer.concat([decipher.update(Buffer.from(stored.encrypted, 'base64')), decipher.final()]) } catch { return null }
  }
}

export class UnavailableFlowSecretStore implements FlowSecretStore {
  async set(): Promise<void> { throw webhookError('webhook_safe_storage_unavailable', 'System safe storage is unavailable') }
  async get(): Promise<Buffer | null> { return null }
}

export class FlowWebhookSecurity {
  private readonly rates = new Map<string, number[]>()
  constructor(private readonly repository: FlowRepository, private readonly secrets: FlowSecretStore, private readonly now: () => number = Date.now) {}

  async provision(flowId: string, nodeId: string): Promise<{ triggerId: string; secret: string; credentialReferenceId: string }> {
    const existing = this.repository.getTriggerState(flowId, nodeId)
    if (existing) throw webhookError('webhook_already_provisioned', 'Webhook credentials already exist; rotate them instead of retrieving the secret')
    const triggerId = `wh_${randomUUID()}`; const secret = randomBytes(32); const referenceId = `flowcred_${randomUUID()}`; const safeStorageKey = `flow-webhook-${referenceId}`
    await this.secrets.set(safeStorageKey, secret)
    this.repository.saveCredentialReference({ id: referenceId, provider: 'runtime-secure-store', safeStorageKey, createdAt: new Date(this.now()).toISOString() })
    this.repository.saveTriggerState({ flowId, nodeId, enabled: true, state: { triggerId, credentialReferenceId: referenceId } })
    return { triggerId, secret: secret.toString('base64url'), credentialReferenceId: referenceId }
  }

  async verify(triggerId: string, request: Request): Promise<{ flowId: string; nodeId: string; input: unknown }> {
    const verified = await this.verifyForReceipt(triggerId, request)
    this.repository.pruneNonces(this.now() - REPLAY_WINDOW_MS)
    if (!this.repository.rememberNonce(triggerId, verified.nonce, verified.acceptedAt)) throw webhookError('webhook_replay', 'Webhook nonce was already used')
    return { flowId: verified.flowId, nodeId: verified.nodeId, input: verified.input }
  }

  /** Authentication alone must not consume a nonce before the inbox commit. */
  async verifyForReceipt(triggerId: string, request: Request): Promise<{ flowId: string; nodeId: string; input: unknown; nonce: string; fingerprint: string; acceptedAt: number }> {
    const contentLength = Number(request.headers.get('content-length') ?? 0)
    if (contentLength > MAX_BODY_BYTES) throw webhookError('webhook_body_limit', 'Webhook request exceeds 1 MiB')
    const body = Buffer.from(await request.arrayBuffer()); if (body.length > MAX_BODY_BYTES) throw webhookError('webhook_body_limit', 'Webhook request exceeds 1 MiB')
    const timestampText = request.headers.get('x-workwise-timestamp') ?? ''; const nonce = request.headers.get('x-workwise-nonce') ?? ''; const signatureText = (request.headers.get('x-workwise-signature') ?? '').replace(/^sha256=/, '')
    const timestamp = Number(timestampText); if (!Number.isInteger(timestamp) || Math.abs(this.now() - timestamp * 1000) > REPLAY_WINDOW_MS) throw webhookError('webhook_timestamp_invalid', 'Webhook timestamp is outside the five-minute replay window')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw webhookError('webhook_nonce_invalid', 'Webhook nonce is invalid')
    const state = this.repository.findTriggerState(triggerId); if (!state?.enabled) throw webhookError('webhook_trigger_missing', 'Webhook trigger is unavailable')
    this.enforceRate(triggerId)
    const referenceId = typeof state.state.credentialReferenceId === 'string' ? state.state.credentialReferenceId : ''; const reference = this.repository.getCredentialReference(referenceId); if (!reference) throw webhookError('webhook_credential_missing', 'Webhook credential reference is unavailable')
    const secret = await this.secrets.get(reference.safeStorageKey); if (!secret) throw webhookError('webhook_credential_missing', 'Webhook credential is unavailable')
    const expected = createHmac('sha256', secret).update(timestampText).update('.').update(nonce).update('.').update(body).digest(); const supplied = /^[a-f0-9]{64}$/i.test(signatureText) ? Buffer.from(signatureText, 'hex') : Buffer.alloc(0)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw webhookError('webhook_signature_invalid', 'Webhook signature is invalid')
    let input: unknown; try { input = body.length ? JSON.parse(body.toString('utf8')) : {} } catch { input = { body: body.toString('utf8') } }
    return { flowId: state.flowId, nodeId: state.nodeId, input, nonce, fingerprint: createHash('sha256').update(triggerId).update('.').update(timestampText).update('.').update(nonce).update('.').update(body).digest('hex'), acceptedAt: this.now() }
  }

  private enforceRate(triggerId: string): void { const cutoff = this.now() - 60_000; const recent = (this.rates.get(triggerId) ?? []).filter((time) => time > cutoff); if (recent.length >= RATE_LIMIT) throw webhookError('webhook_rate_limit', 'Webhook rate limit exceeded'); recent.push(this.now()); this.rates.set(triggerId, recent) }
}

function safeKey(value: string): string { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid safe-storage key'); return value }
function webhookError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
