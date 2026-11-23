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
  const fileSummary = isHost ? null : /^Run (write|edit)\r?\nTarget: <workspace>\/([^\r\n]+)(?:\r?\n|$)/.exec(summary)
  const action = fileSummary?.[1]
  const target = fileSummary?.[2]
  const fileChange = (action === 'write' || action === 'edit') && (!toolName || toolName === action) &&
    target && !target.includes('\\') && target.split('/').every(part => part && part !== '..' && part !== '.')
    ? { action, target: redactRuntimeText(target) } : null
  const folderLine = isHost ? /^Workspace(?: \(JSON\))?: (.+)$/m.exec(summary)?.[1] : undefined
  let folder = folderLine
  if (folderLine?.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(folderLine)
      if (typeof parsed === 'string') folder = parsed
    } catch { /* Older receipts already contain a displayable folder. */ }
  }
  return <div className="mt-2 text-xs leading-relaxed">
    {fileChange ? <>
      <p className="font-medium">{t(fileChange.action === 'write' ? 'approvalOperationWriteFile' : 'approvalOperationEditFile')}</p>
      <dl className="mt-2 flex flex-wrap gap-x-2 text-ds-muted">
        <dt>{t('approvalOperationWorkspaceFile')}</dt>
        <dd className="min-w-0 break-all">{fileChange.target}</dd>
      </dl>
      <p className="mt-2">{t(fileChange.action === 'write' ? 'approvalOperationWriteImpact' : 'approvalOperationEditImpact')}</p>
    </> : <p>{t(taskReasonKey(reason))}</p>}
    {folder ? <dl className="mt-2 flex flex-wrap gap-x-2 text-ds-muted">
      <dt>{t('approvalOperationWorkspace')}</dt>
      <dd className="min-w-0 break-all">{redactRuntimeText(folder)}</dd>
    </dl> : null}
    <TechnicalDetails detail={redactRuntimeText(summary)} label={t('approvalScopeDetails')} />
  </div>
}
