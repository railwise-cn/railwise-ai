import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { classifyPathFacts, extractStaticPhpReferences, isWithinRoot, routeResolution, safeAbsolutePath } from './website-canonical-inspection.mjs'

test('canonical path checks reject traversal and symlink escapes', () => {
  const root = '/srv/www/site'
  assert.equal(safeAbsolutePath('/srv/www/site/products/workwise/index.php'), '/srv/www/site/products/workwise/index.php')
  assert.equal(safeAbsolutePath('/srv/www/site/../secrets.php'), null)
  assert.equal(isWithinRoot(root, '/srv/www/site/products/railwise-ai/index.php'), true)
  assert.equal(isWithinRoot(root, '/srv/www/site-other/index.php'), false)
  assert.deepEqual(classifyPathFacts({ path: '/srv/www/site/products/workwise/index.php', realpath: '/etc/passwd', fileType: 'regular file', sha256: 'a'.repeat(64), approvedRoot: root }), {
    resolution: 'blocked', reason: 'symlink_outside_approved_root', path: '/srv/www/site/products/workwise/index.php', realpath: '/etc/passwd', fileType: null, sha256: null
  })
})

test('PHP inspection is static and resolves only literal in-root references', () => {
  const source = `<?php
require_once __DIR__ . '/../../includes/workwise_product.php';
$manifest = __DIR__ . '/../../data/workwise-product.json';
require $userSuppliedPath;
$version = '0.5.3';
// PRIVATE_CONFIG_CANARY must never be returned by source inspection.
?>`
  const report = extractStaticPhpReferences(source, '/srv/www/site/products/workwise/index.php', '/srv/www/site')
  assert.equal(report.staticOnly, true)
  assert.ok(report.references.some(item => item.path === '/srv/www/site/includes/workwise_product.php' && item.status === 'resolved'))
  assert.ok(report.references.some(item => item.path === '/srv/www/site/data/workwise-product.json' && item.status === 'resolved'))
  assert.ok(report.references.some(item => item.status === 'unknown'))
  assert.deepEqual(report.versionMarkers, ['0.5.3'])
  assert.equal(JSON.stringify(report).includes('PRIVATE_CONFIG_CANARY'), false)
})

test('route mapping keeps redirects and dynamic script paths explicit', () => {
  assert.equal(routeResolution({ requestPath: '/products/workwise/', location: '/', directives: { return: '301 /products/railwise-ai/' }, effectiveRoot: '/srv/www/site' }).resolution, 'redirect')
  assert.equal(routeResolution({ requestPath: '/products/railwise-ai/', location: '/', directives: { scriptFilename: '$document_root$fastcgi_script_name' }, effectiveRoot: '/srv/www/site' }).reason, 'dynamic_or_missing_script_path')
  assert.equal(routeResolution({ requestPath: '/products/railwise-ai/', location: null, directives: {}, effectiveRoot: '/srv/www/site' }).reason, 'no_matching_location')
})

test('canonical inspection is available only as a read-only dedicated workflow mode', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/repair-website-cache.yml', import.meta.url), 'utf8'))
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? workflow.on?.['workflow_dispatch']?.inputs ?? {}
  assert.deepEqual(inputs.mode.options, ['inspect', 'canonical-inspect', 'apply'])
  const repair = workflow.jobs.repair
  assert.match(String(repair.if), /inputs\.mode == 'canonical-inspect'/)
  assert.match(String(repair.environment?.name), /release-inspection/)
  assert.equal(String(repair.steps.find(step => String(step.run || '').includes('repair-website-cache.mjs'))?.run).includes('apply'), false)
})

