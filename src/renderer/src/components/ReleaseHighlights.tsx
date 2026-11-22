import { useEffect, useState } from 'react'
import { ArrowUpCircle, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const releaseHighlights = {
  '0.5.9': {
    zh: '聊天附件支持粘贴和 PDF 读取。「＋」菜单可选技能、目标、计划和插件。执行记录更简洁，Windows 更新提示更清楚。',
    en: 'Paste files and read PDFs in chat. Use the add menu for skills, goals, plans and plugins. Tool details stay collapsed, and Windows updates show clearer status.'
  },
  '0.5.10': {
    zh: '附件以紧凑卡片呈现，所选技能显示真实名称。任务可在原对话审批、继续并查看成果。Windows 与 Mac 采用统一的界面字体。',
    en: 'Attachments use compact cards and selected skills show their names. Approve tasks, resume work, and open results in the original conversation. Windows and Mac share the same interface font.'
  }
} satisfies Record<string, { zh: string; en: string }>

type ReleaseVersion = keyof typeof releaseHighlights

function hasHighlights(version: string): version is ReleaseVersion {
  return Object.hasOwn(releaseHighlights, version)
}
const detailsUrl = 'https://www.railwise.cn/products/railwise-ai/#download'

export function ReleaseHighlights() {
  const { i18n } = useTranslation()
  const [releaseVersion, setReleaseVersion] = useState<ReleaseVersion>()
  useEffect(() => {
    let active = true
    void window.workwise?.getAppVersion?.().then(version => {
      if (!active || !hasHighlights(version)) return
      const seenKey = `railwise.release-highlights.${version}`
      try {
        if (localStorage.getItem(seenKey)) return
        localStorage.setItem(seenKey, '1')
      } catch {
        // Some isolated desktop sessions cannot persist storage.
      }
      setReleaseVersion(version)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  if (!releaseVersion) return null
  const chinese = (i18n.resolvedLanguage ?? i18n.language ?? '').startsWith('zh')
  const title = chinese ? '本版更新' : 'What’s new'
  const description = releaseHighlights[releaseVersion][chinese ? 'zh' : 'en']
  const details = chinese ? '查看更新说明' : 'Release notes'
  const dismiss = chinese ? '关闭本版更新' : 'Dismiss release highlights'
  return (
    <section aria-label={title} className="ds-no-drag mx-3 mt-3 flex shrink-0 items-start gap-3 rounded-lg border border-ds-border bg-ds-card px-3 py-2.5 text-sm text-ds-ink">
      <ArrowUpCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ds-muted" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title} · {releaseVersion}</p>
        <p className="mt-0.5 text-ds-muted">{description}</p>
        <button type="button" className="mt-1 underline underline-offset-2" onClick={() => void window.workwise.openExternal(detailsUrl)}>{details}</button>
      </div>
      <button type="button" className="shrink-0 rounded-md p-1 text-ds-muted hover:bg-ds-main focus-visible:ring-2" aria-label={dismiss} onClick={() => setReleaseVersion(undefined)}>
        <X aria-hidden="true" className="size-4" />
      </button>
    </section>
  )
}
