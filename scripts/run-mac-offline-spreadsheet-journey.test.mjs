import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

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

  assert.match(journey, /\.ds-code-sidebar canvas\[data-u-comp="render-canvas"\]/)
  assert.match(journey, /Univer cell editor focus/)
  assert.match(journey, /text in the active cell editor/)
  assert.match(journey, /committed cell edit/)
  assert.match(journey, /workbookAtFailure/)
  assert.match(journey, /gridCanvases:/)
})
