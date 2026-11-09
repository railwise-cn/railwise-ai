import { randomUUID } from 'node:crypto'
import type { FlowDefinitionV1, FlowNodeRunV1, FlowNodeV1, FlowRunV1 } from '../contracts/flow.js'
import { FlowRepository } from './repository.js'
import { inspectProcess } from '../services/process-identity.js'

export type FlowAdapterContext = { run: FlowRunV1; definition: FlowDefinitionV1; node: FlowNodeV1; input: unknown; signal: AbortSignal }
export type FlowAdapterResult = { kind: 'output'; output: unknown } | { kind: 'wait'; reason: 'approval' | 'breakpoint' | 'task'; checkpoint?: unknown }
export type FlowNodeAdapter = (context: FlowAdapterContext) => Promise<FlowAdapterResult>
type NodeExecutionResult = FlowAdapterResult | { kind: 'error'; error: string; output: unknown }

export class FlowExecutor {
  private readonly active = new Map<string, AbortController>()
  private readonly interrupting = new Set<string>()
  constructor(private readonly repository: FlowRepository, private readonly adapters: ReadonlyMap<string, FlowNodeAdapter>, private readonly nowIso: () => string = () => new Date().toISOString()) {}

  async start(flowId: string, input: unknown, invocationStack: string[] = []): Promise<FlowRunV1> {
    if (invocationStack.includes(flowId)) throw new Error('recursive Flow invocation rejected')
    if (invocationStack.length >= 3) throw new Error('Flow invocation depth exceeds three')
    const draft = this.repository.get(flowId); if (!draft?.publishedVersionId) throw new Error('Flow is not published')
    if (draft.variables.archived === true) throw new Error('Flow is archived')
    const version = this.repository.getVersion(draft.publishedVersionId); if (!version) throw new Error('Published Flow version is missing')
    const run = this.repository.createRun({ flowId, versionId: version.id, input, invocationStack: [...invocationStack, flowId] })
    this.dispatchQueued(run.id)
    return run
  }

  /** Dispatch an already committed source run without creating another run. */
  dispatchQueued(runId: string): FlowRunV1 {
    const run = this.repository.getRun(runId)
    if (!run) throw new Error(`run not found: ${runId}`)
    if (run.status !== 'queued' || this.active.has(runId)) return run
    const version = this.repository.getVersion(run.versionId)
    if (!version || version.flowId !== run.flowId) throw new Error('Accepted Flow version is missing')
    const claimed = this.repository.claimRun(runId, ['queued'])
    if (claimed) void this.execute(claimed, version.definition)
    return this.repository.getRun(runId) ?? run
  }

  async testNode(definition: FlowDefinitionV1, nodeId: string, input: unknown): Promise<FlowAdapterResult> {
    const node = definition.nodes.find((item) => item.id === nodeId); if (!node) throw new Error(`node not found: ${nodeId}`)
    const adapter = this.adapters.get(node.type); if (!adapter) throw new Error(`node adapter unavailable: ${node.type}`)
    const controller = new AbortController()
    const run = { id: `test_${randomUUID()}`, flowId: definition.id, versionId: 'draft', status: 'running', input, invocationStack: [], startedAt: this.nowIso(), updatedAt: this.nowIso() } as FlowRunV1
    return withTimeout(adapter({ run, definition, node, input, signal: controller.signal }), node.policy.timeoutMs, controller)
  }

  cancel(runId: string): boolean {
    const controller = this.active.get(runId)
    if (controller) { controller.abort(); return true }
    return this.repository.transaction(() => {
      const run = this.repository.getRun(runId)
      if (!run || !['queued', 'paused', 'interrupted', 'waiting_approval'].includes(run.status)) return false
      const now = this.nowIso()
      for (const node of this.repository.listNodeRuns(runId)) if (['paused', 'waiting_approval', 'interrupted'].includes(node.status)) this.repository.saveNodeRun({ ...node, status: 'cancelled', completedAt: now })
      this.repository.saveRun({ ...run, status: 'cancelled', updatedAt: now, completedAt: now })
      return true
    })
  }

