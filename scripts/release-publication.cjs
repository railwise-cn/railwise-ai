// The publication contract owns names and URLs; storage/application identities
// remain independent. Historical packages are read, never renamed in place.
const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, lstatSync, writeFileSync, mkdirSync, copyFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const brand = require('../src/shared/product-brand.json')
const policy = Object.freeze(brand.release)
const prefixes = [policy.artifactPrefix, ...policy.legacyArtifactPrefixes]
const namespaces = [policy.downloadNamespace, ...policy.legacyDownloadNamespaces]
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const artifactPattern = new RegExp(`^(${prefixes.map(escape).join('|')})(?:-Candidate-([a-f0-9]{12}))?-(\\d+\\.\\d+\\.\\d+)-(mac|win|linux)-(arm64|x64|Apple-Silicon|Intel|x86_64)\\.(dmg|zip|exe|AppImage)(\\.blockmap)?$`)
const metadataIdentity = Object.freeze({
  'latest-mac.yml': { platform: 'mac', arch: null, format: 'yml', role: 'update-metadata' },
  'latest.yml': { platform: 'win', arch: 'x64', format: 'yml', role: 'update-metadata' }
})
function publicationFileIdentity(name) {
  const parsed = parseArtifactName(name)
  if (!parsed) return metadataIdentity[name] || null
  return { ...parsed, role: parsed.blockmap ? 'blockmap' : parsed.format === 'zip' ? 'update-archive' : 'installer' }
}

