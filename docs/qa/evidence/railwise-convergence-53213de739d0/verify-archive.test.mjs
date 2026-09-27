import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
test('default verification preserves the baseline and rejects changed bytes and extra entries', () => {
  const root = mkdtempSync('/private/tmp/railwise-manifest-selfcheck-')
  try {
    const script = join(root, 'verify-archive.mjs')
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'verify-archive.mjs'), script)
    writeFileSync(join(root, 'evidence.txt'), 'original\n')
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(run('--write-manifest').status, 0)
    const manifest = readFileSync(join(root, 'archive-manifest.json'))
    assert.equal(run().status, 0)
    assert(readFileSync(join(root, 'archive-manifest.json')).equals(manifest))
    writeFileSync(join(root, 'evidence.txt'), 'modified\n')
    assert.notEqual(run().status, 0)
    assert(readFileSync(join(root, 'archive-manifest.json')).equals(manifest))
    writeFileSync(join(root, 'evidence.txt'), 'original\n')
    writeFileSync(join(root, 'unexpected.txt'), 'extra\n')
    assert.notEqual(run().status, 0)
    assert(readFileSync(join(root, 'archive-manifest.json')).equals(manifest))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
