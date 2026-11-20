import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const json = path => readFile(path, 'utf8').then(JSON.parse)
const literal = JSON.stringify
const addressInput = '[data-u-comp="defined-name"] input:not(:disabled)'

export function macWorkbookCanvasPoint(canvas, address, layout = {}) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,5})$/.exec(address)
  if (!match) throw new Error('Invalid workbook address')
  const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1
  const row = Number(match[2]) - 1
  const { rect, clientWidth, clientHeight } = canvas
  const scaleX = rect.width / clientWidth, scaleY = rect.height / clientHeight
  if (![scaleX, scaleY].every(scale => Number.isFinite(scale) && scale > 0)) throw new Error('Invalid measured canvas scale')
  // Defaults of the pinned Univer 1.5.2 blank sheet; prefer the actual saved
  // sheet dimensions when supplied. Coordinates remain viewport CSS pixels.
  const x = rect.x + ((layout.rowHeader?.width ?? 46) + (column + 0.5) * (layout.defaultColumnWidth ?? 88)) * scaleX
  const y = rect.y + ((layout.columnHeader?.height ?? 20) + (row + 0.5) * (layout.defaultRowHeight ?? 24)) * scaleY
  if (x <= rect.x || y <= rect.y || x >= rect.x + rect.width || y >= rect.y + rect.height) throw new Error('Cell is outside the visible canvas')
  return { x, y }
}

async function key(cdp, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const event = { key, code, windowsVirtualKeyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}

export async function selectMacWorkbookCell(cdp, address, layout = {}) {
  assert.match(address, /^[A-Z]{1,3}[1-9]\d{0,5}$/)
  const target = await cdp.wait(`(() => {
    const input=document.querySelector(${literal(addressInput)});
    const zoom=getComputedStyle(document.documentElement).getPropertyValue('--ds-ui-scale');
    if(input?.getClientRects().length){
      const box=input.getBoundingClientRect(),point={x:box.x+box.width/2,y:box.y+box.height/2};
      if(document.elementFromPoint(point.x,point.y)!==input)return null;
      return {kind:'address',point,rect:box.toJSON(),zoom};
    }
    const canvas=[...document.querySelectorAll('canvas')].find(node=>node.clientWidth>200&&node.clientHeight>150&&node.getClientRects().length);
    if(!canvas)return null;
    const geometry={rect:canvas.getBoundingClientRect().toJSON(),clientWidth:canvas.clientWidth,clientHeight:canvas.clientHeight};
    const point=(${macWorkbookCanvasPoint.toString()})(geometry,${literal(address)},${literal(layout)});
    if(document.elementFromPoint(point.x,point.y)!==canvas)return null;
    return {kind:'canvas',point,...geometry,zoom};
  })()`, 'the actual workbook cell target')
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...target.point })
  if (target.kind === 'canvas') return { address, ...target }
  await cdp.wait(`document.activeElement?.matches(${literal(addressInput)})`, 'workbook address keyboard focus')
  await key(cdp, 'a', 'KeyA', 65, 4)
  await key(cdp, 'Backspace', 'Backspace', 8)
  await cdp.send('Input.insertText', { text: address })
  await cdp.wait(`document.querySelector(${literal(addressInput)})?.value===${literal(address)}`, 'the typed workbook cell address')
  await key(cdp, 'Enter', 'Enter', 13)
  await cdp.wait(`!document.activeElement?.matches(${literal(addressInput)}) && document.querySelector(${literal(addressInput)})?.value===${literal(address)}`,
    'the selected cell after native address navigation')
  return { address, ...target }
}

function observeWorkbookUi() {
  const rect = node => node?.getBoundingClientRect().toJSON()
  const active = document.activeElement
  const input = document.querySelector('[data-u-comp="defined-name"] input')
  return {
    devicePixelRatio, scale: getComputedStyle(document.documentElement).getPropertyValue('--ds-ui-scale'),
    nameBox: input ? { value: input.value, rect: rect(input) } : null,
    focused: active ? { tag: active.tagName, id: active.id, editable: active.isContentEditable,
      component: active.getAttribute('data-u-comp'), text: active.isContentEditable ? active.textContent.slice(0, 120) : undefined } : null,
    canvases: [...document.querySelectorAll('canvas')].filter(node => node.clientWidth > 200 && node.clientHeight > 150)
      .slice(0, 4).map(node => ({ rect: rect(node), clientWidth: node.clientWidth, clientHeight: node.clientHeight,
        width: node.width, height: node.height, zoom: getComputedStyle(node).zoom })),
    status: [...document.querySelectorAll('[role="status"],[role="alert"]')].map(node => node.textContent.trim().slice(0, 160)).slice(0, 6)
  }
}

