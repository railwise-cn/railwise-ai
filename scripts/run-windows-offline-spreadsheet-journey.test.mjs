import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateWindowsOfflineSpreadsheetReport, validateWindowsSpreadsheetCandidate } from './run-windows-offline-spreadsheet-journey.mjs'
import { dispatchWindowsSmokeEntry } from './run-windows-ui-smoke.mjs'

const sourcePath = fileURLToPath(new URL('./run-windows-offline-spreadsheet-journey.mjs', import.meta.url))
const workflowPath = fileURLToPath(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url))
const installSmokePath = fileURLToPath(new URL('./run-windows-install-smoke.ps1', import.meta.url))

const identity = {
  version: '0.5.11',
  sourceHead: 'a'.repeat(40),
  buildRunId: 45115646587,
  buildRunAttempt: 1,
  installerSha256: 'b'.repeat(64),
  installedAsarSha256: 'c'.repeat(64)
}

function report() {
  return {
    status: 'passed', platform: 'win32', arch: 'x64', ...identity,
    execution: 'installed-ui', packageUnchanged: true,
    networkIsolation: { rendererOffline: true, blockedProtocols: ['http:', 'https:'] },
    checks: [
      'new-local-rwsheet', 'formula-calculation-saved', 'undo-restores-prior-cell-value',
      'external-save-conflict-preserves-original-and-saves-copy',
      'utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal',
      'save-reopen-multiple-sheets-through-production-reader',
      'xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes'
    ],
    formula: { expression: '=SUM(4,5)', value: 9 },
    undo: { shortcut: 'Ctrl+Z', restoredPreviousValue: true },
    conflict: { originalPreserved: true, copyPreservedUnsavedEdit: true },
    csv: { preservesLeadingZeroAndPrecision: true },
    savedWorkbook: { sheetCount: 2, reopenedThroughProductionReader: true, reopenedInVisibleGrid: true, formulaValueAfterReopen: 9 },
    xlsxPreview: { sheetNames: ['监测点', '记录'], preservedSparseCellCoordinates: true,
      renderedReadOnlyGrid: true, editingControlsHidden: true, systemOpenEntryVisible: true, sha256: 'd'.repeat(64) }
  }
}

test('Windows spreadsheet receipt binds the installed package and every offline workbook assertion', () => {
  assert.equal(validateWindowsSpreadsheetCandidate(identity).buildRunId, 45115646587)
  assert.equal(validateWindowsOfflineSpreadsheetReport(report(), identity).status, 'passed')

  const futureBuild = { ...identity, version: '0.5.12', sourceHead: 'f'.repeat(40), buildRunId: 45150000000,
    buildRunAttempt: 2, installerSha256: 'e'.repeat(64), installedAsarSha256: 'd'.repeat(64) }
  assert.equal(validateWindowsSpreadsheetCandidate(futureBuild).version, '0.5.12')

  const wrongInstaller = report()
  wrongInstaller.installerSha256 = 'e'.repeat(64)
  assert.throws(() => validateWindowsOfflineSpreadsheetReport(wrongInstaller, identity))

  const missingUndo = report()
  missingUndo.checks.splice(2, 1)
  assert.throws(() => validateWindowsOfflineSpreadsheetReport(missingUndo, identity))

  const editablePreview = report()
  editablePreview.xlsxPreview.editingControlsHidden = false
  assert.throws(() => validateWindowsOfflineSpreadsheetReport(editablePreview, identity))

  const stalePackage = report()
  stalePackage.buildRunId++
  assert.throws(() => validateWindowsOfflineSpreadsheetReport(stalePackage, identity))
})

test('Windows UI entry keeps the spreadsheet flow isolated and passes the exact installer digest', async () => {
  const calls = []
  await dispatchWindowsSmokeEntry(['app.exe', identity.version, identity.sourceHead, 'evidence', '--offline-spreadsheet', identity.installerSha256], {}, {
    runUi: async options => calls.push(options)
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].spreadsheetSmoke, true)
  assert.equal(calls[0].installerSha256, identity.installerSha256)

  await assert.rejects(() => dispatchWindowsSmokeEntry(['app.exe', identity.version, identity.sourceHead,
    'evidence', '--startup-appearance', '--offline-spreadsheet', identity.installerSha256], {}, {
    runStartupAppearance: async () => undefined
  }), /exclusive/)
})

test('Windows workflow and installer driver expose a separate exact-package spreadsheet entry', async () => {
  const [workflow, installer] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(installSmokePath, 'utf8')
  ])
  assert.match(workflow, /run_windows_spreadsheet:/)
  assert.match(workflow, /RAILWISE_WINDOWS_SPREADSHEET_SMOKE: \$\{\{ inputs\.run_windows_spreadsheet \}\}/)
  assert.match(installer, /--offline-spreadsheet/)
  assert.match(installer, /\$report\.installer\.sha256/)
})

test('Windows workbook journey keeps the expected production interactions in the installed renderer', async () => {
  const source = await readFile(sourcePath, 'utf8')
  for (const interaction of [
    '新建表格', '=SUM(4,5)', 'modifiers = 0', '保存副本', 'DOM.setFileInputFiles', '导出当前表为 CSV',
    'kun:workspace-file-preview', 'openSpreadsheet', 'installedAsarSha256', 'reopenedInVisibleGrid'
  ]) assert.ok(source.includes(interaction), `Missing workbook acceptance interaction ${interaction}`)
  const uiSource = await readFile(fileURLToPath(new URL('./run-windows-ui-smoke.mjs', import.meta.url)), 'utf8')
  assert.match(uiSource, /Network\.setBlockedURLs/)
  assert.match(uiSource, /offline:\s*true/)
  assert.match(uiSource, /else if \(spreadsheetSmoke\) \{[\s\S]+?offline-spreadsheet-ui-journey-isolated/)
})