  async resume(runId: string): Promise<FlowRunV1> {
    if (this.active.has(runId)) throw new Error('Flow run is already executing')
    const run = this.repository.getRun(runId); if (!run) throw new Error(`run not found: ${runId}`)
    const version = this.repository.getVersion(run.versionId); if (!version) throw new Error('Flow version not found')
    if (!['paused', 'interrupted', 'waiting_approval', 'failed'].includes(run.status)) throw new Error(`run cannot resume from ${run.status}`)
    if (run.status === 'interrupted' && run.checkpoint?.resumable === false) throw new Error('Flow cannot resume because the interrupted node is not resumable')
    const claimed = this.repository.claimRun(run.id, ['paused', 'interrupted', 'waiting_approval', 'failed'])
    if (!claimed) throw new Error('Flow run was claimed by another Runtime')
    void this.execute(claimed, version.definition)
    return claimed
  }

  checkpointActiveRuns(): number {
    let count = 0
    for (const [runId, controller] of this.active) {
      const run = this.repository.getRun(runId); if (!run) continue
      const version = this.repository.getVersion(run.versionId); const runningIds = this.repository.listNodeRuns(runId).filter((item) => item.status === 'running').map((item) => item.nodeId); const resumable = version !== null && runningIds.every((id) => version?.definition.nodes.find((node) => node.id === id)?.policy.resumable === true)
      this.interrupting.add(runId); controller.abort(); this.repository.saveRun({ ...run, status: 'interrupted', checkpoint: { reason: 'application_exit', resumable, runningNodeIds: runningIds }, updatedAt: this.nowIso(), completedAt: undefined }); count += 1
    }
    return count
  }

  reconcileStartup(): number {
    let count = 0
    for (const run of this.repository.listRunsByStatus(['queued', 'running'])) {
      // A committed source inbox item which has never dispatched is safe to start.
      // Running nodes must still be reconciled rather than replayed blindly.
      if (run.status === 'queued' && this.repository.listNodeRuns(run.id).length === 0) continue
      const owner = run.checkpoint?.executionOwner as { pid?: unknown; fingerprint?: unknown } | undefined
      if (owner && typeof owner.pid === 'number' && typeof owner.fingerprint === 'string' && inspectProcess({ pid: owner.pid, fingerprint: owner.fingerprint }) === 'alive') continue
      const version = this.repository.getVersion(run.versionId); const running = this.repository.listNodeRuns(run.id).filter((item) => item.status === 'running')
      const resumable = version !== null && running.every((item) => version?.definition.nodes.find((node) => node.id === item.nodeId)?.policy.resumable === true)
      for (const nodeRun of running) this.repository.saveNodeRun({ ...nodeRun, status: 'interrupted', completedAt: this.nowIso() })
      this.repository.saveRun({ ...run, status: 'interrupted', checkpoint: { reason: 'runtime_restart', resumable, runningNodeIds: running.map((item) => item.nodeId) }, updatedAt: this.nowIso(), completedAt: undefined }); count += 1
    }
    return count
  }

