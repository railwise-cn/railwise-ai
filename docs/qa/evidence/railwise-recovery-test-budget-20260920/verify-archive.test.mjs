import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('read-only verification preserves the manifest and rejects changed logs and extra files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'railwise-test-budget-manifest-'))
  try {
    const root = join(temporary, 'archive')
    cpSync(dirname(fileURLToPath(import.meta.url)), root, { recursive: true })
    const path = join(root, 'archive-manifest.json')
    const original = readFileSync(path)
    const run = () => spawnSync(process.execPath, [join(root, 'verify-archive.mjs')], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    assert(readFileSync(path).equals(original))
    const log = join(root, 'completion-gate-budget-lint.txt')
    const bytes = readFileSync(log)
    writeFileSync(log, 'changed\n')
    assert.notEqual(run().status, 0)
    assert(readFileSync(path).equals(original))
    writeFileSync(log, bytes)
    writeFileSync(join(root, 'unexpected.txt'), 'extra\n')
    assert.notEqual(run().status, 0)
    assert(readFileSync(path).equals(original))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