function version(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid publication version: ${value}`)
  return value
}
function artifactName({ version: releaseVersion, platform, arch, format, publicName = false, prefix = policy.artifactPrefix, candidateSourceHead, blockmap = false }) {
  version(releaseVersion)
  if (!prefixes.includes(prefix)) throw new Error('Unrecognized artifact prefix')
  if (!['mac', 'win', 'linux'].includes(platform) || !['arm64', 'x64', 'x86_64'].includes(arch) || !['dmg', 'zip', 'exe', 'AppImage'].includes(format)) throw new Error('Invalid artifact platform, architecture or format')
  if (candidateSourceHead && !/^[a-f0-9]{12,40}$/.test(candidateSourceHead)) throw new Error('Invalid candidate source HEAD')
  const identity = candidateSourceHead ? `${prefix}-Candidate-${candidateSourceHead.slice(0, 12)}` : prefix
  const publicArch = publicName && platform === 'mac' && format === 'dmg' ? (arch === 'arm64' ? 'Apple-Silicon' : 'Intel') : arch
  return `${identity}-${releaseVersion}-${platform}-${publicArch}.${format}${blockmap ? '.blockmap' : ''}`
}
function parseArtifactName(name) {
  if (typeof name !== 'string' || basename(name) !== name) return null
  const match = artifactPattern.exec(name)
  if (!match) return null
  const [, prefix, candidateSourceHead, releaseVersion, platform, rawArch, format, blockmap] = match
  const arch = rawArch === 'Apple-Silicon' ? 'arm64' : rawArch === 'Intel' ? 'x64' : rawArch
  return { prefix, candidateSourceHead, version: releaseVersion, platform, arch, format, blockmap: Boolean(blockmap), publicName: ['Apple-Silicon', 'Intel'].includes(rawArch) }
}
function expectedReleaseFiles(releaseVersion, prefix = policy.artifactPrefix) {
  return [
    ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(format => ({ name: artifactName({ version: releaseVersion, platform: 'mac', arch, format, prefix }), platform: `darwin-${arch}`, artifact: 'release-mac' }))),
    { name: 'latest-mac.yml', platform: 'darwin', artifact: 'release-mac' },
    ...[false, true].map(blockmap => ({ name: artifactName({ version: releaseVersion, platform: 'win', arch: 'x64', format: 'exe', prefix, blockmap }), platform: 'win32-x64', artifact: 'release-win' })),
    { name: 'latest.yml', platform: 'win32-x64', artifact: 'release-win' }
  ]
}
function publicInstallers(releaseVersion, prefix = policy.artifactPrefix) {
  return [
    ...['arm64', 'x64'].map(arch => ({ id: arch === 'arm64' ? 'macos-apple-silicon' : 'macos-intel', platform: 'mac', arch, format: 'dmg', name: artifactName({ version: releaseVersion, platform: 'mac', arch, format: 'dmg', publicName: true, prefix }) })),
    { id: 'windows-x64', platform: 'win', arch: 'x64', format: 'exe', name: artifactName({ version: releaseVersion, platform: 'win', arch: 'x64', format: 'exe', prefix }) }
  ]
}
function namespace(value = policy.downloadNamespace) {
  const match = String(value).match(/^([a-z][a-z0-9-]*)(?:\/acceptance\/([1-9]\d*))?$/)
  if (!match || !namespaces.includes(match[1])) throw new Error(`Unrecognized release namespace: ${value}`)
  return { prefix: match[0], namespace: match[1], relative: match[2] ? `acceptance/${match[2]}` : '', acceptanceRunId: match[2] || '' }
}
function updateUrl({ channel = 'stable', releasePrefix = policy.downloadNamespace, publicBaseUrl = 'https://www.railwise.cn/downloads' } = {}) {
  if (!['stable', 'frontier'].includes(channel)) throw new Error('Invalid release channel')
  return `${publicBaseUrl.replace(/\/+$/, '')}/${namespace(releasePrefix).prefix}/channels/${channel}/latest/`
}
function detectPrefix(files, releaseVersion) {
  const found = new Set(files.map(file => parseArtifactName(typeof file === 'string' ? file : file.name || file.fileName)).filter(file => file && !file.candidateSourceHead && file.version === releaseVersion).map(file => file.prefix))
  if (found.size !== 1) throw new Error('Publication must have exactly one artifact naming identity')
  return [...found][0]
}
function createPublicationManifest({ directory, version: releaseVersion, sourceHead = '', channel = 'stable', releasePrefix = policy.downloadNamespace, publicBaseUrl = 'https://www.railwise.cn/downloads', publishedAt = '' }) {
  version(releaseVersion)
  if (sourceHead && !/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('Invalid publication source HEAD')
  const entries = readdirSync(directory).filter(name => { const parsed = parseArtifactName(name); return metadataIdentity[name] || parsed && !parsed.candidateSourceHead && parsed.version === releaseVersion })
  const artifactPrefix = detectPrefix(entries, releaseVersion)
  const base = updateUrl({ channel, releasePrefix, publicBaseUrl })
  const archiveBase = base.replace(/latest\/$/, `releases/v${releaseVersion}/`)
  const files = entries.sort().map(name => {
    const path = join(directory, name)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Publication asset is not a regular file: ${name}`)
    const bytes = readFileSync(path)
    return { name, ...publicationFileIdentity(name), size: info.size, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64'), url: `${archiveBase}${name}`, latestUrl: `${base}${name}` }
  })
  const installers = publicInstallers(releaseVersion, artifactPrefix).map(installer => {
    const file = files.find(entry => entry.name === installer.name)
    if (!file) throw new Error(`Missing public installer: ${installer.name}`)
    return { ...installer, ...file }
  })
  return validatePublicationManifest({ schemaVersion: 1, productName: brand.platform, artifactPrefix, version: releaseVersion, tag: `v${releaseVersion}`, sourceHead, channel, downloadNamespace: namespace(releasePrefix).prefix, publishedAt, updateBaseUrl: base, files, installers })
}
function validatePublicationManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.productName !== brand.platform) throw new Error('Invalid publication identity')
  version(manifest.version)
  if (manifest.tag !== `v${manifest.version}` || !prefixes.includes(manifest.artifactPrefix) || !['stable', 'frontier'].includes(manifest.channel) || (manifest.sourceHead && !/^[a-f0-9]{40}$/.test(manifest.sourceHead)) || !Array.isArray(manifest.files) || !Array.isArray(manifest.installers)) throw new Error('Invalid publication manifest')
  namespace(manifest.downloadNamespace)
  if (new Set(manifest.files.map(file => file.name)).size !== manifest.files.length) throw new Error('Duplicate publication files')
  const required = expectedReleaseFiles(manifest.version, manifest.artifactPrefix).map(file => metadataIdentity[file.name] ? file.name : artifactName({ ...parseArtifactName(file.name), publicName: true }))
  const allowed = new Set([...required, ...required.filter(name => name.endsWith('.dmg') || name.endsWith('.zip')).map(name => `${name}.blockmap`)])
  if (required.some(name => !manifest.files.some(file => file.name === name)) || manifest.files.some(file => !allowed.has(file.name))) throw new Error('Publication artifact set mismatch')
  for (const file of manifest.files) {
    const parsed = parseArtifactName(file.name)
    const identity = publicationFileIdentity(file.name)
    if (!identity || (parsed && (parsed.candidateSourceHead || parsed.version !== manifest.version || parsed.prefix !== manifest.artifactPrefix)) || file.role !== identity.role || file.platform !== identity.platform || file.arch !== identity.arch || file.format !== identity.format || !Number.isSafeInteger(file.size) || file.size < 1 || !/^[a-f0-9]{64}$/.test(file.sha256) || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) throw new Error('Invalid publication file')
    const base = new URL(manifest.updateBaseUrl)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith(`/${manifest.downloadNamespace}/channels/${manifest.channel}/latest/`)) throw new Error('Invalid publication URL')
    const archive = new URL(`../releases/${manifest.tag}/${file.name}`, base).href
    if (file.latestUrl !== new URL(file.name, base).href || file.url !== archive) throw new Error('Publication file URL mismatch')
  }
  const expected = publicInstallers(manifest.version, manifest.artifactPrefix)
  if (manifest.installers.length !== expected.length || expected.some(installer => !manifest.installers.some(file => file.name === installer.name && file.id === installer.id && manifest.files.some(asset => asset.name === file.name && asset.sha256 === file.sha256 && asset.size === file.size && asset.url === file.url)))) throw new Error('Publication installer set mismatch')
  return manifest
}
function readPublicationManifest(path) { return validatePublicationManifest(JSON.parse(readFileSync(path, 'utf8'))) }

