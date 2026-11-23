import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const REPORT_FILE = 'windows-offline-spreadsheet.json'
const requiredChecks = [
  'new-local-rwsheet',
  'formula-calculation-saved',
  'undo-restores-prior-cell-value',
  'external-save-conflict-preserves-original-and-saves-copy',
  'utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal',
  'save-reopen-multiple-sheets-through-production-reader',
  'xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes'
]

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function until(description, read, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out while waiting for ${description}`)
}

async function createXlsxFixture(path) {
  const zip = new JSZip()
  zip.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="监测点" r:id="s1"/><sheet name="记录" r:id="s2"/></sheets></workbook>')
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="4"><c r="B4" t="s"><v>1</v></c><c r="D4"><v>12</v></c></row></sheetData></worksheet>')
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>地铁</t></is></c></row></sheetData></worksheet>')
  zip.file('xl/sharedStrings.xml', '<sst><si><t>点位</t></si><si><t>001</t></si></sst>')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }), { flag: 'wx' })
}

function workbookCell(workbook, row, column) {
  return workbook.sheets?.[workbook.sheetOrder?.[0]]?.cellData?.[row]?.[column]
}

export function validateWindowsOfflineSpreadsheetReport(report, identity) {
  assert.equal(report.status, 'passed')
  assert.equal(report.platform, 'win32')
  assert.equal(report.arch, 'x64')
  assert.equal(report.version, identity.version)
  assert.equal(report.sourceHead, identity.sourceHead)
  if (identity.buildRunId !== undefined) assert.equal(report.buildRunId, identity.buildRunId)
  if (identity.buildRunAttempt !== undefined) assert.equal(report.buildRunAttempt, identity.buildRunAttempt)
  assert.equal(report.installerSha256, identity.installerSha256)
  assert.equal(report.installedAsarSha256, identity.installedAsarSha256)
  assert.equal(report.execution, 'installed-ui')
  assert.equal(report.networkIsolation?.rendererOffline, true)
  assert.equal(report.packageUnchanged, true)
  assert.deepEqual(report.checks, requiredChecks)
  assert.deepEqual(report.formula, { expression: '=SUM(4,5)', value: 9 })
  assert.equal(report.undo?.restoredPreviousValue, true)
  assert.deepEqual(report.conflict, { originalPreserved: true, copyPreservedUnsavedEdit: true })
  assert.equal(report.csv?.preservesLeadingZeroAndPrecision, true)
  assert.equal(report.savedWorkbook?.sheetCount, 2)
  assert.equal(report.savedWorkbook?.reopenedThroughProductionReader, true)
  assert.equal(report.xlsxPreview?.sheetNames?.[0], '监测点')
  assert.equal(report.xlsxPreview?.sheetNames?.[1], '记录')
  assert.equal(report.xlsxPreview?.preservedSparseCellCoordinates, true)
  assert.equal(report.xlsxPreview?.renderedReadOnlyGrid, true)
  assert.equal(report.xlsxPreview?.editingControlsHidden, true)
  assert.equal(report.xlsxPreview?.systemOpenEntryVisible, true)
  assert.match(report.xlsxPreview?.sha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(report.savedWorkbook?.reopenedInVisibleGrid, true)
  assert.equal(report.savedWorkbook?.formulaValueAfterReopen, 9)
  return report
}

export function validateWindowsSpreadsheetCandidate(identity) {
  assert.match(identity.version ?? '', /^\d+\.\d+\.\d+$/)
  assert.match(identity.sourceHead ?? '', /^[a-f0-9]{40}$/)
  assert.match(String(identity.buildRunId ?? ''), /^[1-9]\d*$/)
  assert.match(String(identity.buildRunAttempt ?? ''), /^[1-9]\d*$/)
  assert.match(identity.installerSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.match(identity.installedAsarSha256 ?? '', /^[a-f0-9]{64}$/)
  return identity
}

export async function runWindowsOfflineSpreadsheetJourney({
  cdp,
  workspace,
  evidenceDir,
  version,
  sourceHead,
  buildRunId,
  buildRunAttempt,
  installerSha256,
  installedAsarSha256,
  asarPath
}) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'Windows')
  validateWindowsSpreadsheetCandidate({ version, sourceHead, buildRunId, buildRunAttempt, installerSha256, installedAsarSha256 })

  const report = {
    schemaVersion: 1,
    status: 'running',
    platform: 'win32',
    arch: 'x64',
    version,
    sourceHead,
    buildRunId,
    buildRunAttempt,
    installerSha256,
    installedAsarSha256,
    execution: 'installed-ui',
    networkIsolation: { rendererOffline: true, blockedProtocols: ['http:', 'https:'] },
    checks: []
  }
  const reportPath = join(evidenceDir, REPORT_FILE)
  let originalWorkbookPath
  let stage = 'prepare-workbook-fixtures'

  try {
    await Promise.all([workspace, evidenceDir].map(path => mkdir(path, { recursive: true })))
    const xlsxName = '只读预览.xlsx'
    const xlsxPath = join(workspace, xlsxName)
    await createXlsxFixture(xlsxPath)
    const originalXlsxSha256 = await sha256(xlsxPath)

    const click = text => cdp.click('button', text)
    const key = async (keyValue, code, windowsVirtualKeyCode, modifiers = 0) => {
      const event = { key: keyValue, code, windowsVirtualKeyCode, modifiers }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    }
    const readWorkbook = path => readFile(path, 'utf8').then(contents => {
      const file = JSON.parse(contents)
      assert.equal(file.version, 1)
      return file.workbook
    })
    const save = () => click('保存表格')

    stage = 'create-local-rwsheet'
    await click('新建表格')
    await cdp.wait(`(() => {
      const panel=document.querySelector('.ds-code-sidebar');
      const canvas=[...(panel?.querySelectorAll('canvas[data-u-comp="render-canvas"]')??[])]
        .find(item=>item.clientWidth>200&&item.clientHeight>150);
      return Boolean(canvas&&[...panel.querySelectorAll('button')].some(button=>button.textContent==='保存表格'&&!button.disabled));
    })()`, 'editable workbook')
    report.checks.push('new-local-rwsheet')
    const filename = (await readdir(workspace)).find(name => name.endsWith('.rwsheet'))
    assert.ok(filename, 'New workbook must be saved in the isolated workspace')
    originalWorkbookPath = join(workspace, filename)

    const cellEditorId = '__editor___INTERNAL_EDITOR__DOCS_NORMAL'
    const clickCell = async (row, column, count = 1) => {
      const canvas = await cdp.wait(`[...document.querySelectorAll('.ds-code-sidebar canvas[data-u-comp="render-canvas"]')]
        .map(canvas=>canvas.getBoundingClientRect().toJSON()).find(box=>box.width>200&&box.height>150)`, 'workbook grid canvas')
      const point = { x: canvas.x + 68 + column * 79, y: canvas.y + 30 + row * 22 }
      const hit = await cdp.evaluate(`(() => {
        const element=document.elementFromPoint(${point.x},${point.y});
        return element?{tag:element.tagName,component:element.getAttribute('data-u-comp')}:null;
      })()`)
      report.lastCellInteraction = { row, column, point, hit }
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
      }
    }
    const edit = async (row, column, value) => {
      await clickCell(row, column, 2)
      await cdp.wait(`document.activeElement?.id===${JSON.stringify(cellEditorId)}&&document.activeElement.isContentEditable`, 'Univer cell editor focus')
      await cdp.send('Input.insertText', { text: value })
      await key('Enter', 'Enter', 13)
    }

    stage = 'save-formula-result'
    await edit(0, 0, '=SUM(4,5)')
    await save()
    let formula = await until('saved formula expression', async () => {
      const cell = workbookCell(await readWorkbook(originalWorkbookPath), 0, 0)
      return cell?.f === '=SUM(4,5)' ? cell : null
    })
    if (formula.v !== 9) {
      await new Promise(resolve => setTimeout(resolve, 250))
      await save()
      formula = await until('calculated formula result after one save retry', async () => {
        const cell = workbookCell(await readWorkbook(originalWorkbookPath), 0, 0)
        return cell?.f === '=SUM(4,5)' && cell.v === 9 ? cell : null
      })
    }
    report.formula = { expression: formula.f, value: formula.v }
    report.checks.push('formula-calculation-saved')

    stage = 'verify-ctrl-z'
    await edit(0, 1, '撤销前')
    await save()
    await until('pre-undo value', async () => workbookCell(await readWorkbook(originalWorkbookPath), 0, 1)?.v === '撤销前')
    await clickCell(0, 1)
    await key('z', 'KeyZ', 90, 2)
    await save()
    await until('undo value removal', async () => {
      const workbook = await readWorkbook(originalWorkbookPath)
      return workbookCell(workbook, 0, 0)?.v === 9 && workbookCell(workbook, 0, 1)?.v !== '撤销前'
    })
    report.undo = { shortcut: 'Ctrl+Z', restoredPreviousValue: true }
    report.checks.push('undo-restores-prior-cell-value')

    stage = 'verify-save-conflict-copy'
    await edit(0, 1, '保留未保存修改')
    const external = await readWorkbook(originalWorkbookPath)
    external.name = '外部程序修改'
    const externalBytes = JSON.stringify({ version: 1, workbook: external })
    await writeFile(originalWorkbookPath, externalBytes)
    await save()
    await cdp.wait('Boolean(document.querySelector(\'input[aria-label="新文件名"]\'))', 'save conflict and copy form')
    assert.equal(await readFile(originalWorkbookPath, 'utf8'), externalBytes, 'External changes must remain on the original file')
    const suggested = await cdp.evaluate('document.querySelector(\'input[aria-label="新文件名"]\')?.value')
    assert.match(suggested, /^[^/\\]+副本$/)
    const copyName = `${suggested}.rwsheet`
    await click('保存副本')
    await cdp.wait(`document.body.innerText.includes(${JSON.stringify(`已保存 · ${copyName}`)})`, 'save copy')
    const copyPath = join(workspace, copyName)
    const copied = await readWorkbook(copyPath)
    assert.equal(workbookCell(copied, 0, 1)?.v, '保留未保存修改')
    assert.equal(workbookCell(copied, 0, 0)?.v, 9)
    assert.equal(await readFile(originalWorkbookPath, 'utf8'), externalBytes)
    report.conflict = { originalPreserved: true, copyPreservedUnsavedEdit: true }
    report.checks.push('external-save-conflict-preserves-original-and-saves-copy')

    stage = 'verify-chinese-csv-import-export'
    const csvPath = join(workspace, '监测导入.csv')
    await writeFile(csvPath, '\uFEFF点位,位移\r\n001,"4.20"\r\n')
    const rootNode = (await cdp.send('DOM.getDocument')).root.nodeId
    const input = (await cdp.send('DOM.querySelector', { nodeId: rootNode, selector: 'input[accept=".csv,text/csv"]' })).nodeId
    assert.ok(input, 'CSV import control must be available')
    await cdp.send('DOM.setFileInputFiles', { nodeId: input, files: [csvPath] })
    await cdp.wait('document.body.innerText.includes("已导入 · 监测导入")', 'Chinese CSV import')
    const downloadPath = join(evidenceDir, 'downloads')
    await mkdir(downloadPath, { recursive: true })
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath })
    await click('导出当前表为 CSV')
    const exported = await until('downloaded Chinese CSV', async () => {
      const name = (await readdir(downloadPath)).find(file => file.endsWith('.csv'))
      if (!name) return null
      const contents = await readFile(join(downloadPath, name), 'utf8')
      return contents.includes('点位,位移') && contents.includes('001,4.20') ? { name, contents } : null
    })
    report.csv = { filename: exported.name, bytes: Buffer.byteLength(exported.contents), preservesLeadingZeroAndPrecision: true }
    report.checks.push('utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal')

    stage = 'save-reopen-multiple-sheets'
    await save()
    const savedCopy = await until('saved workbook with imported CSV sheet', async () => {
      const workbook = await readWorkbook(copyPath)
      return workbook.sheetOrder.length === 2 ? workbook : null
    })
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('kun:workspace-file-preview', {
      detail:${JSON.stringify({ workspaceRoot: workspace, path: copyPath })}
    }))`)
    await cdp.wait(`(() => {
      const panel=document.querySelector('.ds-code-sidebar');
      const canvas=[...(panel?.querySelectorAll('canvas[data-u-comp="render-canvas"]')??[])]
        .find(item=>item.getClientRects().length&&item.clientWidth>200&&item.clientHeight>150);
      return panel?.innerText.includes(${JSON.stringify(copyName)})&&canvas;
    })()`, 'the saved workbook reopened in the visible grid')
    const reopened = await cdp.evaluate(`window.workwise.openSpreadsheet(${JSON.stringify({ workspaceRoot: workspace, path: copyPath })})`)
    assert.equal(reopened.kind, 'workbook')
    const reopenedWorkbook = JSON.parse(reopened.content).workbook
    assert.equal(reopenedWorkbook.sheetOrder.length, 2)
    assert.equal(workbookCell(reopenedWorkbook, 0, 0)?.v, 9)
    assert.equal(reopenedWorkbook.sheets[reopenedWorkbook.sheetOrder[1]]?.name, '监测导入')
    report.savedWorkbook = { path: copyName, sheetCount: savedCopy.sheetOrder.length,
      reopenedThroughProductionReader: true, reopenedInVisibleGrid: true, formulaValueAfterReopen: workbookCell(reopenedWorkbook, 0, 0)?.v }
    report.checks.push('save-reopen-multiple-sheets-through-production-reader')

    stage = 'verify-read-only-xlsx-grid'
    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('kun:workspace-file-preview', {
      detail:${JSON.stringify({ workspaceRoot: workspace, path: xlsxPath })}
    }))`)
    const previewRendered = await cdp.wait(`(() => {
      const panel=document.querySelector('.ds-code-sidebar');
      const canvas=[...(panel?.querySelectorAll('canvas[data-u-comp="render-canvas"]')??[])]
        .find(item=>item.getClientRects().length&&item.clientWidth>200&&item.clientHeight>150);
      return panel?.innerText.includes('只读预览')&&canvas&&{
        saveButtonVisible:[...panel.querySelectorAll('button')].some(button=>button.getClientRects().length&&button.textContent.includes('保存表格')),
        csvImportVisible:[...panel.querySelectorAll('button')].some(button=>button.getClientRects().length&&button.textContent.includes('导入 CSV')),
        systemOpenEntryVisible:[...panel.querySelectorAll('button')].some(button=>button.getClientRects().length&&
          (button.getAttribute('aria-label')==='在系统应用打开'||button.textContent.includes('在系统应用打开')))
      };
    })()`, 'read-only XLSX grid')
    assert.equal(previewRendered.saveButtonVisible, false)
    assert.equal(previewRendered.csvImportVisible, false)
    assert.equal(previewRendered.systemOpenEntryVisible, true)
    const preview = await cdp.evaluate(`window.workwise.openSpreadsheet(${JSON.stringify({ workspaceRoot: workspace, path: xlsxPath })})`)
    assert.equal(preview.kind, 'xlsx')
    assert.deepEqual(preview.preview.sheets.map(sheet => sheet.name), ['监测点', '记录'])
    assert.ok(preview.preview.sheets[0].cells.some(cell => cell.row === 3 && cell.column === 1 && cell.value === '001'))
    assert.ok(preview.preview.sheets[0].cells.some(cell => cell.row === 3 && cell.column === 3 && cell.value === 12))
    assert.ok(preview.preview.sheets[1].cells.some(cell => cell.row === 1 && cell.column === 0 && cell.value === '地铁'))
    assert.equal(await sha256(xlsxPath), originalXlsxSha256, 'XLSX source bytes must stay unchanged in read-only preview')
    report.xlsxPreview = { filename: xlsxName, sha256: originalXlsxSha256, sheetNames: preview.preview.sheets.map(sheet => sheet.name),
      preservedSparseCellCoordinates: true, renderedReadOnlyGrid: true, editingControlsHidden: true,
      systemOpenEntryVisible: previewRendered.systemOpenEntryVisible }
    report.checks.push('xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes')

    report.packageUnchanged = await sha256(asarPath) === installedAsarSha256
    assert.equal(report.packageUnchanged, true, 'Installed ASAR must remain unchanged during spreadsheet acceptance')
    report.status = 'passed'
    validateWindowsOfflineSpreadsheetReport(report, { version, sourceHead, buildRunId, buildRunAttempt,
      installerSha256, installedAsarSha256 })
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error), stage }
    if (originalWorkbookPath) {
      report.workbookAtFailure = await readFile(originalWorkbookPath, 'utf8').then(contents => JSON.parse(contents)).catch(() => undefined)
    }
    if (cdp) {
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 5000).catch(() => undefined)
      if (screenshot?.data) {
        const name = 'windows-offline-spreadsheet-failure.png'
        await writeFile(join(evidenceDir, name), Buffer.from(screenshot.data, 'base64'))
        report.failureScreenshot = name
      }
    }
    throw error
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  return report
}
