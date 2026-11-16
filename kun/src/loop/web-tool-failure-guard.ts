import type { ToolCallLike } from '../ports/tool-host.js'

export type WebToolFailureGuardOptions = { threshold?: number }
const WEB_TOOL_NAMES = new Set(['web_fetch', 'web_search'])

/** A failed source must not remove working sources or the browser from a Turn. */
export class WebToolFailureGuard {
  private readonly threshold: number
  private readonly failures = new Map<string, number>()
  private readonly blocked = new Set<string>()
  private successfulResult = false

  constructor(options: WebToolFailureGuardOptions = {}) {
    this.threshold = Math.max(1, Math.floor(options.threshold ?? 2))
  }

  inspect(call: ToolCallLike): { suppress: boolean; reason?: string } {
    if (!isWebToolCall(call) || !this.blocked.has(sourceKey(call))) return { suppress: false }
    return { suppress: true, reason: 'This read-only source exhausted its bounded retries. Inspect its recorded error, use an authorized browser for a dynamic page, or continue with other sources. Preserve policy denials and unverified coverage.' }
  }

  /** Kept for callers that formerly removed every web tool from the catalog. */
  isBlocked(): boolean { return false }

  shouldFailDegradedCompletion(): boolean {
    return this.blocked.size > 0 && !this.successfulResult
  }

  recoveryInstruction(): string | null {
    if (!this.blocked.size) return null
    return `Read-only retries were exhausted for ${[...this.blocked].join(', ')}. Other sources and authorized browser tools remain available. Use real error codes to resolve missing providers, authentication, dynamic pages or network failures. Report source coverage accurately and deliver verified files. A failed source cannot establish a general network outage.`
  }

  observe(call: ToolCallLike, isError: boolean, output?: unknown): void {
    if (!isWebToolCall(call)) return
    const key = sourceKey(call)
    if (!isError) {
      this.successfulResult = true
      this.failures.delete(key)
      this.blocked.delete(key)
      return
    }
    const record = output && typeof output === 'object' ? output as Record<string, unknown> : {}
    const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
    const code = String(record.code ?? error.code ?? '')
    const hardFailure = /(?:blocked|denied|forbidden|unavailable|invalid_url|private_address)/i.test(code)
    const failures = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, failures)
    if (hardFailure || failures >= this.threshold) this.blocked.add(key)
  }
}

function isWebToolCall(call: ToolCallLike): boolean { return WEB_TOOL_NAMES.has(call.toolName) }

function sourceKey(call: ToolCallLike): string {
  if (call.toolName === 'web_fetch') {
    try { return `${call.toolName}:${new URL(String(call.arguments.url)).origin}` } catch { return `${call.toolName}:invalid-url` }
  }
  return call.toolName
}
