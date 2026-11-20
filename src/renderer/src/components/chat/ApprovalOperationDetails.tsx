import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { BrowserApprovalDetails, browserApprovalFields } from './BrowserApprovalDetails'
import { taskReasonKey } from '../../agent/ag-ui-activity'
import type { TaskUserPresentation } from '@shared/agent-workbench'

export function ApprovalOperationDetails({ summary, toolName, presentation }: {
  summary: string
  toolName?: string
  presentation?: TaskUserPresentation
}): ReactElement {
  const { t } = useTranslation('common')
  const [showDetails, setShowDetails] = useState(false)
  if (browserApprovalFields(summary)) return <BrowserApprovalDetails summary={summary} />
  const isHost = presentation?.scope === 'host' || toolName === 'request_host_shell' || summary.startsWith('Run request_host_shell\n')
  const reason = isHost ? 'approval_host_shell' : presentation?.reason ?? 'approval_required'
  return <div className="mt-2 text-xs leading-relaxed">
    <p>{t(taskReasonKey(reason))}</p>
    <details className="mt-2 text-ds-muted" onToggle={event => setShowDetails(event.currentTarget.open)}>
      <summary className="cursor-pointer">{t('approvalScopeDetails')}</summary>
      {showDetails ? <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">{summary}</pre> : null}
    </details>
  </div>
}
