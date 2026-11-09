import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import publication from './release-publication.cjs'
import generator from './generate-website-product-manifest.cjs'
import { _internals as r2, buildLatestManifest } from './publish-r2.mjs'

function fixture(t, prefix = publication.policy.artifactPrefix) {
  const root = mkdtempSync(join(tmpdir(), 'railwise-publication-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = join(root, 'input'); const output = join(root, 'output')
  mkdirSync(input)
  const version = '0.5.5'
  const files = publication.expectedReleaseFiles(version, prefix).filter(file => !file.name.endsWith('.yml'))
  for (const file of files) writeFileSync(join(input, file.name), `synthetic ${file.name}`)
  for (const [platform, metadata] of [['mac', 'latest-mac.yml'], ['win', 'latest.yml']]) {
    const entries = files.filter(file => publication.parseArtifactName(file.name).platform === platform && !file.name.endsWith('.blockmap')).map(file => {
      const bytes = readFileSync(join(input, file.name))
      return { name: file.name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }
    })
    writeFileSync(join(input, metadata), `version: ${version}\nfiles:\n${entries.map(file => `  - url: ${file.name}\n    sha512: ${file.sha512}\n    size: ${file.size}`).join('\n')}\npath: ${entries[0].name}\nsha512: ${entries[0].sha512}\nreleaseDate: '2026-11-09T00:00:00.000Z'\n`)
  }
  execFileSync(process.execPath, ['scripts/prepare-website-release-assets.cjs', input, output, version], { cwd: resolve('.'), env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) }, stdio: 'pipe' })
  return { input, output, version, manifest: publication.readPublicationManifest(join(output, 'publication-manifest.json')) }
}

