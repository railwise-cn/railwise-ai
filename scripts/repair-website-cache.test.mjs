import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