function copyPublicInstallers(source, destination) {
  const manifest = readPublicationManifest(join(source, 'publication-manifest.json'))
  mkdirSync(destination, { recursive: true })
  for (const file of manifest.installers) {
    const bytes = readFileSync(join(source, file.name))
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Installer differs from publication manifest')
    copyFileSync(join(source, file.name), join(destination, file.name))
  }
  return manifest
}

module.exports = { policy, prefixes, namespaces, artifactPattern, artifactName, parseArtifactName, expectedReleaseFiles, publicInstallers, namespace, updateUrl, detectPrefix, createPublicationManifest, validatePublicationManifest, readPublicationManifest, copyPublicInstallers }
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'public-names') process.stdout.write(publicInstallers(args[0]).map(file => file.name).join('\n') + '\n')
  else if (command === 'copy-installers') copyPublicInstallers(args[0], args[1])
  else if (command === 'name') process.stdout.write(artifactName(JSON.parse(args[0])) + '\n')
  else if (command === 'create') writeFileSync(join(args[0], 'publication-manifest.json'), JSON.stringify(createPublicationManifest({ directory: args[0], version: args[1], sourceHead: args[2] || '', channel: args[3] || 'stable' }), null, 2) + '\n')
  else throw new Error('Usage: release-publication.cjs public-names VERSION | name JSON | create DIRECTORY VERSION [SOURCE_HEAD] [CHANNEL]')
}
