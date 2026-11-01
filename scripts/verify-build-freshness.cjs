const { existsSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const outputFiles = [
  'out/main/index.js',
  'out/preload/index.cjs',
  'out/renderer/index.html',
  'out/markdown-rendering/mermaid.js',
  'out/markdown-rendering/mermaid-build.json',
  'kun/dist/cli/serve-entry.js'
]
const productionRoots = ['src', 'kun/src']
const productionExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.mjs', '.svg', '.ts', '.tsx'])

function extension(path) {
  const match = /\.[^./]+$/.exec(path)
  return match?.[0] ?? ''
}

function isProductionInput(path) {
  const normalized = path.replaceAll('\\', '/')
  if (/\.(?:test|spec)\.[^.]+$/.test(normalized)) return false
  if (normalized.includes('/__tests__/')) return false
  return productionExtensions.has(extension(normalized))
}

function collectFiles(path, result) {
  if (!existsSync(path)) return
  const stat = statSync(path)
  if (stat.isFile()) {
    if (isProductionInput(path)) result.push(path)
    return
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    collectFiles(join(path, entry.name), result)
  }
}

const missingOutputs = outputFiles.filter((path) => !existsSync(join(root, path)))
if (missingOutputs.length) {
  throw new Error(`Build output is missing (${missingOutputs.join(', ')}). Run npm run build before packaging.`)
}

const inputs = []
for (const path of productionRoots) collectFiles(join(root, path), inputs)
for (const path of ['electron.vite.config.ts', 'electron-builder.cjs', 'package.json', 'package-lock.json', 'scripts/build-markdown-rendering.cjs']) collectFiles(join(root, path), inputs)

const newestInput = inputs.reduce((latest, path) => {
  const mtime = statSync(path).mtimeMs
  return mtime > latest.mtime ? { path, mtime } : latest
}, { path: '', mtime: 0 })
const oldestOutput = outputFiles.reduce((oldest, path) => {
  const mtime = statSync(join(root, path)).mtimeMs
  return mtime < oldest.mtime ? { path, mtime } : oldest
}, { path: '', mtime: Number.POSITIVE_INFINITY })

if (newestInput.mtime > oldestOutput.mtime) {
  throw new Error(
    `Build output is stale: ${newestInput.path.replace(`${root}/`, '')} is newer than ${oldestOutput.path}. ` +
    'Run npm run build before packaging.'
  )
}

console.log(`Build freshness passed (${inputs.length} production inputs checked).`)
