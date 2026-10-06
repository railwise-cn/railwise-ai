#!/usr/bin/env node

/**
 * Verify the non-build release gates before a Stable publication.
 *
 * This check deliberately lives in the repository so the workflow cannot
 * treat a successful build as release approval. It requires a committed,
 * version-bound evidence manifest and an explicit confirmation for the exact
 * tag. GitHub's protected `production-release` environment supplies the
 * independent human approval after this job passes.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'

const ROOT = process.cwd()

function fail(message) {
  throw new Error(`[release-gate] ${message}`)
}

function arg(name) {
  const prefix = `--${name}=`
  const value = process.argv.find(entry => entry.startsWith(prefix))
  return value ? value.slice(prefix.length) : ''
}

function statusOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.status === 'string') return value.status
  return ''
}

function requireStatus(value, label) {
  if (statusOf(value) !== 'passed') fail(`${label} must have status=passed`)
}

function resolveEvidencePath(input, tag) {
  const requested = input || `docs/qa/release-gates/${tag}.json`
  const expanded = requested.replaceAll('${tag}', tag).replaceAll('<tag>', tag)
  if (isAbsolute(expanded)) fail('release evidence path must be repository-relative')
  const path = resolve(ROOT, expanded)
  const rel = relative(ROOT, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('release evidence path must stay inside the repository')
  if (!rel.startsWith('docs/qa/release-gates/')) {
    fail('release evidence path must be under docs/qa/release-gates/')
  }
  return { path, relativePath: rel }
}

function requireTrackedArtifact(value, label) {
  const candidate = typeof value === 'string' ? value : value?.path
  if (!candidate || typeof candidate !== 'string') fail(`${label} must provide a repository-relative path`)
  const { path, relativePath } = resolveEvidencePath(candidate, '')
  if (!existsSync(path)) fail(`${label} file does not exist: ${relativePath}`)
  ensureTracked(relativePath)
  return relativePath
}

function ensureTracked(relativePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: ROOT, stdio: 'pipe' })
  } catch {
    fail(`release evidence must be committed and tracked by git: ${relativePath}`)
  }
}

export function verifyReleaseApproval({
  tag = process.env.GITHUB_REF_NAME || '',
  refType = process.env.GITHUB_REF_TYPE || '',
  sourceHead = process.env.GITHUB_SHA || '',
  confirmation = process.env.RELEASE_CONFIRMATION || '',
  evidence = process.env.RELEASE_EVIDENCE || '',
} = {}) {
  if (refType !== 'tag') fail(`Stable publication must run from an exact tag; ref_type=${refType || '(missing)'}`)
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag must match vX.Y.Z exactly: ${tag || '(missing)'}`)
  if (confirmation !== `PUBLISH-STABLE-${tag}`) {
    fail(`release confirmation must be PUBLISH-STABLE-${tag}`)
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceHead)) fail('GITHUB_SHA must be the 40-character commit targeted by the tag')
  let resolvedTagCommit
  try {
    resolvedTagCommit = execFileSync('git', ['rev-list', '-n', '1', tag], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch {
    fail(`release tag cannot be resolved locally: ${tag}`)
  }
  if (resolvedTagCommit !== sourceHead) {
    fail(`GITHUB_SHA ${sourceHead} does not match commit ${resolvedTagCommit} resolved from ${tag}`)
  }

  const version = tag.slice(1)
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  if (packageJson.version !== version) {
    fail(`package.json version ${packageJson.version} does not match ${tag}`)
  }

  const { path: evidencePath, relativePath } = resolveEvidencePath(evidence, tag)
  if (!existsSync(evidencePath)) fail(`release evidence file does not exist: ${relativePath}`)
  ensureTracked(relativePath)

  let manifest
  try {
    manifest = JSON.parse(readFileSync(evidencePath, 'utf8'))
  } catch (error) {
    fail(`release evidence is not valid JSON: ${error.message}`)
  }

  if (manifest.schemaVersion !== 1) fail('release evidence schemaVersion must be 1')
  if (manifest.scope !== 'public-release') fail('release evidence scope must be public-release')
  requireStatus(manifest.status, 'release evidence')

  const release = manifest.release
  if (!release || release.tag !== tag || release.version !== version || release.sourceHead !== sourceHead) {
    fail('release evidence must bind release.tag, release.version and release.sourceHead to this run')
  }

  const packageEvidence = manifest.package
  if (!packageEvidence || packageEvidence.version !== version) {
    fail('release evidence package.version must match the tagged package')
  }
  const packageIdentity = packageEvidence.identity
  if (!packageIdentity || typeof packageIdentity !== 'object' ||
      typeof packageIdentity.bundleId !== 'string' || packageIdentity.bundleId.length === 0 ||
      typeof packageIdentity.artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(packageIdentity.artifactSha256)) {
    fail('release evidence package.identity must include bundleId and a 64-character artifactSha256')
  }
  requireStatus(packageEvidence.signature, 'package.signature')
  requireStatus(packageEvidence.notarization, 'package.notarization')
  if (!Array.isArray(packageEvidence.screenshots) || packageEvidence.screenshots.length === 0) {
    fail('release evidence must list screenshots from the installed package review')
  }
  packageEvidence.screenshots.forEach((screenshot, index) => {
    requireTrackedArtifact(screenshot, `package.screenshots[${index}]`)
  })

  const acceptance = manifest.acceptance
  if (!acceptance || typeof acceptance !== 'object') fail('release evidence acceptance section is required')
  for (const key of ['functionalChecklist', 'uiComputerUse', 'updaterRoundTrip']) {
    requireStatus(acceptance[key], `acceptance.${key}`)
    requireTrackedArtifact(acceptance[key], `acceptance.${key}`)
  }
  const independentReview = acceptance.independentSeniorEngineerReview
  requireStatus(independentReview, 'acceptance.independentSeniorEngineerReview')
  const reviewerLabel = typeof independentReview === 'object'
    ? `${independentReview.reviewerType || ''} ${independentReview.reviewRole || ''}`
    : ''
  if (!/ai|agent|simulat/i.test(reviewerLabel)) {
    fail('independentSeniorEngineerReview must identify the required AI/agent senior-engineer review')
  }
  requireTrackedArtifact(independentReview, 'acceptance.independentSeniorEngineerReview')

  return { tag, version, sourceHead, evidence: relativePath }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyReleaseApproval({
      tag: process.env.GITHUB_REF_NAME || arg('tag'),
      refType: process.env.GITHUB_REF_TYPE || arg('ref-type'),
      sourceHead: process.env.GITHUB_SHA || arg('source-head'),
      confirmation: process.env.RELEASE_CONFIRMATION || arg('confirmation'),
      evidence: process.env.RELEASE_EVIDENCE || arg('evidence'),
    })
    console.log(`[release-gate] verified ${result.tag} at ${result.sourceHead} using ${result.evidence}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