  private async execute(runInput: FlowRunV1, definition: FlowDefinitionV1): Promise<void> {
    const controller = new AbortController(); this.active.set(runInput.id, controller)
    let run: FlowRunV1 = { ...runInput, status: 'running', updatedAt: this.nowIso() }; this.repository.saveRun(run)
    try {
      const prior = this.repository.listNodeRuns(run.id).filter((item) => item.status === 'succeeded')
      const outputs = new Map(prior.map((item) => [item.nodeId, item.output]))
      const completed = new Set(prior.map((item) => item.nodeId))
      const failed = new Set<string>()
      const skipped = new Set<string>()
      const cycles = boundedLoopCycles(definition)
      const cycleByNode = new Map(cycles.flatMap((cycle) => cycle.nodeIds.map((id) => [id, cycle] as const)))
      const loopIterations = new Map<string, number>()
      const loopFeedback = new Map<string, unknown>()
      const finalizedLoops = new Set<string>()
      const enabled = definition.nodes.filter((node) => !node.disabled)
      while (completed.size < enabled.length) {
        if (controller.signal.aborted) throw Object.assign(new Error('Flow cancelled'), { code: 'cancelled' })
        const settled = new Set([...completed, ...failed, ...skipped])
        const candidates = enabled.filter((node) => !settled.has(node.id) && executionIncoming(definition, node, cycleByNode).every((edge) => settled.has(edge.sourceNodeId) && !pendingLoopEdge(edge, cycleByNode, finalizedLoops)))
        for (const node of candidates) {
          const edges = allIncoming(definition, node.id)
          if (edges.length && !edges.some((edge) => edgeActive(edge, outputs, failed))) {
            skipped.add(node.id); completed.add(node.id)
            const attempt = Math.max(0, ...this.repository.listNodeRuns(run.id).filter((item) => item.nodeId === node.id).map((item) => item.attempt)) + 1
            this.repository.saveNodeRun({ id: `noderun_${randomUUID()}`, runId: run.id, nodeId: node.id, attempt, status: 'skipped', completedAt: this.nowIso() })
          }
        }
        const ready = candidates.filter((node) => !skipped.has(node.id))
        if (completed.size >= enabled.length) continue
        if (!ready.length) throw new Error('Flow cannot make progress; graph may contain an unresolved cycle')
        const concurrency = Math.max(1, Math.min(16, ...ready.map((node) => node.policy.concurrencyLimit)))
        for (let index = 0; index < ready.length; index += concurrency) {
          const batch = ready.slice(index, index + concurrency)
          const results = await Promise.all(batch.map((node) => this.executeNode(run, definition, node, loopFeedback.has(node.id) ? loopFeedback.get(node.id) : resolveInput(run.input, definition, node, outputs, failed), controller.signal)))
          for (let offset = 0; offset < batch.length; offset += 1) {
            const result = results[offset]!; const node = batch[offset]!
            if (result.kind === 'wait') {
              run = { ...run, status: result.reason === 'approval' ? 'waiting_approval' : 'paused', checkpoint: { ...run.checkpoint, nodeId: node.id, reason: result.reason, ...(result.checkpoint && typeof result.checkpoint === 'object' ? result.checkpoint as Record<string, unknown> : {}) }, updatedAt: this.nowIso() }
              this.repository.saveRun(run); return
            }
            if (result.kind === 'error') { outputs.set(node.id, result.output); failed.add(node.id); completed.add(node.id); continue }
            const cycle = cycleByNode.get(node.id)
            outputs.set(node.id, cycle?.loopNodeId === node.id ? { branch: 'body', value: result.output } : result.output); completed.add(node.id)
          }
          for (const cycle of cycles) {
            if (finalizedLoops.has(cycle.loopNodeId) || !cycle.nodeIds.every((id) => completed.has(id))) continue
            const iteration = (loopIterations.get(cycle.loopNodeId) ?? 0) + 1; loopIterations.set(cycle.loopNodeId, iteration)
            if (iteration >= cycle.maxIterations) { const current = outputs.get(cycle.loopNodeId); outputs.set(cycle.loopNodeId, { branch: 'done', value: edgeValue(current) }); finalizedLoops.add(cycle.loopNodeId); continue }
            const feedbackEdges = definition.edges.filter((edge) => edge.targetNodeId === cycle.loopNodeId && cycle.nodeIds.includes(edge.sourceNodeId)); const feedbackValues = feedbackEdges.map((edge) => edgeValue(outputs.get(edge.sourceNodeId))); loopFeedback.set(cycle.loopNodeId, feedbackValues.length === 1 ? feedbackValues[0] : Object.fromEntries(feedbackEdges.map((edge, index) => [edge.targetPortId || String(index), feedbackValues[index]])))
            for (const id of cycle.nodeIds) { completed.delete(id); failed.delete(id); skipped.delete(id); outputs.delete(id) }
          }
        }
      }
      const terminal = enabled.filter((node) => !skipped.has(node.id) && !definition.edges.some((edge) => edge.sourceNodeId === node.id))
      run = { ...run, status: 'succeeded', output: Object.fromEntries(terminal.map((node) => [node.id, outputs.get(node.id)])), updatedAt: this.nowIso(), completedAt: this.nowIso() }
      this.repository.saveRun(run)
    } catch (error) {
      if (this.interrupting.has(run.id)) { this.repository.saveRun({ ...run, status: 'interrupted', checkpoint: this.repository.getRun(run.id)?.checkpoint ?? { reason: 'application_exit', resumable: false }, updatedAt: this.nowIso(), completedAt: undefined }); return }
      const cancelled = (error as { code?: string }).code === 'cancelled' || controller.signal.aborted
      this.repository.saveRun({ ...run, status: cancelled ? 'cancelled' : 'failed', output: { error: error instanceof Error ? error.message : String(error) }, updatedAt: this.nowIso(), completedAt: this.nowIso() })
    } finally { this.active.delete(run.id); this.interrupting.delete(run.id) }
  }

