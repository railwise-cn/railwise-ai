import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const sourcePath = fileURLToPath(new URL('./run-mac-offline-spreadsheet-journey.mjs', import.meta.url))

test('Mac workbook journey initializes its UI click helper before the first workbook navigation', async () => {
  const source = await readFile(sourcePath, 'utf8')
  const journey = source.slice(source.indexOf('export async function runInstalledMacOfflineSpreadsheetJourney'))
  const helper = journey.indexOf('const click = async text =>')
  const firstUse = journey.indexOf("await click('新建会话')")

  assert.ok(helper >= 0)
  assert.ok(firstUse > helper)
})
