const { dependencyArtifactFilters } = require('./dependency-artifact-policy.cjs')

const EXPLICIT_RUNTIME_PACKAGES = ['@modelcontextprotocol/sdk', 'zod-to-json-schema', 'bindings', 'file-uri-to-path']
const OFFLINE_RENDERING_PACKAGES = ['katex', 'mermaid', 'markdown-it-footnote']
const RUNTIME_ENTRY_ASSETS = [
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  'node_modules/zod-to-json-schema/dist/cjs/index.js',
  'node_modules/zod-to-json-schema/dist/esm/index.js',
  'node_modules/bindings/bindings.js',
  'node_modules/file-uri-to-path/index.js'
]

function explicitRuntimePackageFiles() {
  const exclusions = [
    ...dependencyArtifactFilters(), '!**/*.map', '!**/*.d.ts', '!**/*.ts',
    '!**/tsconfig*.json', '!**/README*', '!**/CHANGELOG*'
  ]
  const fileSet = (name, include) => ({
    from: `node_modules/${name}`, to: `node_modules/${name}`, filter: [...include, ...exclusions]
  })
  return [
    ...EXPLICIT_RUNTIME_PACKAGES.map(name => fileSet(name, ['**/*'])),
    fileSet('katex', ['package.json', 'LICENSE', 'dist/**/*']),
    fileSet('mermaid', ['package.json', 'LICENSE']),
    fileSet('markdown-it-footnote', ['package.json', 'LICENSE', 'index.mjs', 'dist/index.cjs.js'])
  ]
}

module.exports = { explicitRuntimePackageFiles, EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS }
