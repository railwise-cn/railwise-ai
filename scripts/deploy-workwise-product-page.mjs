#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { runContentCommand } from './workwise-content-deploy.mjs'

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RELEASE_ROOT_SUFFIX = '/downloads/workwise'
const PRODUCT_URL = 'https://www.railwise.cn/products/workwise/'

function parseArgs(argv) {
  const command = argv[0]
  const flags = new Map()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument: ${name || '<empty>'}`)
    flags.set(name.slice(2), value)
  }
  return { command, flags }
}

function requireFlag(flags, name) {
  const value = String(flags.get(name) || '').trim()
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

function normalizeVersion(value) {
  const version = String(value || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version: ${value}`)
  return version
}

function normalizeToken(value, label) {
  const token = String(value || '').trim()
  if (!SAFE_TOKEN.test(token)) throw new Error(`Invalid ${label}: ${value}`)
  return token
}

function sourceFiles(sourceDirectory) {
  const source = resolve(sourceDirectory)
  const files = [
    { source: resolve(source, 'products/workwise/index.php'), relative: 'products/workwise/index.php' },
    { source: resolve(source, 'includes/workwise_product.php'), relative: 'includes/workwise_product.php' },
    { source: resolve(source, 'data/workwise-product.json'), relative: 'data/workwise-product.json' }
  ]
  const screenshotDirectory = resolve(source, 'products/screenshots/workwise')
  if (existsSync(screenshotDirectory) && statSync(screenshotDirectory).isDirectory()) {
    for (const name of readdirSync(screenshotDirectory).sort()) {
      if (/^[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(name)) {
        files.push({
          source: resolve(screenshotDirectory, name),
          relative: `products/screenshots/workwise/${name}`
        })
      }
    }
  }
  return files
}

function validateSource(sourceDirectory, version) {
  const files = sourceFiles(sourceDirectory)
  for (const file of files) {
    if (!existsSync(file.source) || !statSync(file.source).isFile() || statSync(file.source).size === 0) {
      throw new Error(`Missing website source file: ${file.relative}`)
    }
  }

  const manifest = JSON.parse(readFileSync(files[2].source, 'utf8'))
  if (manifest.version !== version) throw new Error(`Manifest version is ${manifest.version}, expected ${version}.`)
  if (manifest.releaseUrl !== `https://github.com/railwise-cn/railwise-ai/releases/tag/v${version}`) {
    throw new Error('Manifest Release URL does not match the requested version.')
  }

  const expectedFiles = [
    `WorkWise-${version}-mac-Apple-Silicon.dmg`,
    `WorkWise-${version}-mac-Intel.dmg`,
    `WorkWise-${version}-win-x64.exe`
  ]
  const platforms = Array.isArray(manifest.platforms) ? manifest.platforms : []
  if (platforms.length !== expectedFiles.length) throw new Error('Website manifest must expose exactly three installers.')
  for (const name of expectedFiles) {
    const entry = platforms.find((item) => item?.file === name)
    if (!entry || !String(entry.url || '').includes(`/stable/releases/v${version}/${name}`)) {
      throw new Error(`Missing immutable website installer entry: ${name}`)
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) {
      throw new Error(`Invalid SHA-256 for website installer entry: ${name}`)
    }
  }
  return { files, manifest }
}

function normalizeReleaseRoot(value) {
  const root = String(value || '').trim().replace(/\/+$/, '')
  const parts = root.split('/').filter(Boolean)
  if (
    !root.startsWith('/') ||
    !root.endsWith(RELEASE_ROOT_SUFFIX) ||
    root.includes('//') ||
    parts.some((part) => part === '.' || part === '..') ||
    !/^\/[A-Za-z0-9._/-]+$/.test(root)
  ) {
    throw new Error('Unsafe website release root.')
  }
  return root
}

function readSshConfig() {
  const host = String(process.env.WORKWISE_WEBSITE_SSH_HOST || '').trim()
  const port = String(process.env.WORKWISE_WEBSITE_SSH_PORT || '').trim()
  const user = String(process.env.WORKWISE_WEBSITE_SSH_USER || '').trim()
  const keyPath = resolve(String(process.env.WORKWISE_WEBSITE_SSH_KEY_PATH || ''))
  const knownHostsPath = resolve(String(process.env.WORKWISE_WEBSITE_SSH_KNOWN_HOSTS_PATH || ''))
  const releaseRoot = normalizeReleaseRoot(process.env.WORKWISE_WEBSITE_RELEASE_ROOT)

  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('Invalid website SSH host.')
  }
  const portNumber = Number.parseInt(port, 10)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new Error('Invalid website SSH port.')
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) throw new Error('Invalid website SSH user.')
  for (const [label, path] of [['private key', keyPath], ['known_hosts', knownHostsPath]]) {
    if (!path || !existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing SSH ${label}.`)
  }
  return { host, port: String(portNumber), user, keyPath, knownHostsPath, releaseRoot }
}

function sshOptions(config) {
  return [
    '-p', config.port,
    '-i', config.keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=2',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsPath}`
  ]
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function runRemote(config, script, args) {
  const remote = `bash -s -- ${args.map(shellQuote).join(' ')}`
  return execFileSync('ssh', [...sshOptions(config), `${config.user}@${config.host}`, remote], {
    input: script,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 5 * 60_000,
    killSignal: 'SIGKILL'
  })
}

const PREPARE_SCRIPT = String.raw`
set -euo pipefail
release_root="$1"
deploy_id="$2"
case "$release_root" in /*/downloads/workwise) ;; *) exit 64 ;; esac
stage="/tmp/workwise-product-deploy-$deploy_id/payload"
case "$stage" in /tmp/workwise-product-deploy-*/payload) ;; *) exit 64 ;; esac
install -d -m 700 "$stage/products/workwise" "$stage/products/screenshots/workwise" "$stage/includes" "$stage/data"
printf '%s\n' "$stage"
`

const DEPLOY_SCRIPT = String.raw`
set -euo pipefail
fail() { printf 'WorkWise product page deploy error: %s\n' "$1" >&2; exit 1; }
discover_runtime() {
  host_www_root='/opt/1panel/1panel/www'
  container_www_root='/www'
  case "$release_root" in
    "$host_www_root"/sites/www.railwise.cn/index/downloads/workwise) ;;
    *) fail 'website release root is not the approved railwise.cn document root' ;;
  esac

  site_root='/www/sites/www.railwise.cn/index'

  web_container=''
  web_count=0
  for candidate in $(docker ps -q); do
    image="$(docker inspect --format '{{.Config.Image}}' "$candidate" 2>/dev/null || true)"
    if case "$image" in 1panel/openresty:*|*/1panel/openresty:*) true ;; *) false ;; esac \
      && docker inspect --format '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$candidate" 2>/dev/null \
        | grep -Fqx "$host_www_root $container_www_root true"; then
      web_container="$candidate"
      web_count=$((web_count + 1))
    fi
  done
  [ "$web_count" -eq 1 ] || fail "expected one writable railwise.cn web mount, found $web_count"

  php_container=''
  php_count=0
  for candidate in $(docker ps -q); do
    image="$(docker inspect --format '{{.Config.Image}}' "$candidate" 2>/dev/null || true)"
    case "$image" in
      1panel-php-fpm:*|*/1panel-php-fpm:*)
        php_container="$candidate"
        php_count=$((php_count + 1))
        ;;
    esac
  done
  [ "$php_count" -eq 1 ] || fail "expected one website PHP runtime, found $php_count"

  page_path="$site_root/products/workwise/index.php"
  include_path="$site_root/includes/workwise_product.php"
  json_path="$site_root/data/workwise-product.json"
}
container_run() {
  docker exec -u 0 "$web_container" "$@"
}
container_write() {
  docker exec -i -u 0 "$web_container" tee "$1" >/dev/null
}
container_decode() {
  encoded="$1"
  target="$2"
  sed -e 's/^{"data":"//' -e 's/"}$//' "$encoded" | base64 -d | docker exec -i -u 0 "$web_container" tee "$target" >/dev/null
}
verify_live_targets() {
  container_run test -f "$page_path" || fail 'missing live WorkWise product page'
  container_run test -f "$include_path" || fail 'missing live WorkWise product include'
  container_run test -f "$json_path" || fail 'missing live WorkWise product manifest'
  container_run grep -Fq '$workwiseManifest = rw_workwise_manifest();' "$page_path" || fail 'live product page marker was not recognized'
  container_run grep -Fq 'function rw_workwise_manifest()' "$include_path" || fail 'live product include marker was not recognized'
  container_run grep -Fq '"releaseChannel": "stable"' "$json_path" || fail 'live product manifest marker was not recognized'
}
release_root="$1"
version="$2"
deploy_id="$3"
case "$release_root" in /*/downloads/workwise) ;; *) exit 64 ;; esac
stage="/tmp/workwise-product-deploy-$deploy_id/payload"
case "$stage" in /tmp/workwise-product-deploy-*/payload) ;; *) exit 64 ;; esac

discover_runtime
verify_live_targets
backup="$(dirname "$site_root")/.workwise-product-backups/$deploy_id"
case "$backup" in /www/sites/www.railwise.cn/.workwise-product-backups/*) ;; *) exit 64 ;; esac

test -s "$stage/products/workwise/index.php" || fail 'missing staged product page'
test -s "$stage/includes/workwise_product.php" || fail 'missing staged product include'
test -s "$stage/data/workwise-product.json" || fail 'missing staged product manifest'
printf 'Validated staged and live WorkWise website paths.\n'
printf 'Derived the unique WorkWise targets from the approved document root.\n'

docker exec -i "$php_container" php -l < "$stage/products/workwise/index.php" >/dev/null || fail 'product page PHP lint failed'
docker exec -i "$php_container" php -l < "$stage/includes/workwise_product.php" >/dev/null || fail 'product include PHP lint failed'
docker exec -i "$php_container" php -r '$p=json_decode(stream_get_contents(STDIN), true); if (!is_array($p) || ($p["version"] ?? "") !== $argv[1]) { exit(65); }' -- "$version" < "$stage/data/workwise-product.json" || fail 'product manifest JSON/version validation failed'
printf 'Validated PHP syntax, JSON and exact WorkWise version.\n'

container_run install -d -m 700 "$backup" || fail 'could not create backup directory'
container_run cp -p "$page_path" "$backup/product-page.php" || fail 'could not back up product page'
container_run cp -p "$include_path" "$backup/workwise_product.php" || fail 'could not back up product include'
container_run cp -p "$json_path" "$backup/workwise-product.json" || fail 'could not back up product manifest'
if container_run test -d "$site_root/products/screenshots/workwise"; then
  container_run cp -R "$site_root/products/screenshots/workwise" "$backup/screenshots" || fail 'could not back up product screenshots'
fi

stage_replacement() {
  live="$1"
  source="$2"
  next="$live.workwise-next"
  container_run cp -p "$live" "$next" || fail 'could not create metadata-preserving next file'
  container_write "$next" < "$source" || fail 'could not write next file'
}
stage_replacement "$include_path" "$stage/includes/workwise_product.php"
stage_replacement "$json_path" "$stage/data/workwise-product.json"
stage_replacement "$page_path" "$stage/products/workwise/index.php"
printf 'Created server backup and next-version files.\n'

committed=0
rollback() {
  if [ "$committed" -eq 0 ]; then
    if container_run test -f "$backup/product-page.php"; then container_run cp -p "$backup/product-page.php" "$page_path"; fi
    if container_run test -f "$backup/workwise_product.php"; then container_run cp -p "$backup/workwise_product.php" "$include_path"; fi
    if container_run test -f "$backup/workwise-product.json"; then container_run cp -p "$backup/workwise-product.json" "$json_path"; fi
    if container_run test -d "$backup/screenshots"; then
      container_run install -d -m 755 "$site_root/products/screenshots/workwise"
      container_run cp -R "$backup/screenshots/." "$site_root/products/screenshots/workwise/"
    fi
    container_run rm -f "$page_path.workwise-next" "$include_path.workwise-next" "$json_path.workwise-next"
  fi
}
trap rollback EXIT HUP INT TERM
container_run mv -f "$include_path.workwise-next" "$include_path"
container_run mv -f "$json_path.workwise-next" "$json_path"
container_run mv -f "$page_path.workwise-next" "$page_path"
container_run install -d -m 755 "$site_root/products/screenshots/workwise"
for encoded in "$stage"/products/screenshots/workwise/*.json; do
  [ -f "$encoded" ] || continue
  image_name="$(basename "$encoded" .json)"
  container_decode "$encoded" "$site_root/products/screenshots/workwise/$image_name"
done
committed=1
trap - EXIT HUP INT TERM
printf 'Deployed WorkWise product page %s with a server-side backup.\n' "$version"
`

const ROLLBACK_SCRIPT = String.raw`
set -euo pipefail
fail() { printf 'WorkWise product page rollback error: %s\n' "$1" >&2; exit 1; }
discover_web_container() {
  host_www_root='/opt/1panel/1panel/www'
  container_www_root='/www'
  case "$release_root" in
    "$host_www_root"/sites/www.railwise.cn/index/downloads/workwise) ;;
    *) fail 'website release root is not the approved railwise.cn document root' ;;
  esac
  web_container=''
  web_count=0
  for candidate in $(docker ps -q); do
    image="$(docker inspect --format '{{.Config.Image}}' "$candidate" 2>/dev/null || true)"
    if case "$image" in 1panel/openresty:*|*/1panel/openresty:*) true ;; *) false ;; esac \
      && docker inspect --format '{{range .Mounts}}{{println .Source .Destination .RW}}{{end}}' "$candidate" 2>/dev/null \
        | grep -Fqx "$host_www_root $container_www_root true"; then
      web_container="$candidate"
      web_count=$((web_count + 1))
    fi
  done
  [ "$web_count" -eq 1 ] || fail "expected one writable railwise.cn web mount, found $web_count"
}
container_run() {
  docker exec -u 0 "$web_container" "$@"
}
release_root="$1"
deploy_id="$2"
case "$release_root" in /*/downloads/workwise) ;; *) exit 64 ;; esac
discover_web_container
site_root='/www/sites/www.railwise.cn/index'
page_path="$site_root/products/workwise/index.php"
include_path="$site_root/includes/workwise_product.php"
json_path="$site_root/data/workwise-product.json"
backup='/www/sites/www.railwise.cn/.workwise-product-backups/'"$deploy_id"
case "$backup" in /www/sites/www.railwise.cn/.workwise-product-backups/*) ;; *) exit 64 ;; esac
container_run test -s "$backup/product-page.php"
container_run test -s "$backup/workwise_product.php"
container_run test -s "$backup/workwise-product.json"
container_run cp -p "$backup/product-page.php" "$page_path"
container_run cp -p "$backup/workwise_product.php" "$include_path"
container_run cp -p "$backup/workwise-product.json" "$json_path"
printf 'Rolled back WorkWise product page from the server-side backup.\n'
`

function copyToStage(config, localPath, remotePath) {
  execFileSync('scp', [
    '-P', config.port,
    '-i', config.keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=2',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHostsPath}`,
    localPath,
    `${config.user}@${config.host}:${remotePath}`
  ], { stdio: 'inherit', timeout: 5 * 60_000, killSignal: 'SIGKILL' })
}

function deploy(sourceDirectory, version, deployId) {
  const validated = validateSource(sourceDirectory, version)
  const config = readSshConfig()
  const stage = runRemote(config, PREPARE_SCRIPT, [config.releaseRoot, deployId]).trim()
  if (stage !== `/tmp/workwise-product-deploy-${deployId}/payload`) {
    throw new Error('Remote deployment stage was not recognized.')
  }
  for (const file of validated.files) {
    if (file.relative.startsWith('products/screenshots/workwise/')) continue
    copyToStage(config, file.source, `${stage}/${file.relative}`)
  }
  const encodedScreenshots = validated.files.filter((file) => file.relative.startsWith('products/screenshots/workwise/'))
  const temporaryEncoded = []
  try {
    for (const file of encodedScreenshots) {
      const imageName = basename(file.source)
      const encodedPath = `/tmp/workwise-product-${deployId}-${imageName}.json`
      writeFileSync(encodedPath, JSON.stringify({ data: readFileSync(file.source).toString('base64') }))
      temporaryEncoded.push(encodedPath)
      copyToStage(config, encodedPath, `${stage}/products/screenshots/workwise/${imageName}.json`)
    }
  } finally {
    for (const encodedPath of temporaryEncoded) {
      try { execFileSync('rm', ['-f', encodedPath]) } catch {
        // Best-effort cleanup must preserve any original upload failure.
      }
    }
  }
  process.stdout.write(runRemote(config, DEPLOY_SCRIPT, [config.releaseRoot, version, deployId]))
}

function rollback(deployId) {
  const config = readSshConfig()
  process.stdout.write(runRemote(config, ROLLBACK_SCRIPT, [config.releaseRoot, deployId]))
}

async function verifyPublic(sourceDirectory, version) {
  const { manifest } = validateSource(sourceDirectory, version)
  const response = await fetch(`${PRODUCT_URL}?release=${encodeURIComponent(version)}&t=${Date.now()}`, {
    redirect: 'follow',
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Product page returned HTTP ${response.status}.`)
  const html = await response.text()
  const required = [
    `softwareVersion":"v${version}`,
    `${manifest.name || 'WorkWise'} v${version} 已发布`,
    `releases/tag/v${version}`,
    ...manifest.platforms.map((item) => item.url)
  ]
  for (const text of required) {
    if (!html.includes(text)) throw new Error(`Product page is missing expected content: ${text}`)
  }
  for (const item of manifest.platforms) {
    const url = new URL(item.url, PRODUCT_URL)
    const range = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000)
    })
    if (range.status !== 206 || !/^bytes 0-\d+\/\d+$/i.test(range.headers.get('content-range') || '')) {
      throw new Error(`Installer Range verification failed for ${basename(url.pathname)}.`)
    }
    await range.arrayBuffer()
  }
  console.log(`Verified public WorkWise product page and three immutable ${version} installers.`)
}

const { command, flags } = parseArgs(process.argv.slice(2))
const source = requireFlag(flags, 'source')
const version = normalizeVersion(requireFlag(flags, 'version'))
const mode = flags.get('mode') || 'full'
if (!['full', 'content-only'].includes(mode)) throw new Error(`Invalid mode: ${mode}`)

if (mode === 'content-only') {
  validateSource(source, version)
  await runContentCommand({
    command, source, sourceSha: requireFlag(flags, 'source-sha'),
    deployId: flags.get('deploy-id'),
    output: flags.get('output'),
    config: command === 'validate' ? undefined : readSshConfig(),
    transport: { runRemote, copyToStage }
  })
} else if (command === 'validate') {
  validateSource(source, version)
  console.log(`Validated WorkWise website source for ${version}.`)
} else if (command === 'deploy') {
  deploy(source, version, normalizeToken(requireFlag(flags, 'deploy-id'), 'deploy id'))
} else if (command === 'rollback') {
  rollback(normalizeToken(requireFlag(flags, 'deploy-id'), 'deploy id'))
} else if (command === 'verify-public') {
  await verifyPublic(source, version)
} else {
  throw new Error(`Unknown command: ${command || '<empty>'}`)
}
