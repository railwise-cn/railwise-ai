import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

const labels: Record<string, string> = {
  站点: 'browserApprovalSite', 动作: 'browserApprovalAction', 目标: 'browserApprovalTarget', 输入内容: 'browserApprovalInput',
  授权期限: 'browserApprovalLifetime', 操作说明: 'browserApprovalNotice', 校验范围: 'browserApprovalVerificationScope', 计划目的: 'browserApprovalPurpose',
  执行时刻: 'browserApprovalTimes', 时区: 'browserApprovalTimezone', 浏览器: 'browserSkillBrowser', 账号状态: 'browserApprovalAccount',
  读取路径: 'browserApprovalReadPaths', 写入路径: 'browserApprovalWritePaths', 网页动作: 'browserApprovalActions'
}

export function browserApprovalFields(summary: string): Array<{ name: string; value: string }> | undefined {
  const lines = summary.split('\n')
  const plan = lines[0] === '确认周期浏览器权限'
  if (!plan && lines[0] !== '确认浏览器操作') return undefined
  const required = plan ? ['计划目的', '执行时刻', '时区', '读取路径', '写入路径', '站点', '网页动作', '浏览器', '账号状态', '授权期限', '操作说明']
    : ['站点', '动作', '目标', '输入内容', '授权期限', '操作说明']
  const fields = [...required, ...['校验范围', ...(!plan ? ['计划目的', '执行时刻', '时区', '浏览器', '账号状态'] : [])].filter(field => lines.some(line => line.startsWith(`${field} `)))]
  try {
    return fields.map(name => {
      const prefix = `${name} `
      const line = lines.find(value => value.startsWith(prefix))
      const value: unknown = JSON.parse(line?.slice(prefix.length) ?? 'null')
      if (typeof value !== 'string') throw new Error('Invalid browser review')
      return { name, value }
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
      {values.map(({ name, value }) => <div key={name} className="contents">
        <dt className="text-ds-muted">{t(labels[name])}</dt>
        <dd className="whitespace-pre-wrap break-words">{value || t('browserApprovalNoInput')}</dd>
      </div>)}
    </dl> : <p>{t('browserApprovalInvalid')}</p>}
    <details className="mt-2 text-ds-muted" onToggle={event => setShowDetails(event.currentTarget.open)}>
      <summary className="cursor-pointer">{t('browserApprovalTechnicalDetails')}</summary>
      {showDetails ? <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words">{summary}</pre> : null}
    </details>
  </section>
}
