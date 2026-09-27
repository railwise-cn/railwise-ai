#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { appendFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const PRODUCT_NAME = 'RailWise AI'
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const SEMVER_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

function parseSemverTag(tag) {
  const value = String(tag || '').trim()
  const match = value.match(SEMVER_TAG)
  if (!match) return null

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)
  return {
    tag: value,
    version: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch
  }
}

function parseSemverVersion(version) {
  const value = String(version || '').trim()
  const match = value.match(SEMVER_VERSION)
  if (!match) {
    throw new Error(`package.json version must be x.y.z when no release tags exist, got: ${version}`)
  }

  return {
    version: value,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10)
  }
}

function compareSemver(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function newestSemverTag(tags) {
  const parsed = unique(tags)
    .map(parseSemverTag)
    .filter(Boolean)
    .sort(compareSemver)
  return parsed[parsed.length - 1] || null
}

function previousSemverTag(tags, selectedTag) {
  return newestSemverTag(unique(tags).filter((tag) => tag !== selectedTag))
}

function computeReleaseVersion({ allTags = [], headTags = [], packageVersion }) {
  const existingHeadTag = newestSemverTag(headTags)
  if (existingHeadTag) {
    const previous = previousSemverTag(allTags, existingHeadTag.tag)
    return {
      version: existingHeadTag.version,
      tag: existingHeadTag.tag,
      releaseName: `${PRODUCT_NAME} ${existingHeadTag.version}`,
      previousTag: previous?.tag || '',
      existingTag: true
    }
  }

  const latest = newestSemverTag(allTags)
  const base = latest || parseSemverVersion(packageVersion)
  const version = `${base.major}.${base.minor}.${base.patch + 1}`
  return {
    version,
    tag: `v${version}`,
    releaseName: `${PRODUCT_NAME} ${version}`,
    previousTag: latest?.tag || '',
    existingTag: false
  }
}

function computeCandidateVersion({ allTags = [], packageVersion }) {
  const candidate = parseSemverVersion(packageVersion)
  const previous = newestSemverTag(allTags)
  return {
    version: candidate.version,
    tag: `v${candidate.version}`,
    releaseName: `${PRODUCT_NAME} ${candidate.version} Candidate`,
    previousTag: previous?.tag || '',
    existingTag: false
  }
}

function gitLines(args) {
  const output = execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
  return output ? output.split(/\r?\n/).filter(Boolean) : []
}

function fetchTags() {
  try {
    execFileSync('git', ['fetch', '--force', '--tags', 'origin', 'refs/tags/*:refs/tags/*'], {
      cwd: ROOT,
      stdio: 'inherit'
    })
  } catch {
    execFileSync('git', ['fetch', '--force', '--tags', 'origin'], {
      cwd: ROOT,
      stdio: 'inherit'
    })
  }
}

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return pkg.version
}

function writeGitHubOutputs(result) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return

  appendFileSync(
    outputPath,
    [
      `version=${result.version}`,
      `tag=${result.tag}`,
      `release_name=${result.releaseName}`,
      `previous_tag=${result.previousTag}`,
      `existing_tag=${result.existingTag ? 'true' : 'false'}`
    ].join('\n') + '\n',
    'utf8'
  )
}

function main() {
  const noFetch = process.argv.includes('--no-fetch') || process.env.CI_RELEASE_NO_FETCH === '1'
  const candidateOnly = process.argv.includes('--candidate')
  if (!noFetch) fetchTags()

  const input = {
    allTags: gitLines(['tag', '--list', 'v*']),
    headTags: gitLines(['tag', '--points-at', 'HEAD', '--list', 'v*']),
    packageVersion: readPackageVersion()
  }
  const result = candidateOnly ? computeCandidateVersion(input) : computeReleaseVersion(input)

  writeGitHubOutputs(result)
  console.log(JSON.stringify(result, null, 2))
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[compute-ci-release-version] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  computeCandidateVersion,
  computeReleaseVersion,
  newestSemverTag,
  parseSemverTag
}