  private async executeNode(run: FlowRunV1, definition: FlowDefinitionV1, node: FlowNodeV1, input: unknown, parentSignal: AbortSignal): Promise<NodeExecutionResult> {
    if (node.policy.breakpoint && run.checkpoint?.nodeId !== node.id) return { kind: 'wait', reason: 'breakpoint' }
    const adapter = this.adapters.get(node.type); if (!adapter) throw new Error(`node adapter unavailable: ${node.type}`)
    let lastError: unknown
    const priorAttempt = Math.max(0, ...this.repository.listNodeRuns(run.id).filter((item) => item.nodeId === node.id).map((item) => item.attempt))
    for (let attempt = 1; attempt <= node.policy.retryAttempts + 1; attempt += 1) {
      const id = `noderun_${randomUUID()}`; const startedAt = this.nowIso(); const attemptNumber = priorAttempt + attempt
      const nodeRun: FlowNodeRunV1 = { id, runId: run.id, nodeId: node.id, attempt: attemptNumber, status: 'running', input: bounded(input), startedAt }
      this.repository.saveNodeRun(nodeRun)
      const controller = new AbortController(); const abort = () => controller.abort(); parentSignal.addEventListener('abort', abort, { once: true })
      try {
        const result = await withTimeout(adapter({ run, definition, node, input, signal: controller.signal }), node.policy.timeoutMs, controller)
        this.repository.saveNodeRun({ ...nodeRun, status: result.kind === 'wait' ? (result.reason === 'approval' ? 'waiting_approval' : 'paused') : 'succeeded', ...(result.kind === 'output' ? { output: bounded(result.output) } : {}), completedAt: this.nowIso() })
        return result
      } catch (error) {
        lastError = error; this.repository.saveNodeRun({ ...nodeRun, status: parentSignal.aborted ? 'cancelled' : 'failed', error: error instanceof Error ? error.message : String(error), completedAt: this.nowIso() })
        if (attempt <= node.policy.retryAttempts && !parentSignal.aborted) await delay(node.policy.retryBackoffMs * attempt, parentSignal)
      } finally { parentSignal.removeEventListener('abort', abort) }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    if (node.policy.errorBehavior === 'error_edge') return { kind: 'error', error: message, output: { error: message, nodeId: node.id } }
    if (node.policy.errorBehavior === 'continue') return { kind: 'output', output: { error: message, nodeId: node.id, continued: true } }
    throw lastError
  }
}

function allIncoming(definition: FlowDefinitionV1, nodeId: string) { return definition.edges.filter((edge) => edge.targetNodeId === nodeId) }
type LoopCycle = { loopNodeId: string; nodeIds: string[]; maxIterations: number }
function boundedLoopCycles(definition: FlowDefinitionV1): LoopCycle[] { return stronglyConnected(definition).flatMap((nodeIds) => { const loops = nodeIds.map((id) => definition.nodes.find((node) => node.id === id)).filter((node) => node?.type === 'loop'); if (loops.length !== 1) return []; return [{ loopNodeId: loops[0]!.id, nodeIds, maxIterations: Math.max(1, Number(loops[0]!.config.maxIterations) || 1) }] }) }
function executionIncoming(definition: FlowDefinitionV1, node: FlowNodeV1, cycleByNode: Map<string, LoopCycle>) { const cycle = cycleByNode.get(node.id); return allIncoming(definition, node.id).filter((edge) => !(cycle?.loopNodeId === node.id && cycle.nodeIds.includes(edge.sourceNodeId))) }
function pendingLoopEdge(edge: FlowDefinitionV1['edges'][number], cycleByNode: Map<string, LoopCycle>, finalized: Set<string>): boolean { const sourceCycle = cycleByNode.get(edge.sourceNodeId); return Boolean(sourceCycle?.loopNodeId === edge.sourceNodeId && edge.sourcePortId === 'done' && !finalized.has(sourceCycle.loopNodeId)) }
function edgeActive(edge: FlowDefinitionV1['edges'][number], outputs: Map<string, unknown>, failed: Set<string>): boolean {
  if (edge.branch === 'error') return failed.has(edge.sourceNodeId)
  if (failed.has(edge.sourceNodeId)) return false
  const output = outputs.get(edge.sourceNodeId)
  if (output && typeof output === 'object' && 'branch' in output) {
    const branch = String((output as { branch: unknown }).branch)
    if (['true', 'false', 'body', 'done'].includes(edge.sourcePortId)) return edge.sourcePortId === branch
  }
  return true
}
function resolveInput(root: unknown, definition: FlowDefinitionV1, node: FlowNodeV1, outputs: Map<string, unknown>, failed: Set<string>): unknown { const edges = allIncoming(definition, node.id).filter((edge) => edgeActive(edge, outputs, failed)); const bound = Object.fromEntries(Object.entries(node.bindings).map(([key, binding]) => { if (binding.kind === 'literal') return [key, binding.value]; if (binding.kind === 'port') return [key, edgeValue(outputs.get(binding.nodeId))]; return [key, property({ input: root, variables: definition.variables, ...definition.variables }, binding.variable)] })); if (!edges.length && !Object.keys(bound).length) return root; return { ...(root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : { input: root }), ...Object.fromEntries(edges.map((edge) => [edge.targetPortId, edgeValue(outputs.get(edge.sourceNodeId))])), ...bound } }
function edgeValue(output: unknown): unknown { return output && typeof output === 'object' && 'branch' in output && 'value' in output ? (output as { value: unknown }).value : output }
function property(value: unknown, path: string): unknown { return path.split('.').filter(Boolean).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value) }
function stronglyConnected(definition: FlowDefinitionV1): string[][] { let cursor = 0; const index = new Map<string, number>(); const low = new Map<string, number>(); const stack: string[] = []; const active = new Set<string>(); const result: string[][] = []; const visit = (id: string) => { index.set(id, cursor); low.set(id, cursor++); stack.push(id); active.add(id); for (const target of definition.edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId)) { if (!index.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)) } else if (active.has(target)) low.set(id, Math.min(low.get(id)!, index.get(target)!)) } if (low.get(id) === index.get(id)) { const component: string[] = []; let current: string; do { current = stack.pop()!; active.delete(current); component.push(current) } while (current !== id); const self = component.length === 1 && definition.edges.some((edge) => edge.sourceNodeId === id && edge.targetNodeId === id); if (component.length > 1 || self) result.push(component) } }; for (const node of definition.nodes) if (!index.has(node.id)) visit(node.id); return result }
function bounded(value: unknown): unknown { const text = JSON.stringify(value); return text.length <= 256_000 ? value : { truncated: true, preview: text.slice(0, 255_000) } }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> { let timer: ReturnType<typeof setTimeout>; let abort: (() => void) | undefined; try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`node timed out after ${timeoutMs}ms`)); controller.abort() }, timeoutMs) }), new Promise<never>((_, reject) => { abort = () => reject(Object.assign(new Error('node execution cancelled'), { code: 'cancelled' })); controller.signal.addEventListener('abort', abort, { once: true }) })]) } finally { clearTimeout(timer!); if (abort) controller.signal.removeEventListener('abort', abort) } }
async function delay(ms: number, signal: AbortSignal): Promise<void> { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) }, { once: true }) }) }
