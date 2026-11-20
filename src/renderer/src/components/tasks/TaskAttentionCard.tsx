import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskAttentionV1, TaskRunV1 } from '@shared/agent-workbench'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import { isMatchingExecutionGrantExpiredAttention } from '@shared/task-presentation'
import { ApprovalOperationDetails } from '../chat/ApprovalOperationDetails'
import { CapabilityRequiredCard } from '../chat/CapabilityRequiredCard'
import { redactRuntimeText } from '../chat/conversation-visibility'

type Question = { id: string; label: string; options?: Array<{ label: string; value?: string }> }
function attentionQuestions(item: TaskAttentionV1): Question[] {
  const candidate = item.payload?.questions
  if (!Array.isArray(candidate)) return []
  return candidate.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return []
    const record = value as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label : typeof record.question === 'string' ? record.question : item.title
    const options = Array.isArray(record.options) ? record.options.flatMap(option => {
      if (!option || typeof option !== 'object' || typeof option.label !== 'string') return []
      return [{ label: option.label as string, ...(typeof option.value === 'string' ? { value: option.value } : {}) }]
    }) : undefined
    return [{ id: value.id, label, options }]
  })
}

export function TaskAttentionCard({ item, ownerTask, conversationThreadId, workspaceRoot, onResolved, onOpenThread, onOpenFlow }: { item: TaskAttentionV1; ownerTask?: TaskRunV1; conversationThreadId?: string; workspaceRoot?: string; onResolved: (notice?: string) => void; onOpenThread?: (id: string) => void; onOpenFlow?: (flowId?: string, flowRunId?: string) => void }): ReactElement {
  const { t } = useTranslation('common')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<'dingtalk' | 'lark'>('dingtalk')
  const [providerPrompt, setProviderPrompt] = useState('')
  const questions = attentionQuestions(item)
  const capability = item.payload?.capability
  const originalRequest = item.payload?.request
  const capabilityCard: ExternalTaskCapabilityCard | null = item.payload?.kind === 'capability_required' && item.taskId &&
    (conversationThreadId || item.threadId) && originalRequest && typeof originalRequest === 'object' &&
    'prompt' in originalRequest && typeof originalRequest.prompt === 'string' && capability && typeof capability === 'object' &&
    'provider' in capability && ['dingtalk','lark','feishu','browser-skill','ego-browser','workspace','schedule'].includes(String(capability.provider)) &&
    'status' in capability && ['available','not_installed','needs_authorization','unsupported','blocked'].includes(String(capability.status)) &&
    'message' in capability && typeof capability.message === 'string'
      ? {threadId:(conversationThreadId || item.threadId)!,taskId:item.taskId,attentionId:item.id,prompt:originalRequest.prompt,capability:capability as ExternalTaskCapabilityCard['capability']}
      : null
  const resolveFlow = async (decision?: 'approve' | 'reject'): Promise<void> => {
    if (busy || !item.flowRunId || (decision && !item.nodeId)) return
    setBusy(true)
    setError('')
    try {
      const path = decision ? '/v1/flow-runs/decision' : `/v1/flow-runs/${encodeURIComponent(item.flowRunId)}/resume`
      const body = decision ? { runId: item.flowRunId, nodeId: item.nodeId, decision } : {}
      const result = await window.workwise.runtimeRequest(path, 'POST', JSON.stringify(body))
      if (!result.ok) {
        let message = t('taskWorkspaceActionFailed')
        try { message = JSON.parse(result.body).message ?? message } catch { /* Keep the actionable fallback. */ }
        throw new Error(message)
      }
      onResolved()
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)) } finally { setBusy(false) }
  }
  const resolveIntent = async (intent: 'supplement' | 'new'): Promise<void> => {
    const request = item.payload?.request
    if (busy || !item.threadId || !request || typeof request !== 'object' || !('prompt' in request) || typeof request.prompt !== 'string') return
    setBusy(true)
    setError('')
    try {
      await window.workwise.coordinateTaskCommand({
        threadId: item.threadId, ...(item.taskId ? { taskId: item.taskId } : {}),
        intent, resolveAttentionId: item.id, idempotencyKey: `attention:${item.id}:${intent}`,
        request: request as Record<string, unknown> & { prompt: string }
      })
      onResolved()
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)) } finally { setBusy(false) }
  }
  const resolveProvider = async (): Promise<void> => {
    const original = item.payload?.request
    if (busy || !item.threadId || !providerPrompt.trim() || !original || typeof original !== 'object') return
    setBusy(true)
    setError('')
    try {
      await window.workwise.coordinateTaskCommand({ threadId:item.threadId, ...(item.taskId ? {taskId:item.taskId} : {}),
        intent:'new', resolveAttentionId:item.id, selectedExternalProvider:selectedProvider,
        idempotencyKey:`provider-choice:${item.id}:${globalThis.crypto.randomUUID()}`,
        request:{...original,prompt:providerPrompt.trim(),displayText:providerPrompt.trim()} })
      onResolved()
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)) } finally { setBusy(false) }
  }
  const resolve = async (decision?: 'allow' | 'deny'): Promise<void> => {
    if (!item.requestId || busy || submitted) return
    setBusy(true)
    setError('')
    try {
      const path = decision ? `/v1/approvals/${encodeURIComponent(item.requestId)}` : `/v1/user-inputs/${encodeURIComponent(item.requestId)}`
      const body = decision ? { decision } : { answers: questions.map(question => ({ id: question.id, label: question.label, value: answers[question.id] ?? '' })) }
      const result = await window.workwise.runtimeRequest(path, 'POST', JSON.stringify(body))
      if (result.status === 404 || result.status === 409 || result.status === 410) {
        onResolved(t('taskWorkspaceDecisionRefresh'))
        return
      }
      if (!result.ok) throw new Error(t('taskWorkspaceActionFailed'))
      setSubmitted(true)
      onResolved(t(decision ? 'taskWorkspaceDecisionSaved' : 'taskWorkspaceSupplementSaved'))
    } catch { setError(t('taskWorkspaceActionFailed')) } finally { setBusy(false) }
  }
  return <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
    <h4 className="text-sm font-semibold">{item.title}</h4>
    {item.kind === 'approval' && item.requestId ? <ApprovalOperationDetails summary={item.message} presentation={item.presentation} /> : <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed">{capabilityCard && isMatchingExecutionGrantExpiredAttention(item, ownerTask) ? t('capabilityExecutionGrantExpiredSummary') : redactRuntimeText(item.message)}</p>}
    {capabilityCard ? <CapabilityRequiredCard card={capabilityCard} workspaceRoot={item.workspaceRoot || workspaceRoot} /> : null}
    {item.payload?.kind === 'external_provider_choice' ? <div className="mt-3 space-y-2">
      <label className="block text-xs">{t('taskCommandProvider')}<select aria-label={t('taskCommandProvider')} value={selectedProvider} onChange={event => setSelectedProvider(event.target.value as 'dingtalk' | 'lark')} className="mt-1 block w-full rounded-lg border border-ds-border bg-ds-card p-2 text-ds-ink"><option value="dingtalk">{t('taskEffectProvider_dingtalk')}</option><option value="lark">{t('taskEffectProvider_lark')}</option></select></label>
      <label className="block text-xs">{t('taskCommandSingleProviderRequest')}<textarea aria-label={t('taskCommandSingleProviderRequest')} value={providerPrompt} onChange={event => setProviderPrompt(event.target.value)} rows={3} placeholder={t('taskCommandSingleProviderHint')} className="mt-1 block w-full rounded-lg border border-ds-border bg-ds-card p-2 text-ds-ink" /></label>
      <button type="button" disabled={busy || !providerPrompt.trim()} onClick={() => void resolveProvider()} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-50">{t('taskCommandCreateProviderTask')}</button>
    </div> : null}
    {questions.map(question => <label key={question.id} className="mt-3 block text-xs font-medium">{question.label}
      {question.options?.length ? <select value={answers[question.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} className="mt-1 block w-full rounded-lg border border-ds-border bg-ds-card p-2 text-ds-ink"><option value="">{t('taskWorkspaceChooseAnswer')}</option>{question.options.map(option => <option key={option.value ?? option.label} value={option.value ?? option.label}>{option.label}</option>)}</select> : null}
      <textarea aria-label={question.label} value={answers[question.id] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} className="mt-1 block w-full rounded-lg border border-ds-border bg-ds-card p-2 text-ds-ink" rows={2} />
    </label>)}
    <div className="mt-3 flex flex-wrap gap-2">
      {item.ownerKind === 'flow' && item.payload?.action === 'review_flow' ? <><button type="button" disabled={busy} onClick={() => void resolveFlow('approve')} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('taskWorkspaceAllow')}</button><button type="button" disabled={busy} onClick={() => void resolveFlow('reject')} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-50">{t('taskWorkspaceDeny')}</button></> : null}
      {item.ownerKind === 'flow' && item.payload?.action === 'continue_flow' ? <button type="button" disabled={busy} onClick={() => void resolveFlow()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('taskRunResume')}</button> : null}
      {item.ownerKind === 'flow' && onOpenFlow ? <button type="button" onClick={() => onOpenFlow(item.flowId, item.flowRunId)} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs">{t('taskWorkspaceOpenFlow')}</button> : null}
      {item.payload?.kind === 'task_input_intent' ? <>{(!Array.isArray(item.payload.choices) || item.payload.choices.includes('supplement')) ? <button type="button" disabled={busy} onClick={() => void resolveIntent('supplement')} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('taskCommandChooseSupplement')}</button> : null}{(!Array.isArray(item.payload.choices) || item.payload.choices.includes('new')) ? <button type="button" disabled={busy} onClick={() => void resolveIntent('new')} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-50">{t('taskCommandChooseNew')}</button> : null}</> : null}
      {item.kind === 'approval' && item.requestId ? <>
        {!item.presentation || item.presentation.actions.includes('approve') ? <button type="button" disabled={busy || submitted} onClick={() => void resolve('allow')} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('taskWorkspaceAllow')}</button> : null}
        {!item.presentation || item.presentation.actions.includes('deny') ? <button type="button" disabled={busy || submitted} onClick={() => void resolve('deny')} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs disabled:opacity-50">{t('taskWorkspaceDeny')}</button> : null}
      </> : null}
      {item.kind === 'question' && item.requestId && questions.length ? <button type="button" disabled={busy || submitted || questions.some(question => !answers[question.id]?.trim())} onClick={() => void resolve()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{t('taskWorkspaceSubmitAnswer')}</button> : null}
      {conversationThreadId && onOpenThread ? <button type="button" onClick={() => onOpenThread(conversationThreadId)} className="rounded-lg border border-current/20 px-3 py-1.5 text-xs">{t(item.kind === 'approval' && (item.presentation?.scope === 'host' || item.message.startsWith('Run request_host_shell\n')) ? 'taskWorkspaceFileFromConversation' : 'taskWorkspaceOpenConversation')}</button> : null}
    </div>
    {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p> : null}
  </div>
}
