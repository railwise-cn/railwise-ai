import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

const fields = ['站点', '动作', '目标', '输入内容', '授权期限', '操作说明']
const labels = ['browserApprovalSite', 'browserApprovalAction', 'browserApprovalTarget', 'browserApprovalInput', 'browserApprovalLifetime', 'browserApprovalNotice']

export function browserApprovalFields(summary: string): string[] | undefined {
  const lines = summary.split('\n')
  if (lines[0] !== '确认浏览器操作') return undefined
  try {
    return fields.map(field => {
      const prefix = `${field} `
      const line = lines.find(value => value.startsWith(prefix))
      const value: unknown = JSON.parse(line?.slice(prefix.length) ?? 'null')
      if (typeof value !== 'string') throw new Error('Invalid browser review')
      return value
    })
  } catch { return undefined }
}

/** Business review is visible. Original technical evidence is loaded only when opened. */
export function BrowserApprovalDetails({ summary }: { summary: string }): ReactElement {
  const { t } = useTranslation('common')
  const [showDetails, setShowDetails] = useState(false)
  const values = browserApprovalFields(summary)
  return <section className="mt-2 text-xs">
    {values ? <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
      {values.map((value, index) => <div key={fields[index]} className="contents">
        <dt className="text-ds-muted">{t(labels[index])}</dt>
        <dd className="whitespace-pre-wrap break-words">{value || t('browserApprovalNoInput')}</dd>
      </div>)}
    </dl> : <p>{t('browserApprovalInvalid')}</p>}
    <details className="mt-2 text-ds-muted" onToggle={event => setShowDetails(event.currentTarget.open)}>
      <summary className="cursor-pointer">{t('browserApprovalTechnicalDetails')}</summary>
      {showDetails ? <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words">{summary}</pre> : null}
    </details>
  </section>
}
