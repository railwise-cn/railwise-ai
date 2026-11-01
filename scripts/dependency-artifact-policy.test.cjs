const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { minimatch } = require('minimatch')
const asar = require('@electron/asar')
const config = require('../electron-builder.cjs')
const { verifyBundledDependencyArtifacts } = require('./dependency-artifact-policy.cjs')

function excluded(path, filters) {
  return filters.some((filter) => typeof filter === 'string' && filter.startsWith('!') && minimatch(path, filter.slice(1), { dot: true }))
}

test('main and managed-runtime filters exclude browser artifacts and logs while retaining runtime modules', () => {
  const managed = config.extraResources.find((resource) => resource.from === 'kun/node_modules').filter
  for (const relative of ['lib0/.playwright-mcp/console.log', 'lib0/playwright-report/index.html', 'lib0/test-results/result.json', 'lib0/nested/diagnostic.log', 'lib0/nested/diagnostic.LOG']) {
    assert.equal(excluded(`node_modules/${relative}`, config.files), true)
    assert.equal(excluded(relative, managed), true)
  }
  for (const relative of ['lib0/dist/index.js', '@modelcontextprotocol/sdk/dist/esm/client/auth.js', 'zod/package.json']) {
    assert.equal(excluded(`node_modules/${relative}`, config.files), false)
    assert.equal(excluded(relative, managed), false)
  }
})

test('package gate detects artifacts in the real ASAR and managed dependency layouts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workwise-dependency-artifacts-'))
  try {
    const source = join(root, 'source')
    mkdirSync(join(source, 'node_modules/lib0/.playwright-mcp'), { recursive: true })
    writeFileSync(join(source, 'node_modules/lib0/.playwright-mcp/console.log'), 'synthetic developer output')
    await asar.createPackage(source, join(root, 'app.asar'))
    assert.throws(() => verifyBundledDependencyArtifacts(root), /Dependency developer artifacts must not ship/)
    rmSync(join(source, 'node_modules/lib0/.playwright-mcp'), { recursive: true })
    await asar.createPackage(source, join(root, 'app.asar'))
    const dependency = join(root, 'app.asar.unpacked/kun/node_modules/example')
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(dependency, 'diagnostic.log'), 'synthetic developer output')
    assert.throws(() => verifyBundledDependencyArtifacts(root), /kun\/node_modules\/example\/diagnostic.log/)
    rmSync(join(dependency, 'diagnostic.log'))
    writeFileSync(join(dependency, 'index.js'), 'module.exports = true')
    assert.deepEqual(verifyBundledDependencyArtifacts(root), { artifacts: 0 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
