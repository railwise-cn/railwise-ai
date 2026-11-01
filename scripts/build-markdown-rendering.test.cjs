const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const vm = require('node:vm')
const { buildMarkdownRendering, validateMermaidInputs, sha256 } = require('./build-markdown-rendering.cjs')

test('the actual offline browser bundle binds core ESM and reviewed sanitizer inputs', async () => {
  const output = await mkdtemp(join(tmpdir(), 'railwise-mermaid-bundle-'))
  try {
    const report = await buildMarkdownRendering(undefined, output)
    const bytes = await readFile(join(output, 'mermaid.js'))
    assert.equal(report.sha256, sha256(bytes))
    assert.equal(report.versions.dompurify, '3.4.17')
    const sandbox = vm.createContext({ console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL })
    new vm.Script(bytes.toString('utf8')).runInContext(sandbox, { timeout: 15000 })
    assert.equal(typeof sandbox.mermaid.initialize, 'function')
    assert.equal(typeof sandbox.mermaid.render, 'function')
  } finally { await rm(output, { recursive: true, force: true }) }
})

test('prebundled or nested sanitizer dependencies cannot pass core provenance', () => {
  const base = { 'node_modules/mermaid/dist/mermaid.core.mjs': {}, 'node_modules/dompurify/dist/purify.es.mjs': {}, 'node_modules/katex/dist/katex.mjs': {} }
  assert.throws(() => validateMermaidInputs({ ...base, 'node_modules/mermaid/dist/mermaid.min.js': {} }), /prebundled/)
  assert.throws(() => validateMermaidInputs({ ...base, 'node_modules/mermaid/node_modules/dompurify/dist/purify.es.mjs': {} }), /reviewed root/)
})
