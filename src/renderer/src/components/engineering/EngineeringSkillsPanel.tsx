import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { engineeringProfessionalText } from './engineering-professional-text'

type Capability = { id: string; label: string; available: boolean; reason?: string }

function capabilityUnavailableText(text: string): string {
  return text.replace(/(?:the )?survey skills catalog/i, 'Survey capability information').replace('工程测量技能目录', '工程测量能力信息')
}

function capabilityLabel(item: Capability, fallback: string): string {
  const label = engineeringProfessionalText(item.label)
  if (label && !/(?:\b(?:skill|tool|plugin|parser|runtime|api|json|mcp)[_.:/ -]|\bsurvey_[a-z0-9_-]+\b)/i.test(label)) return label
  return fallback
}

export function EngineeringSkillsPanel({ runtimeReady }: { runtimeReady: boolean }): ReactElement {
  const { t } = useTranslation('common')
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!runtimeReady) return
    let cancelled = false
    void rendererRuntimeClient.runtimeRequest('/v1/engineering/capabilities').then(capabilitiesResponse => {
      if (cancelled) return
      try {
        if (!capabilitiesResponse.ok) throw new Error(t('engineeringSkillsUnavailable'))
        setCapabilities((JSON.parse(capabilitiesResponse.body) as { capabilities?: Capability[] }).capabilities ?? [])
      } catch { setError(t('engineeringSkillsUnavailable')) }
    }).catch(() => { if (!cancelled) setError(t('engineeringSkillsUnavailable')) })
    return () => { cancelled = true }
  }, [runtimeReady, t])
  return <section className="min-w-0 p-5" aria-label={t('engineeringCapabilityCatalog')}>
    <h2 className="text-[13px] font-semibold">{t('engineeringCapabilityCatalog')}</h2>
    <div className="mt-3 divide-y divide-ds-border-muted border-y border-ds-border-muted">
      {capabilities.map(item => <article key={item.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-ds-ink">{capabilityLabel(item, t('engineeringCapabilityCatalog'))}</h3>
          {item.reason ? <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{engineeringProfessionalText(item.reason)}</p> : null}
        </div>
        <span className={`shrink-0 text-[11px] font-semibold ${item.available ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>{item.available ? t('engineeringAvailable') : t('engineeringRestricted')}</span>
      </article>)}
      {error ? <p role="alert" className="py-3 text-[11px] text-red-700 dark:text-red-300">{engineeringProfessionalText(capabilityUnavailableText(error))}</p> : null}
    </div>
  </section>
}
