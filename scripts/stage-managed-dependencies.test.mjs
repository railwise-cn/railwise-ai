import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedBytes, finalizeWebsite, r2Matches, validateManifest } from './stage-managed-dependencies.mjs'

const manifest = JSON.parse(await readFile(new URL('../src/shared/managed-dependencies.json', import.meta.url), 'utf8'))
const bytes = Buffer.from('exact upstream dependency')
const file = { id: 'fixture', component: 'fixture', version: '1.0.0', name: 'fixture.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
file.mirrorPath = `${file.component}/${file.version}/${file.sha256}/${file.name}`

test('committed manifest pins all runtime targets, sources, licenses and Python metadata', () => {
  assert.equal(validateManifest(manifest).files.length, 25)
  for (const [target, entry] of Object.entries(manifest.pythonDownloads)) {
    const runtime = manifest.files.find(item => item.id === `python-${target}`)
    assert.equal(entry.metadata.sha256, runtime.sha256)
    assert.equal(entry.metadata.url, runtime.sourceUrl)
    assert.equal(entry.metadata.build, '20260211')
  }
  for (const component of ['uv', 'cpython', 'lark-cli']) {
    const runtimes = manifest.files.filter(item => item.component === component && item.role === 'runtime')
    assert.equal(runtimes.length, component === 'lark-cli' ? 4 : 6)
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
    const root = join(directory, 'downloads')
    const base = join(root, 'railwise-ai', 'dependencies')
    async function stage(suffix) {
      const path = join(base, `.stage-${suffix}`)
      const source = join(path, file.mirrorPath)
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

test('dependency workflow excludes every application job', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/\n  (?=[a-z][a-z0-9-]+:)/).slice(1)
  assert.ok(jobs.length > 10)
  for (const job of jobs) {
    if (job.startsWith('stage-managed-dependencies:')) assert.match(job, /inputs.stage_dependency_mirror == true/)
    else assert.match(job, /\n    if: \$\{\{ inputs.stage_dependency_mirror != true &&/)
  }
})
