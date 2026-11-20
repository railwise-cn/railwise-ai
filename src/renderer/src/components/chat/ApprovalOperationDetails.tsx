import type { ReactElement } from 'react'
import { TechnicalDetails } from '../ui/TechnicalDetails'
import { redactRuntimeText } from './conversation-visibility'
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
  if (browserApprovalFields(summary)) return <BrowserApprovalDetails summary={summary} />
  const isHost = presentation?.scope === 'host' || toolName === 'request_host_shell' || summary.startsWith('Run request_host_shell\n')
  const reason = isHost ? 'approval_host_shell' : presentation?.reason ?? 'approval_required'
  const folderLine = isHost ? /^Workspace(?: \(JSON\))?: (.+)$/m.exec(summary)?.[1] : undefined
  let folder = folderLine
  if (folderLine?.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(folderLine)
      if (typeof parsed === 'string') folder = parsed
    } catch { /* Older receipts already contain a displayable folder. */ }
  }
  return <div className="mt-2 text-xs leading-relaxed">
    <p>{t(taskReasonKey(reason))}</p>
    {folder ? <dl className="mt-2 flex flex-wrap gap-x-2 text-ds-muted">
      <dt>{t('approvalOperationWorkspace')}</dt>
      <dd className="min-w-0 break-all">{redactRuntimeText(folder)}</dd>
    </dl> : null}
    <TechnicalDetails detail={redactRuntimeText(summary)} label={t('approvalScopeDetails')} />
  </div>
}
