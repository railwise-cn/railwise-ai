import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { connectCdp } from './run-windows-ui-smoke.mjs'

const require = createRequire(import.meta.url)
const JSZip = require('jszip')
const REPORT_FILE = 'mac-offline-spreadsheet.json'

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

async function until(description, read, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(100)
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

function createCandidateEnvironment(environment, root, profile, workspace) {
  const home = join(root, 'home')
  const cache = join(root, 'cache')
  const logs = join(root, 'logs')
  const runtime = join(root, 'runtime')
  return {
    PATH: environment.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: cache,
    TMPDIR: root,
    LANG: 'zh_CN.UTF-8',
    WORKWISE_CANDIDATE: '1',
    WORKWISE_CANDIDATE_ROOT: root,
    WORKWISE_CANDIDATE_USER_DATA: profile,
    WORKWISE_CANDIDATE_CACHE: cache,
    WORKWISE_CANDIDATE_LOGS: logs,
    WORKWISE_CANDIDATE_HOME: home,
    WORKWISE_TOOLS_ROOT: join(home, '.workwise', 'tools'),
    WORKWISE_CANDIDATE_OUTBOUND_DISABLED: '1',
    WORKWISE_CANDIDATE_INBOUND_DISABLED: '1',
    WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '0',
    RAILWISE_QA_WORKSPACE: workspace,
    RAILWISE_QA_RUNTIME: runtime
  }
}

export function spreadsheetCellAddress(row, column) {
  let columnNumber = column + 1
  let columnName = ''
  while (columnNumber > 0) {
    const remainder = (columnNumber - 1) % 26
    columnName = String.fromCharCode(65 + remainder) + columnName
    columnNumber = Math.floor((columnNumber - 1) / 26)
  }
  return `${columnName}${row + 1}`
}

export function parseSpreadsheetCellAddress(address) {
  const match = /^([A-Z]+)(\d+)$/i.exec(address.trim())
  if (!match || Number(match[2]) < 1) return null
  let column = 0
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64
  return { row: Number(match[2]) - 1, column: column - 1 }
}

async function findRendererSocket(profile, log, expectedUrl) {
  const portFromLog = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
  const portFromProfile = await readFile(join(profile, 'DevToolsActivePort'), 'utf8')
    .then(contents => contents.split('\n')[0]).catch(() => '')
  const port = portFromLog || portFromProfile
  if (!/^\d+$/.test(port ?? '')) return null
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
    .then(response => response.json()).catch(() => [])
  return targets.find(target => target.type === 'page' && target.url.startsWith('file:') &&
    fileURLToPath(target.url) === expectedUrl && target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`))?.webSocketDebuggerUrl ?? null
}

export async function runInstalledMacOfflineSpreadsheetJourney({
  executable,
  temporary,
  evidenceDir,
  version,
  installedAsarSha256,
  installer,
  source
}) {
  assert.equal(process.platform, 'darwin')
  const root = await mkdtemp(join(temporary, 'railwise-mac-offline-sheet-'))
  const workspace = join(root, '工程验收')
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  const home = join(root, 'home')
  const cache = join(root, 'cache')
  const logs = join(root, 'logs')
  const downloads = join(root, 'downloads')
  const xlsxName = '只读预览.xlsx'
  const xlsxPath = join(workspace, xlsxName)
  const report = {
    schemaVersion: 1,
    status: 'running',
    platform: 'darwin',
    arch: process.arch,
    version,
    sourceHead: source.sourceHead,
    buildRunId: source.runId,
    buildRunAttempt: source.runAttempt,
    installerSha256: installer.sha256,
    installedAsarSha256,
    execution: 'installed-ui',
    networkIsolation: {
      outboundDisabledEnvironment: true,
      rendererBlockedProtocols: ['http:', 'https:'],
      chromiumProxy: '127.0.0.1:9',
      credentialAccessDisabled: true
    },
    checks: []
  }
  let child
  let cdp
  let launchLog = ''
  let originalWorkbookPath

  try {
    await Promise.all([workspace, profile, runtime, home, cache, logs, downloads, evidenceDir]
      .map(path => mkdir(path, { recursive: true })))
    await createXlsxFixture(xlsxPath)
    const originalXlsxSha256 = await sha256(xlsxPath)
    const profileSettings = {
      schema: 'workwise.settings',
      version: 2,
      revision: 0,
      locale: 'zh',
      theme: 'light',
      workspaceRoot: workspace,
      appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
      agents: { kun: { autoStart: true, dataDir: runtime, port: 58931 } }
    }
    await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify(profileSettings))
    const environment = createCandidateEnvironment(process.env, root, profile, workspace)
    child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--lang=zh-CN', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { launchLog = (launchLog + bytes).slice(-3000) })
    let launchError
    child.once('error', error => { launchError = error })
    const asarPath = join(dirname(dirname(executable)), 'Resources', 'app.asar')
    const expectedRenderer = join(await import('node:fs/promises').then(fs => fs.realpath(asarPath)), 'out', 'renderer', 'index.html')
    const socket = await until('installed renderer', async () => {
      if (launchError) throw launchError
      assert.equal(child.exitCode, null, 'Installed candidate exited before the workbook journey started')
      return findRendererSocket(profile, launchLog, expectedRenderer)
    }, 60_000)
    cdp = await connectCdp(socket)
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] })
    assert.equal(await cdp.evaluate('window.workwise.getAppVersion()'), version)

    const click = async text => {
      try { await cdp.click('button', text) } catch (error) {
        report.lastClickFailure = {
          label: text,
          error: error instanceof Error ? error.message : String(error),
          state: await cdp.evaluate(`(() => ({url:location.href,title:document.title,
            activeOverlay:document.querySelector('.ds-workbench-shell')?.dataset.activeOverlay??null,
            visibleButtons:[...document.querySelectorAll('button')].filter(button=>button.getClientRects().length).map(button=>({
              text:button.textContent.trim().slice(0,80),ariaLabel:button.getAttribute('aria-label'),disabled:button.disabled
            })).slice(-60),
            visibleSections:[...document.querySelectorAll('section')].filter(section=>section.getClientRects().length).map(section=>section.getAttribute('aria-label')).filter(Boolean)
          }))()`, 2000).catch(() => undefined)
        }
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 5000).catch(() => undefined)
        if (capture?.data) {
          const name = 'mac-offline-spreadsheet-click-failure.png'
          await writeFile(join(evidenceDir, name), Buffer.from(capture.data, 'base64'))
          report.lastClickFailure.screenshot = name
        }
        throw error
      }
    }
    const newWorkbookButton = 'button[aria-label="新建表格"]'
    const navigationReady = await cdp.wait(`(() => {
      const workbook = document.querySelector(${JSON.stringify(newWorkbookButton)})
      const newConversation = document.querySelector('button[aria-label="新建会话"]')
      if (workbook?.getClientRects().length) return 'workbook'
      if (newConversation?.getClientRects().length && !newConversation.disabled) return 'new-conversation'
      return null
    })()`, 'workbook navigation controls', 30_000)
    if (navigationReady === 'new-conversation') {
      await cdp.click('button[aria-label="新建会话"]', '新建会话')
      await cdp.wait(`Boolean(document.querySelector(${JSON.stringify(newWorkbookButton)})?.getClientRects().length)`, 'new conversation workbook controls')
    }
    const editableReady = '[...document.querySelectorAll("button")].some(button => button.textContent === "保存表格" && !button.disabled)'
    const save = () => click('保存表格')
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
    const cellAt = (workbook, row, column) => workbook.sheets?.[workbook.sheetOrder?.[0]]?.cellData?.[row]?.[column]
    const cellAddressAttempts = []
    let rowPixelCorrection = 0
    let columnPixelCorrection = 0

    await click('新建表格')
    await cdp.wait(`${editableReady} && [...document.querySelectorAll('.ds-code-sidebar canvas[data-u-comp="render-canvas"]')]
      .some(canvas => canvas.clientWidth > 200 && canvas.clientHeight > 150)`, 'editable workbook')
    report.checks.push('new-local-rwsheet')
    const filename = (await readdir(workspace)).find(name => name.endsWith('.rwsheet'))
    assert.ok(filename, 'New workbook must be saved in the isolated workspace')
    originalWorkbookPath = join(workspace, filename)
    let canvas
    const cellEditorId = '__editor___INTERNAL_EDITOR__DOCS_NORMAL'
    const clickCell = async (row, column, count = 1) => {
      let previous
      const interaction = await until('stable visible workbook cell', async () => {
        const current = await cdp.evaluate(`(() => {
          const canvas=[...document.querySelectorAll('.ds-code-sidebar canvas[data-u-comp="render-canvas"]')]
            .find(item=>item.getClientRects().length&&item.clientWidth>200&&item.clientHeight>150);
          if(!canvas)return null;
          const box=canvas.getBoundingClientRect().toJSON();
          const point={x:box.x+83+${column}*79+${columnPixelCorrection},y:box.y+59+${row}*22+${rowPixelCorrection}};
          const element=document.elementFromPoint(point.x,point.y);
          const hit=element?{tag:element.tagName,component:element.getAttribute('data-u-comp'),className:element.className?.toString?.()??''}:null;
          return {box,point,hit,ready:Boolean(element===canvas&&hit?.component==='render-canvas')};
        })()`)
        if (!current?.ready) { previous = undefined; return null }
        if (previous && ['x', 'y', 'width', 'height'].every(key => previous.box[key] === current.box[key])) return current
        previous = current
        return null
      })
      canvas = interaction.box
      const point = interaction.point
      report.lastCellInteraction = { row, column, canvas, point, hit: interaction.hit }
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
      }
    }
    const edit = async (row, column, value) => {
      const expectedAddress = spreadsheetCellAddress(row, column)
      for (let attempt = 0; attempt < 3; attempt++) {
        await clickCell(row, column, 2)
        await cdp.wait(`document.activeElement?.id === ${JSON.stringify(cellEditorId)} && document.activeElement.isContentEditable`,
          'Univer cell editor focus')
        let address = await cdp.evaluate('document.querySelector(\'[data-u-comp="sheet-cell-editor-address"]\')?.textContent?.trim() ?? null')
        if (!address) {
          const point = report.lastCellInteraction.point
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 1, deltaY: 0 })
          try {
            address = await cdp.wait('document.querySelector(\'[data-u-comp="sheet-cell-editor-address"]\')?.textContent?.trim() || null',
              'selected cell address', 3000)
          } finally {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: -1, deltaY: 0 })
          }
        }
        const actualCell = parseSpreadsheetCellAddress(address)
        const attemptEvidence = { expectedAddress, address, point: report.lastCellInteraction.point, rowPixelCorrection, columnPixelCorrection }
        cellAddressAttempts.push(attemptEvidence)
        report.cellAddressAttempts = cellAddressAttempts
        if (address === expectedAddress) {
          await cdp.send('Input.insertText', { text: value })
          await key('Enter', 'Enter', 13)
          return
        }
        await key('Escape', 'Escape', 27)
        if (!actualCell) throw new Error(`Univer did not expose a valid selected cell address. Expected ${expectedAddress}, received ${address}`)
        rowPixelCorrection += (row - actualCell.row) * 22
        columnPixelCorrection += (column - actualCell.column) * 79
      }
      throw new Error(`Univer cell selection did not reach ${expectedAddress}. Attempts: ${JSON.stringify(cellAddressAttempts)}`)
    }

    await edit(0, 0, '=SUM(4,5)')
    await save()
    let formula = await until('saved formula expression in A1', async () => {
      const cell = cellAt(await readWorkbook(originalWorkbookPath), 0, 0)
      return cell?.f === '=SUM(4,5)' ? cell : null
    })
    if (formula.v !== 9) {
      await wait(250)
      await save()
      formula = await until('calculated formula result in A1 after one save retry', async () => {
        const cell = cellAt(await readWorkbook(originalWorkbookPath), 0, 0)
        return cell?.f === '=SUM(4,5)' && cell.v === 9 ? cell : null
      })
    }
    report.formula = { expression: formula.f, value: formula.v, address: 'A1' }
    report.checks.push('formula-calculation-saved')

    await edit(0, 1, '撤销前')
    await save()
    await until('pre-undo value in B1', async () => cellAt(await readWorkbook(originalWorkbookPath), 0, 1)?.v === '撤销前')
    await clickCell(0, 1)
    await key('z', 'KeyZ', 90, 4)
    await save()
    await until('undo value removal', async () => {
      const workbook = await readWorkbook(originalWorkbookPath)
      return cellAt(workbook, 0, 0)?.v === 9 && cellAt(workbook, 0, 1)?.v !== '撤销前'
    })
    report.checks.push('undo-restores-prior-cell-value')

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
    assert.equal(cellAt(copied, 0, 1)?.v, '保留未保存修改')
    assert.equal(cellAt(copied, 0, 0)?.v, 9)
    assert.equal(await readFile(originalWorkbookPath, 'utf8'), externalBytes)
    report.conflict = { originalPreserved: true, copyPreservedUnsavedEdit: true, copySha256: await sha256(copyPath) }
    report.checks.push('external-save-conflict-preserves-original-and-saves-copy')

    const csvPath = join(root, '监测导入.csv')
    await writeFile(csvPath, '\uFEFF点位,位移\r\n001,"4.20"\r\n')
    const rootNode = (await cdp.send('DOM.getDocument')).root.nodeId
    const input = (await cdp.send('DOM.querySelector', { nodeId: rootNode, selector: 'input[accept=".csv,text/csv"]' })).nodeId
    assert.ok(input, 'CSV import control must be available')
    await cdp.send('DOM.setFileInputFiles', { nodeId: input, files: [csvPath] })
    await cdp.wait('document.body.innerText.includes("已导入 · 监测导入")', 'Chinese CSV import')
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await click('导出当前表为 CSV')
    const exported = await until('downloaded Chinese CSV', async () => {
      const name = (await readdir(downloads)).find(file => file.endsWith('.csv'))
      if (!name) return null
      const contents = await readFile(join(downloads, name), 'utf8')
      return contents.includes('点位,位移') && contents.includes('001,4.20') ? { name, contents } : null
    })
    report.csv = { filename: exported.name, bytes: Buffer.byteLength(exported.contents), preservesLeadingZeroAndPrecision: true }
    report.checks.push('utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal')

    await save()
    const savedCopy = await until('saved workbook with imported CSV sheet', async () => {
      const workbook = await readWorkbook(copyPath)
      return workbook.sheetOrder.length === 2 ? workbook : null
    })
    const reopened = await cdp.evaluate(`window.workwise.openSpreadsheet(${JSON.stringify({ workspaceRoot: workspace, path: copyPath })})`)
    assert.equal(reopened.kind, 'workbook')
    assert.equal(JSON.parse(reopened.content).workbook.sheetOrder.length, 2)
    report.savedWorkbook = { path: copyName, sheetCount: savedCopy.sheetOrder.length, reopenedThroughProductionReader: true,
      sha256: await sha256(copyPath) }
    report.checks.push('save-reopen-multiple-sheets-through-production-reader')

    await cdp.evaluate(`window.dispatchEvent(new CustomEvent('kun:workspace-file-preview', {
      detail: ${JSON.stringify({ workspaceRoot: workspace, path: xlsxPath })}
    }))`)
    const previewRendered = await cdp.wait(`(() => {
      const panel = document.querySelector('.ds-code-sidebar');
      const canvas = [...(panel?.querySelectorAll('canvas[data-u-comp="render-canvas"]') ?? [])]
        .find(item => item.getClientRects().length && item.clientWidth > 200 && item.clientHeight > 150);
      return panel?.innerText.includes('只读预览') && canvas && {
        panelVisible: Boolean(panel.getClientRects().length), gridRendered: true,
        saveButtonVisible: [...panel.querySelectorAll('button')].some(button => button.getClientRects().length && button.textContent.includes('保存表格')),
        csvImportVisible: [...panel.querySelectorAll('button')].some(button => button.getClientRects().length && button.textContent.includes('导入 CSV')),
        systemOpenEntryVisible: [...panel.querySelectorAll('button')].some(button => button.getClientRects().length &&
          (button.getAttribute('aria-label') === '在系统应用打开' || button.textContent.includes('在系统应用打开')))
      };
    })()`, 'read-only XLSX grid', 45_000)
    assert.equal(previewRendered.panelVisible, true)
    assert.equal(previewRendered.gridRendered, true)
    assert.equal(previewRendered.saveButtonVisible, false)
    assert.equal(previewRendered.csvImportVisible, false)
    assert.equal(previewRendered.systemOpenEntryVisible, true)
    const preview = await cdp.evaluate(`window.workwise.openSpreadsheet(${JSON.stringify({ workspaceRoot: workspace, path: xlsxPath })})`)
    assert.equal(preview.kind, 'xlsx')
    assert.deepEqual(preview.preview.sheets.map(sheet => sheet.name), ['监测点', '记录'])
    assert.ok(preview.preview.sheets[0].cells.some(cell => cell.row === 3 && cell.column === 1 && cell.value === '001'))
    assert.ok(preview.preview.sheets[0].cells.some(cell => cell.row === 3 && cell.column === 3 && cell.value === 12))
    assert.ok(preview.preview.sheets[1].cells.some(cell => cell.row === 1 && cell.column === 0 && cell.value === '地铁'))
    assert.equal(await sha256(xlsxPath), originalXlsxSha256, 'XLSX source bytes must remain unchanged by read-only preview')
    report.xlsxPreview = { filename: xlsxName, sha256: originalXlsxSha256, sheetNames: preview.preview.sheets.map(sheet => sheet.name),
      preservedSparseCellCoordinates: true, renderedReadOnlyGrid: true, editingControlsHidden: true, systemOpenEntryVisible: true }
    report.checks.push('xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes')

    report.packageUnchanged = await sha256(asarPath) === installedAsarSha256
    assert.equal(report.packageUnchanged, true, 'Installed ASAR must remain unchanged during spreadsheet acceptance')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error instanceof Error ? error.message : String(error)
    report.launchTail = launchLog
    if (cdp) {
      if (originalWorkbookPath) {
        report.workbookAtFailure = await readFile(originalWorkbookPath, 'utf8')
          .then(contents => JSON.parse(contents))
          .catch(error => ({ readError: error instanceof Error ? error.message : String(error) }))
      }
      report.rendererEndState = await cdp.evaluate(`(() => ({
        url: location.href,
        title: document.title,
        gridCanvases: [...document.querySelectorAll('.ds-code-sidebar canvas')].map(canvas => ({
          component: canvas.dataset.uComp ?? null,
          rect: canvas.getBoundingClientRect().toJSON(),
          pointerEvents: getComputedStyle(canvas).pointerEvents,
          className: canvas.className
        })),
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName,
          component: document.activeElement.getAttribute('data-u-comp'),
          className: document.activeElement.className?.toString?.() ?? ''
        } : null,
        cellEditors: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].map(element => ({
          tag: element.tagName,
          id: element.id,
          editable: element.isContentEditable,
          value: 'value' in element ? element.value : element.textContent,
          innerText: element.innerText,
          className: element.className?.toString?.() ?? ''
        })),
        activeButtons: [...document.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => ({
          text: button.textContent.trim().slice(0, 80), ariaLabel: button.getAttribute('aria-label'), disabled: button.disabled
        })).slice(-80),
        text: document.body.innerText.slice(-1400)
      }))()`, 1000).catch(() => undefined)
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 5000).catch(() => undefined)
      if (capture?.data) {
        const name = 'mac-offline-spreadsheet-failure.png'
        await writeFile(join(evidenceDir, name), Buffer.from(capture.data, 'base64'))
        report.failureScreenshot = name
      }
    }
    throw error
  } finally {
    cdp?.close()
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await until('owned acceptance process shutdown', () => child.exitCode !== null || child.signalCode !== null, 4_000)
        .catch(() => child.kill('SIGKILL'))
    }
    await writeFile(join(evidenceDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error('This acceptance driver is loaded by run-mac-startup-appearance-smoke.mjs')
}
