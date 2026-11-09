export type FlowReference = { flowId?: string; flowRunId?: string }
let pending: FlowReference | null = null
export function requestFlowDetail(reference: FlowReference): void {
  pending = reference
  window.dispatchEvent(new CustomEvent('railwise:open-flow', { detail: reference }))
}
export function takeRequestedFlow(): FlowReference | null {
  const reference = pending
  pending = null
  return reference
}
