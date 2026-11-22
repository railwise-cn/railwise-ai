import { normalizeScheduleSpec } from '@shared/app-settings-schedule'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, addEdge, applyEdgeChanges,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type ReactFlowInstance
} from '@xyflow/react'
import { AlertTriangle, CheckCircle2, ChevronRight, Download, History, Loader2, Play, Save, Send, Square, TestTube2, Workflow } from 'lucide-react'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'
import { flowMatchesFilter, type FlowListFilter } from './flow-filter'
import { surveyDraftSelection, clearSurveyDraftSelection } from '../../agent/survey-collaboration-client'
import { SurveyReviewFlowPanel } from './SurveyReviewFlowPanel'
import { useChatStore } from '../../store/chat-store'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { takeRequestedFlow, type FlowReference } from '../../store/flow-navigation'

type PortType = 'string' | 'number' | 'boolean' | 'json' | 'table' | 'file' | 'document' | 'image' | 'agent_message'
type RegistryPort = { id: string; label: string; type: PortType; required: boolean; multiple: boolean }
type RegistryEntry = { type: string; category: string; label: string; inputs: RegistryPort[]; outputs: RegistryPort[]; available: boolean; disabledReason?: string; configurationRoute?: string }
type FlowNodeData = { label: string; registry?: RegistryEntry }
type FlowCopy = TFunction<'common'>
type FlowBinding = { kind: 'literal'; value: unknown } | { kind: 'variable'; variable: string } | { kind: 'port'; nodeId: string; portId: string }
type FlowDefinition = { schemaVersion: 1; id: string; name: string; description: string; revision: number; nodes: Array<{ id: string; type: string; label: string; position: { x: number; y: number }; bindings: Record<string, unknown>; config: Record<string, unknown>; policy: NodePolicy; disabled: boolean }>; edges: Array<{ id: string; sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string; conversionId?: string; branch: 'normal' | 'error' }>; variables: Record<string, unknown>; workspace?: string; publishedVersionId?: string; createdAt: string; updatedAt: string }
type NodePolicy = { timeoutMs: number; retryAttempts: number; retryBackoffMs: number; errorBehavior: 'fail' | 'error_edge' | 'continue'; concurrencyLimit: number; resumable: boolean; breakpoint: boolean }
type ValidationIssue = { code: string; severity: 'error' | 'warning'; message: string; nodeId?: string }
type FlowRun = { id: string; flowId?: string; status: string; input?: unknown; startedAt: string; updatedAt: string }
type FlowNodeRun = { id: string; nodeId: string; attempt: number; status: string; input?: unknown; output?: unknown; error?: string }
type FlowRunDetails = { run: FlowRun; nodeRuns: FlowNodeRun[]; events: Array<{ id: string; type: string; nodeId?: string; payload: unknown; createdAt: string }> }

const PORT_COLORS: Record<PortType, string> = { string: '#2563eb', number: '#7c3aed', boolean: '#ca8a04', json: '#64748b', table: '#0891b2', file: '#475569', document: '#0f766e', image: '#db2777', agent_message: '#ea580c' }
const PORT_CONVERSIONS: Record<string, { from: PortType; to: PortType }> = { 'string-to-number': { from: 'string', to: 'number' }, 'string-to-boolean': { from: 'string', to: 'boolean' }, 'string-to-json': { from: 'string', to: 'json' }, 'table-to-json': { from: 'table', to: 'json' }, 'file-to-document': { from: 'file', to: 'document' }, 'image-to-file': { from: 'image', to: 'file' }, 'agent-message-to-string': { from: 'agent_message', to: 'string' } }
const DEFAULT_POLICY: NodePolicy = { timeoutMs: 120000, retryAttempts: 0, retryBackoffMs: 1000, errorBehavior: 'fail', concurrencyLimit: 1, resumable: false, breakpoint: false }
const MODEL_NODE_TYPES = new Set(['agent', 'subagent', 'classification', 'parameter_extraction', 'image_generation', 'speech_generation', 'music_generation', 'video_generation'])
const FLOW_NODE_TYPES = { workwise: FlowNodeCard }
const FLOW_NODE_WIDTH = 180
const FLOW_NODE_HEIGHT = 80
const NODE_CONFIG_FIELDS: Record<string, Array<{ key: string; label: string; kind?: 'number' | 'boolean' | 'json'; required?: boolean; placeholder?: string }>> = {
  schedule_trigger: [],
  webhook_trigger: [{ key: 'credentialRef', label: 'Webhook 密钥引用', required: true }],
  agent: [{ key: 'prompt', label: '系统提示词', required: true }], subagent: [{ key: 'prompt', label: '委派提示词', required: true }],
  knowledge_retrieval: [{ key: 'attachmentId', label: '附件 ID' }, { key: 'query', label: '检索词' }, { key: 'limit', label: '结果上限', kind: 'number' }],
  classification: [{ key: 'categories', label: '分类列表(JSON)', kind: 'json', required: true }, { key: 'prompt', label: '分类说明' }],
  parameter_extraction: [{ key: 'schema', label: '参数 Schema(JSON)', kind: 'json', required: true }, { key: 'prompt', label: '抽取说明' }],
  http: [{ key: 'url', label: 'URL', required: true, placeholder: 'https://...' }, { key: 'method', label: '方法', placeholder: 'GET' }, { key: 'headers', label: '请求头(JSON)', kind: 'json' }, { key: 'body', label: '请求体(JSON)', kind: 'json' }, { key: 'allowLoopback', label: '允许本机 HTTP', kind: 'boolean' }],
  restricted_code: [{ key: 'source', label: '受限代码', required: true }], condition: [{ key: 'path', label: '字段路径' }, { key: 'operator', label: '条件操作符', placeholder: 'equals / exists / truthy' }, { key: 'value', label: '比较值(JSON)', kind: 'json' }],
  switch: [{ key: 'path', label: '字段路径' }, { key: 'cases', label: '分支(JSON)', kind: 'json', required: true }, { key: 'defaultBranch', label: '默认分支' }],
  loop: [{ key: 'maxIterations', label: '最大循环次数', kind: 'number', required: true }],
  human_approval: [{ key: 'summary', label: '审批说明' }], alert_confirmation: [{ key: 'summary', label: '告警说明' }],
  docx_output: [{ key: 'outputPath', label: '输出路径', required: true }], xlsx_output: [{ key: 'outputPath', label: '输出路径', required: true }], pdf_output: [{ key: 'outputPath', label: '输出路径', required: true }], pptx_output: [{ key: 'outputPath', label: '输出路径', required: true }],
  run_flow: [{ key: 'flowId', label: '目标流程标识', required: true }]
}

