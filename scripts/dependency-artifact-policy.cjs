const { existsSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')

const ARTIFACT_DIRECTORIES = ['.playwright-mcp', 'playwright-report', 'test-results']

function dependencyArtifactFilters(prefix = '**') {
  return [
    ...ARTIFACT_DIRECTORIES.map((directory) => `!${prefix}/${directory}/**`),
    `!${prefix}/*.[lL][oO][gG]`
  ]
}

function isDependencyArtifact(path) {
  const parts = path.replaceAll('\\', '/').split('/')
  return parts.some((part) => ARTIFACT_DIRECTORIES.includes(part)) || /\.log$/i.test(parts.at(-1) || '')
}

function archiveDependencyArtifacts(entries) {
  return entries.map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, ''))
    .filter(path => path.startsWith('node_modules/') && isDependencyArtifact(path))
    .map(path => `app.asar/${path}`)
}

function verifyBundledDependencyArtifacts(resourcesRoot) {
  const asar = require('@electron/asar')
  const artifacts = []
  const archive = join(resourcesRoot, 'app.asar')
  asar.uncache(archive)
  artifacts.push(...archiveDependencyArtifacts(asar.listPackage(archive)))
  const managedRoot = join(resourcesRoot, 'app.asar.unpacked', 'kun', 'node_modules')
  const walk = (directory) => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      const path = relative(managedRoot, target).replaceAll('\\', '/')
      if (isDependencyArtifact(path)) artifacts.push(`app.asar.unpacked/kun/node_modules/${path}`)
      else if (entry.isDirectory()) walk(target)
    }
  }
  walk(managedRoot)
  if (artifacts.length) throw new Error(`Dependency developer artifacts must not ship: ${artifacts.join(', ')}`)
  return { artifacts: 0 }
}

module.exports = { dependencyArtifactFilters, isDependencyArtifact, archiveDependencyArtifacts, verifyBundledDependencyArtifacts }
