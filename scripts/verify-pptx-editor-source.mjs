import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const readJson = async (path) => JSON.parse(await readFile(resolve(path), 'utf8'))
const sha1 = (bytes) => createHash('sha1').update(bytes).digest('hex')
const source = await readJson('src/asset/pptx-editors/pptx-vanilla-viewer-source.json')
const pausedPptist = await readJson('src/asset/pptx-editors/pptist-source.json')
const packageJson = await readJson('package.json')
const lock = await readJson('package-lock.json')
const installed = await readJson('node_modules/pptx-vanilla-viewer/package.json')
const builderConfig = await readFile(resolve('electron-builder.cjs'), 'utf8')

const fullSha = /^[0-9a-f]{40}$/
if (source.name !== 'pptx-vanilla-viewer' || source.version !== '3.80.0') {
  throw new Error('Unexpected PPTX editor package or version.')
}
if (source.repository !== 'https://github.com/ChristopherVR/ooxml') {
  throw new Error('PPTX editor source must use the canonical upstream repository.')
}
if (!fullSha.test(source.ref) || source.ref !== '9ff78cf6a7c65dbeabb84a89a1099af4258decc7') {
  throw new Error('PPTX editor source must be pinned to the audited full release commit.')
}
if (source.license !== 'Apache-2.0' || source.integration !== 'local-vanilla-dom') {
  throw new Error('PPTX editor license or integration metadata is out of date.')
}
if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(source.npmIntegrity)) {
  throw new Error('PPTX editor npm integrity is invalid.')
}
if (!/^[0-9a-f]{64}$/.test(source.releaseArtifactSha256)) {
  throw new Error('PPTX editor release artifact digest is invalid.')
}
if (source.externalContent !== false || source.googleFonts !== false) {
  throw new Error('PPTX editor external content and Google Fonts must remain disabled.')
}
if (!builderConfig.includes("from: 'src/asset/pptx-editors'") || !builderConfig.includes("to: 'third-party/pptx-editors'")) {
  throw new Error('PPTX editor legal notices are not configured for packaged resources.')
}
if (packageJson.dependencies?.['pptx-vanilla-viewer'] !== source.version) {
  throw new Error('package.json must pin the PPTX editor to the audited exact version.')
}
const locked = lock.packages?.['node_modules/pptx-vanilla-viewer']
if (
  locked?.version !== source.version ||
  locked?.integrity !== source.npmIntegrity ||
  locked?.resolved !== `https://registry.npmjs.org/pptx-vanilla-viewer/-/pptx-vanilla-viewer-${source.version}.tgz`
) {
  throw new Error('package-lock.json does not match the audited PPTX editor artifact.')
}
if (installed.version !== source.version || installed.license !== source.license) {
  throw new Error('Installed PPTX editor package does not match its source manifest.')
}
for (const file of ['LICENSE', 'NOTICE']) {
  await readFile(resolve(`node_modules/pptx-vanilla-viewer/${file}`))
}
if (source.bundledComponents?.find((item) => item.name === 'mtx-decompressor')?.license !== 'MPL-2.0') {
  throw new Error('The separately licensed MTX font decompressor notice must be retained.')
}
const mtx = source.bundledComponents.find((item) => item.name === 'mtx-decompressor')
if (
	mtx.sourceRef !== 'bb0e738720f36828aedb14c26667bdde0740355c' ||
	mtx.sourceTag !== 'v1.9.0' ||
  mtx.repository !== 'https://github.com/ChristopherVR/mtx-decompressor' ||
	mtx.npmVersion !== '1.9.0' ||
	mtx.npmIntegrity !== 'sha512-gQ+oQRw5BSolUlvO4CjTKgAg2K28cb0aAafdcyN2V9GxsxZAFyfrqyZ7z48f+3CGpnTC2bAeNal2HtNpFunBvQ==' ||
	mtx.sourceArchiveSha256 !== '6169045c2de01709519753fe169d4126b0f47640e85bcddc7848117cfa96b7ea' ||
  mtx.vendorPath !== 'src/asset/pptx-editors/third-party/mtx-decompressor'
) {
  throw new Error('The vendored MTX component source and integrity metadata are incomplete.')
}
const mtxRoot = resolve(mtx.vendorPath)
const mtxPackage = await readJson(`${mtx.vendorPath}/package.json`)
if (mtxPackage.name !== 'mtx-decompressor' || mtxPackage.version !== mtx.npmVersion || mtxPackage.license !== 'MPL-2.0') {
  throw new Error('The vendored MTX package metadata does not match the audited component.')
}
for (const file of [
  'LICENSE',
  'README.md',
  'SOURCE-OFFER.md',
  'dist/index.js',
  'dist/index.mjs',
  'dist/index.d.ts',
  'dist/index.d.mts'
]) {
  const entry = await stat(resolve(mtxRoot, file))
  if (!entry.isFile() || entry.size === 0) throw new Error(`Vendored MTX file is missing or empty: ${file}`)
}
const sourceFiles = {
  'src/__fixtures__/bit-samples.ts': 'd559a9af9aa4fb88eb76576d662bc29acce01d27',
  'src/__fixtures__/real/fontawesome-3.2.1.eot': '0662cb96bfb78cb2603df4bc9995314bd6806312',
  'src/__fixtures__/real/fontawesome-3.2.1.ttf': 'd3659246915cacb0c9204271f1f9fc5f77049eac',
  'src/__fixtures__/real/fontawesome-4.7.0.eot': 'e9f60ca953f93e35eab4108bd414bc02ddcf3928',
  'src/__fixtures__/real/fontawesome-4.7.0.ttf': '35acda2fa1196aad98c2adf4378a7611dd713aa3',
  'src/__fixtures__/real/glyphicons-3.3.7.eot': 'b93a4953fff68df523aa7656497ee339d6026d64',
  'src/__fixtures__/real/glyphicons-3.3.7.ttf': '1413fc609ab6f21774de0cb7e01360095584f65b',
  'src/__fixtures__/value-edge-samples.ts': '5f3193eb342e949618ecd09d71ef30ca14dd99f0',
  'src/ahuff.test.ts': 'c63caf2920f47ee294c5745c95bf321e6e4534d9',
  'src/ahuff.ts': '9a5617926ba778c44855a96a21214da17478b098',
  'src/bitio.fixtures.test.ts': '14f1fb95d474480092c3ea3ac2fcfc4cc62f2bb2',
  'src/bitio.test.ts': '25d7bee4df1b7df9333d3e13ee6f043e0c3015a8',
  'src/bitio.ts': '48d3ae15f3ee951b18c1d816dd663e0246d1617f',
  'src/bitio.width.test.ts': '5cf2f7a4fd5af28f70df8a0a68398510a1828331',
  'src/ctf-parser.test.ts': '74144ea60921dd92b4afe13c2d29d0a0ebdf5879',
  'src/ctf-parser.ts': '40dd85f01036439e846a28e40cafad3ea90bf178',
  'src/eot.test.ts': '6b8644e3f31f47c82dd80edb5ea1b6771c369d1e',
  'src/eot.ts': '16c01a5eff62e60f8e596f00e2f2810dbc651c51',
  'src/errors.ts': 'a4f8576563b943e69262ce5418b5f897c7b292b1',
  'src/hardening.test.ts': '2b770c92dba02e79db2e2dd23375669bce529894',
  'src/hdmx.test.ts': 'a464dd4e209e7738222bf91abc447f6265773122',
  'src/hdmx.ts': 'a71325fc7d42c5d19fefe0d829fb9ac2b72fd82b',
  'src/index.ts': '48b6d28eb7d5eb7fc2f26e8f11e1e2537869b934',
  'src/integration.test.ts': 'c48ba37e271bc18a258d404968aa6021330b22b2',
  'src/lzcomp.guards.test.ts': '66caccab30d4b3e24437d9a0b64810589120b325',
  'src/lzcomp.test.ts': '456deab3b377a3b24e19f65962f3c64a32454105',
  'src/lzcomp.ts': '44b51531fec755c8edd11e6bd5d062b0cf92a73c',
  'src/magnitude.test.ts': 'e4154ec7bd05da678fce663a3996b64f2329a1d3',
  'src/magnitude.ts': '602a391e2019653f31fde2c2cf6f59d2a7792999',
  'src/mtx-decompress.test.ts': 'd574f76349d4b1d13ff393474a749215c7ec8625',
  'src/mtx-decompress.ts': '907e27b6d18895a7f3fa501d8db9cb9c32d9ad81',
  'src/real-fonts.test.ts': '6d8fadc70ae29026726b8bde3290493e4e0ff4b4',
  'src/sfnt-builder.test.ts': 'f8a67cc40b25134ddd8cbae6f700d461d8bbb259',
  'src/sfnt-builder.ts': '6a2962f9dbb40a61bd8f7bda90e8a757e9941c9a',
  'src/stream.test.ts': '65118710cd32139789a2195c6ca529928913a940',
  'src/stream.ts': 'bb87e90b354150db2af6cfb90a59791f580aada7',
  'src/triplet-encodings.test.ts': '824fce5b89e605f615f18b9ec755200d04eb7031',
  'src/triplet-encodings.ts': 'c69a8ddae0c993f8f076520fcb5b9b889d2efdf1',
  'src/vdmx.test.ts': '587f9f656b4cbe5d85b9c111614fbd8b24dc1ee1',
  'src/vdmx.ts': 'b01263ddea07fb00e01b8641c4cd8b41a06d545c'
}
const localPatchBlobs = {
  'src/ctf-parser.test.ts': '743e24225cb035abb8e47862f84dc3f94b57cc7d'
}
const declaredLocalPatches = Object.fromEntries(
  (source.localPatches ?? []).map((patch) => [patch.path, patch.railwiseBlobSha1]),
)
if (JSON.stringify(declaredLocalPatches) !== JSON.stringify(localPatchBlobs)) {
  throw new Error('The source manifest does not match the reviewed local MTX patch set.')
}
for (const [file, expectedBlobSha] of Object.entries(sourceFiles)) {
  const bytes = await readFile(resolve(mtxRoot, file))
  // Git blob IDs protect the vendored source against accidental edits while
  // remaining independent of filesystem timestamps and line-ending metadata.
  const blobHeader = Buffer.from(`blob ${bytes.length}\0`)
  const actualBlobSha = sha1(Buffer.concat([blobHeader, bytes]))
  if (actualBlobSha !== expectedBlobSha && actualBlobSha !== localPatchBlobs[file]) {
    throw new Error(`Vendored MTX source does not match the pinned commit: ${file}`)
  }
}
if (Object.keys(localPatchBlobs).some((file) => !Object.hasOwn(sourceFiles, file))) {
  throw new Error('A local MTX patch is not based on a file pinned to the upstream source.')
}
const pinnedSourceFiles = [
  'src/__fixtures__/bit-samples.ts',
  'src/__fixtures__/real/fontawesome-3.2.1.eot',
  'src/__fixtures__/real/fontawesome-3.2.1.ttf',
  'src/__fixtures__/real/fontawesome-4.7.0.eot',
  'src/__fixtures__/real/fontawesome-4.7.0.ttf',
  'src/__fixtures__/real/glyphicons-3.3.7.eot',
  'src/__fixtures__/real/glyphicons-3.3.7.ttf',
  'src/__fixtures__/value-edge-samples.ts',
  'src/ahuff.test.ts',
  'src/ahuff.ts',
  'src/bitio.fixtures.test.ts',
  'src/bitio.test.ts',
  'src/bitio.ts',
  'src/bitio.width.test.ts',
  'src/ctf-parser.test.ts',
  'src/ctf-parser.ts',
  'src/eot.test.ts',
  'src/eot.ts',
  'src/errors.ts',
  'src/hardening.test.ts',
  'src/hdmx.test.ts',
  'src/hdmx.ts',
  'src/index.ts',
  'src/integration.test.ts',
  'src/lzcomp.guards.test.ts',
  'src/lzcomp.test.ts',
  'src/lzcomp.ts',
  'src/magnitude.test.ts',
  'src/magnitude.ts',
  'src/mtx-decompress.test.ts',
  'src/mtx-decompress.ts',
  'src/real-fonts.test.ts',
  'src/sfnt-builder.test.ts',
  'src/sfnt-builder.ts',
  'src/stream.test.ts',
  'src/stream.ts',
  'src/triplet-encodings.test.ts',
  'src/triplet-encodings.ts',
  'src/vdmx.test.ts',
  'src/vdmx.ts'
]
if (
  Object.keys(sourceFiles).some((file) => !pinnedSourceFiles.includes(file)) ||
  pinnedSourceFiles.some((file) => !Object.hasOwn(sourceFiles, file))
) {
  throw new Error('The vendored MTX source manifest is incomplete or contains an unexpected entry.')
}
if (pausedPptist.license !== 'AGPL-3.0' || pausedPptist.status !== 'paused-license-decision') {
  throw new Error('The rejected PPTist source record must remain marked as paused.')
}

console.log(`PPTX editor source verified: ${source.name} ${source.version} ${source.ref} (${source.license}; bundled MPL-2.0 component recorded)`)