export function createStarterFlowInput(id: string, options: { triggerType?: 'manual' | 'scheduled'; translate?: FlowCopy } = {}): Omit<FlowDefinition, 'revision' | 'createdAt' | 'updatedAt' | 'publishedVersionId'> {
  const triggerType = options.triggerType ?? 'manual'
  const scheduled = triggerType === 'scheduled'
  const translate = options.translate
  const triggerId = `manual_${crypto.randomUUID().slice(0, 8)}`
  const agentId = `agent_${crypto.randomUUID().slice(0, 8)}`
  return {
    schemaVersion: 1,
    id,
    name: translate?.(scheduled ? 'workflow.starterScheduledName' : 'workflow.starterName')
      ?? (scheduled ? '我的第一个定时流程' : '我的第一个流程'),
    description: translate?.(scheduled ? 'workflow.starterScheduledDescription' : 'workflow.starterDescription')
      ?? (scheduled ? '按设定时间启动，由智能体按要求处理。' : '手动启动，由智能体按要求处理。'),
    nodes: [
      {
        id: triggerId,
        type: triggerType === 'scheduled' ? 'schedule_trigger' : 'manual_trigger',
        label: translate?.(scheduled ? 'workflow.node.schedule_trigger' : 'workflow.node.manual_trigger')
          ?? (scheduled ? '定时触发' : '手动触发'),
        position: { x: 120, y: 180 },
        bindings: {},
        config: triggerType === 'scheduled' ? { kind: 'interval', everyMinutes: 15, timezone: 'Asia/Shanghai' } : {},
        policy: { ...DEFAULT_POLICY },
        disabled: false
      },
      {
        id: agentId,
        type: 'agent',
        label: translate?.('workflow.node.agent') ?? '智能体处理',
        position: { x: 420, y: 180 },
        bindings: {},
        config: { prompt: translate?.('workflow.starterPrompt') ?? '请根据输入完成任务，并返回清晰、可核验的结果。' },
        policy: { ...DEFAULT_POLICY, retryAttempts: 1, resumable: true },
        disabled: false
      }
    ],
    edges: [{
      id: `edge_${crypto.randomUUID().slice(0, 8)}`,
      sourceNodeId: triggerId,
      sourcePortId: 'output',
      targetNodeId: agentId,
      targetPortId: 'input',
      branch: 'normal'
    }],
    variables: {}
  }
}

