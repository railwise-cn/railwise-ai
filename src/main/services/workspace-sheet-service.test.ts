import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newWorkbookContent } from '../../shared/workspace-sheet'
import { openSpreadsheet, saveWorkbook } from './workspace-sheet-service'

vi.mock('./write-document-index', () => ({ invalidateWriteDocumentIndex: vi.fn() }))

let root: string
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-sheet-'))) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function makeWorkbook(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="监测点" r:id="s1"/><sheet name="记录" r:id="s2"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>')
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="4"><c r="B4" t="s"><v>0</v></c><c r="D4"><f>3*4</f><v>12</v></c></row></sheetData></worksheet>')
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>地铁</t></is></c></row></sheetData></worksheet>')
  zip.file('xl/sharedStrings.xml', '<sst><si><r><t>点位</t></r><r><t>001</t></r></si></sst>')
  return zip.generateAsync({type:'nodebuffer'})
}

describe('built-in spreadsheets', () => {
  it('creates and reopens a workbook, then rejects a conflicting save without changing the original', async () => {
    const target = { workspaceRoot: root, path: '测绘.rwsheet' }
    const original = newWorkbookContent('测绘')
    const created = await saveWorkbook({ ...target, content: original, expectedSha256: null })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.message)
    expect(await openSpreadsheet(target, vi.fn())).toEqual({ kind: 'workbook', content: original, sha256: created.sha256 })
    const changed = newWorkbookContent('外部修改')
    await writeFile(join(root, target.path), changed)
    const save = await saveWorkbook({ ...target, content: newWorkbookContent('我的编辑'), expectedSha256: created.sha256 })
    expect(save).toMatchObject({ ok: false, conflict: true })
    expect(await readFile(join(root, target.path), 'utf8')).toBe(changed)
    expect(await saveWorkbook({ ...target, path: '../outside.rwsheet', content: original, expectedSha256: null })).toMatchObject({ ok: false })
  })

  it('keeps sparse coordinates and cached formula values without writing a task artifact', async () => {
    const absolutePath = join(root, '监测.xlsx')
    const bytes = await makeWorkbook()
    await writeFile(absolutePath, bytes)
    const target = { taskId: 'task', artifactId: 'artifact' }
    const reader = vi.fn().mockResolvedValue({
      ok: true, status: 200, body: JSON.stringify({
        ...target, absolutePath, authorizedRoot: root,
        executionGrantId: 'grant', turnId: 'turn', operationId: 'operation',
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    })
    const opened = await openSpreadsheet(target, reader)
    expect(opened).toEqual({
      kind: 'xlsx', preview: { simplified: true, sheets: [
        { name: '监测点', cells: [{ row: 3, column: 1, value: '点位001' }, { row: 3, column: 3, value: 12 }] },
        { name: '记录', cells: [{ row: 1, column: 0, value: '地铁' }] }
      ] }
    })
    expect(await readFile(absolutePath)).toEqual(bytes)
    await writeFile(absolutePath, Buffer.concat([bytes, Buffer.from('changed')]))
    expect(await openSpreadsheet(target, reader)).toMatchObject({ kind: 'error' })
  })
})
