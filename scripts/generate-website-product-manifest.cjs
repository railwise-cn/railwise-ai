#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const { readPublicationManifest } = require('./release-publication.cjs')

function productManifest(publication, previous = {}) {
  if (!/^[a-f0-9]{40}$/.test(publication.sourceHead)) throw new Error('Website publication requires the exact source HEAD')
  const date = publication.publishedAt || publication.files.length && previous.publishedAt
  if (!date || !Number.isFinite(Date.parse(date))) throw new Error('Website publication requires a release date')
  const platforms = publication.installers.map(file => {
    const old = previous.platforms?.find(item => item.id === file.id) || {}
    const mac = file.platform === 'mac'
    return {
      ...old, id: file.id,
      name: mac ? `macOS ${file.arch === 'arm64' ? 'Apple Silicon' : 'Intel'}` : 'Windows x64',
      file: file.name, size: `${(file.size / 1024 / 1024).toFixed(1)} MB`,
      url: new URL(file.url).pathname, sha256: file.sha256,
      icon: mac ? 'fab fa-apple' : 'fab fa-windows',
      description: old.description || (mac ? `适合 ${file.arch === 'arm64' ? 'M 系列' : 'Intel'}芯片的 macOS 设备。` : '适合 64 位 Windows 设备。')
    }
  })
  return { ...previous, schemaVersion: 1, name: publication.productName, shortName: publication.productName,
    version: publication.version, publishedAt: new Date(date).toISOString().slice(0, 10),
    releaseCommit: publication.sourceHead, releaseChannel: publication.channel,
    releaseUrl: `https://github.com/railwise-cn/railwise-ai/releases/tag/${publication.tag}`,
    repositoryUrl: 'https://github.com/railwise-cn/railwise-ai', platforms }
}
module.exports = { productManifest }
if (require.main === module) {
  const [publicationPath, outputPath] = process.argv.slice(2)
  if (!publicationPath || !outputPath) throw new Error('Usage: generate-website-product-manifest.cjs PUBLICATION_JSON WEBSITE_PRODUCT_JSON')
  const previous = JSON.parse(readFileSync(outputPath, 'utf8'))
  writeFileSync(outputPath, JSON.stringify(productManifest(readPublicationManifest(publicationPath), previous), null, 2) + '\n')
}
