import { useMemo, useState, type ReactElement } from 'react'
import { FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SurveyTabularMappingV1, SurveyTabularProbeV1 } from '@shared/survey-tabular'

export type SurveyTabularProbe = SurveyTabularProbeV1
export type SurveyTabularMapping = SurveyTabularMappingV1

const fieldKeys = ['id', 'from', 'to', 'value', 'routeLength', 'sigma', 'stationCount'] as const
type Field = typeof fieldKeys[number]
const emptyFields: Record<Field, number> = { id: -1, from: -1, to: -1, value: -1, routeLength: -1, sigma: -1, stationCount: -1 }
const templateKey = 'railwise-survey-tabular-mapping/v2'
const legacyTemplateKey = 'railwise-survey-tabular-mapping/v1'
type MappingTemplate = { columns: string[]; mapping: Omit<SurveyTabularMapping, 'sourceSha256' | 'tableId' | 'confirmed' | 'mappingId' | 'revision'> }
type MappingProfile = MappingTemplate & { id: string; label: string }
function parseTemplate(mapping: unknown): MappingTemplate['mapping'] | undefined {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return undefined
  const parsed = SurveyTabularMappingV1.safeParse({ ...(mapping as Record<string, unknown>), sourceSha256: '0'.repeat(64), tableId: 'template', confirmed: true, mappingId: 'template', revision: 0 })
  return parsed.success ? mapping as MappingTemplate['mapping'] : undefined
}
function readTemplates(columns: string[]): MappingProfile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(templateKey) ?? localStorage.getItem(legacyTemplateKey) ?? 'null') as unknown
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return []
    const record = stored as Record<string, unknown>
    const candidates: unknown[] = Array.isArray(record.profiles)
      ? record.profiles
      : Array.isArray(record.columns) && 'mapping' in record ? [{ id: 'legacy-template', label: '默认方案', ...record }] : []
    return candidates.flatMap((item, index) => {
      if (!item || typeof item !== 'object') return []
      const value = item as Partial<MappingProfile>
      if (JSON.stringify(value.columns) !== JSON.stringify(columns)) return []
      const mapping = parseTemplate(value.mapping)
      return mapping ? [{ id: typeof value.id === 'string' && value.id ? value.id : `profile-${index + 1}`, label: typeof value.label === 'string' && value.label ? value.label : `方案 ${index + 1}`, columns, mapping }] : []
    })
  } catch { return [] }
}
function parseKnownPoints(text: string, networkType: SurveyTabularMapping['networkType']): SurveyTabularMapping['knownPoints'] | null {
  const ids = new Set<string>()
  const result: SurveyTabularMapping['knownPoints'] = []
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith('#')) continue
    const values = trimmed.split(/[,;\s]+/)
    const countValid = networkType === 'leveling' ? values.length === 2 : values.length === 3 || values.length === 4
    if (!countValid || ids.has(values[0]!) || ids.size >= 10000) return null
    const parsed = values.slice(1).map(Number)
    if (values.slice(1).some(value => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) || parsed.some(value => !Number.isFinite(value))) return null
    ids.add(values[0]!); result.push(networkType === 'leveling' ? { id: values[0]!, height: parsed[0] } : { id: values[0]!, x: parsed[0], y: parsed[1], ...(parsed.length === 3 ? { height: parsed[2] } : {}) })
  }
  return result
}