async function until(label, read) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(100)
  }
  throw new Error(`The installed workbook did not produce ${label}`)
}

export async function verifyMacWorkbook(cdp, { root, workspace }, evidenceDir) {
  const receipt = { status: 'failed', network: 'renderer HTTP and HTTPS blocked', checks: [], diagnostics: [] }
  let original
  const sample = async phase => {
    receipt.diagnostics.push({ phase, ui: await cdp.evaluate(`(${observeWorkbookUi.toString()})()`),
      ...(original ? { savedCells: await json(original).then(saved => {
        const sheet = saved.workbook.sheets?.[saved.workbook.sheetOrder?.[0]]
        return Object.entries(sheet?.cellData ?? {}).flatMap(([row, columns]) => Object.entries(columns)
          .map(([column, cell]) => ({ row, column, formula: cell.f, value: cell.v }))).slice(0, 12)
      }).catch(() => undefined) } : {}) })
  }
  try {
    await cdp.send('Page.bringToFront')
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] })
    const ready = '[...document.querySelectorAll("button")].some(button=>button.textContent==="保存表格"&&!button.disabled)'
    const click = label => cdp.click('button', label)
    const save = () => click('保存表格')
    const readWorkbook = async path => {
      const saved = await json(path)
      assert.equal(saved.version, 1)
      return saved.workbook
    }
    const cell = (workbook, row, column) => workbook.sheets?.[workbook.sheetOrder?.[0]]?.cellData?.[row]?.[column]

    let returnedFromSettings = false
    const returnFromSettings = async () => {
      const settingsBack = await cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='返回'&&button.getClientRects().length))`)
      if (!settingsBack) return
      assert.equal(returnedFromSettings, false, 'Unexpected repeated navigation to settings')
      await cdp.click('button', '返回')
      returnedFromSettings = true
      receipt.diagnostics.push({ phase: 'returned-from-settings-through-real-back-button' })
      await wait(300)
    }

    await wait(750)
    await returnFromSettings()
    await cdp.click('button[aria-label="新建表格"]')
    const canvasExpression = '[...document.querySelectorAll("canvas")].map(c=>c.getBoundingClientRect().toJSON()).find(box=>box.width>200&&box.height>150)'
    await cdp.wait(ready + ' && (' + canvasExpression + ')', 'real editable workbook')
    receipt.checks.push('new-workbook')
    const filename = (await readdir(workspace)).find(name => name.endsWith('.rwsheet'))
    assert.ok(filename)
    original = join(workspace, filename)
    await sample('new-workbook')
    const initialWorkbook = await readWorkbook(original)
    const sheetLayout = initialWorkbook.sheets?.[initialWorkbook.sheetOrder?.[0]] ?? {}
    const layout = { rowHeader: sheetLayout.rowHeader, columnHeader: sheetLayout.columnHeader,
      defaultColumnWidth: sheetLayout.defaultColumnWidth, defaultRowHeight: sheetLayout.defaultRowHeight }
    const select = async address => {
      await returnFromSettings()
      const target = await selectMacWorkbookCell(cdp, address, layout)
      receipt.diagnostics.push({ phase: 'native-cell-selection', target })
    }
    const edit = async (address, text) => {
      await select(address)
      await key(cdp, 'F2', 'F2', 113)
      await cdp.wait('Boolean(document.activeElement?.isContentEditable && document.activeElement.id.startsWith("__editor_"))', 'the real focused cell editor')
      await sample('editing-' + address)
      await cdp.send('Input.insertText', { text })
      await key(cdp, 'Enter', 'Enter', 13)
      await sample('committed-' + address)
    }

    await edit('A1', '=SUM(4,5)')
    await wait(300)
    await save()
    await sample('first-formula-save')
    let resavedFormula = false
    const formula = await until('a saved calculated formula', async () => {
      const actual = cell(await readWorkbook(original), 0, 0)
      if (!resavedFormula && actual?.f === '=SUM(4,5)' && actual.v !== 9) {
        resavedFormula = true
        await wait(750)
        await save()
        await sample('formula-calculation-resave')
      }
      return actual?.f === '=SUM(4,5)' && actual.v === 9 && actual
    })
    receipt.formula = { expression: formula.f, value: formula.v }
    receipt.checks.push('formula-calculated-and-persisted')

    await edit('B1', '撤销前')
    await wait(200)
    await save()
    await until('the edited value', async () => cell(await readWorkbook(original), 0, 1)?.v === '撤销前')
    await select('B2')
    await key(cdp, 'z', 'KeyZ', 90, 4)
    await wait(200)
    await save()
    await until('the reverted value', async () => {
      const book = await readWorkbook(original)
      return cell(book, 0, 0)?.v === 9 && (cell(book, 0, 1)?.v ?? '') === ''
    })
    receipt.checks.push('native-macos-undo-restored-previous-value')

    await edit('B1', '保留未保存修改')
    await wait(200)
    const external = await json(original)
    external.workbook.name = '同时被外部程序修改'
    const externalBytes = literal(external)
    await writeFile(original, externalBytes)
    await save()
    const suggestion = await cdp.wait('document.querySelector(\'input[aria-label="新文件名"]\')?.value', 'save conflict and copy form')
    assert.match(suggestion, /^[^/\\]+副本$/)
    assert.equal(await readFile(original, 'utf8'), externalBytes)
    const copyName = `${suggestion}.rwsheet`
    await click('保存副本')
    await cdp.wait(`document.body.innerText.includes(${literal('已保存 · ' + copyName)})`, 'copy saved')
    const copy = join(workspace, copyName)
    const copied = await readWorkbook(copy)
    assert.equal(cell(copied, 0, 1)?.v, '保留未保存修改')
    assert.equal(cell(copied, 0, 0)?.v, 9)
    assert.equal(await readFile(original, 'utf8'), externalBytes)
    receipt.checks.push('outside-save-conflict-original-unchanged-copy-retains-unsaved-edit')

    const csv = join(root, '监测导入.csv')
    const downloads = join(root, 'downloads')
    await mkdir(downloads)
    await writeFile(csv, '\uFEFF点位,位移\r\n001,"4.20"\r\n')
    const rootNode = (await cdp.send('DOM.getDocument')).root.nodeId
    const input = (await cdp.send('DOM.querySelector', { nodeId: rootNode, selector: 'input[accept=".csv,text/csv"]' })).nodeId
    assert.ok(input)
    await cdp.send('DOM.setFileInputFiles', { nodeId: input, files: [csv] })
    await cdp.wait('document.body.innerText.includes("已导入 · 监测导入")', 'Chinese CSV imported')
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
    await click('导出当前表为 CSV')
    const exported = await until('a downloaded UTF-8 CSV', async () => {
      const name = (await readdir(downloads)).find(file => file.endsWith('.csv'))
      if (!name) return null
      const text = await readFile(join(downloads, name), 'utf8')
      return text.includes('点位,位移') && text.includes('001,4.20') ? text : null
    })
    receipt.csvBytes = Buffer.byteLength(exported)
    receipt.checks.push('active-csv-export-preserves-chinese-leading-zeros-and-decimal-text')
    await save()
    await until('saved sheets and formula', async () => {
      const book = await readWorkbook(copy)
      return book.sheetOrder.length === 2 && cell(book, 0, 0)?.v === 9
    })
    const reopened = await cdp.evaluate(`window.workwise.openSpreadsheet(${literal({ path: copy, workspaceRoot: workspace })})`)
    assert.equal(reopened.kind, 'workbook')
    assert.equal(JSON.parse(reopened.content).workbook.sheetOrder.length, 2)
    assert.equal(await readFile(original, 'utf8'), externalBytes)
    receipt.checks.push('saved-copy-read-back-through-installed-file-reader')
    await sample('completed-workbook')
    receipt.status = 'passed'
    return receipt
  } catch (error) {
    receipt.status = 'failed'
    receipt.error = error.message
    await sample('failure').catch(failure => { receipt.diagnosticError = failure.message })
    throw error
  } finally {
    try {
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 2000)
      const screenshot = Buffer.from(capture.data, 'base64')
      assert.ok(screenshot.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      await writeFile(join(evidenceDir, `mac-workbook${receipt.status === 'passed' ? '' : '-failure'}.png`), screenshot)
    } catch (error) { receipt.screenshotError = error.message }
    await writeFile(join(evidenceDir, 'mac-workbook.json'), `${literal(receipt, null, 2)}\n`)
  }
}
