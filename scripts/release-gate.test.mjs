import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { verifyReleaseApproval } from './verify-release-approval.mjs'

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url)
const workflowSource = readFileSync(workflowPath, 'utf8')
const workflow = parse(workflowSource)
const triggers = workflow.on ?? workflow['on']
const jobs = workflow.jobs ?? {}

function input(name) {
  const value = triggers?.workflow_dispatch?.inputs?.[name]
  assert.ok(value, `release.yml must declare workflow_dispatch input ${name}`)
  return value
}

test('stable release workflow cannot be triggered by pushing a version tag', () => {
  assert.ok(triggers?.workflow_dispatch, 'stable publication must be manually dispatched')
  assert.equal(triggers?.push, undefined, 'release.yml must not publish from push events')
  assert.doesNotMatch(workflowSource, /push:\s*[\s\S]{0,120}tags:\s*\n?\s*-\s*["']?v\\\*/)
})

test('stable publication requires an explicit opt-in and a review evidence path', () => {
  const publish = input('publish_release')
  assert.equal(publish.type, 'boolean')
  assert.equal(publish.default, false)

  const confirmation = input('release_confirmation')
  assert.equal(confirmation.type, 'string')
  assert.equal(confirmation.required, false, 'maintenance/candidate runs must not require a stable approval token')

  const evidence = input('release_evidence')
  assert.equal(evidence.type, 'string')
  assert.match(String(evidence.default ?? ''), /docs\/qa\/release-gates\//)

  const publishJob = jobs.publish
  assert.ok(publishJob, 'release.yml must retain an explicit publish job')
  assert.match(String(publishJob.if), /github\.event_name\s*==\s*['"]workflow_dispatch['"]/, 'publish must be dispatch-only')
  assert.match(String(publishJob.if), /github\.ref_type\s*==\s*['"]tag['"]/, 'publish must run only for a tag ref')
  assert.match(String(publishJob.if), /inputs\.publish_release\s*==\s*true/, 'publish must require publish_release=true')
  assert.match(String(publishJob.if), /release[-_]approval[-_]gate|verify[-_]release[-_]approval/, 'publish must depend on the approval/evidence gate')
  const environment = typeof publishJob.environment === 'string' ? publishJob.environment : publishJob.environment?.name
  assert.equal(environment, 'production-release', 'stable publication must use the protected production environment')
  assert.ok(Array.isArray(publishJob.needs), 'publish must declare its upstream jobs')
  assert.ok(publishJob.needs.some((name) => /release[-_]approval[-_]gate|verify[-_]release[-_]approval/.test(String(name))), 'approval gate must be an upstream publish dependency')
})

test('release workflow verifies the recorded approval evidence before side effects', () => {
  assert.ok(existsSync(new URL('./verify-release-approval.mjs', import.meta.url)), 'approval evidence verifier is required')
  assert.match(workflowSource, /scripts\/verify-release-approval\.mjs/, 'publish workflow must invoke the approval evidence verifier')

  const publish = jobs.publish
  const gateName = (publish.needs ?? []).find((name) => /release[-_]approval[-_]gate|verify[-_]release[-_]approval/.test(String(name)))
  assert.ok(gateName, 'publish must wait for a dedicated approval/evidence gate')
  const gate = jobs[gateName]
  assert.ok(gate, `approval gate job ${gateName} must exist`)
  const gateSteps = gate.steps ?? []
  const verifyIndex = gateSteps.findIndex((step) => /verify-release-approval\.mjs/.test(String(step.run ?? '')))
  assert.ok(verifyIndex >= 0, 'approval evidence must be checked in the dedicated gate job')
  assert.doesNotMatch(JSON.stringify(gate), /publish-r2|deploy-website-release|gh release/, 'approval gate must be read-only')

  const publishSteps = publish.steps ?? []
  const firstSideEffectIndex = publishSteps.findIndex((step) => /publish-r2\.mjs\s+(upload|promote)|deploy-website-release\.mjs\s+(stage|promote)|gh\s+release\s+(create|edit|upload)/.test(String(step.run ?? '')))
  assert.ok(firstSideEffectIndex >= 0, 'publish job must contain a detectable publication side effect')
  assert.ok(gateSteps.length > verifyIndex, 'approval evidence gate must complete before publish can run')
})

test('stable publication does not inherit write permission globally', () => {
  assert.equal(workflow.permissions?.contents, 'read', 'workflow-wide token must be read-only')
  assert.equal(jobs.publish.permissions?.contents, 'write', 'only the publish job may receive contents: write')
})

test('every job that can mutate stable delivery is dispatch-gated', () => {
  const mutatingJobs = Object.entries(jobs).filter(([, job]) => {
    const source = JSON.stringify(job)
    return /publish-r2|deploy-website-release|gh release/.test(source)
  })
  assert.ok(mutatingJobs.length, 'expected at least one stable delivery job')
  for (const [name, job] of mutatingJobs) {
    assert.match(String(job.if), /github\.event_name\s*==\s*['"]workflow_dispatch['"]/, `${name} must be dispatch-only`)
    assert.match(String(job.if), /confirmation|publish_release|rollback_stable_confirmation|release_approval/, `${name} must require an explicit confirmation or release opt-in`)
  }
})

test('approval verifier rejects non-tag refs and missing exact confirmation before reading evidence', () => {
  const sourceHead = 'a'.repeat(40)
  assert.throws(
    () => verifyReleaseApproval({
      tag: 'v0.5.2',
      refType: 'branch',
      sourceHead,
      confirmation: 'PUBLISH-STABLE-v0.5.2',
    }),
    /exact tag/
  )
  assert.throws(
    () => verifyReleaseApproval({
      tag: 'v0.5.2',
      refType: 'tag',
      sourceHead,
      confirmation: '',
    }),
    /release confirmation must be PUBLISH-STABLE-v0.5.2/
  )
})

test('approval verifier requires a scoped, tracked evidence manifest', () => {
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /scope !== 'public-release'/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /packageIdentity\.artifactSha256/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /requireTrackedArtifact/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /rev-list[\s\S]*sourceHead/)
})