export function SurveyTabularMappingForm({ fileName, probe, disabled, onConfirm, onCancel, onDelimiterChange }: { fileName: string; probe: SurveyTabularProbe; disabled: boolean; onConfirm: (mapping: SurveyTabularMapping) => void; onCancel: () => void; onDelimiterChange?: (delimiter: ',' | '\t' | ';') => void }): ReactElement {
  const { t } = useTranslation('common')
  const visibleTables = probe.tables.filter(item => item.visibility === 'visible' && item.importable)
  const hiddenTables = probe.tables.filter(item => item.visibility !== 'visible')
  const unsupportedTables = probe.tables.filter(item => item.visibility === 'visible' && !item.importable)
  const table = visibleTables[0]
  const [profiles] = useState(() => readTemplates(table?.columns ?? []))
  const [selectedProfileId, setSelectedProfileId] = useState(profiles[0]?.id ?? '')
  const selectedProfile = profiles.find(profile => profile.id === selectedProfileId)
  const profileMapping = selectedProfile?.mapping
  const [tableId, setTableId] = useState(table?.id ?? '')
  const [networkType, setNetworkType] = useState<'leveling' | 'plane-control'>(profileMapping?.networkType ?? 'leveling')
  const [observationType, setObservationType] = useState<'height-difference' | 'distance' | 'direction'>(profileMapping?.observationType ?? 'height-difference')
  const [linearUnit, setLinearUnit] = useState<'m' | 'mm' | 'cm' | 'km'>(profileMapping?.linearUnit ?? 'm')
  const [angularUnit, setAngularUnit] = useState<'rad' | 'degree-decimal' | 'gon'>(profileMapping?.angularUnit ?? 'degree-decimal')
  const [routeLengthUnit, setRouteLengthUnit] = useState<'m' | 'km'>(profileMapping?.routeLengthUnit ?? 'm')
  const [coordinateSystem, setCoordinateSystem] = useState(profileMapping?.coordinateSystem ?? '')
  const [verticalDatum, setVerticalDatum] = useState(profileMapping?.verticalDatum ?? '')
  const [projection, setProjection] = useState(profileMapping?.projection ?? '')
  const [ellipsoid, setEllipsoid] = useState(profileMapping?.ellipsoid ?? '')
  const [knownPoints, setKnownPoints] = useState((profileMapping?.knownPoints ?? []).map(point => profileMapping?.networkType === 'leveling' ? `${point.id}, ${point.height}` : [point.id, point.x, point.y, point.height].filter(value => value !== undefined).join(', ')).join('\n'))
  const [remember, setRemember] = useState(false)
  const [profileName, setProfileName] = useState(selectedProfile?.label ?? t('surveyTabularProfileNameDefault'))
  const delimiter = probe.delimiter ?? ','
  const [unknownPoints, setUnknownPoints] = useState((profileMapping?.unknownPoints ?? []).map(point => [point.id, point.x, point.y, point.height].filter(value => value !== undefined).join(', ')).join('\n'))
  const [columns, setColumns] = useState<Record<Field, number>>(() => ({ ...emptyFields, ...Object.fromEntries(profileMapping?.bindings.map(binding => [binding.field, binding.columnIndex]) ?? []) }))
  const control = 'min-h-11 w-full rounded-md border border-ds-border bg-ds-card px-2.5 text-[12px] text-ds-ink outline-none focus:border-accent'
  const selectedTable = useMemo(() => visibleTables.find(item => item.id === tableId) ?? table, [visibleTables, table, tableId])
  const applyProfile = (profile: MappingProfile | undefined): void => {
    setSelectedProfileId(profile?.id ?? '')
    const mapping = profile?.mapping
    if (!mapping) { setColumns(emptyFields); setProfileName(t('surveyTabularProfileNameDefault')); return }
    setNetworkType(mapping.networkType); setObservationType(mapping.observationType); setLinearUnit(mapping.linearUnit); setAngularUnit(mapping.angularUnit); setRouteLengthUnit(mapping.routeLengthUnit)
    setCoordinateSystem(mapping.coordinateSystem); setVerticalDatum(mapping.verticalDatum); setProjection(mapping.projection ?? ''); setEllipsoid(mapping.ellipsoid ?? '')
    setKnownPoints(mapping.knownPoints.map(point => mapping.networkType === 'leveling' ? `${point.id}, ${point.height}` : [point.id, point.x, point.y, point.height].filter(value => value !== undefined).join(', ')).join('\n'))
    setUnknownPoints((mapping.unknownPoints ?? []).map(point => [point.id, point.x, point.y, point.height].filter(value => value !== undefined).join(', ')).join('\n'))
    setColumns({ ...emptyFields, ...Object.fromEntries(mapping.bindings.map(binding => [binding.field, binding.columnIndex])) }); setProfileName(profile.label)
  }
  const setField = (field: Field, value: string): void => setColumns(current => ({ ...current, [field]: Number(value) }))
  const known = parseKnownPoints(knownPoints, networkType)
  const unknown = networkType === 'plane-control' ? parseKnownPoints(unknownPoints, networkType) : []
  const mapped = fieldKeys.filter(field => columns[field] >= 0)
  const candidate = selectedTable ? SurveyTabularMappingV1.safeParse({ schemaVersion: 'survey-tabular-mapping/v1', mappingId: 'mapping-validation', revision: 0, sourceSha256: probe.sourceSha256, tableId: selectedTable.id, headerRow: 1, delimiter, networkType, observationType, linearUnit, angularUnit, routeLengthUnit, coordinateSystem, verticalDatum, ...(projection.trim() ? { projection: projection.trim() } : {}), ...(ellipsoid.trim() ? { ellipsoid: ellipsoid.trim() } : {}), bindings: mapped.map(field => ({ field, columnIndex: columns[field] })), knownPoints: known ?? [], ...(unknown?.length ? { unknownPoints: unknown } : {}), confirmed: true }) : null
  const valid = Boolean(candidate?.success && selectedTable && coordinateSystem.trim() && verticalDatum.trim() && known && known.length && unknown
    && columns.from >= 0 && columns.to >= 0 && columns.value >= 0 && new Set(mapped.map(field => columns[field])).size === mapped.length
    && mapped.every(field => Number.isInteger(columns[field]) && columns[field] < selectedTable.columns.length)
    && (networkType === 'leveling' ? observationType === 'height-difference' : observationType === 'distance' || observationType === 'direction'))
  const submit = (): void => {
    if (disabled || !valid || !selectedTable || !candidate?.success) return
    const mapping: SurveyTabularMapping = { ...candidate.data, mappingId: `tabular-ui-${probe.sourceSha256.slice(0, 12)}-${networkType}-${observationType}` }
    if (remember) {
      const { sourceSha256: _source, tableId: _table, confirmed: _confirmed, mappingId: _mapping, revision: _revision, ...saved } = mapping
      void _source; void _table; void _confirmed; void _mapping; void _revision
      try {
        const current = readTemplates(selectedTable.columns).filter(profile => profile.id !== selectedProfileId)
        const id = selectedProfileId || `profile-${Date.now().toString(36)}`
        const label = profileName.trim() || t('surveyTabularProfileNameDefault')
        localStorage.setItem(templateKey, JSON.stringify({ profiles: [...current, { id, label, columns: selectedTable.columns, mapping: saved }] }))
      } catch { /* A full storage quota does not invalidate the explicit import. */ }
    }
    onConfirm(mapping)
  }
  return <form aria-label={t('surveyTabularMappingTitle')} className="mb-3 space-y-4 border border-accent/35 bg-ds-main p-4" onSubmit={event => { event.preventDefault(); submit() }}>
    <div className="flex items-start gap-2"><FileSpreadsheet className="mt-0.5 h-4 w-4 text-accent" /><div><h4 className="text-[13px] font-semibold">{t('surveyTabularMappingTitle')}</h4><p className="mt-1 break-all text-[12px] text-ds-muted">{fileName} · {probe.formatId}</p></div></div>
    {selectedProfile ? <p className="text-[12px] text-amber-700 dark:text-amber-300">{t('surveyTabularTemplatePending')}</p> : null}
    {hiddenTables.length ? <p className="text-[12px] text-amber-700 dark:text-amber-300" role="status">{t('surveyTabularHiddenSheets', { sheets: hiddenTables.map(item => `${item.name} (${t(`surveyTabularVisibility.${item.visibility}`)})`).join('、') })}</p> : null}
    {unsupportedTables.length ? <p className="text-[12px] text-ds-muted" role="status">{t('surveyTabularUnsupportedSheets', { sheets: unsupportedTables.map(item => item.name).join('、') })}</p> : null}
    {!visibleTables.length ? <p className="text-[12px] text-red-700 dark:text-red-300" role="alert">{t('surveyTabularNoVisibleSheets')}</p> : null}
    <fieldset disabled={disabled} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{profiles.length ? <label className="space-y-1 text-[12px]">{t('surveyTabularProfile')}<select className={control} value={selectedProfileId} onChange={event => applyProfile(profiles.find(profile => profile.id === event.target.value))}><option value="">{t('surveyTabularManualProfile')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label> : null}<label className="space-y-1 text-[12px]">{t('surveyTabularProfileName')}<input className={control} value={profileName} onChange={event => setProfileName(event.target.value)} /></label><label className="space-y-1 text-[12px]">{t('surveyTabularTable')}<select className={control} value={selectedTable?.id ?? ''} disabled={!visibleTables.length} onChange={event => { setTableId(event.target.value); setColumns(emptyFields); setSelectedProfileId('') }}>{visibleTables.map(item => <option key={item.id} value={item.id}>{item.name} · {item.rowCount} {t('surveyTabularRows')}</option>)}</select></label><label className="space-y-1 text-[12px]">{t('surveyNetworkType')}<select className={control} value={networkType} onChange={event => { const value = event.target.value as typeof networkType; setSelectedProfileId(''); setNetworkType(value); setObservationType(value === 'leveling' ? 'height-difference' : 'distance'); setKnownPoints('') }}><option value="leveling">{t('surveyLeveling')}</option><option value="plane-control">{t('surveyPlaneControl')}</option></select></label><label className="space-y-1 text-[12px]">{t('surveyTabularObservationType')}<select className={control} value={observationType} onChange={event => { setSelectedProfileId(''); setObservationType(event.target.value as typeof observationType) }}>{networkType === 'leveling' ? <option value="height-difference">{t('surveyTabularHeightDifference')}</option> : <><option value="distance">{t('surveyTabularDistance')}</option><option value="direction">{t('surveyTabularDirection')}</option></>}</select></label></div>
      <div><p className="mb-2 text-[12px] font-medium">{t('surveyTabularColumnBindings')}</p><div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">{fieldKeys.map(field => <label key={field} className="space-y-1 text-[12px] text-ds-muted">{t(`surveyTabularField.${field}`)}<select className={control} value={columns[field]} onChange={event => setField(field, event.target.value)}><option value={-1}>{t('surveyTabularUnmapped')}</option>{(selectedTable?.columns ?? []).map((column, index) => <option key={`${column}-${index}`} value={index}>{index + 1}. {column}</option>)}</select></label>)}</div></div>
      {selectedTable ? <div className="overflow-x-auto border border-ds-border-muted"><table className="min-w-full text-left text-[11px]"><thead className="bg-ds-subtle"><tr>{selectedTable.columns.map((column, index) => <th key={`${column}-${index}`} className="whitespace-nowrap px-2 py-1.5">{index + 1}. {column}</th>)}</tr></thead><tbody className="divide-y divide-ds-border-muted">{selectedTable.previewRows.slice(0, 3).map((row, rowIndex) => <tr key={rowIndex}>{selectedTable.columns.map((_, index) => <td key={index} className="whitespace-nowrap px-2 py-1.5 text-ds-muted">{row[index] ?? ''}</td>)}</tr>)}</tbody></table></div> : null}
      <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-[12px]">{t('surveyTabularLinearUnit')}<select className={control} value={linearUnit} onChange={event => setLinearUnit(event.target.value as typeof linearUnit)}><option value="m">m</option><option value="mm">mm</option><option value="cm">cm</option><option value="km">km</option></select></label><label className="space-y-1 text-[12px]">{t('surveyTabularAngularUnit')}<select className={control} value={angularUnit} onChange={event => setAngularUnit(event.target.value as typeof angularUnit)}><option value="degree-decimal">{t('surveyTabularDegree')}</option><option value="gon">gon</option><option value="rad">rad</option></select></label><label className="space-y-1 text-[12px]">{t('surveyTabularRouteUnit')}<select className={control} value={routeLengthUnit} onChange={event => setRouteLengthUnit(event.target.value as typeof routeLengthUnit)}><option value="m">m</option><option value="km">km</option></select></label></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[12px]">{t('surveyCoordinateSystem')}<input className={control} value={coordinateSystem} onChange={event => setCoordinateSystem(event.target.value)} placeholder={t('surveyTabularRequired')} /></label><label className="space-y-1 text-[12px]">{t('surveyHeightDatum')}<input className={control} value={verticalDatum} onChange={event => setVerticalDatum(event.target.value)} placeholder={t('surveyTabularRequired')} /></label></div>
      {networkType === 'plane-control' ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-[12px]">{t('surveyProfessionalProjection')}<input className={control} value={projection} onChange={event => setProjection(event.target.value)} /></label><label className="space-y-1 text-[12px]">{t('surveyProfessionalEllipsoid')}<input className={control} value={ellipsoid} onChange={event => setEllipsoid(event.target.value)} /></label></div> : null}
      {probe.formatId === 'delimited-text' ? <label className="block max-w-xs space-y-1 text-[12px]">{t('surveyMappingDelimiter')}<select className={control} value={delimiter} disabled={disabled || !onDelimiterChange} onChange={event => onDelimiterChange?.(event.target.value as typeof delimiter)}><option value=",">{t('surveyMappingComma')}</option><option value=";">{t('surveyTabularSemicolon')}</option><option value={'\t'}>{t('surveyTabularTab')}</option></select></label> : null}
      <label className="block space-y-1 text-[12px]">{t('surveyKnownPoints')}<textarea className={`${control} min-h-20`} value={knownPoints} onChange={event => setKnownPoints(event.target.value)} placeholder={t(networkType === 'leveling' ? 'surveyTabularKnownPointsHeightHint' : 'surveyTabularKnownPointsPlaneHint')} /></label>
      {networkType === 'plane-control' ? <label className="block space-y-1 text-[12px]">{t('surveyTabularApproximatePoints')}<textarea className={`${control} min-h-20`} value={unknownPoints} onChange={event => setUnknownPoints(event.target.value)} placeholder={t('surveyTabularKnownPointsPlaneHint')} /></label> : null}
      <label className="flex min-h-11 items-center gap-2 text-[12px]"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t('surveyTabularRemember')}</label>
    </fieldset>
    {!valid ? <p role="alert" className="text-[12px] text-red-700 dark:text-red-300">{t('surveyTabularMappingRequired')}</p> : <p className="text-[12px] text-ds-muted">{t('surveyTabularConfirmHint')}</p>}
    <div className="flex justify-end gap-2"><button type="button" disabled={disabled} onClick={onCancel} className="min-h-11 border border-ds-border px-3 text-[12px] disabled:opacity-50">{t('surveyMappingCancel')}</button><button type="submit" disabled={disabled || !valid} className="min-h-11 bg-accent px-4 text-[12px] font-semibold text-white disabled:opacity-50">{t('surveyTabularConfirm')}</button></div>
  </form>
}
