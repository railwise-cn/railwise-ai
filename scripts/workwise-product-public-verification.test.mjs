import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NGINX_VHOST_ROOTS_PYTHON, verifyProductPublication } from './workwise-product-public-verification.mjs'

const manifest = JSON.parse(readFileSync(new URL('../website/data/workwise-product.json', import.meta.url)))
const html = `"softwareVersion":"v${manifest.version}" ${manifest.name} v${manifest.version} 已发布 releases/tag/v${manifest.version} ${manifest.platforms.map((item) => item.url).join(' ')}`
const options = { attempts: 2, delay: async () => {}, log: () => {} }
const goodResponse = (url) => {
  if (String(url).includes('/data/')) return Response.json(manifest)
  if (String(url).includes('/releases/')) return new Response('data', { status: 206, headers: { 'content-range': 'bytes 0-3/100' } })
  return new Response(html)
}

test('failure rollback reads the screenshot inventory inside the web container', () => {
  const source = readFileSync(new URL('./deploy-workwise-product-page.mjs', import.meta.url), 'utf8')
  const restore = source.match(/restore_screenshots\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(restore)
  for (const hadScreenshots of [true, false]) {
    const directory = mkdtempSync(join(tmpdir(), 'workwise-rollback-'))
    try {
      const backup = join(directory, 'backup')
      const images = join(directory, 'site/products/screenshots/workwise')
      mkdirSync(backup, { recursive: true })
      mkdirSync(images, { recursive: true })
      writeFileSync(join(backup, 'deployed-screenshots.txt'), 'existing.jpg\nintroduced.jpg\n')
      writeFileSync(join(images, 'existing.jpg'), 'new existing image')
      writeFileSync(join(images, 'introduced.jpg'), 'introduced image')
      writeFileSync(join(images, 'unrelated.jpg'), 'preserve this image')
      if (hadScreenshots) {
        mkdirSync(join(backup, 'screenshots'))
        writeFileSync(join(backup, 'screenshots/existing.jpg'), 'original image')
      }
      // /container-only has no host-side files; every container operation is
      // redirected into a fixture filesystem, reproducing the mount boundary.
      execFileSync('bash', ['-s'], { encoding: 'utf8', env: { ...process.env, FIXTURE_ROOT: directory }, input: `
set -euo pipefail
backup=/container-only/backup
site_root=/container-only/site
container_run() {
  local arg
  local args=()
  for arg in "$@"; do
    case "$arg" in
      /container-only/*) args+=("$FIXTURE_ROOT/\${arg#/container-only/}") ;;
      *) args+=("$arg") ;;
    esac
  done
  "\${args[@]}"
}
${restore}
restore_screenshots
` })
      assert.equal(existsSync(join(images, 'introduced.jpg')), false)
      assert.equal(readFileSync(join(images, 'unrelated.jpg'), 'utf8'), 'preserve this image')
      if (hadScreenshots) assert.equal(readFileSync(join(images, 'existing.jpg'), 'utf8'), 'original image')
      else assert.equal(existsSync(join(images, 'existing.jpg')), false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('discovers only direct roots from the exact active www.railwise.cn server', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workwise-nginx-roots-'))
  const dumpPath = join(directory, 'nginx-dump.txt')
  try {
    writeFileSync(dumpPath, String.raw`# configuration file /etc/nginx/nginx.conf:
http {
  server {
    server_name railwise.cn www.railwise.cn;
    root "/www/audit-releases/audit-20260924-final/site";
    location /legacy/ { root /www/audit-releases/audit-old/site; }
  }
  server {
    server_name www.other.example;
    root /www/audit-releases/audit-other/site;
  }
  server {
    server_name www.railwise.cn;
    location / { root /www/audit-releases/audit-nested/site; }
  }
  server {
    server_name www.railwise.cn;
    root /www/audit-releases/../escaped/site;
  }
}
`)
    const roots = execFileSync('python3', ['-c', NGINX_VHOST_ROOTS_PYTHON, dumpPath], { encoding: 'utf8' })
    assert.deepEqual(roots.trim().split('\n'), ['/www/audit-releases/audit-20260924-final/site'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normalizes a trailing slash and accepts release identifiers with dots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workwise-nginx-roots-'))
  const dumpPath = join(directory, 'nginx-dump.txt')
  try {
    writeFileSync(dumpPath, String.raw`http {
  server {
    server_name www.railwise.cn;
    root "/www/audit-releases/audit-20260924-final.1/site/";
  }
}
`)
    const roots = execFileSync('python3', ['-c', NGINX_VHOST_ROOTS_PYTHON, dumpPath], { encoding: 'utf8' })
    assert.deepEqual(roots.trim().split('\n'), ['/www/audit-releases/audit-20260924-final.1/site'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('keeps conflicting active host roots visible so deployment fails closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workwise-nginx-roots-'))
  const dumpPath = join(directory, 'nginx-dump.txt')
  try {
    writeFileSync(dumpPath, String.raw`http {
  server { server_name www.railwise.cn; root /www/audit-releases/audit-one/site; }
  server { server_name www.railwise.cn; root /www/audit-releases/audit-two/site; }
}
`)
    const roots = execFileSync('python3', ['-c', NGINX_VHOST_ROOTS_PYTHON, dumpPath], { encoding: 'utf8' })
    assert.deepEqual(roots.trim().split('\n'), [
      '/www/audit-releases/audit-one/site',
      '/www/audit-releases/audit-two/site'
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('retries a stale normal page and verifies both URLs, manifest and all installers', async () => {
  const calls = []
  await verifyProductPublication(manifest, { ...options, fetcher: async (url) => {
    calls.push(String(url))
    return calls.length === 1 ? new Response('"softwareVersion":"v0.5.0"') : goodResponse(url)
  } })
  assert.equal(calls.filter((url) => url.endsWith('/products/workwise/')).length, 2)
  assert.equal(calls.filter((url) => url.includes('?release=')).length, 1)
  assert.equal(calls.filter((url) => url.includes('/releases/')).length, 3)
})

test('persistent stale default URL fails even when cache-busting URL would be fresh', async () => {
  let attempts = 0
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) => {
    attempts++
    return String(url).endsWith('/products/workwise/') ? new Response('"softwareVersion":"v0.5.0"') : goodResponse(url)
  } }), /Observed page version v0.5.0/)
  assert.equal(attempts, 2)
})

test('correct page cannot mask an old public manifest or wrong installer hash', async () => {
  for (const bad of [
    { ...manifest, version: '0.5.0' },
    { ...manifest, platforms: manifest.platforms.map((p, i) => i ? p : { ...p, sha256: '0'.repeat(64) }) }
  ]) {
    await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
      String(url).includes('/data/') ? Response.json(bad) : goodResponse(url)
    }), /Public manifest version|Public installer metadata mismatch/)
  }
})

test('missing download content and unsupported Range responses remain failures', async () => {
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
    String(url).includes('/products/') ? new Response(html.replace(manifest.platforms[0].url, '')) : goodResponse(url)
  }), /missing expected content/)
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
    String(url).includes('/releases/') ? new Response('full file', { status: 200 }) : goodResponse(url)
  }), /Installer Range verification failed/)
})