export function FlowWorkspaceView({ leftSidebarCollapsed, onToggleLeftSidebar, filter }: { leftSidebarCollapsed: boolean; onToggleLeftSidebar: () => void; filter: FlowListFilter }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [flows, setFlows] = useState<FlowDefinition[]>([]); const [registry, setRegistry] = useState<RegistryEntry[]>([])
  const [activeId, setActiveId] = useState<string | null>(null); const [draft, setDraft] = useState<FlowDefinition | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const flowWritePending = useRef(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [runs, setRuns] = useState<FlowRun[]>([]); const [mockInput, setMockInput] = useState('{}'); const [busy, setBusy] = useState<string | null>(null); const [error, setError] = useState<FlowViewError | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null); const [runDetails, setRunDetails] = useState<FlowRunDetails | null>(null)
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<Node<FlowNodeData>, Edge> | null>(null)

  const visibleFlows = useMemo(() => flows.filter((flow) => flowMatchesFilter(flow, filter)), [filter, flows])
  const load = useCallback(async () => { setBusy('loading'); try { const result = await runtimeJson<{ flows: FlowDefinition[]; registry: RegistryEntry[] }>('/v1/flows'); setFlows(result.flows); setRegistry(result.registry); const filtered = result.flows.filter((flow) => flowMatchesFilter(flow, filter)); const selected = filtered.find((flow) => flow.id === activeIdRef.current) ?? filtered[0] ?? null; activeIdRef.current = selected?.id ?? null; setActiveId(selected?.id ?? null); setDraft(selected); setError(null) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }, [filter])
  useEffect(() => {
    const requested = takeRequestedFlow()
    if (requested?.flowId) {
      activeIdRef.current = requested.flowId
      setSelectedRunId(requested.flowRunId ?? null)
    }
    const selection = surveyDraftSelection()
    if (selection?.kind === 'flow') {
      activeIdRef.current = selection.flowId
      setSelectedRunId(selection.runId)
      clearSurveyDraftSelection()
    }
    void load()
  }, [load])
  useEffect(() => {
    const open = (event: Event): void => {
      const reference = (event as CustomEvent<FlowReference>).detail
      takeRequestedFlow()
      if (!reference.flowId) return
      activeIdRef.current = reference.flowId
      setSelectedRunId(reference.flowRunId ?? null)
      void load()
    }
    window.addEventListener('railwise:open-flow', open)
    return () => window.removeEventListener('railwise:open-flow', open)
  }, [load])
  useEffect(() => {
    let current = true
    if (!activeId) { setRuns([]); return }
    void runtimeJson<{ runs: FlowRun[] }>(`/v1/flows/${encodeURIComponent(activeId)}/history`).then(value => {
      if (!current) return
      setRuns(value.runs)
      setSelectedRunId(previous => value.runs.some(item => item.id === previous) ? previous : value.runs[0]?.id ?? null)
    }).catch(reason => { if (current) { setRuns([]); setError({ key: 'workflow.historyUnavailable', detail: message(reason) }) } })
    return () => { current = false }
  }, [activeId])
  useEffect(() => {
    let current = true; let timer: ReturnType<typeof setTimeout> | undefined
    setRunDetails(null)
    if (!selectedRunId || !activeId) return
    const refresh = async (): Promise<void> => {
      try {
        const value = await runtimeJson<FlowRunDetails>(`/v1/flow-runs/${encodeURIComponent(selectedRunId)}`)
        if (!current) return
        if (value.run.id !== selectedRunId || value.run.flowId && value.run.flowId !== activeId) throw new Error('run-selection-mismatch')
        setRunDetails(value); setError(null)
        setRuns(items => items.map(item => item.id === value.run.id ? value.run : item))
        if (['queued', 'running', 'waiting_approval', 'paused', 'interrupted'].includes(value.run.status)) timer = setTimeout(() => void refresh(), 2000)
      } catch (reason) {
        if (current) { setRunDetails(null); setError(flowViewError(reason)); timer = setTimeout(() => void refresh(), 4000) }
      }
    }
    void refresh()
    return () => { current = false; clearTimeout(timer) }
  }, [selectedRunId, activeId])

  const nodes = useMemo<Node<FlowNodeData>[]>(() => (draft?.nodes ?? []).map((node) => ({
    id: node.id,
    type: 'workwise',
    position: node.position,
    width: FLOW_NODE_WIDTH,
    height: FLOW_NODE_HEIGHT,
    data: flowNodeDisplay(node, registry, t),
    selected: node.id === selectedNodeId
  })), [draft, registry, selectedNodeId, t])
  const edges = useMemo<Edge[]>(() => (draft?.edges ?? []).map((edge) => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePortId, target: edge.targetNodeId, targetHandle: edge.targetPortId, animated: false, style: { stroke: '#94a3b8' } })), [draft])
  const selectedNode = draft?.nodes.find((node) => node.id === selectedNodeId) ?? null
  const canvasFlowId = draft?.id

  useEffect(() => {
    if (!flowInstance || !canvasFlowId || nodes.length === 0) return
    const frame = window.requestAnimationFrame(() => {
      void flowInstance.fitView({ padding: 0.2, minZoom: 0.4, maxZoom: 1.2, duration: 0 })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [canvasFlowId, flowInstance, nodes.length])

  const onNodesChange = (changes: NodeChange<Node<FlowNodeData>>[]) => {
    const flowId = draft?.id
    if (!flowId) return
    const positions = new Map<string, { x: number; y: number }>()
    for (const change of changes) if (change.type === 'position' && change.position) positions.set(change.id, change.position)
    if (positions.size === 0) return
    setDraft(current => {
      if (!current || current.id !== flowId) return current
      let moved = false
      const next = current.nodes.map(node => {
        const position = positions.get(node.id)
        if (!position || position.x === node.position.x && position.y === node.position.y) return node
        moved = true
        return { ...node, position }
      })
      return moved ? { ...current, nodes: next } : current
    })
  }
  const onEdgesChange = (changes: EdgeChange<Edge>[]) => {
    const flowId = draft?.id
    if (!flowId) return
    setDraft(current => {
      if (!current || current.id !== flowId) return current
      const previous: Edge[] = current.edges.map(edge => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePortId, target: edge.targetNodeId, targetHandle: edge.targetPortId }))
      const next = applyEdgeChanges(changes, previous).map(edge => {
        const existing = current.edges.find(item => item.id === edge.id)
        const sourcePortId = edge.sourceHandle ?? 'output', targetPortId = edge.targetHandle ?? 'input'
        if (existing && existing.sourceNodeId === edge.source && existing.sourcePortId === sourcePortId && existing.targetNodeId === edge.target && existing.targetPortId === targetPortId) return existing
        return { ...existing, id: edge.id, sourceNodeId: edge.source, sourcePortId, targetNodeId: edge.target, targetPortId, branch: existing?.branch ?? 'normal' as const }
      })
      return next.length === current.edges.length && next.every((edge, index) => edge === current.edges[index]) ? current : { ...current, edges: next }
    })
  }
  const onConnect = (connection: Connection) => { if (!draft || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return; const source = registry.find((entry) => entry.type === draft.nodes.find((node) => node.id === connection.source)?.type)?.outputs.find((port) => port.id === connection.sourceHandle); const target = registry.find((entry) => entry.type === draft.nodes.find((node) => node.id === connection.target)?.type)?.inputs.find((port) => port.id === connection.targetHandle); const compatibility = source && target ? flowPortCompatibility(source.type, target.type) : null; if (!compatibility) { setError({ key: 'workflow.invalidConnection', detail: `${source?.type ?? '?'} → ${target?.type ?? '?'}` }); return } const flowId = draft.id; const sourceNodeId = connection.source, sourcePortId = connection.sourceHandle, targetNodeId = connection.target, targetPortId = connection.targetHandle; setDraft(current => { if (!current || current.id !== flowId) return current; const existing: Edge[] = current.edges.map(edge => ({ id: edge.id, source: edge.sourceNodeId, sourceHandle: edge.sourcePortId, target: edge.targetNodeId, targetHandle: edge.targetPortId })); const next = addEdge(connection, existing); if (next.length === existing.length) return current; const item = next.at(-1)!; return { ...current, edges: [...current.edges, { id: item.id, sourceNodeId, sourcePortId, targetNodeId, targetPortId, ...(compatibility.conversionId ? { conversionId: compatibility.conversionId } : {}), branch: 'normal' }] } }); setError(null) }
  const addNode = (entry: RegistryEntry) => { if (!draft || !entry.available) return; const id = `${entry.type}_${crypto.randomUUID().slice(0, 8)}`; const next = { id, type: entry.type, label: flowNodeName(t, entry.type, entry.label), position: { x: 180 + draft.nodes.length * 24, y: 100 + draft.nodes.length * 20 }, bindings: {}, config: entry.type === 'loop' ? { maxIterations: 10 } : {}, policy: { ...DEFAULT_POLICY }, disabled: false }; setDraft({ ...draft, nodes: [...draft.nodes, next] }); setSelectedNodeId(id) }
  const createFlow = async () => { setBusy('create'); try { const id = `flow_${crypto.randomUUID()}`; const value = await runtimeJson<{ flow: FlowDefinition }>('/v1/flows', 'POST', createStarterFlowInput(id, { triggerType: filter === 'scheduled' ? 'scheduled' : 'manual', translate: t })); activeIdRef.current = id; setFlows((current) => [value.flow, ...current]); setActiveId(id); setDraft(value.flow); setSelectedNodeId(value.flow.nodes.find((node) => node.type === 'agent')?.id ?? null); setIssues([]); setError(null) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }
  const adoptServerFlow = (flow: FlowDefinition) => {
    setDraft(current => current?.id === flow.id ? flow : current)
    setFlows(current => current.map(item => item.id === flow.id ? flow : item))
  }
  const persistDraft = async (definition: FlowDefinition): Promise<FlowDefinition> => {
    const value = await runtimeJson<{ flow: FlowDefinition }>(`/v1/flows/${definition.id}`, 'PUT', { definition, expectedRevision: definition.revision })
    adoptServerFlow(value.flow)
    return value.flow
  }
  const writeFlow = async (action: string, operation: () => Promise<void>): Promise<void> => {
    if (flowWritePending.current || busy !== null) return
    flowWritePending.current = true
    setBusy(action)
    try { await operation(); setError(null) } catch (reason) { setError(flowViewError(reason)) } finally { flowWritePending.current = false; setBusy(null) }
  }
  const readPublishedFlow = async (id: string): Promise<void> => {
    const value = await runtimeJson<{ flow: FlowDefinition }>(`/v1/flows/${encodeURIComponent(id)}`)
    adoptServerFlow(value.flow)
  }
  const save = async () => { if (!draft) return; await writeFlow('save', async () => { await persistDraft(draft) }) }
  const setScheduleEnabled = async (enabled: boolean) => {
    if (!draft?.variables.taskSchedule) return
    await writeFlow('schedule', async () => {
      const saved = await persistDraft({ ...draft, variables: { ...draft.variables, enabled } })
      const published = await runtimeJson<{ published: boolean }>(`/v1/flows/publish`, 'POST', { id: saved.id })
      if (!published.published) throw new Error('计划状态未能保存，请刷新核对。')
      await readPublishedFlow(saved.id)
    })
  }
  const validate = async (): Promise<void> => {
    if (!draft) return
    await writeFlow('validate', async () => {
      const result = await runtimeJson<{ issues: ValidationIssue[] }>('/v1/flows/validate', 'POST', { definition: draft })
      setIssues(result.issues)
    })
  }
  const publish = async () => { if (!draft) return; await writeFlow('publish', async () => { const saved = await persistDraft(draft); const result = await runtimeJson<{ published: boolean; validation: { issues: ValidationIssue[] } }>('/v1/flows/publish', 'POST', { id: saved.id }); setIssues(result.validation.issues); if (!result.published) throw new Error('发布校验未通过'); await readPublishedFlow(saved.id) }) }
  const run = async () => { if (!draft) return; setBusy('run'); try { const input = JSON.parse(mockInput); const result = await runtimeJson<{ run: FlowRun }>('/v1/flows/run', 'POST', { flowId: draft.id, input, invocationStack: [] }); setRuns((current) => [result.run, ...current.filter((item) => item.id !== result.run.id)]) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }
  const testNode = async () => { if (!draft || !selectedNodeId) return; setBusy('test'); try { await runtimeJson('/v1/flows/test-node', 'POST', { definition: draft, nodeId: selectedNodeId, mockInput: JSON.parse(mockInput) }) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }
  const cancelRun = async () => { const active = runs.find((item) => item.id === selectedRunId && ['queued', 'running', 'waiting_approval', 'paused', 'interrupted'].includes(item.status)); if (!active) return; setBusy('cancel'); try { await runtimeJson(`/v1/flow-runs/${active.id}/cancel`, 'POST', {}); const details = await runtimeJson<FlowRunDetails>(`/v1/flow-runs/${active.id}`); setRunDetails(details); setRuns(current => current.map(item => item.id === active.id ? details.run : item)); setError(null) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }
  const exportRedacted = async () => { if (!draft) return; setBusy('export'); try { const result = await runtimeJson<{ flow: unknown }>(`/v1/flows/${draft.id}/export`); const json = `${JSON.stringify(result.flow, null, 2)}\n`; const saved = await window.workwise.saveWorkspaceFileAs({ suggestedName: `${safeFileName(draft.name)}.workwise-flow.json`, dataBase64: utf8Base64(json), mimeType: 'application/json' }); if (!saved.ok && !saved.canceled) throw new Error(saved.message) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }
  const runAction = async (action: 'resume' | 'retry' | 'approve' | 'reject', nodeId?: string) => { if (!selectedRunId) return; setBusy(action); try { if (action === 'approve' || action === 'reject') await runtimeJson('/v1/flow-runs/decision', 'POST', { runId: selectedRunId, nodeId, decision: action }); else await runtimeJson(`/v1/flow-runs/${selectedRunId}/${action}`, 'POST', action === 'retry' ? { nodeId } : {}); const details = await runtimeJson<FlowRunDetails>(`/v1/flow-runs/${selectedRunId}`); setRunDetails(details); setRuns((current) => current.map((item) => item.id === details.run.id ? details.run : item)) } catch (reason) { setError(flowViewError(reason)) } finally { setBusy(null) } }

  if (draft && typeof draft.variables.surveyDraftId === 'string') return <div className="ds-opaque-work-surface flex h-full min-h-0 flex-col bg-ds-main text-ds-ink">
    <header className="ds-drag flex min-h-14 shrink-0 items-center gap-3 border-b border-ds-border bg-ds-card px-4">
      {leftSidebarCollapsed ? <SidebarTitlebarToggleButton onClick={onToggleLeftSidebar} title={t('surveyReviewFlowSidebar')} ariaLabel={t('surveyReviewFlowSidebar')} /> : null}
      <Workflow className="h-5 w-5 text-accent" aria-hidden="true" /><h1 className="text-base font-semibold">{t('surveyReviewFlowTitle')}</h1>
    </header>
    <SurveyReviewFlowPanel key={`${draft.id}:${selectedRunId}`} name={draft.name} draftId={draft.variables.surveyDraftId} workspace={draft.workspace} details={runDetails} busy={busy !== null} error={error !== null}
      onAction={(action, nodeId) => void runAction(action, nodeId)} onCancel={() => void cancelRun()} onReturn={() => useChatStore.getState().openEngineering()}
      onAdvanced={() => runDetails ? <RunDetailsPanel details={runDetails} nodes={draft.nodes} onAction={(action, nodeId) => void runAction(action, nodeId)} busy={busy !== null} /> : <p className="pb-3 text-xs text-ds-muted">{t('surveyReviewFlowStatus.loading')}</p>} />
  </div>

  return <div className="ds-opaque-work-surface flex h-full min-h-0 flex-col bg-[#f8fafc] text-[#1e293b] dark:bg-ds-main dark:text-white">
    <header className="ds-drag flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-[#e2e8f0] bg-white px-4 py-2 dark:border-ds-border dark:bg-ds-card">
      {leftSidebarCollapsed ? <SidebarTitlebarToggleButton onClick={onToggleLeftSidebar} title={t('sidebarExpand')} ariaLabel={t('sidebarExpand')} /> : null}
      <Workflow className="h-5 w-5 shrink-0 text-blue-600" aria-hidden="true" />
      <h1 className="text-[16px] font-semibold">{t(filter === 'scheduled' ? 'workflow.scheduledTitle' : 'flow')}</h1>
      <select className="ds-no-drag min-w-0 max-w-full rounded-lg border border-[#e2e8f0] bg-white px-3 py-1.5 text-[13px] dark:border-ds-border dark:bg-ds-main"
        aria-label={t('workflow.select')} value={activeId ?? ''} onChange={(event) => {
          const flow = visibleFlows.find((item) => item.id === event.target.value) ?? null
          activeIdRef.current = flow?.id ?? null
          setActiveId(flow?.id ?? null)
          setDraft(flow)
        }}>
        <option value="">{t('workflow.select')}</option>{visibleFlows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name}</option>)}
      </select>
      <button className="ds-no-drag rounded-lg border border-[#e2e8f0] px-3 py-1.5 text-[13px] hover:bg-slate-50 dark:border-ds-border" onClick={() => void createFlow()}>{t('workflow.create')}</button>
      <div className="ml-auto flex max-w-full flex-wrap gap-2">
        {draft?.variables.taskSchedule ? <button disabled={busy !== null} className="ds-no-drag rounded-lg border border-ds-border px-3 py-1.5 text-[13px]" onClick={() => void setScheduleEnabled(draft.variables.enabled === false)}>{t(draft.variables.enabled === false ? 'workflow.enableSchedule' : 'workflow.pauseSchedule')}</button> : null}
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-blue-600" aria-hidden="true" /> : null}
        <Action icon={<Save />} label={t('workflow.save')} disabled={busy !== null || !draft} onClick={() => void save()} />
        <Action icon={<CheckCircle2 />} label={t('workflow.validate')} disabled={busy !== null || !draft} onClick={() => void validate()} />
        <Action icon={<Download />} label={t('workflow.export')} disabled={busy !== null || !draft} onClick={() => void exportRedacted()} />
        <Action icon={<Send />} label={t('workflow.publish')} disabled={busy !== null || !draft} primary onClick={() => void publish()} />
        <Action icon={<Play />} label={t('workflow.run')} disabled={busy !== null || !draft} primary onClick={() => void run()} />
        {runs.some((item) => ['queued', 'running', 'waiting_approval', 'paused', 'interrupted'].includes(item.status))
          ? <Action icon={<Square />} label={t('cancel')} disabled={busy !== null || !draft} onClick={() => void cancelRun()} /> : null}
      </div>
    </header>
    {error ? <div className="border-b border-ds-border bg-ds-card px-4 py-2 text-xs">
      <p role="alert" className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />{t(error.key)}</p>
      {error.detail ? <TechnicalDetails><pre className="whitespace-pre-wrap break-words">{error.detail}</pre></TechnicalDetails> : null}
    </div> : null}
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(320px,1fr)_auto] lg:grid-cols-[220px_minmax(360px,1fr)_320px] lg:grid-rows-1">
      <aside className="max-h-44 overflow-y-auto border-b border-r border-[#e2e8f0] bg-white p-3 dark:border-ds-border dark:bg-ds-card lg:max-h-none">
        <div className="mb-3 text-[12px] font-semibold text-ds-muted">{t('workflow.catalogue')}</div>
        {registry.length === 0 && busy === 'loading' ? <LoadingState label={t('workflow.catalogueLoading')} /> : groupRegistry(registry).map(([category, entries]) => <section key={category} className="mb-4">
          <h2 className="mb-1.5 text-[11px] font-medium text-ds-muted">{t(`workflow.category.${category}`, { defaultValue: t('workflow.category.other') })}</h2>
          <div className="space-y-1">{entries.map((entry) => {
            const name = flowNodeName(t, entry.type, entry.label)
            const availability = flowRegistryAvailabilityLabel(entry, t)
            return <button key={entry.type} disabled={!entry.available || !draft} title={availability} aria-label={`${name}. ${availability}`} onClick={() => addNode(entry)} className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-[12px] hover:border-blue-100 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-blue-400/10">
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /><span className="truncate">{name}</span>
            </button>
          })}</div>
        </section>)}
      </aside>
      <main className="relative min-h-[320px] min-w-0 bg-[radial-gradient(circle,#cbd5e1_1px,transparent_1px)] [background-size:20px_20px]">{busy === 'loading' && !draft ? <LoadingState label={t('workflow.loading')} /> : !draft ? <EmptyState onCreate={() => void createFlow()} /> : <ReactFlow key={draft.id} aria-label={t('workflow.canvas')} className="h-full w-full" style={{ width: '100%', height: '100%' }} nodes={nodes} edges={edges} nodeTypes={FLOW_NODE_TYPES} onInit={setFlowInstance} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, node) => setSelectedNodeId(node.id)} fitView fitViewOptions={{ padding: 0.2, minZoom: 0.4, maxZoom: 1.2 }} deleteKeyCode={['Backspace', 'Delete']} selectionOnDrag multiSelectionKeyCode="Shift"><MiniMap pannable zoomable nodeColor="#2563eb" /><Controls /><Background gap={20} size={1} color="transparent" /></ReactFlow>}</main>
      <aside className="min-h-0 overflow-y-auto border-l border-[#e2e8f0] bg-white p-4 dark:border-ds-border dark:bg-ds-card"><FlowNodeInspector node={selectedNode} entry={selectedNode ? registry.find((item) => item.type === selectedNode.type) : undefined} allNodes={draft?.nodes ?? []} registry={registry} variables={draft?.variables ?? {}} onChange={(next) => draft && setDraft({ ...draft, nodes: draft.nodes.map((item) => item.id === next.id ? next : item) })} mockInput={mockInput} onMockInput={setMockInput} onTest={() => void testNode()} busy={busy === 'test'} /><div className="my-5 border-t border-[#e2e8f0] dark:border-ds-border" /><div className="mb-2 flex items-center gap-2 text-[13px] font-semibold"><History className="h-4 w-4" aria-hidden="true" />{t('workflow.history')}</div><div className="space-y-2">{runs.slice(0, 20).map((runItem) => <button type="button" onClick={() => setSelectedRunId(runItem.id)} key={runItem.id} className={`w-full rounded-lg border p-2 text-left text-[11px] dark:border-ds-border ${selectedRunId === runItem.id ? 'border-blue-400 bg-blue-50' : 'border-[#e2e8f0]'}`}><div className="flex items-center justify-between"><time dateTime={runItem.startedAt}>{new Date(runItem.startedAt).toLocaleString(i18n.language)}</time><Status value={runItem.status} /></div></button>)}</div>{runDetails ? <RunDetailsPanel details={runDetails} nodes={draft?.nodes} onAction={(action, nodeId) => void runAction(action, nodeId)} busy={busy !== null} /> : null}{issues.length ? <section className="mt-5 border-t border-ds-border pt-3"><p role="status" className="text-xs">{t('workflow.validationIssues', { count: issues.length })}</p><TechnicalDetails><ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul></TechnicalDetails></section> : null}</aside>
    </div>
  </div>
}

function flowNodeName(t: FlowCopy, type: string, fallback?: string): string {
  return t(`workflow.node.${type}`, { defaultValue: fallback && fallback !== type ? fallback : t('workflow.node.other') })
}

function flowNodeDisplay(node: FlowDefinition['nodes'][number], registry: RegistryEntry[], t: FlowCopy): FlowNodeData {
  const entry = registry.find((item) => item.type === node.type)
  const title = node.label.trim()
  const label = title && title !== node.type && title !== entry?.label ? title : flowNodeName(t, node.type, entry?.label)
  return { label, registry: entry }
}

function FlowNodeCard({ data, selected }: NodeProps<Node<FlowNodeData>>): ReactElement {
  const { t } = useTranslation('common')
  return <div role="group" aria-label={data.label} className={`min-w-[180px] rounded-xl border bg-white shadow-sm ${selected ? 'border-blue-500 ring-2 ring-blue-100' : 'border-[#e2e8f0]'}`}>
    <div className="border-b border-[#e2e8f0] px-3 py-2 text-[12px] font-semibold">{data.label}</div>
    <div className="relative flex min-h-8 justify-between gap-4 px-2 py-2">
      <div>{data.registry?.inputs.map((port, index) => {
        const name = t(`workflow.port.${port.id}`, { defaultValue: port.label })
        return <div key={port.id} className="relative text-[9px] text-ds-muted">
          <Handle id={port.id} type="target" position={Position.Left} aria-label={name} style={{ top: 12 + index * 18, background: PORT_COLORS[port.type] }} />{name}
        </div>
      })}</div>
      <div className="ml-auto">{data.registry?.outputs.map((port, index) => {
        const name = t(`workflow.port.${port.id}`, { defaultValue: port.label })
        return <div key={port.id} className="relative text-right text-[9px] text-ds-muted">{name}
          <Handle id={port.id} type="source" position={Position.Right} aria-label={name} style={{ top: 12 + index * 18, background: PORT_COLORS[port.type] }} />
        </div>
      })}</div>
    </div>
  </div>
}
export function FlowNodeInspector({ node, entry, allNodes, registry, variables, onChange, mockInput, onMockInput, onTest, busy }: { node: FlowDefinition['nodes'][number] | null; entry?: RegistryEntry; allNodes: FlowDefinition['nodes']; registry: RegistryEntry[]; variables: Record<string, unknown>; onChange: (node: FlowDefinition['nodes'][number]) => void; mockInput: string; onMockInput: (value: string) => void; onTest: () => void; busy: boolean }): ReactElement {
  const { t } = useTranslation('common')
  if (!node) return <div className="py-10 text-center text-[12px] text-ds-muted">{t('workflow.chooseStep')}</div>
  const policy = node.policy; const bindings = node.bindings as Record<string, FlowBinding>
  const changePolicy = (patch: Partial<NodePolicy>) => onChange({ ...node, policy: { ...policy, ...patch } })
  const changeConfig = (key: string, value: unknown) => onChange({ ...node, config: { ...node.config, [key]: value } })
  const changeBinding = (portId: string, binding: FlowBinding) => onChange({ ...node, bindings: { ...node.bindings, [portId]: binding } })
  const portOptions = allNodes.filter((item) => item.id !== node.id).flatMap((item) => (registry.find((candidate) => candidate.type === item.type)?.outputs ?? []).map((port) => ({ value: `${item.id}:${port.id}`, label: `${item.label} · ${port.label}` })))
  return <div><div className="mb-3 text-[13px] font-semibold">{t('workflow.stepSettings')}</div><Field label={t('workflow.stepName')}><input value={node.label} onChange={(event) => onChange({ ...node, label: event.target.value })} /></Field>
    {entry?.inputs.length ? <section className="mt-4"><div className="text-[11px] font-semibold text-[#475569]">输入绑定</div>{entry.inputs.map((port) => { const binding = bindings[port.id] ?? { kind: 'literal', value: '' }; return <div key={port.id} className="mt-2 rounded-lg border border-[#e2e8f0] p-2"><div className="flex items-center justify-between text-[11px]"><span>{port.label}{port.required ? ' *' : ''}</span><span className="text-[9px] text-[#94a3b8]">{port.type}</span></div><select className="mt-1 w-full rounded border border-[#e2e8f0] px-2 py-1 text-[11px]" value={binding.kind} onChange={(event) => changeBinding(port.id, event.target.value === 'variable' ? { kind: 'variable', variable: Object.keys(variables)[0] ?? '' } : event.target.value === 'port' ? { kind: 'port', nodeId: '', portId: '' } : { kind: 'literal', value: '' })}><option value="literal">常量</option><option value="variable">流程变量</option><option value="port">节点输出</option></select>{binding.kind === 'literal' ? <textarea className="mt-1 w-full rounded border border-[#e2e8f0] p-1.5 font-mono text-[10px]" value={formatConfigValue(binding.value)} onChange={(event) => changeBinding(port.id, { kind: 'literal', value: parseConfigValue(event.target.value) })} /> : binding.kind === 'variable' ? <select className="mt-1 w-full rounded border border-[#e2e8f0] px-2 py-1 text-[11px]" value={binding.variable} onChange={(event) => changeBinding(port.id, { kind: 'variable', variable: event.target.value })}><option value="">选择变量</option>{Object.keys(variables).map((key) => <option key={key}>{key}</option>)}</select> : <select className="mt-1 w-full rounded border border-[#e2e8f0] px-2 py-1 text-[11px]" value={`${binding.nodeId}:${binding.portId}`} onChange={(event) => { const [nodeId, portId] = event.target.value.split(':'); changeBinding(port.id, { kind: 'port', nodeId: nodeId ?? '', portId: portId ?? '' }) }}><option value=":">选择节点输出</option>{portOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}</div> })}</section> : null}
    {MODEL_NODE_TYPES.has(node.type) ? <div className="grid grid-cols-2 gap-2"><Field label="提供商"><input value={String(node.config.provider ?? '')} onChange={(event) => changeConfig('provider', event.target.value)} placeholder="默认" /></Field><Field label="模型"><input value={String(node.config.model ?? '')} onChange={(event) => changeConfig('model', event.target.value)} placeholder="默认模型" /></Field></div> : null}
    {node.type === 'schedule_trigger' ? <><ScheduleConfigFields config={node.config} onChange={config => onChange({ ...node, config })} /><ScheduleAuthoritySummary value={variables.taskSchedule} /></> : null}
    {(NODE_CONFIG_FIELDS[node.type] ?? []).map((field) => <Field key={field.key} label={`${field.label}${field.required ? ' *' : ''}`}>{field.kind === 'boolean' ? <input type="checkbox" checked={node.config[field.key] === true} onChange={(event) => changeConfig(field.key, event.target.checked)} /> : field.kind === 'json' ? <textarea rows={3} className="font-mono" value={formatConfigValue(node.config[field.key])} onChange={(event) => changeConfig(field.key, parseConfigValue(event.target.value))} placeholder={field.placeholder} /> : <input type={field.kind === 'number' ? 'number' : 'text'} value={String(node.config[field.key] ?? '')} onChange={(event) => changeConfig(field.key, field.kind === 'number' ? Number(event.target.value) : event.target.value)} placeholder={field.placeholder} />}</Field>)}
    <details className="mt-4 border-t border-ds-border pt-2"><summary className="cursor-pointer text-xs text-ds-muted">{t('workflow.advancedStepSettings')}</summary><div className="grid grid-cols-2 gap-2"><Field label="超时(ms)"><input type="number" min={100} max={3600000} value={policy.timeoutMs} onChange={(event) => changePolicy({ timeoutMs: Number(event.target.value) })} /></Field><Field label="重试次数"><input type="number" min={0} max={10} value={policy.retryAttempts} onChange={(event) => changePolicy({ retryAttempts: Number(event.target.value) })} /></Field><Field label="退避(ms)"><input type="number" min={0} max={300000} value={policy.retryBackoffMs} onChange={(event) => changePolicy({ retryBackoffMs: Number(event.target.value) })} /></Field><Field label="并发限制"><input type="number" min={1} max={64} value={policy.concurrencyLimit} onChange={(event) => changePolicy({ concurrencyLimit: Number(event.target.value) })} /></Field></div><Field label="错误处理"><select className="w-full rounded-lg border border-[#e2e8f0] px-2 py-1.5" value={policy.errorBehavior} onChange={(event) => changePolicy({ errorBehavior: event.target.value as NodePolicy['errorBehavior'] })}><option value="fail">失败并停止</option><option value="error_edge">错误分支</option><option value="continue">记录后继续</option></select></Field><label className="mt-2 flex items-center gap-2 text-[11px]"><input type="checkbox" checked={policy.resumable} onChange={(event) => changePolicy({ resumable: event.target.checked })} />可恢复</label><label className="mt-2 flex items-center gap-2 text-[11px]"><input type="checkbox" checked={policy.breakpoint} onChange={(event) => changePolicy({ breakpoint: event.target.checked })} />断点</label><Field label="测试数据（JSON）"><textarea rows={5} value={mockInput} onChange={(event) => onMockInput(event.target.value)} className="font-mono" /></Field><button onClick={onTest} disabled={busy} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] text-blue-700 disabled:opacity-50"><TestTube2 className="h-4 w-4" />单节点测试</button></details></div>
}
export function ScheduleAuthoritySummary({ value }: { value: unknown }): ReactElement | null {
  const { t } = useTranslation('common')
  if (!value || typeof value !== 'object') return null
  const saved = value as { authorization?: { until?: string }; scope?: { readPathAllowlist?: string[]; writePathAllowlist?: string[]; networkAllowlist?: string[]; browserScope?: { origins?: string[] } } }
  if (saved.authorization?.until !== 'disabled' || !saved.scope) return <p className="mt-3 text-xs text-ds-muted">{t('workflow.permissionReview')}</p>
  const delimiter = t('listSeparator', { defaultValue: ', ' })
  const scope = saved.scope
  return <section className="mt-3 space-y-2 rounded-lg border border-ds-border p-3 text-xs" aria-label={t('workflow.continuousPermission')}>
    <p>{t('workflow.permissionEnds')}</p>
    <p>{t('workflow.writeScope', { scope: scope.writePathAllowlist?.join(delimiter) || t('workflow.artifactDirectory') })}</p>
    <details><summary className="cursor-pointer">{t('workflow.showScopes')}</summary>
      <p className="mt-2 break-all">{t('workflow.readScope', { scope: scope.readPathAllowlist?.join(delimiter) || t('workflow.noReadScope') })}</p>
      <p className="mt-2 break-all">{t('workflow.networkScope', { scope: (scope.browserScope?.origins ?? scope.networkAllowlist)?.join(delimiter) || t('workflow.noNetworkScope') })}</p>
    </details>
  </section>
}

export function ScheduleConfigFields({ config, onChange }: { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }): ReactElement {
  const { t } = useTranslation('common')
  let normalized = config
  try { normalized = normalizeScheduleSpec(config) } catch { /* Keep incomplete edits visible for correction. */ }
  const kind = String(normalized.kind ?? 'manual')
  const update = (patch: Record<string, unknown>) => {
    const { schedule: _legacyExpression, ...current } = config
    onChange({ ...current, ...normalized, ...patch })
  }
  const times = Array.isArray(normalized.times) ? normalized.times.join(', ') : String(config.timeOfDay ?? '09:00')
  return <div className="space-y-2">
    <Field label={t('workflow.scheduleType')}><select aria-label={t('workflow.scheduleType')} value={kind} onChange={event => update({ kind: event.target.value })}>
      <option value="manual">{t('scheduleKind_manual')}</option>
      <option value="daily">{t('workflow.scheduleEveryDay')}</option>
      <option value="interval">{t('workflow.scheduleInterval')}</option>
      <option value="at">{t('workflow.scheduleOneOff')}</option>
    </select></Field>
    {kind === 'daily' ? <>
      <Field label={t('workflow.dailyTimes')}><input aria-label={t('workflow.dailyTimes')} value={times} placeholder="08:30, 16:30" onChange={event => update({ times: event.target.value.split(/[,，]/).map(value => value.trim()) })} /></Field>
      <Field label={t('workflow.timezone')}><input aria-label={t('workflow.timezone')} value={String(config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)} placeholder="Asia/Shanghai" onChange={event => update({ timezone: event.target.value })} /></Field>
    </> : null}
    {kind === 'interval' ? <Field label={t('scheduleEveryMinutes')}><input aria-label={t('scheduleEveryMinutes')} type="number" min={1} max={10080} value={Number(config.everyMinutes ?? 15)} onChange={event => update({ everyMinutes: Number(event.target.value) })} /></Field> : null}
    {kind === 'at' ? <Field label={t('scheduleRunAt')}><input aria-label={t('scheduleRunAt')} value={String(config.atTime ?? '')} placeholder="2026-11-14T09:00:00+08:00" onChange={event => update({ atTime: event.target.value })} /></Field> : null}
  </div>
}
function formatConfigValue(value: unknown): string { if (value === undefined) return ''; return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
function parseConfigValue(value: string): unknown { const trimmed = value.trim(); if (!trimmed) return ''; try { return JSON.parse(trimmed) } catch { return value } }
export function RunDetailsPanel({ details, nodes = [], onAction, busy }: {
  details: FlowRunDetails
  nodes?: FlowDefinition['nodes']
  onAction: (action: 'resume' | 'retry' | 'approve' | 'reject', nodeId?: string) => void
  busy: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const names = new Map(nodes.map((node) => [node.id, flowNodeDisplay(node, [], t).label]))
  const stepNumbers = new Map([...new Set(details.nodeRuns.map((nodeRun) => nodeRun.nodeId))].map((nodeId, index) => [nodeId, index + 1]))
  return <section className="mt-4 border-t border-ds-border pt-3">
    <div className="mb-2 flex items-center justify-between text-xs font-semibold"><span>{t('workflow.runDetails')}</span><Status value={details.run.status} /></div>
    {['interrupted', 'paused', 'failed'].includes(details.run.status) ? <button disabled={busy} onClick={() => onAction('resume')} className="mb-2 rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">{t('workflow.resume')}</button> : null}
    <div className="space-y-2">{details.nodeRuns.map((nodeRun) => <div key={nodeRun.id} className="rounded-lg border border-ds-border p-2 text-xs">
      <div className="flex items-center justify-between gap-2"><span>{names.get(nodeRun.nodeId) ?? t('workflow.step', { number: stepNumbers.get(nodeRun.nodeId) })}</span><Status value={nodeRun.status} /></div>
      {nodeRun.status === 'waiting_approval' || nodeRun.input !== undefined || nodeRun.output !== undefined || nodeRun.error || nodeRun.attempt > 1
        ? <TechnicalDetails label={nodeRun.status === 'waiting_approval' ? t('workflow.approvalReview') : undefined}>
        {nodeRun.attempt > 1 ? <p>{t('workflow.stepAttempt', { number: nodeRun.attempt })}</p> : null}
        {nodeRun.input !== undefined ? <JsonBlock label={t('workflow.stepInput')} value={nodeRun.input} /> : null}
        {nodeRun.output !== undefined ? <JsonBlock label={t('workflow.stepOutput')} value={nodeRun.output} /> : null}
        {nodeRun.error ? <pre className="mt-2 whitespace-pre-wrap break-words">{nodeRun.error}</pre> : null}
        {nodeRun.status === 'waiting_approval' ? <div className="mt-2 flex gap-2">
          <button disabled={busy} onClick={() => onAction('approve', nodeRun.nodeId)} className="rounded border border-ds-border px-2 py-1 text-accent">{t('workflow.approve')}</button>
          <button disabled={busy} onClick={() => onAction('reject', nodeRun.nodeId)} className="rounded border border-ds-border px-2 py-1">{t('approvalDeny')}</button>
        </div> : null}
      </TechnicalDetails> : null}
      {nodeRun.status === 'failed' ? <button disabled={busy} onClick={() => onAction('retry', nodeRun.nodeId)} className="mt-2 rounded border border-ds-border px-2 py-1 text-accent">{t('workflow.retryStep')}</button> : null}
    </div>)}</div>
    <TechnicalDetails label={t('workflow.eventRecord', { count: details.events.length })}>
      <pre className="whitespace-pre-wrap break-words">{JSON.stringify(details.events, null, 2)}</pre>
    </TechnicalDetails>
  </section>
}

function TechnicalDetails({ label, children }: { label?: string; children: ReactNode }): ReactElement {
  const { t } = useTranslation('common')
  return <details className="mt-2 text-xs text-ds-muted">
    <summary className="cursor-pointer">{label ?? t('technicalDetails')}</summary>
    <div className="mt-1 max-h-40 overflow-auto rounded bg-ds-main p-2">{children}</div>
  </details>
}

function JsonBlock({ label, value }: { label: string; value: unknown }): ReactElement {
  return <div className="mt-2"><div>{label}</div><pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(value, null, 2)}</pre></div>
}

type FlowViewError = { key: string; detail?: string }

class FlowRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

function flowViewError(reason: unknown): FlowViewError {
  const detail = message(reason)
  if (reason instanceof FlowRequestError && reason.status === 409) return { key: 'workflow.writeConflict', detail }
  if (reason instanceof SyntaxError) return { key: 'workflow.invalidTestInput', detail }
  return { key: 'workflow.actionFailed', detail }
}

function safeFileName(value: string): string { return value.trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || 'flow' }
function utf8Base64(value: string): string { const bytes = new TextEncoder().encode(value); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
export function flowPortCompatibility(from: PortType, to: PortType): { conversionId?: string } | null { if (from === to) return {}; const conversion = Object.entries(PORT_CONVERSIONS).find(([, value]) => value.from === from && value.to === to); return conversion ? { conversionId: conversion[0] } : null }
export function flowRegistryAvailabilityLabel(entry: RegistryEntry, t: FlowCopy): string {
  if (entry.available) return t('workflow.available')
  if (entry.type === 'subagent') return t('workflow.unavailableSubagent')
  if (entry.type === 'publish') return t('workflow.unavailablePublish')
  if (entry.type === 'archive') return t('workflow.unavailableArchive')
  return t(entry.configurationRoute?.startsWith('settings') ? 'workflow.needsConnection' : 'workflow.unavailable')
}
function Field({ label, children }: { label: string; children: ReactElement }): ReactElement { return <label className="mt-2 block text-[11px] text-[#64748b]"><span className="mb-1 block">{label}</span><span className="[&>input]:w-full [&>input]:rounded-lg [&>input]:border [&>input]:border-[#e2e8f0] [&>input]:px-2 [&>input]:py-1.5 [&>textarea]:w-full [&>textarea]:rounded-lg [&>textarea]:border [&>textarea]:border-[#e2e8f0] [&>textarea]:p-2">{children}</span></label> }
function Action({ icon, label, onClick, primary, disabled }: { icon: ReactElement; label: string; onClick: () => void; primary?: boolean; disabled?: boolean }): ReactElement { return <button disabled={disabled} onClick={onClick} className={`ds-no-drag flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] ${primary ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-[#e2e8f0] bg-white hover:bg-slate-50 dark:border-ds-border dark:bg-ds-main'}`}>{<span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>}{label}</button> }
export function flowStatusClass(value: string): string { if (value === 'succeeded') return 'bg-green-100 text-green-700'; if (value === 'failed') return 'bg-red-100 text-red-700'; if (value === 'paused') return 'bg-yellow-100 text-yellow-700'; if (value.includes('approval') || value === 'interrupted') return 'bg-orange-100 text-orange-700'; if (value === 'cancelled' || value === 'skipped') return 'bg-slate-100 text-slate-600'; return 'bg-blue-100 text-blue-700' }
function Status({ value }: { value: string }): ReactElement { const { t } = useTranslation('common'); return <span className={`rounded px-1.5 py-0.5 ${flowStatusClass(value)}`}>{t(`workflow.status.${value}`, { defaultValue: t('workflow.status.unknown') })}</span> }
function LoadingState({ label }: { label: string }): ReactElement { return <div className="flex h-full min-h-24 items-center justify-center gap-2 text-[12px] text-blue-600"><Loader2 className="h-4 w-4 animate-spin" />{label}</div> }
function EmptyState({ onCreate }: { onCreate: () => void }): ReactElement {
  const { t } = useTranslation('common')
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
    <Workflow className="h-9 w-9 text-ds-muted" aria-hidden="true" />
    <p className="text-sm font-semibold">{t('workflow.empty')}</p>
    <button onClick={onCreate} className="rounded-lg bg-blue-600 px-3 py-2 text-xs text-white">{t('workflow.new')}</button>
  </div>
}
async function runtimeJson<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> { const response = await window.workwise.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body)); if (!response.ok) { let value: { message?: string } = {}; try { value = JSON.parse(response.body) } catch { /* empty */ } throw new FlowRequestError(value.message ?? `Runtime request failed (${response.status})`, response.status) } return JSON.parse(response.body) as T }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value) }
function groupRegistry(registry: RegistryEntry[]): Array<[string, RegistryEntry[]]> { const groups = new Map<string, RegistryEntry[]>(); for (const entry of registry) groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]); return [...groups.entries()] }
