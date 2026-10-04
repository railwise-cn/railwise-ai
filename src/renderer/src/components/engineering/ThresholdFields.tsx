import { type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'

type ThresholdRow = { name: string; value: string }
type Translate = (key: string, options?: Record<string, unknown>) => string

function thresholdRows(value: string): ThresholdRow[] {
  return value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const separator = line.indexOf(' = ')
    if (separator >= 0) return { name: line.slice(0, separator), value: line.slice(separator + 3) }
    const legacySeparator = line.indexOf('=')
    return legacySeparator < 0 ? { name: line, value: '' } : { name: line.slice(0, legacySeparator).trim(), value: line.slice(legacySeparator + 1).trim() }
  })
}

export function parseThresholds(value: string, translate: Translate): Record<string, number> {
  const thresholds: Record<string, number> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator < 1) throw new Error(translate('engineeringThresholdFormatError'))
    const name = trimmed.slice(0, separator).trim()
    const numberText = trimmed.slice(separator + 1).trim()
    const numberValue = Number(numberText)
    if (!name || !numberText || !Number.isFinite(numberValue)) throw new Error(translate('engineeringThresholdValueError'))
    if (Object.hasOwn(thresholds, name)) throw new Error(translate('engineeringThresholdDuplicate'))
    // Define a data property so every existing user key, including names that
    // resemble JavaScript object members, remains a literal monitoring item.
    Object.defineProperty(thresholds, name, { value: numberValue, writable: true, enumerable: true, configurable: true })
  }
  return thresholds
}

/** The persisted threshold keys and legacy text model remain unchanged. */
export function ThresholdFields({ value, unit, onChange }: { value: string; unit: string; onChange: (value: string) => void }): ReactElement {
  const { t } = useTranslation('common')
  const rows = thresholdRows(value)
  const write = (next: ThresholdRow[]): void => onChange(next.map(row => `${row.name} = ${row.value}`).join('\n'))
  const update = (index: number, patch: Partial<ThresholdRow>): void => write(rows.map((row, position) => position === index ? { ...row, ...patch } : row))
  const controlClass = 'mt-1 min-h-11 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[13px] text-ds-ink outline-none focus:border-accent'
  return <fieldset className="min-w-0 lg:col-span-2">
    <legend className="text-[12px] font-medium text-ds-muted">{t('engineeringThresholds')}</legend>
    <p className="mt-1 text-[11px] leading-4 text-ds-faint">{t('engineeringThresholdHint')}</p>
    <div className="mt-2 space-y-3">{rows.map((row, index) => {
      const kind = row.name === 'default' || row.name === 'settlement' ? row.name : 'custom'
      return <div key={index} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0"><label className="block text-[11px] text-ds-muted">{t('engineeringThresholdItem')}<select aria-label={`${t('engineeringThresholdItem')} ${index + 1}`} value={kind} onChange={event => update(index, { name: event.target.value === 'custom' ? '' : event.target.value })} className={controlClass}>
          <option value="default" disabled={rows.some((other, position) => position !== index && other.name === 'default')}>{t('engineeringThresholdDefault')}</option>
          <option value="settlement" disabled={rows.some((other, position) => position !== index && other.name === 'settlement')}>{t('engineeringThresholdSettlement')}</option>
          <option value="custom">{t('engineeringThresholdCustom')}</option>
        </select></label>{kind === 'custom' ? <label className="mt-2 block text-[11px] text-ds-muted">{t('engineeringThresholdCustomName')}<input aria-label={`${t('engineeringThresholdCustomName')} ${index + 1}`} value={row.name} onChange={event => update(index, { name: event.target.value })} className={controlClass} /></label> : null}</div>
        <label className="col-start-1 block min-w-0 text-[11px] text-ds-muted sm:col-start-auto">{t('engineeringThresholdValue', { unit })}<input inputMode="decimal" aria-label={`${t('engineeringThresholdValue', { unit })} ${index + 1}`} value={row.value} onChange={event => update(index, { value: event.target.value })} className={controlClass} /></label>
        <button type="button" aria-label={t('engineeringThresholdRemove', { number: index + 1 })} title={t('engineeringThresholdRemove', { number: index + 1 })} onClick={() => write(rows.filter((_, position) => position !== index))} className="col-start-2 row-start-1 row-end-3 inline-flex min-h-11 min-w-11 items-center justify-center self-end rounded-md text-ds-muted hover:bg-ds-hover sm:col-start-auto sm:row-auto"><X className="h-4 w-4" /></button>
      </div>
    })}</div>
    {!rows.length ? <p className="mt-2 text-[11px] text-ds-faint">{t('engineeringThresholdEmpty')}</p> : null}
    <button type="button" onClick={() => write([...rows, { name: rows.some(row => row.name === 'default') ? '' : 'default', value: '' }])} className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-md border border-ds-border px-3 text-[12px] text-ds-ink"><Plus className="h-4 w-4" />{t('engineeringThresholdAdd')}</button>
  </fieldset>
}
