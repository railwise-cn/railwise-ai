import type { RuntimeRequestResult } from '../../shared/workwise-api'

export function assertMcpConfigurationApplied(response: RuntimeRequestResult, revision: number): void {
  let result: { applied?: unknown; ok?: unknown; revision?: unknown } | undefined
  try { result = JSON.parse(response.body) } catch { /* A non-JSON response cannot acknowledge the snapshot. */ }
  // Older Runtime versions only acknowledge healthy configurations through ok.
  const applied = result?.applied === true || (result?.applied === undefined && result?.ok === true)
  if (!response.ok || !applied || result?.revision !== revision) {
    throw new Error('连接配置已保存，但 Runtime 尚未确认应用。请重试检查或启用。')
  }
}
