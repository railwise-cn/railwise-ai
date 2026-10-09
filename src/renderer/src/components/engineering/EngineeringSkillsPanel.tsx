import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { engineeringProfessionalText } from './engineering-professional-text'

type Capability = { id: string; label: string; available: boolean; reason?: string }

const capabilityLabelKeys: Readonly<Record<string, string>> = {
  'survey-adjustment': 'engineeringCapabilitySurveyAdjustment',
  'third-party-monitoring': 'engineeringCapabilityThirdPartyMonitoring',
  'engineering-delivery': 'engineeringCapabilitySurveyDelivery',
  'tender-master': 'engineeringCapabilityTenderPreparation',
  standards: 'engineeringCapabilityStandards'
}
const unavailableReasonKeys: Readonly<Record<string, string>> = {
  'survey runtime unavailable': 'engineeringCapabilitySurveyUnavailable',
  'engineering runtime unavailable': 'engineeringCapabilityMonitoringUnavailable',
  'skill runtime unavailable': 'engineeringCapabilityTemporarilyUnavailable'
}
const implementationDetails = /\b(?:skill|tool|plugin|parser|runtime|api|json|mcp|http|exception|traceback|stack|database|cache|node_modules|ENOMEM|EACCES|ENOENT|SQLITE_[A-Z_]+)\b|(?:\/(?:Users|private|tmp|var)\/|[A-Z]:\\)|[{}[\]]|\b(?:survey|engineering|skill|tool|runtime|capability)_[a-z0-9_-]+\b|\b[a-z][a-z0-9_]*(?:_error|_failed|_unavailable|_denied|_invalid)\b|\b[A-Z][a-z]+(?:Error|Exception)\b|contextHash|sourceSha256|inputHash|projectRevision|networkRevision|开发|代码|接口|工具(?:名称|ID)|参数\s*JSON/i
const professionalRestriction = /水准|高程|坐标|基准|控制点|控制网|观测|平差|基线|闭合|精度|限差|单位|距离|角度|仪器|资料|格式|监测|变形|沉降|成果|规范|\b(?:leveling|elevation|coordinate|datum|control point|control network|observation|adjustment|baseline|GNSS|RINEX|closure|precision|tolerance|units?|distance|angle|instrument|survey data|source data|monitoring data|deformation|settlement|format|standards?|CSV|XLSX|COSA)\b/i

function capabilityLabel(item: Capability, t: TFunction, language: string): string {
  if (Object.prototype.hasOwnProperty.call(capabilityLabelKeys, item.id)) return t(capabilityLabelKeys[item.id])
  const label = engineeringProfessionalText(item.label, language)
  if (label && !/(?:\b(?:skill|tool|plugin|parser|runtime|api|json|mcp)[_.:/ -]|\bsurvey_[a-z0-9_-]+\b)/i.test(label)) return label
  return t('engineeringCapabilityCatalog')
}

function capabilityReason(reason: string, t: TFunction, language: string): string {
  const serviceReason = reason.trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(unavailableReasonKeys, serviceReason)) return t(unavailableReasonKeys[serviceReason])
  // Keep actionable survey restrictions, but never forward unknown service
  // failures or their internal payloads to the professional work surface.
  const professional = engineeringProfessionalText(reason, language).split(/\r?\n/)
    .filter(line => !implementationDetails.test(line) && professionalRestriction.test(line))
    .join('\n').trim()
  return professional || t('engineeringCapabilityTemporarilyUnavailable')
}

export function EngineeringSkillsPanel({ runtimeReady }: { runtimeReady: boolean }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!runtimeReady) return
    let cancelled = false
    void rendererRuntimeClient.runtimeRequest('/v1/engineering/capabilities').then(capabilitiesResponse => {
      if (cancelled) return
      try {
        if (!capabilitiesResponse.ok) throw new Error(t('engineeringSkillsUnavailable'))
        setCapabilities((JSON.parse(capabilitiesResponse.body) as { capabilities?: Capability[] }).capabilities ?? [])
        setError(false)
      } catch { setError(true) }
    }).catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [runtimeReady, t])
  return <section className="min-w-0 p-5" aria-label={t('engineeringCapabilityCatalog')}>
    <h2 className="text-[13px] font-semibold">{t('engineeringCapabilityCatalog')}</h2>
    <div className="mt-3 divide-y divide-ds-border-muted border-y border-ds-border-muted">
      {capabilities.map(item => <article key={item.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-ds-ink">{capabilityLabel(item, t, i18n.language)}</h3>
          {item.reason ? <p className="mt-1 whitespace-pre-line text-[11px] text-amber-700 dark:text-amber-300">{capabilityReason(item.reason, t, i18n.language)}</p> : null}
        </div>
        <span className={`shrink-0 text-[11px] font-semibold ${item.available ? 'text-green-700 dark:text-green-300' : 'text-amber-700 dark:text-amber-300'}`}>{item.available ? t('engineeringAvailable') : t('engineeringRestricted')}</span>
      </article>)}
      {error ? <p role="alert" className="py-3 text-[11px] text-red-700 dark:text-red-300">{t('engineeringSkillsUnavailable')}</p> : null}
    </div>
  </section>
}
