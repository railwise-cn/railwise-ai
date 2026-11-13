import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { websiteStaticTransport } from './deploy-website-release.mjs'
import { checkedBytes, finalizeWebsite, inspectPublishedDependencies, inspectWebsiteStage, r2Matches, validateManifest } from './stage-managed-dependencies.mjs'

const manifest = JSON.parse(await readFile(new URL('../src/shared/managed-dependencies.json', import.meta.url), 'utf8'))
const bytes = Buffer.from('exact upstream dependency')
const file = { id: 'fixture', component: 'fixture', version: '1.0.0', name: 'fixture.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
file.mirrorPath = `${file.component}/${file.version}/${file.sha256}/${file.name}`

test('committed manifest pins all runtime targets, sources, licenses and Python metadata', () => {
  assert.equal(validateManifest(manifest).files.length, 36)
  assert.deepEqual(manifest.files.filter(item => item.component === 'browser-skill').map(item => item.id), ['browser-skill-darwin-arm64', 'browser-skill-darwin-x64', 'browser-skill-win32-x64', 'browser-skill-license', 'browser-skill-source'])
  for (const [target, entry] of Object.entries(manifest.pythonDownloads)) {
    const runtime = manifest.files.find(item => item.id === `python-${target}`)
    assert.equal(entry.metadata.sha256, runtime.sha256)
    assert.equal(entry.metadata.url, runtime.sourceUrl)
    assert.equal(entry.metadata.build, '20260211')
  }
  for (const component of ['uv', 'cpython', 'lark-cli', 'officecli']) {
    const runtimes = manifest.files.filter(item => item.component === component && item.role === 'runtime')
    assert.equal(runtimes.length, ['lark-cli', 'officecli'].includes(component) ? 4 : 6)
  }
})

test('rejects untrusted source hosts, mutable paths and missing licenses', () => {
  for (const change of [item => { item.sourceUrl = 'https://untrusted.example/runtime.zip' }, item => { item.mirrorPath = 'latest/runtime.zip' }, item => { item.license = '' }, item => { item.sourceIds = ['absent-source'] }]) {
    const altered = structuredClone(manifest)
    change(altered.files.find(item => item.role === 'runtime'))
    assert.throws(() => validateManifest(altered))
  }
})

test('checks response bounds and hash before storage', async () => {
  assert.deepEqual(await checkedBytes(new Response(bytes), file), bytes)
  await assert.rejects(checkedBytes(new Response(Buffer.concat([bytes, bytes])), file), /locked size/)
  await assert.rejects(checkedBytes(new Response(Buffer.alloc(bytes.length)), file), /integrity mismatch/)
  const redirected = new Response(bytes)
  Object.defineProperty(redirected, 'url', { value: 'https://untrusted.example/file' })
  await assert.rejects(checkedBytes(redirected, file), /unapproved/)
})

test('existing R2 objects are verified, conflicts fail and absence permits creation', async () => {
  const client = body => ({ send: async () => ({ Body: [body] }) })
  assert.equal(await r2Matches(client(bytes), 'bucket', 'key', file), true)
  await assert.rejects(r2Matches(client(Buffer.alloc(bytes.length)), 'bucket', 'key', file), /conflicts/)
  assert.equal(await r2Matches({ send: async () => { throw { $metadata: { httpStatusCode: 404 } } } }, 'bucket', 'key', file), false)
})

test('website finalization preserves immutable objects and fails conflicting content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-stage-test-'))
  try {
    const root = join(directory, 'downloads', 'workwise')
    const base = join(root, 'dependencies')
    async function stage(suffix) {
      const path = join(base, `.deploy-${suffix}`, 'payload')
      const source = join(path, file.id)
      await mkdir(join(source, '..'), { recursive: true })
      await writeFile(source, bytes)
      await writeFile(join(path, 'manifest.json'), JSON.stringify({ files: [file] }))
      return path
    }
    const execute = path => execFileSync('bash', ['-s', '--', root, path], { input: finalizeWebsite, stdio: ['pipe', 'pipe', 'pipe'] })
    execute(await stage('first'))
    const target = join(base, file.mirrorPath)
    assert.deepEqual(await readFile(target), bytes)
    execute(await stage('same'))
    await writeFile(target, 'existing conflict')
    const conflictingStage = await stage('conflict')
    assert.throws(() => execute(conflictingStage), /Immutable dependency conflict/)
    assert.equal(await readFile(target, 'utf8'), 'existing conflict')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('incremental staging verifies published resources and transfers only missing files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-incremental-test-'))
  try {
    const root = join(directory, 'downloads', 'workwise')
    const target = join(root, 'dependencies', file.mirrorPath)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, bytes)
    const missing = { ...file, id: 'missing', mirrorPath: 'fixture/1.0.0/missing.bin' }
    const metadata = Buffer.from(JSON.stringify({ files: [file, missing] })).toString('base64')
    const inspect = () => JSON.parse(execFileSync('bash', ['-s', '--', root, metadata], { input: inspectPublishedDependencies, stdio: ['pipe', 'pipe', 'pipe'] }).toString())
    assert.deepEqual(inspect(), { present: ['fixture'], missing: ['missing'] })
    const stage = join(root, 'dependencies', '.deploy-reuse', 'payload')
    await mkdir(stage, { recursive: true })
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ files: [file] }))
    execFileSync('bash', ['-s', '--', root, stage], { input: finalizeWebsite, stdio: ['pipe', 'pipe', 'pipe'] })
    assert.deepEqual(await readFile(target), bytes)
    await writeFile(target, 'changed')
    assert.throws(inspect, /Immutable dependency conflict/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('real worker startup forwards numeric configured and default chunk sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-worker-start-test-'))
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'setsid'), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 })
    await writeFile(join(bin, 'chmod'), '#!/bin/sh\nmode="$1"\nshift\nif [ "$1" = -- ]; then shift; fi\nexec /bin/chmod "$mode" "$@"\n', { mode: 0o700 })
    for (const configured of [undefined, '1048576']) {
      const payload = join(directory, configured ?? 'default')
      await mkdir(payload)
      const manifestPath = join(payload, '.r2-downloads.json')
      await writeFile(manifestPath, '[]')
      await writeFile(join(payload, '.r2-download-worker.py'), 'import json,pathlib,sys\npathlib.Path(sys.argv[2], "worker-args.json").write_text(json.dumps(sys.argv[1:]))\n')
      execFileSync('bash', ['-s', '--', manifestPath, payload, ...(configured ? [configured] : [])], {
        input: websiteStaticTransport.startR2DownloadScript,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let state
      for (let attempt = 0; attempt < 100; attempt++) {
        state = await readFile(join(payload, '.r2-download.status'), 'utf8').catch(() => undefined)
        if (state) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(state?.trim(), 'success 0')
      assert.deepEqual(JSON.parse(await readFile(join(payload, 'worker-args.json'), 'utf8')), [manifestPath, payload, configured ?? '16777216'])
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('saved transfer inspection is read-only and bound to the committed manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-inspect-test-'))
  try {
    const metadata = Buffer.from(JSON.stringify({ files: [file] }))
    await writeFile(join(directory, 'manifest.json'), metadata)
    await writeFile(join(directory, '.download-fixture.part-00000'), bytes)
    const expectedHash = createHash('sha256').update(metadata).digest('hex')
    const run = hash => execFileSync('bash', ['-s', '--', directory, hash], { input: inspectWebsiteStage, stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    assert.deepEqual(JSON.parse(run(expectedHash)), { state: 'running', workerAlive: false, partCount: 1, downloadedBytes: bytes.length })
    assert.throws(() => run('0'.repeat(64)), /manifest differs/)
    assert.deepEqual(await readFile(join(directory, '.download-fixture.part-00000')), bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('remote transfer reuses verified R2 objects and preserves the public namespace mapping', async () => {
  const script = await readFile(new URL('./stage-managed-dependencies.mjs', import.meta.url), 'utf8')
  assert.match(script, /ensurePublicDownloadAlias/)
  assert.match(script, /\$\{ssh.root\}\/dependencies\/\.deploy-/)
  assert.match(script, /getSignedUrl/)
  assert.match(script, /waitForRemoteR2Download/)
  assert.doesNotMatch(script, /copyDirectory/)
})

test('dependency workflow excludes every application job', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n {2}(?=[a-z][a-z0-9-]+:)/).slice(1)
  assert.ok(jobs.length > 10)
  for (const job of jobs) {
    if (job.startsWith('stage-managed-dependencies:')) assert.match(job, /inputs.stage_dependency_mirror == true/)
    else if (job.startsWith('existing-windows-package-acceptance:')) assert.match(job, /inputs.existing_windows_package_run_id != ''/)
    else assert.match(job, /\n {4}if: \$\{\{ inputs.stage_dependency_mirror != true &&/)
  }
})
