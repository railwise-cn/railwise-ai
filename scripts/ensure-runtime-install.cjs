const { existsSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')

const REQUIRED_PATHS = [
  'kun/package-lock.json',
  'kun/node_modules/diff/package.json',
  'kun/node_modules/parse5/package.json',
  'kun/node_modules/zod/package.json',
  'kun/node_modules/@modelcontextprotocol/sdk/package.json'
]
const RUNTIME_SQLITE_MODULE_PATH = 'kun/node_modules/better-sqlite3'

function run(command, args) {
  return spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  })
}

function ensureRuntimeInstall() {
  if (!REQUIRED_PATHS.every((path) => existsSync(path))) {
    const installRuntime = run('npm', ['--prefix', 'kun', 'ci'])
    if (installRuntime.status !== 0) {
      process.exit(installRuntime.status || 1)
    }
  }

  if (existsSync(RUNTIME_SQLITE_MODULE_PATH)) {
    rmSync(RUNTIME_SQLITE_MODULE_PATH, { recursive: true, force: true })
    return
  }
}

ensureRuntimeInstall()
