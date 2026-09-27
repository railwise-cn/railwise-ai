import { useEffect, useRef, useState, type ReactElement, type MouseEvent } from 'react'
import { BookOpen, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SurveyStandardBasisResolvedV1 } from '@shared/survey-standard-basis'
import { readResultStandardBasis, StandardBasisRequestError, standardBasisPdfPageUrl, type StandardBasisContext } from '../../agent/survey-standard-basis-client'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence, type EngineeringEvidenceSelection } from './EngineeringEvidenceQuestion'

export function SurveyStandardBasis({ context, runtimeReady = true, parent }: { context: StandardBasisContext | null; runtimeReady?: boolean; parent?: Extract<EngineeringEvidenceSelection, { kind: 'scoring' | 'sampling-run' }> }): ReactElement {
  const { t, i18n } = useTranslation('standardBasis')
  const language = i18n.resolvedLanguage?.startsWith('zh') ? 'zh' : 'en'
  const [expanded, setExpanded] = useState(false)
  const scope = JSON.stringify([context, runtimeReady, expanded, parent])
  const active = useRef(scope); active.current = scope
  const generation = useRef(0)
  const [view, setView] = useState<{ scope: string; value?: SurveyStandardBasisResolvedV1; error?: string; loading?: boolean } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  async function load(): Promise<void> {
    if (!context || !runtimeReady || !expanded) return
    const token = ++generation.current
    const current = (): boolean => active.current === scope && token === generation.current
    setView({ scope, loading: true })
    try {
      const value = await readResultStandardBasis(context)
      if (current()) setView({ scope, value })
    } catch (cause) {
      if (current()) setView({ scope, error: cause instanceof StandardBasisRequestError ? cause.reason : 'request-failed' })
    }
  }
  useEffect(() => {
    void load()
    return () => { generation.current += 1 }
    // The serialized context also invalidates an in-flight read on result change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  const current = view?.scope === scope ? view : null
  const value = current?.value
  const locators = value ? [...new Map([
    ...value.entry.rule.locators.map((locator, index) => ({ locator, path: ['entry', 'rule', 'locators', index] })),
    ...value.profile.locators.map((locator, index) => ({ locator, path: ['profile', 'locators', index] }))
  ].map(item => [JSON.stringify(item.locator), item])).values()] : []
  async function openPdf(event: MouseEvent<HTMLAnchorElement>, page: number): Promise<void> {
    event.preventDefault()
    if (!value) return
    try { await window.workwise.openExternal(standardBasisPdfPageUrl(value, page)) }
    catch { if (active.current === scope) setView({ scope, value, error: 'open-failed' }) }
  }
  return <details className="min-w-0 border-t border-ds-border-muted pt-2" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer py-2 font-medium"><BookOpen aria-hidden="true" className="mr-2 inline h-4 w-4" />{t('open')}</summary>
    {expanded ? <section aria-label={t('title')} className="min-w-0 space-y-3 py-2">
      <h6 ref={heading} tabIndex={-1} className="font-semibold">{t('title')}</h6>
      <p className="leading-5 text-amber-900 dark:text-amber-200">{t('boundary')}</p>
      <p className="leading-5 text-ds-muted">{t('legacyAssociation')}</p>
      {!context ? <p role="status">{t('missingIdentity')}</p> : !runtimeReady ? <p role="status">{t('offline')}</p> : null}
      {current?.loading ? <p role="status" aria-live="polite">{t('loading')}</p> : null}
      {current?.error ? <div role="alert"><p>{t(`errors.${current.error}`)}</p>{current.error === 'request-failed' ? <button type="button" className="mt-2 min-h-9 rounded border border-ds-border px-3 py-2" onClick={() => { heading.current?.focus(); void load() }}>{t('retry')}</button> : null}</div> : null}
      {value ? <EngineeringSelectedEvidence reference={{ kind: 'standard-basis', reference: value.reference, ruleDigest: value.entry.ruleDigest, ...(parent ? { parent } : {}) }}>
        <p className="font-medium">{value.entry.rule.title[language]}<EngineeringEvidenceQuestion label={value.entry.rule.title[language]} disabled={!runtimeReady} /></p>
        <p className="leading-5">{value.entry.rule.summary[language]}</p>
        <dl className="grid min-w-0 gap-2 sm:grid-cols-2">
          <div><dt className="text-ds-muted">{t('standard')}</dt><dd>{value.reference.standardCode}</dd></div>
          <div><dt className="text-ds-muted">{t('profile')}</dt><dd>{value.profile.label[language]}</dd></div>
          <div><dt className="text-ds-muted">{t('rule')}</dt><dd className="break-all font-mono">{value.reference.ruleId} · {value.reference.ruleVersion}</dd></div>
          <div><dt className="text-ds-muted">{t('algorithm')}</dt><dd className="break-all font-mono">{value.reference.algorithmVersion}</dd></div>
        </dl>
        <div className="space-y-3" aria-label={t('clauses')}>
          {locators.map(({ locator, path }, index) => <div key={index} className="space-y-1">
            <p className="font-medium">{t('clause', { value: locator.clauses.join(', ') })}{locator.tables.length ? ` · ${t('table', { value: locator.tables.join(', ') })}` : ''}<EngineeringEvidenceQuestion label={t('clause', { value: locator.clauses.join(', ') })} selector={{ path, identityPaths: locator.clauses.map((clause, clauseIndex) => ({ path: ['clauses', clauseIndex], equals: clause })) }} disabled={!runtimeReady} /></p>
            <p className="leading-5">{locator.description[language]}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2">{locator.pdfPages.map((page, pageIndex) => <a key={page} href={standardBasisPdfPageUrl(value, page)} onClick={event => void openPdf(event, page)} className="inline-flex min-h-8 items-center gap-1 text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2" title={t('officialPdf')}>
              <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0" />{t('page', { printed: locator.printedPages[pageIndex], pdf: page })}
            </a>)}</div>
          </div>)}
        </div>
        <div><p className="font-medium">{t('choices')}</p><ul className="list-disc space-y-1 pl-5">{value.entry.rule.implementationChoices.map((text, index) => <li key={index} className="leading-5">{text[language]}</li>)}</ul></div>
        <div><p className="font-medium">{t('exclusions')}</p><ul className="list-disc space-y-1 pl-5">{value.entry.rule.exclusions.map((text, index) => <li key={index} className="leading-5">{text[language]}</li>)}</ul></div>
        <details><summary className="cursor-pointer py-2">{t('digests')}</summary><dl className="space-y-2 break-all font-mono text-[11px]">
          <div><dt>{t('sourceDigest')}</dt><dd>{value.reference.sourceSha256}</dd></div>
          <div><dt>{t('ruleDigest')}</dt><dd>{value.entry.ruleDigest}</dd></div>
          <div><dt>{t('profileVersion')}</dt><dd>{value.reference.profileVersion}</dd></div>
        </dl></details>
      </EngineeringSelectedEvidence> : null}
    </section> : null}
  </details>
}
