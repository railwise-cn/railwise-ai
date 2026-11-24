import { ExecutionGrantSchema } from '../contracts/permissions.js'
import type { OperationReceipt } from '../contracts/tasks.js'
import { operationFingerprint } from './task-run-repository.js'

export function verifiedWebSearchResultUrls(
  receipts: readonly OperationReceipt[],
  taskId: string,
  turnId: string
): string[] {
  const urls = new Set<string>()
  for (const receipt of receipts) {
    const request = recordValue(receipt.request)
    const result = recordValue(receipt.result)
    const item = recordValue(result.item)
    const output = recordValue(item.output)
    const grant = ExecutionGrantSchema.safeParse(request.executionGrant)
    if (receipt.ownerId !== taskId || receipt.kind !== 'tool' || receipt.status !== 'succeeded' ||
      receipt.fingerprint !== operationFingerprint(receipt.request) || request.providerId !== 'web' ||
      request.toolName !== 'web_search' || request.turnId !== turnId || !grant.success ||
      grant.data.taskId !== taskId || grant.data.turnId !== turnId || result.approved !== true ||
      !grant.data.allowedProviderIds?.includes('web') || !grant.data.allowedToolNames?.includes('web_search') ||
      item.kind !== 'tool_result' || item.status !== 'completed' || item.isError === true ||
      item.toolName !== 'web_search' || item.callId !== request.callId || item.threadId !== grant.data.threadId ||
      item.turnId !== turnId || output.untrusted !== true || typeof output.query !== 'string' || !Array.isArray(output.results)) continue

    for (const value of output.results) {
      const candidate = recordValue(value).url
      if (typeof candidate !== 'string') continue
      try {
        const url = new URL(candidate)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href === candidate) urls.add(candidate)
      } catch { /* Search providers cannot grant malformed targets. */ }
    }
  }
  return [...urls]
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