test('embedded remote script is valid bash after template extraction', () => {
  const source = readFileSync(new URL('./repair-website-cache.mjs', import.meta.url), 'utf8')
  const match = source.match(/const REMOTE_SCRIPT = String\.raw`([\s\S]*?)`\n/)
  assert.ok(match, 'REMOTE_SCRIPT template must be present')
  const result = spawnSync('bash', ['-n'], { input: match[1], encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stderr || result.stdout}`)
})

test('cache policy upgrades v2, retains legacy routes, and applies idempotently', t => {
  const fixture = cacheRepairFixture(t)
  fixture.write(`server {\n    server_name www.railwise.cn;\n    # WorkWise updater metadata cache policy v2 begin\n    location = /downloads/workwise/channels/stable/latest/latest.json { expires off; }\n    # WorkWise updater metadata cache policy v2 end\n    location /unrelated/ { expires 7d; }\n}\n`)
  const first = fixture.run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /apply=applied/)
  const upgraded = fixture.read()
  assert.doesNotMatch(upgraded, /policy v2/)
  for (const namespace of ['workwise', 'railwise-ai']) {
    for (const channel of ['stable', 'frontier']) {
      for (const name of ['latest.json', 'latest.yml', 'latest-mac.yml']) {
        const expected = `location = /downloads/${namespace}/channels/${channel}/latest/${name} {`
        assert.equal(upgraded.split(expected).length - 1, 1, expected)
        const body = upgraded.split(expected)[1].split('}')[0]
        assert.match(body, /expires off;/)
        assert.match(body, /Cache-Control "no-cache, no-store, must-revalidate"/)
        assert.match(body, /try_files \$uri =404;/)
      }
    }
  }
  assert.match(upgraded, /location \^~ \/downloads\/workwise\/acceptance\//)
  assert.match(upgraded, /location \/unrelated\/ \{ expires 7d; \}/)
  const second = fixture.run()
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /apply=already_present/)
  assert.equal(fixture.read(), upgraded)
  fixture.write(upgraded.replace('location = /downloads/railwise-ai/channels/stable/latest/latest.json', 'location = /downloads/railwise-ai/channels/stable/latest/incorrect.json'))
  const repair = fixture.run()
  assert.equal(repair.status, 0, repair.stderr)
  assert.match(repair.stdout, /apply=applied/)
  assert.equal(fixture.read(), upgraded)
})

test('cache repair rejects incomplete managed blocks and restores config after nginx failures', t => {
  const fixture = cacheRepairFixture(t)
  const malformed = `server {\n    server_name www.railwise.cn;\n    # WorkWise updater metadata cache policy v2 begin\n}\n`
  fixture.write(malformed)
  const rejected = fixture.run()
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /markers do not match/)
  assert.equal(fixture.read(), malformed)

  const futurePolicy = `server {\n    server_name www.railwise.cn;\n    # WorkWise updater metadata cache policy v4 begin\n    location /future/ { expires off; }\n    # WorkWise updater metadata cache policy v4 end\n}\n`
  fixture.write(futurePolicy)
  const futureRejected = fixture.run()
  assert.notEqual(futureRejected.status, 0)
  assert.match(futureRejected.stderr, /unsupported managed cache policy version/)
  assert.equal(fixture.read(), futurePolicy)

  const original = `server {\n    server_name www.railwise.cn;\n    location / { expires 7d; }\n}\n`
  for (const failure of ['test', 'reload']) {
    fixture.write(original)
    const result = fixture.run(failure)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout, failure === 'test' ? /apply=rolled_back\n/ : /apply=rolled_back_reload_failed\n/)
    assert.equal(fixture.read(), original)
  }
})

function cacheRepairFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'railwise-cache-policy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const serverFile = join(dir, 'server.conf')
  const source = readFileSync(new URL('./repair-website-cache.mjs', import.meta.url), 'utf8')
  const remote = source.match(/const REMOTE_SCRIPT = String\.raw`([\s\S]*?)`\n/)[1]
  const script = remote.slice(remote.indexOf('backup="$server_file.workwise-cache-backup.' ))
  const run = (failure = '') => {
    const marker = join(dir, `failed-${failure}`)
    try { rmSync(marker) } catch (error) { if (error.code !== 'ENOENT') throw error }
    return spawnSync('bash', ['-c', `set -euo pipefail
server_file="$FIXTURE_SERVER"
dump="$(mktemp)"
nginx_bin=fixture-nginx
server_run() {
  if [[ "$1" == fixture-nginx ]]; then
    if [[ "${'${2:-}'}" == "-$FIXTURE_FAILURE" && ! -e "$FIXTURE_MARKER" ]]; then
      touch "$FIXTURE_MARKER"
      return 1
    fi
    return 0
  fi
  "$@"
}
server_write_file() { tee "$1" >/dev/null; }
${script}`], { encoding: 'utf8', env: { ...process.env, FIXTURE_SERVER: serverFile, FIXTURE_FAILURE: failure === 'test' ? 't' : failure === 'reload' ? 's' : 'none', FIXTURE_MARKER: marker } })
  }
  return { run, read: () => readFileSync(serverFile, 'utf8'), write: value => writeFileSync(serverFile, value) }
}