test('one publication manifest projects current package names, website downloads and immutable bytes', t => {
  const f = fixture(t)
  assert.equal(f.manifest.artifactPrefix, 'RailWise-AI')
  assert.equal(f.manifest.downloadNamespace, 'railwise-ai')
  assert.equal(f.manifest.installers.length, 3)
  for (const file of f.manifest.files) {
    assert.match(file.url, /\/downloads\/railwise-ai\/channels\/stable\/releases\/v0\.5\.5\//)
    if (file.role === 'update-metadata') {
      assert.ok(['latest-mac.yml', 'latest.yml'].includes(file.name))
      assert.equal(file.sha256, createHash('sha256').update(readFileSync(join(f.output, file.name))).digest('hex'))
      continue
    }
    assert.match(file.name, /^RailWise-AI-/)
    const source = readdirSync(f.input).find(name => { const a = publication.parseArtifactName(name); const b = publication.parseArtifactName(file.name); return a && b && a.platform === b.platform && a.arch === b.arch && a.format === b.format && a.blockmap === b.blockmap })
    assert.deepEqual(readFileSync(join(f.input, source)), readFileSync(join(f.output, file.name)))
  }
  const site = generator.productManifest(f.manifest, { capabilityStatus: { stable: ['Existing capability'] }, platforms: [] })
  assert.equal(site.releaseCommit, 'a'.repeat(40))
  assert.equal(site.version, f.version)
  assert.deepEqual(site.platforms.map(file => file.file), f.manifest.installers.map(file => file.name))
  assert.deepEqual(site.capabilityStatus.stable, ['Existing capability'])
  const latest = JSON.parse(readFileSync(join(f.output, 'latest.json'), 'utf8'))
  assert.deepEqual(latest.files.map(file => file.sha256), f.manifest.files.map(file => file.sha256))
  const github = join(f.output, 'github')
  publication.copyPublicInstallers(f.output, github)
  assert.deepEqual(readdirSync(github).sort(), f.manifest.installers.map(file => file.name).sort())
  execFileSync(process.execPath, ['scripts/verify-release-assets.cjs', f.output], { stdio: 'pipe' })
})

test('legacy filenames are read without rewriting historical receipts or weakening namespace validation', t => {
  const f = fixture(t, 'WorkWise')
  assert.equal(publication.parseArtifactName('WorkWise-0.5.4-mac-Apple-Silicon.dmg').arch, 'arm64')
  assert.equal(publication.parseArtifactName('../RailWise-AI-0.5.5-win-x64.exe'), null)
  assert.equal(publication.parseArtifactName('Other-0.5.5-win-x64.exe'), null)
  assert.equal(publication.namespace('workwise').prefix, 'workwise')
  assert.equal(publication.namespace('railwise-ai').prefix, 'railwise-ai')
  assert.throws(() => publication.namespace('railwise-ai/../workwise'))
  assert.throws(() => publication.detectPrefix(['WorkWise-0.5.5-win-x64.exe', 'RailWise-AI-0.5.5-win-x64.exe'], f.version))
  assert.equal(f.manifest.artifactPrefix, 'RailWise-AI')
  assert.equal(r2.classifyDownload('RailWise-AI-0.5.5-mac-Apple-Silicon.dmg', 'mac').arch, 'arm64')
})

test('publication tampering, redirected URLs and changed installer bytes fail before projection or upload', t => {
  const f = fixture(t)
  const changed = structuredClone(f.manifest)
  changed.files[0].url = 'https://example.invalid/other.exe'
  assert.throws(() => publication.validatePublicationManifest(changed), /URL/)
  const missingUpdateZip = structuredClone(f.manifest)
  missingUpdateZip.files = missingUpdateZip.files.filter(file => !file.name.endsWith('-mac-arm64.zip'))
  assert.throws(() => publication.validatePublicationManifest(missingUpdateZip), /artifact set/)
  assert.throws(() => publication.validatePublicationManifest({ ...f.manifest, sourceHead: '../wrong' }), /manifest/)
  const target = f.manifest.installers[0]
  writeFileSync(join(f.output, target.name), 'changed')
  assert.throws(() => publication.copyPublicInstallers(f.output, join(f.output, 'github')), /differs/)
  assert.throws(() => execFileSync(process.execPath, ['scripts/verify-release-assets.cjs', f.output], { stdio: 'pipe' }))
})

test('R2 public URLs follow the publication contract while physical legacy pointer paths remain compatible', () => {
  const base = 'https://www.railwise.cn/downloads/railwise-ai/channels/stable/latest/'
  const manifests = ['mac', 'win'].map(platform => ({
    platform, version: '0.5.5', releaseDate: '2026-11-09T00:00:00.000Z',
    publication: { updateBaseUrl: base }, updateMetadata: { fileName: platform === 'mac' ? 'latest-mac.yml' : 'latest.yml' },
    downloads: [{ fileName: platform === 'mac' ? 'RailWise-AI-0.5.5-mac-arm64.zip' : 'RailWise-AI-0.5.5-win-x64.exe' }]
  }))
  const latest = buildLatestManifest({ platformManifests: manifests, channel: 'stable', tag: 'v0.5.5', publicBaseUrl: 'https://www.railwise.cn/downloads', basePath: 'workwise', generatedAt: '2026-11-09T00:00:00.000Z' })
  assert.equal(latest.updateBaseUrl, base)
  assert.equal(latest.updateMetadata.mac.url, `${base}latest-mac.yml`)
  assert.ok(latest.downloads.every(file => file.url.startsWith(base)))
  delete manifests[1].publication
  assert.throws(() => buildLatestManifest({ platformManifests: manifests }), /do not agree/)
})

test('R2 collection preserves physical legacy keys and rejects updater drift from sealed bytes', async t => {
  const f = fixture(t)
  const config = { prefix: 'workwise', publicBaseUrl: 'https://www.railwise.cn/downloads' }
  const mac = await r2.collectPlatformRelease({ distDir: f.output, platform: 'mac', tag: 'v0.5.5', channel: 'stable', config })
  assert.equal(mac.publication.sourceHead, f.manifest.sourceHead)
  assert.ok(mac.files.every(file => file.key.startsWith('workwise/channels/stable/releases/v0.5.5/')))
  assert.ok(mac.downloads.every(file => file.archiveUrl.startsWith('https://www.railwise.cn/downloads/railwise-ai/')))
  const metadata = join(f.output, 'latest-mac.yml')
  writeFileSync(metadata, readFileSync(metadata, 'utf8').replace(/size: \d+/, 'size: 1'))
  await assert.rejects(r2.collectPlatformRelease({ distDir: f.output, platform: 'mac', tag: 'v0.5.5', channel: 'stable', config }), /Publication asset changed/)
  assert.throws(() => execFileSync(process.execPath, ['scripts/verify-release-assets.cjs', f.output], { stdio: 'pipe' }))
})
