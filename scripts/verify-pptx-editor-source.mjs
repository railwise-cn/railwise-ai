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
if (source.name !== 'pptx-vanilla-viewer' || source.version !== '3.61.0') {
  throw new Error('Unexpected PPTX editor package or version.')
}
if (source.repository !== 'https://github.com/ChristopherVR/ooxml') {
  throw new Error('PPTX editor source must use the canonical upstream repository.')
}
if (!fullSha.test(source.ref) || source.ref !== 'd8f80c291c1f9ecc23278c4b2ac8674915d30828') {
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
  mtx.sourceRef !== 'd818c57f494bd6ba103291a9d706def706992e5a' ||
  mtx.sourceTag !== 'v1.8.0' ||
  mtx.repository !== 'https://github.com/ChristopherVR/mtx-decompressor' ||
  mtx.npmVersion !== '1.8.0' ||
  mtx.npmIntegrity !== 'sha512-suXE376dUmLX4PPxSmVmdWvu09oeesqmlE5NfKjb6XIUpDRjF2Mn47kM8nXWRkHb3l7ac0P+Crp0J0O984imRQ==' ||
  mtx.sourceArchiveSha256 !== '983d8184fdbb9e6023c4d178f622ac10eb7d0dfb57d1c4eb44bc081021bbe761' ||
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
  'src/__fixtures__/value-edge-samples.ts': '5f3193eb342e949618ecd09d71ef30ca14dd99f0',
  'src/ahuff.test.ts': 'c63caf2920f47ee294c5745c95bf321e6e4534d9',
  'src/ahuff.ts': '2dea9353cbb29c418ccf6ab1e675d6b0622ae5ee',
  'src/bitio.fixtures.test.ts': '14f1fb95d474480092c3ea3ac2fcfc4cc62f2bb2',
  'src/bitio.test.ts': '25d7bee4df1b7df9333d3e13ee6f043e0c3015a8',
  'src/bitio.width.test.ts': '5cf2f7a4fd5af28f70df8a0a68398510a1828331',
  'src/bitio.ts': 'd864835b42838f2501bcd13630fdf94dc4e0d5fd',
  'src/ctf-parser.test.ts': 'ca4fc733da795b48d9bcd025cb6ee60803a43309',
  'src/ctf-parser.ts': 'daa4b2456e485188aaf3304df8cc5de12dca6105',
  'src/eot.test.ts': 'afb520229228ad39525729a2378caab6f2836a63',
  'src/eot.ts': '46ef21b24b2e2a283afd22f2b71f2f7ce48359cd',
  'src/errors.ts': '99420ae4996e0ef54b2e6360c25bcdb2d17b1a42',
  'src/hdmx.test.ts': 'a464dd4e209e7738222bf91abc447f6265773122',
  'src/hdmx.ts': 'a71325fc7d42c5d19fefe0d829fb9ac2b72fd82b',
  'src/index.ts': '8cdeba1c14317ccbd5a06dde87641d0447b5f571',
  'src/integration.test.ts': 'c48ba37e271bc18a258d404968aa6021330b22b2',
  'src/lzcomp.test.ts': '456deab3b377a3b24e19f65962f3c64a32454105',
  'src/lzcomp.ts': 'c18cd34cf63b0701818c004204c15392b9796477',
  'src/magnitude.test.ts': 'e4154ec7bd05da678fce663a3996b64f2329a1d3',
  'src/magnitude.ts': '602a391e2019653f31fde2c2cf6f59d2a7792999',
  'src/mtx-decompress.test.ts': 'd574f76349d4b1d13ff393474a749215c7ec8625',
  'src/mtx-decompress.ts': '1724380eb996b3cfc736e609d074b3459705c145',
  'src/sfnt-builder.test.ts': 'f8a67cc40b25134ddd8cbae6f700d461d8bbb259',
  'src/sfnt-builder.ts': 'ed4ccd0269e596f71855bbdadd945143880738df',
  'src/stream.test.ts': '65118710cd32139789a2195c6ca529928913a940',
  'src/stream.ts': '85f522a06e9c9c459b64e3b937e170a06eeab102',
  'src/triplet-encodings.test.ts': '824fce5b89e605f615f18b9ec755200d04eb7031',
  'src/triplet-encodings.ts': 'c69a8ddae0c993f8f076520fcb5b9b889d2efdf1',
  'src/vdmx.test.ts': '587f9f656b4cbe5d85b9c111614fbd8b24dc1ee1',
  'src/vdmx.ts': 'b01263ddea07fb00e01b8641c4cd8b41a06d545c'
}
for (const [file, expectedBlobSha] of Object.entries(sourceFiles)) {
  const bytes = await readFile(resolve(mtxRoot, file))
  // Git blob IDs protect the vendored source against accidental edits while
  // remaining independent of filesystem timestamps and line-ending metadata.
  const blobHeader = Buffer.from(`blob ${bytes.length}\0`)
  if (sha1(Buffer.concat([blobHeader, bytes])) !== expectedBlobSha) {
    throw new Error(`Vendored MTX source does not match the pinned commit: ${file}`)
  }
}
const pinnedSourceFiles = [
  'src/__fixtures__/bit-samples.ts', 'src/__fixtures__/value-edge-samples.ts',
  'src/ahuff.test.ts', 'src/ahuff.ts', 'src/bitio.fixtures.test.ts',
  'src/bitio.test.ts', 'src/bitio.width.test.ts', 'src/bitio.ts',
  'src/ctf-parser.test.ts', 'src/ctf-parser.ts', 'src/eot.test.ts',
  'src/eot.ts', 'src/errors.ts', 'src/hdmx.test.ts', 'src/hdmx.ts',
  'src/index.ts', 'src/integration.test.ts', 'src/lzcomp.test.ts',
  'src/lzcomp.ts', 'src/magnitude.test.ts', 'src/magnitude.ts',
  'src/mtx-decompress.test.ts', 'src/mtx-decompress.ts',
  'src/sfnt-builder.test.ts', 'src/sfnt-builder.ts', 'src/stream.test.ts',
  'src/stream.ts', 'src/triplet-encodings.test.ts',
  'src/triplet-encodings.ts', 'src/vdmx.test.ts', 'src/vdmx.ts'
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
