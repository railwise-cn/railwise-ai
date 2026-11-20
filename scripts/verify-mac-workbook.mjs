import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

const json = path => readFile(path, 'utf8').then(JSON.parse)
const literal = JSON.stringify

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
  const receipt = { status: 'failed', network: 'renderer HTTP and HTTPS blocked', checks: [] }
  try {
    await cdp.send('Network.enable')
    await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] })
    const ready = '[...document.querySelectorAll("button")].some(button=>button.textContent==="保存表格"&&!button.disabled)'
    const click = label => cdp.click('button', label)
    const save = () => click('保存表格')
    const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
      const event = { key, code, windowsVirtualKeyCode, modifiers }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    }
    const readWorkbook = async path => {
      const saved = await json(path)
      assert.equal(saved.version, 1)
      return saved.workbook
    }
    const cell = (workbook, row, column) => workbook.sheets?.[workbook.sheetOrder?.[0]]?.cellData?.[row]?.[column]

    await cdp.click('button[aria-label="新建表格"]')
    const canvasExpression = '[...document.querySelectorAll("canvas")].map(c=>c.getBoundingClientRect().toJSON()).find(box=>box.width>200&&box.height>150)'
    await cdp.wait(ready + ' && (' + canvasExpression + ')', 'real editable workbook')
    receipt.checks.push('new-workbook')
    const filename = (await readdir(workspace)).find(name => name.endsWith('.rwsheet'))
    assert.ok(filename)
    const original = join(workspace, filename)
    const clickCell = async (row, column, count = 1) => {
      const canvas = await cdp.wait(canvasExpression, 'grid canvas')
      const point = { x: canvas.x + 68 + column * 79, y: canvas.y + 30 + row * 22 }
      for (let clickCount = 1; clickCount <= count; clickCount++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
      }
    }
    const edit = async (row, column, text) => {
      await clickCell(row, column, 2)
      await cdp.send('Input.insertText', { text })
      await key('Enter', 'Enter', 13)
    }

    await edit(0, 0, '=SUM(4,5)')
    await wait(300)
    await save()
    const formula = await until('a saved calculated formula', async () => {
      const actual = cell(await readWorkbook(original), 0, 0)
      return actual?.f === '=SUM(4,5)' && actual.v === 9 && actual
    })
    receipt.formula = { expression: formula.f, value: formula.v }
    receipt.checks.push('formula-calculated-and-persisted')

    await edit(0, 1, '撤销前')
    await wait(200)
    await save()
    await until('the edited value', async () => cell(await readWorkbook(original), 0, 1)?.v === '撤销前')
    await clickCell(1, 1)
    await key('z', 'KeyZ', 90, 4)
    await wait(200)
    await save()
    await until('the reverted value', async () => {
      const book = await readWorkbook(original)
      return cell(book, 0, 0)?.v === 9 && (cell(book, 0, 1)?.v ?? '') === ''
    })
    receipt.checks.push('native-macos-undo-restored-previous-value')

    await edit(0, 1, '保留未保存修改')
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
    receipt.status = 'passed'
    return receipt
  } catch (error) {
    receipt.error = error.message
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'mac-workbook.json'), `${literal(receipt, null, 2)}\n`)
  }
}
