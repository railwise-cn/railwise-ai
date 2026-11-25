import { expect, it } from 'vitest'
import { OperationReceiptSchema } from '../contracts/tasks.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint } from './task-run-repository.js'
import { verifiedWebSearchResultUrls } from './web-search-result-authority.js'

const credentialUrl = new URL('https://source.example/private')
credentialUrl.username = 'qa-user'
credentialUrl.password = 'test-only'

const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', workspaceRoot: '/work',
  workspaceTrust: 'read-only', agentTrust: 'full-access', sandboxMode: 'read-only', approvalPolicy: 'auto', networkAllowlist: ['https://so.qq.com'],
  connectorScopes: [], externalTargets: [], allowedProviderIds: ['web'], allowedToolNames: ['web_search'], revision: 0,
  workspaceRevision: 0, agentRevision: 0, idempotencyKey: 'grant', issuedAt: '2026-11-24T00:00:00.000Z', expiresAt: '2026-11-24T00:15:00.000Z' })

function receipt(overrides: { output?: unknown; resultThreadId?: string; providerId?: string; approved?: boolean; allowedProviderIds?: string[]; allowedToolNames?: string[] } = {}) {
  const executionGrant = ExecutionGrantSchema.parse({ ...grant,
    ...(overrides.allowedProviderIds ? { allowedProviderIds: overrides.allowedProviderIds } : {}),
    ...(overrides.allowedToolNames ? { allowedToolNames: overrides.allowedToolNames } : {})
  })
  const request = { providerId: overrides.providerId ?? 'web', toolName: 'web_search', callId: 'search-call', turnId: 'turn', executionGrant }
  const output = overrides.output ?? { untrusted: true, query: 'query', results: [
    { url: 'https://source.example/notice', title: 'Notice' },
    { url: 'javascript:alert(1)', title: 'Unsafe' },
    { url: credentialUrl.toString(), title: 'Credential URL' }
  ] }
  return OperationReceiptSchema.parse({ id: 'receipt', ownerId: 'task', kind: 'tool', status: 'succeeded', fingerprint: operationFingerprint(request),
    idempotencyKey: 'tool:turn:search-call', request, result: { approved: overrides.approved ?? true, item: {
      id: 'item', kind: 'tool_result', status: 'completed', callId: 'search-call', toolName: 'web_search', threadId: overrides.resultThreadId ?? 'thread',
      turnId: 'turn', isError: false, output
    } }, createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z', revision: 0 })
}

it('grants only canonical public HTTP result URLs from the successful search receipt', () => {
  expect(verifiedWebSearchResultUrls([receipt()], 'task', 'turn')).toEqual(['https://source.example/notice'])
})

it('does not accept unapproved, wrong-provider, or wrong-thread search output', () => {
  expect(verifiedWebSearchResultUrls([receipt({ approved: false }), receipt({ providerId: 'mcp:other' }), receipt({ resultThreadId: 'other' })], 'task', 'turn')).toEqual([])
})

it('does not accept search output when the grant omitted or denied its provider or tool', () => {
  expect(verifiedWebSearchResultUrls([
    receipt({ allowedProviderIds: [] }),
    receipt({ allowedToolNames: [] })
  ], 'task', 'turn')).toEqual([])
})
