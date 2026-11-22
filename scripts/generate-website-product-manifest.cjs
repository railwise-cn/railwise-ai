#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const { readPublicationManifest } = require('./release-publication.cjs')

function productManifest(publication, previous, mirrorVerifiedAt) {
  if (!/^[a-f0-9]{40}$/.test(publication.sourceHead)) throw new Error('Website publication requires the exact source HEAD')
  const date = publication.publishedAt || publication.files.length && previous.publishedAt
  if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Website publication requires a release date')
  if (!Number.isFinite(Date.parse(mirrorVerifiedAt))) throw new Error('Website publication requires the installer mirror verification time')
  const repositoryUrl = 'https://github.com/railwise-cn/railwise-ai'
  const platforms = publication.installers.map(file => {
    const old = previous.platforms?.find(item => item.id === file.id) || {}
    const mac = file.platform === 'mac'
    return {
      ...old, id: file.id,
      name: mac ? `macOS ${file.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}` : 'Windows x64',
      file: file.name, size: `${(file.size / 1_000_000).toFixed(1)} MB`, sizeBytes: file.size,
      url: new URL(file.url).pathname, sha256: file.sha256,
      downloadUrl: `${repositoryUrl}/releases/download/${publication.tag}/${file.name}`,
      mirrorSha256: file.sha256, mirrorVerifiedAt,
      icon: mac ? 'fab fa-apple' : 'fab fa-windows',
      description: old.description || (mac ? `适合 ${file.arch === 'arm64' ? 'M 系列' : 'Intel'}芯片的 macOS 设备。` : '适合 64 位 Windows 设备。')
    }
  })
  return { ...previous, schemaVersion: 1, name: publication.productName, shortName: publication.productName,
    version: publication.version, publishedAt: new Date(date).toISOString().slice(0, 10),
    releaseCommit: publication.sourceHead, releaseChannel: publication.channel,
    releaseUrl: `${repositoryUrl}/releases/tag/${publication.tag}`,
    repositoryUrl, platforms }
}
module.exports = { productManifest }
if (require.main === module) {
  const [publicationPath, outputPath, mirrorVerifiedAt] = process.argv.slice(2)
  if (!publicationPath || !outputPath || !mirrorVerifiedAt) throw new Error('Usage: generate-website-product-manifest.cjs PUBLICATION_JSON WEBSITE_PRODUCT_JSON MIRROR_VERIFIED_AT')
  const previous = JSON.parse(readFileSync(outputPath, 'utf8'))
  writeFileSync(outputPath, JSON.stringify(productManifest(readPublicationManifest(publicationPath), previous, mirrorVerifiedAt), null, 2) + '\n')
}
