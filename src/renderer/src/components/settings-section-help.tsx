import type { ReactElement, ReactNode } from 'react'
import {
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  Github,
  Keyboard,
  Map,
  MessageCircle,
  Puzzle,
  RefreshCw,
  Rocket,
  UserRound
} from 'lucide-react'
import { SettingsCard } from './settings-controls'

const WORKWISE_GITHUB_URL = 'https://github.com/railwise-cn/railwise-ai'
const WORKWISE_PRODUCT_URL = 'https://www.railwise.cn/products/workwise/'
const WORKWISE_ISSUES_URL = 'https://github.com/railwise-cn/railwise-ai/issues'
const WORKWISE_README_URL = 'https://github.com/railwise-cn/railwise-ai#readme'
const WORKWISE_GUIDE_URL = 'https://github.com/railwise-cn/railwise-ai/blob/main/docs/USER_GUIDE.zh-CN.md'
const WORKWISE_AUTHOR_URL = 'https://github.com/wangjiawei508'
const WORKWISE_PRODUCT_INTRO_URL =
  'https://github.com/railwise-cn/railwise-ai/blob/main/docs/product-introduction.zh-CN.md'

function HelpLinkButton({
  href,
  icon,
  label
}: {
  href: string
  icon: ReactNode
  label: string
}): ReactElement {
  return (
    <button
      type="button"
onClick={() => void window.workwise?.openExternal?.(href)?.catch(() => undefined)}
      className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
    >
      {icon}
      <span>{label}</span>
      <ExternalLink className="h-3.5 w-3.5 text-ds-faint" strokeWidth={1.8} />
    </button>
  )
}

function HelpInfoBlock({
  icon,
  title,
  body,
  items = []
}: {
  icon: ReactNode
  title: string
  body: string
  items?: string[]
}): ReactElement {
  return (
    <div className="flex gap-3 border-t border-ds-border-muted py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ds-subtle text-ds-muted">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[14px] font-semibold text-ds-ink">{title}</div>
        <p className="mt-1 text-[13px] leading-6 text-ds-muted">{body}</p>
        {items.length ? (
          <ul className="mt-2 space-y-1.5 text-[12.5px] leading-5 text-ds-muted">
            {items.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-ds-faint" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

export function HelpSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const { t } = ctx

  return (
    <>
      <SettingsCard title={t('sectionHelp')}>
        <div className="px-3 py-4">
          <p className="text-[13px] leading-6 text-ds-muted">{t('helpIntro')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <HelpLinkButton
              href={WORKWISE_GUIDE_URL}
              icon={<BookOpen className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenGuide')}
            />
            <HelpLinkButton
              href={WORKWISE_GITHUB_URL}
              icon={<Github className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenGithub')}
            />
            <HelpLinkButton
              href={WORKWISE_PRODUCT_URL}
              icon={<Download className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenReleases')}
            />
            <HelpLinkButton
              href={WORKWISE_README_URL}
              icon={<FileText className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenReadme')}
            />
            <HelpLinkButton
              href={WORKWISE_ISSUES_URL}
              icon={<ExternalLink className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenIssues')}
            />
            <HelpLinkButton
              href={WORKWISE_AUTHOR_URL}
              icon={<UserRound className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenAuthor')}
            />
            <HelpLinkButton
              href={WORKWISE_PRODUCT_INTRO_URL}
              icon={<FileText className="h-4 w-4" strokeWidth={1.8} />}
              label={t('helpOpenProductIntro')}
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t('helpCapabilityStatusTitle')} className="mt-6">
        <HelpInfoBlock
          icon={<CheckCircle2 className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpStableTitle')}
          body={t('helpStableBody')}
          items={[t('helpStableItemChat'), t('helpStableItemWrite'), t('helpStableItemHelp')]}
        />
        <HelpInfoBlock
          icon={<FlaskConical className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpPreviewTitle')}
          body={t('helpPreviewBody')}
          items={[t('helpPreviewItemMcp'), t('helpPreviewItemSync'), t('helpPreviewItemExport')]}
        />
        <HelpInfoBlock
          icon={<Map className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpRoadmapTitle')}
          body={t('helpRoadmapBody')}
          items={[t('helpRoadmapItemInfrastructure'), t('helpRoadmapItemOperations'), t('helpRoadmapItemKnowledge')]}
        />
      </SettingsCard>

      <SettingsCard title={t('helpGuideTitle')} className="mt-6">
        <HelpInfoBlock
          icon={<Rocket className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpQuickStartTitle')}
          body={t('helpQuickStartBody')}
          items={[t('helpQuickStartItemWorkspace'), t('helpQuickStartItemModel'), t('helpQuickStartItemReview')]}
        />
        <HelpInfoBlock
          icon={<Keyboard className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpCodeTitle')}
          body={t('helpCodeBody')}
          items={[t('helpCodeItemPlan'), t('helpCodeItemReview'), t('helpCodeItemFiles')]}
        />
        <HelpInfoBlock
          icon={<FileText className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpMarkdownTitle')}
          body={t('helpMarkdownBody')}
          items={[t('helpMarkdownItemViews'), t('helpMarkdownItemExport'), t('helpMarkdownItemImages')]}
        />
        <HelpInfoBlock
          icon={<Puzzle className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpSkillsTitle')}
          body={t('helpSkillsBody')}
          items={[t('helpSkillsItemMarket'), t('helpSkillsItemBuiltIn'), t('helpSkillsItemSync')]}
        />
        <HelpInfoBlock
          icon={<MessageCircle className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpPhoneTitle')}
          body={t('helpPhoneBody')}
          items={[t('helpPhoneItemFeishu'), t('helpPhoneItemProfiles'), t('helpPhoneItemSchedule')]}
        />
      </SettingsCard>

      <SettingsCard title={t('helpProjectTitle')} className="mt-6">
        <HelpInfoBlock
          icon={<UserRound className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpAuthorTitle')}
          body={t('helpAuthorBody')}
          items={[t('helpAuthorItemMaintainer'), t('helpAuthorItemFork'), t('helpAuthorItemContributors')]}
        />
        <HelpInfoBlock
          icon={<RefreshCw className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpUpdateTitle')}
          body={t('helpUpdateBody')}
          items={[t('helpUpdateItemCheck'), t('helpUpdateItemDownload'), t('helpUpdateItemPlatforms')]}
        />
        <HelpInfoBlock
          icon={<Download className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpDownloadTitle')}
          body={t('helpDownloadBody')}
          items={[t('helpDownloadItemMac'), t('helpDownloadItemWindows'), t('helpDownloadItemLinux')]}
        />
        <HelpInfoBlock
          icon={<BookOpen className="h-4 w-4" strokeWidth={1.8} />}
          title={t('helpPathsTitle')}
          body={t('helpPathsBody')}
        />
      </SettingsCard>
    </>
  )
}
