import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseSpreadsheetCellAddress, spreadsheetCellAddress } from './run-mac-offline-spreadsheet-journey.mjs'

const sourcePath = fileURLToPath(new URL('./run-mac-offline-spreadsheet-journey.mjs', import.meta.url))

test('Mac workbook journey selects the enabled sidebar conversation button before navigating', async () => {
  const source = await readFile(sourcePath, 'utf8')
  const journey = source.slice(source.indexOf('export async function runInstalledMacOfflineSpreadsheetJourney'))
  const helper = journey.indexOf('const click = async text =>')
  const navigationReady = journey.indexOf("'workbook navigation controls'")
  const newConversation = journey.indexOf("await cdp.click('button[aria-label=\"新建会话\"]', '新建会话')")

  assert.ok(helper >= 0)
  assert.ok(navigationReady > helper)
  assert.ok(newConversation > helper)
  assert.ok(navigationReady < newConversation)
  assert.ok(!journey.includes("await click('新建会话')"))
})

test('Mac workbook journey clicks the rendered Univer grid instead of utility canvases', async () => {
  const source = await readFile(sourcePath, 'utf8')
  const journey = source.slice(source.indexOf('export async function runInstalledMacOfflineSpreadsheetJourney'))

  assert.match(source, /B4" t="s"><v>1<\/v>/)
  assert.match(source, /<si><t>点位<\/t><\/si><si><t>001<\/t><\/si>/)
  assert.match(journey, /\.ds-code-sidebar canvas\[data-u-comp="render-canvas"\]/)
  assert.match(journey, /box\.x\+83\+\$\{column\}\*79\+\$\{columnPixelCorrection\}/)
  assert.match(journey, /box\.y\+37\+\$\{row\}\*22/)
  assert.match(journey, /element===canvas&&hit\?\.component==='render-canvas'/)
  assert.match(journey, /Univer cell editor focus/)
  assert.match(journey, /saved formula expression in A1/)
  assert.match(journey, /pre-undo value in B1/)
  assert.match(journey, /report\.cellEdits = cellEdits/)
  assert.match(journey, /cellAt\(workbook, 0, 0\)\?\.v === 9 && cellAt\(workbook, 0, 1\)/)
  assert.match(journey, /kun:workspace-file-preview/)
  assert.match(journey, /workbookAtFailure/)
  assert.match(journey, /gridCanvases:/)
})

test('Mac workbook journey maps row and column indexes to strict cell addresses', () => {
  assert.equal(spreadsheetCellAddress(0, 0), 'A1')
  assert.equal(spreadsheetCellAddress(0, 25), 'Z1')
  assert.equal(spreadsheetCellAddress(0, 26), 'AA1')
  assert.deepEqual(parseSpreadsheetCellAddress('B1'), { row: 0, column: 1 })
  assert.deepEqual(parseSpreadsheetCellAddress('AA12'), { row: 11, column: 26 })
  assert.equal(parseSpreadsheetCellAddress('A0'), null)
})
