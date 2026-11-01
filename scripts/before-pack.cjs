const { execFileSync } = require('node:child_process')
const { dirname, join } = require('node:path')
const { verifyAudit: verifySpecialistSkillAudit } = require('./specialist-skill-audit.cjs')
const { verifyMarkdownPackagingFileSets } = require('./verify-markdown-packaging-filesets.cjs')

function normalizeArch(arch) {
  if (arch === 'x64' || arch === 'arm64') return arch
  if (arch === 0 || arch === 1) return 'x64'
  if (arch === 3) return 'arm64'
  throw new Error(`[before-pack] Unsupported target architecture: ${String(arch)}`)
}

function resolveElectronAbi() {
  const electronExecutable = require('electron')
  const abi = execFileSync(
    electronExecutable,
    ['-p', 'process.versions.modules'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      }
    }
  ).trim()

  if (!/^\d+$/.test(abi)) {
    throw new Error(`[before-pack] Electron returned an invalid native module ABI: ${abi}`)
  }
  return abi
}

function rebuildManagedRuntimeSqlite(context) {
  const root = join(__dirname, '..')
  const targetArch = normalizeArch(context.arch)
  const electronVersion = require(join(root, 'node_modules', 'electron', 'package.json')).version
  const rebuildMain = require.resolve('@electron/rebuild')
  const rebuildCli = join(dirname(rebuildMain), 'cli.js')
  const electronAbi = resolveElectronAbi()

  console.log(
    `[before-pack] Rebuilding better-sqlite3 for Electron ${electronVersion}, ABI ${electronAbi}, ${targetArch}.`
  )
  execFileSync(
    process.execPath,
    [
      rebuildCli,
      '--force',
      '--which-module',
      'better-sqlite3',
      '--module-dir',
      root,
      '--version',
      electronVersion,
      '--arch',
      targetArch,
      '--force-abi',
      electronAbi,
      '--build-from-source'
    ],
    { cwd: root, stdio: 'inherit' }
  )
}

async function beforePack(context) {
  verifySpecialistSkillAudit()
  const markdownFiles = await verifyMarkdownPackagingFileSets()
  console.log(`[before-pack] Offline Markdown root FileSets verified: ${markdownFiles.collected} files.`)
  rebuildManagedRuntimeSqlite(context)
}

module.exports = beforePack
module.exports._internals = {
  normalizeArch,
  resolveElectronAbi,
  rebuildManagedRuntimeSqlite,
  verifySpecialistSkillAudit
}
