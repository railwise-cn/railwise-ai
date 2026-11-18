import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CellValueType, createUniver, LocaleType, mergeLocales, type IWorkbookData, type IWorksheetData } from '@univerjs/presets'
import { IHTTPImplementation, UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { throwError } from 'rxjs'
import '@univerjs/preset-sheets-core/lib/index.css'
import {
  MAX_WORKBOOK_BYTES, MAX_WORKBOOK_CELLS, WORKBOOK_SUFFIX,
  type OpenSpreadsheetResult, type SheetFileTarget, type SpreadsheetPreview
} from '@shared/workspace-sheet'
import { exportSpreadsheetCsv, parseSpreadsheetCsv } from './spreadsheet-csv'

type LoadedSpreadsheet = Exclude<OpenSpreadsheetResult, { kind: 'error' }>
type Workbook = ReturnType<ReturnType<typeof createUniver>['univerAPI']['createWorkbook']>
type Props = { target: SheetFileTarget; displayName: string; onOpenSystem?: () => void }
const buttonClass = 'rounded-md border border-ds-border px-2.5 py-1 hover:bg-ds-subtle disabled:opacity-50'

function previewData(name: string, preview: SpreadsheetPreview): Partial<IWorkbookData> {
  const entries = preview.sheets.map((sheet, index) => {
    const id = `sheet-${index + 1}`
    const cellData: IWorksheetData['cellData'] = {}
    let rowCount = 50
    let columnCount = 12
    for (const { row, column, value } of sheet.cells) {
      const type = typeof value === 'number' ? CellValueType.NUMBER
        : typeof value === 'boolean' ? CellValueType.BOOLEAN : CellValueType.STRING
      const cells = cellData[row] ??= {}
      cells[column] = { v: typeof value === 'boolean' ? Number(value) : value, t: type }
      rowCount = Math.max(rowCount, row + 1)
      columnCount = Math.max(columnCount, column + 1)
    }
    return [id, { id, name: sheet.name, cellData, rowCount, columnCount }] as const
  })
  return { name, sheetOrder: entries.map(([id]) => id), sheets: Object.fromEntries(entries) }
}

function safeWorkbookSnapshot(data: Partial<IWorkbookData>): Partial<IWorkbookData> {
  const { resources: _resources, custom: _custom, ...workbook } = data
  const sheets = Object.entries(workbook.sheets ?? {}).map(([id, value]) => {
    const { backgroundImage: _background, custom: _metadata, ...sheet } = value
    return [id, sheet]
  })
  return workbook.sheets ? { ...workbook, sheets: Object.fromEntries(sheets) } : workbook
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function exportName(name: string): string {
  return [...name.replace(/[<>:"/\\|?*]/g, '_')]
    .map(character => character.charCodeAt(0) < 32 ? '_' : character).join('') || 'Sheet'
}

export function WorkspaceSpreadsheet({ target, displayName, onOpenSystem }: Props): ReactElement {
  const { i18n } = useTranslation('common')
  const zh = i18n.resolvedLanguage?.toLowerCase().startsWith('zh') ?? true
  const label = (cn: string, en: string) => zh ? cn : en
  const [loaded, setLoaded] = useState<LoadedSpreadsheet | null>(null)
  const [loadError, setLoadError] = useState('')
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [saveAs, setSaveAs] = useState<string | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const workbookRef = useRef<Workbook | null>(null)
  const saveLocation = useRef<{ path: string; sha256: string } | null>(null)
  const workspaceRoot = 'workspaceRoot' in target ? target.workspaceRoot : undefined
  const path = 'path' in target ? target.path : undefined
  const taskId = 'taskId' in target ? target.taskId : undefined
  const artifactId = 'artifactId' in target ? target.artifactId : undefined

  useEffect(() => {
    let live = true
    setLoaded(null)
    setReady(false)
    setLoadError('')
    setStatus('')
    setSaveAs(null)
    saveLocation.current = null
    const request: SheetFileTarget | null = taskId && artifactId ? { taskId, artifactId }
      : workspaceRoot && path ? { workspaceRoot, path } : null
    if (request) {
      void window.workwise.openSpreadsheet(request).then(result => {
        if (!live) return
        if (result.kind === 'error') { setLoadError(result.message); return }
        if (result.kind === 'workbook' && path) saveLocation.current = { path, sha256: result.sha256 }
        setLoaded(result)
      }).catch(error => { if (live) setLoadError(messageFrom(error)) })
    }
    return () => { live = false }
  }, [workspaceRoot, path, taskId, artifactId])

  useEffect(() => {
    if (!loaded || !container.current) return
    const mount = container.current
    let dispose: (() => void) | undefined
    let live = true
    setReady(false)
    void (async () => {
      const localeMessages = zh ? await import('@univerjs/preset-sheets-core/locales/zh-CN')
        : await import('@univerjs/preset-sheets-core/locales/en-US')
      if (!live) return
      const locale = zh ? LocaleType.ZH_CN : LocaleType.EN_US
      const readOnly = loaded.kind === 'xlsx'
      const { univer, univerAPI } = createUniver({
        locale, locales: { [locale]: mergeLocales(localeMessages.default) },
        override: [[IHTTPImplementation, { useValue: {
          send: () => throwError(() => new Error('Network requests are unavailable in local workbooks.'))
        } }]],
        presets: [UniverSheetsCorePreset({
          container: mount,
          header: false,
          toolbar: !readOnly,
          formulaBar: !readOnly,
          contextMenu: !readOnly,
          disableAutoFocus: true
        })]
      })
      dispose = () => univer.dispose()
      const data = loaded.kind === 'xlsx' ? previewData(displayName, loaded.preview)
        : safeWorkbookSnapshot(JSON.parse(loaded.content).workbook)
      const workbook = univerAPI.createWorkbook(data)
      if (readOnly) await workbook.getWorkbookPermission().setReadOnly()
      if (!live) return
      workbookRef.current = workbook
      setReady(true)
    })().catch(error => { if (live) setLoadError(messageFrom(error)) })
    return () => {
      live = false
      workbookRef.current = null
      dispose?.()
    }
  }, [loaded, displayName, zh])

  async function save(copyName?: string): Promise<void> {
    const workbook = workbookRef.current
    const previous = saveLocation.current
    if (!workspaceRoot || loaded?.kind !== 'workbook' || !workbook || !previous || saving) return
    const trimmed = copyName?.trim()
    if (copyName !== undefined && (!trimmed || trimmed === '.' || trimmed === '..' || exportName(trimmed) !== trimmed)) {
      setStatus(label('请输入有效的文件名。', 'Enter a valid file name.'))
      return
    }
    const destination = trimmed
      ? trimmed.toLowerCase().endsWith(WORKBOOK_SUFFIX) ? trimmed : `${trimmed}${WORKBOOK_SUFFIX}`
      : previous.path
    setSaving(true)
    setStatus('')
    try {
      const content = JSON.stringify({ version: 1, workbook: safeWorkbookSnapshot(workbook.save()) })
      const result = await window.workwise.saveWorkbook({
        workspaceRoot, path: destination, content, expectedSha256: trimmed ? null : previous.sha256
      })
      if (!result.ok) {
        setStatus(result.message)
        if (result.conflict) setSaveAs(current => current ?? `${exportName(displayName.replace(/\.rwsheet$/i, ''))}-${label('副本', 'copy')}`)
        return
      }
      saveLocation.current = { path: result.path, sha256: result.sha256 }
      setSaveAs(null)
      setStatus(`${label('已保存', 'Saved')} · ${destination.split(/[/\\]/).at(-1)}`)
    } catch (error) {
      setStatus(messageFrom(error))
    } finally { setSaving(false) }
  }

  async function importCsv(file: File): Promise<void> {
    try {
      const workbook = workbookRef.current
      if (!workbook || file.size > MAX_WORKBOOK_BYTES) throw new Error(label('CSV 文件超过内置读取上限。', 'The CSV file exceeds the size limit.'))
      const rows = parseSpreadsheetCsv(await file.text())
      if (workbook !== workbookRef.current) return
      if (!rows.length) throw new Error(label('CSV 文件没有数据。', 'The CSV file has no data.'))
      const cellData: IWorksheetData['cellData'] = {}
      let columnCount = 26
      rows.forEach((row, index) => {
        cellData[index] = Object.fromEntries(row.map((value, column) => [column, { v: value, t: CellValueType.STRING }]))
        columnCount = Math.max(columnCount, row.length)
      })
      const title = file.name.replace(/\.csv$/i, '').replace(/[\\/?*:[\]]/g, '_').slice(0, 24) || 'CSV'
      const sheetNames = new Set(workbook.getSheets().map(sheet => sheet.getSheetName().toLowerCase()))
      let name = title
      for (let index = 2; sheetNames.has(name.toLowerCase()); index++) name = `${title} ${index}`
      const sheet = workbook.insertSheet(name, { sheet: { cellData, rowCount: Math.max(100, rows.length), columnCount } })
      workbook.setActiveSheet(sheet)
      setStatus(`${label('已导入', 'Imported')} · ${name}`)
    } catch (error) { setStatus(messageFrom(error)) }
  }

  function exportCsv(): void {
    try {
      const sheet = workbookRef.current?.getActiveSheet()
      if (!sheet) return
      const cells = sheet.getDataRange()
      if (cells.getHeight() * cells.getWidth() > MAX_WORKBOOK_CELLS) {
        throw new Error(label('当前工作表超过 CSV 导出范围。', 'The active sheet exceeds the CSV export limit.'))
      }
      const rows = cells.getValues().map(row => row.map(value => value ?? ''))
      const url = URL.createObjectURL(new Blob([exportSpreadsheetCsv(rows)], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${exportName(sheet.getSheetName())}.csv`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { setStatus(messageFrom(error)) }
  }

  const editable = loaded?.kind === 'workbook'
  return <section className="ds-no-drag flex min-h-[260px] min-w-0 flex-1 flex-col overflow-hidden">
    <div className="flex flex-wrap items-center gap-2 border-b border-ds-border px-3 py-2 text-xs">
      {editable ? <>
        <button type="button" className={buttonClass} disabled={!ready || saving} onClick={() => void save()}>{label('保存表格', 'Save workbook')}</button>
        <button type="button" className={buttonClass} disabled={!ready || saving} onClick={() => setSaveAs(saveAs === null ? '' : null)}>{label('另存为', 'Save as')}</button>
        <button type="button" className={buttonClass} disabled={!ready} onClick={() => fileInput.current?.click()}>{label('导入 CSV', 'Import CSV')}</button>
        <input hidden ref={fileInput} type="file" accept=".csv,text/csv" onChange={event => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importCsv(file)
        }} />
        <button type="button" className={buttonClass} disabled={!ready} onClick={exportCsv}>{label('导出当前表为 CSV', 'Export active sheet as CSV')}</button>
      </> : <>
        {loaded?.kind === 'xlsx' ? <span className="text-ds-muted">{loaded.preview.simplified ? label('只读预览 · 显示存储值', 'Read-only preview · stored values') : label('只读预览', 'Read-only preview')}</span> : null}
        {onOpenSystem ? <button type="button" className={buttonClass} onClick={onOpenSystem}>{label('在系统应用打开', 'Open in system app')}</button> : null}
      </>}
    </div>
    {saveAs !== null ? <form className="flex flex-wrap gap-2 px-3 py-2 text-xs" onSubmit={event => { event.preventDefault(); void save(saveAs) }}>
      <input aria-label={label('新文件名', 'New file name')} value={saveAs} onChange={event => setSaveAs(event.target.value)} className="rounded-md border border-ds-border bg-ds-card px-2 py-1" />
      <button type="submit" disabled={saving} className={buttonClass}>{label('保存副本', 'Save copy')}</button>
      <button type="button" onClick={() => setSaveAs(null)} className={buttonClass}>{label('取消', 'Cancel')}</button>
    </form> : null}
    {status ? <p role="status" className="px-3 py-2 text-xs text-ds-muted">{status}</p> : null}
    {loadError ? <p role="alert" className="px-3 py-2 text-xs text-ds-muted">{loadError}</p> : null}
    {!ready && !loadError ? <p role="status" className="px-3 py-2 text-xs text-ds-muted">{label('正在加载表格…', 'Loading spreadsheet…')}</p> : null}
    <div ref={container} className={`min-h-0 flex-1 overflow-hidden ${ready ? '' : 'invisible'}`} />
  </section>
}
