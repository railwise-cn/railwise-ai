import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { hashFile } from './frozen-release-updater-feed.mjs'
import publication from './release-publication.cjs'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW, githubApi } from './verify-reviewed-release-artifacts.mjs'

export const MAC_UPDATER_QA_REF = 'refs/heads/codex/qa-mac-native-updater-reuse-0510'
const QA_WORKFLOW = '.github/workflows/windows-install-smoke.yml'
const QA_FILES = new Set([
  QA_WORKFLOW,
  'scripts/qa-reused-mac-updater.mjs',
  'scripts/qa-reused-mac-updater.test.mjs',
  'scripts/run-frozen-release-updater-acceptance.mjs'
])

// Release asset metadata from railwise-cn/railwise-ai. Existing release pins are independent.
export const QA_MAC_BASELINES = {
  schemaVersion: 1,
  versions: {
    '0.5.7': {
      'darwin-arm64': {
        name: 'RailWise-AI-0.5.7-mac-Apple-Silicon.dmg', assetId: 761311661, size: 397543513,
        sha256: '8b235bb9601e8b89eed1ad0f35b6acf0012cde16d6d607726ba95c302a90ef9f'
      },
      'darwin-x64': {
        name: 'RailWise-AI-0.5.7-mac-Intel.dmg', assetId: 761311658, size: 406488491,
        sha256: 'da99ebfb4a21594e0ce161736f8e13eaa66bc68c25c6000bbb9471d5653660bf'
      }
    },
    '0.5.9': {
      'darwin-arm64': {
        name: 'RailWise-AI-0.5.9-mac-Apple-Silicon.dmg', assetId: 767598133, size: 402395197,
        sha256: '0fb309df7c4f73fe74fa0e7b96d5bfc437a0f2c4e6f6023c2a15e4ac96324c66'
      },
      'darwin-x64': {
        name: 'RailWise-AI-0.5.9-mac-Intel.dmg', assetId: 767598138, size: 411136357,
        sha256: '0f2d5c787d05596a3e7b5296a5ffa1a5276ad2ba7ed0c1bcf387b65738e03ce2'
      }
    }
  }
}

const isHead = value => /^[a-f0-9]{40}$/.test(String(value ?? ''))
const isId = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value))
const requireMatch = (condition, message) => { if (!condition) throw new Error(message) }

export function readQaMacReuseInput({ plan, runId, env = process.env }) {
  const match = /^((?:0\.5\.7)|(?:0\.5\.9)):([a-f0-9]{40})$/.exec(plan ?? '')
  requireMatch(match && isId(runId), 'QA Mac upgrade needs a package run ID and 0.5.7 or 0.5.9 followed by the exact target SHA.')
  requireMatch(env.GITHUB_REPOSITORY === RELEASE_REPOSITORY
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_JOB === 'exact-mac-native-updater'
    && env.GITHUB_REF === MAC_UPDATER_QA_REF
    && env.GITHUB_WORKFLOW_REF === RELEASE_REPOSITORY + '/' + QA_WORKFLOW + '@' + MAC_UPDATER_QA_REF
    && isHead(env.GITHUB_SHA) && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA,
  'Exact package reuse requires the authorized Mac QA workflow and review branch.')
  return { baseline: match[1], targetHead: match[2], runId: Number(runId), driverHead: env.GITHUB_SHA }
}

export function verifyQaMacArtifact(input, run, api = githubApi) {
  const repositoryPath = 'repos/' + RELEASE_REPOSITORY
  const repo = api(repositoryPath)
  const workflow = api(repositoryPath + '/actions/workflows/release.yml')
  const sourceRun = api(repositoryPath + '/actions/runs/' + input.runId)
  requireMatch(repo.full_name === RELEASE_REPOSITORY && isId(repo.id) && workflow.path === RELEASE_WORKFLOW
    && isId(workflow.id) && sourceRun.repository?.id === repo.id && sourceRun.head_repository?.id === repo.id
    && sourceRun.path === RELEASE_WORKFLOW && sourceRun.workflow_id === workflow.id && sourceRun.id === input.runId
    && sourceRun.event === 'workflow_dispatch' && sourceRun.status === 'completed' && isId(sourceRun.run_attempt)
    && sourceRun.head_sha === input.targetHead,
  'Release package run did not match the trusted repository, workflow, or exact target source.')
  const jobs = api(repositoryPath + '/actions/runs/' + input.runId + '/attempts/' + sourceRun.run_attempt + '/jobs?per_page=100').jobs
  const matches = (name, conclusion) => jobs.filter(job => job.name === name).length === 1
    && jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === conclusion)
  const build = jobs.find(job => job.name === 'Build macOS')
  requireMatch(matches('Build macOS', 'success') && matches('Publish GitHub Release', 'skipped')
    && ['Build signed macOS packages', 'Verify final signed macOS artifacts', 'Upload macOS installers'].every(name =>
      build?.steps?.some(step => step.name === name && step.status === 'completed' && step.conclusion === 'success')),
  'The exact run must contain a verified signed macOS build and skipped publication.')

  let packageMode
  if (sourceRun.conclusion === 'success' && matches('Verify three-client candidate', 'success')) {
    packageMode = 'candidate'
  } else if (matches('Prepare release version', 'success') && matches('Build Windows', 'success')
    && matches('Verify three-client candidate', 'skipped') && matches('Private exact-package Windows install smoke', 'success')
    && (sourceRun.conclusion === 'success' && matches('Private exact-package updater smoke', 'success')
      || sourceRun.conclusion === 'failure' && matches('Private exact-package updater smoke', 'failure')
      && jobs.every(job => job.name === 'Private exact-package updater smoke' || ['success', 'skipped'].includes(job.conclusion)))) {
    // The retry is the private Mac smoke, so this job may be the sole failure of the source run.
    packageMode = 'private-stable'
  }
  requireMatch(packageMode, 'The run must be a completed candidate or a private Stable build with its Windows install smoke completed.')
  const artifacts = api(repositoryPath + '/actions/runs/' + input.runId + '/artifacts?per_page=100').artifacts
  const candidates = artifacts.filter(asset => asset.name === 'release-mac' && !asset.expired)
  const [artifact] = candidates
  requireMatch(candidates.length === 1 && isId(artifact.id)
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    && artifact.workflow_run?.id === input.runId && artifact.workflow_run?.head_sha === input.targetHead
    && artifact.workflow_run?.repository_id === repo.id && artifact.workflow_run?.head_repository_id === repo.id,
  'Expected one immutable macOS release artifact tied to the reviewed run.')
  requireMatch(run('git', ['rev-parse', 'HEAD']).stdout.trim() === input.driverHead, 'QA driver checkout changed.')
  run('git', ['merge-base', '--is-ancestor', input.targetHead, input.driverHead])
  const changed = run('git', ['diff', '--name-only', input.targetHead, input.driverHead]).stdout.trim().split('\n').filter(Boolean)
  requireMatch(changed.every(file => QA_FILES.has(file)), 'Differences between target and driver must be limited to the QA workflow.')
  return { ...input, repository: RELEASE_REPOSITORY, runAttempt: sourceRun.run_attempt, packageMode,
    artifact: { id: artifact.id, digest: artifact.digest, name: artifact.name }, scope: 'qa-only' }
}

export function verifyQaMacArchiveEntries(names, version, packageMode) {
  const expected = publication.expectedReleaseFiles(version).filter(file => file.artifact === 'release-mac').map(file => file.name)
  requireMatch(['candidate', 'private-stable'].includes(packageMode), 'Missing admitted Mac package mode.')
  const frozen = names.includes('reviewed-build.json')
  requireMatch(!frozen || packageMode === 'candidate', 'A private Stable archive must not contain a candidate build receipt.')
  if (frozen) expected.push('reviewed-build.json')
  requireMatch(names.length === expected.length && expected.every(name => names.includes(name)),
    'Mac artifact archive contains an unexpected package entry set.')
  return frozen || packageMode === 'private-stable' ? 'stable' : 'qa-frontier'
}

export async function downloadQaMacArtifact(reference, root, version, run) {
  const archive = join(root, 'qa-release-mac.zip')
  const fd = openSync(archive, 'wx', 0o600)
  try {
    run('gh', ['api', '--hostname', 'github.com', 'repos/' + RELEASE_REPOSITORY + '/actions/artifacts/' + reference.artifact.id + '/zip'],
      { stdio: ['ignore', fd, 'pipe'], timeoutMs: 15 * 60_000 })
  } finally {
    closeSync(fd)
  }
  requireMatch('sha256:' + await hashFile(archive) === reference.artifact.digest, 'Immutable Mac artifact archive digest mismatch.')
  const names = run('/usr/bin/unzip', ['-Z1', archive]).stdout.trim().split(/\r?\n/)
  const updaterMode = verifyQaMacArchiveEntries(names, version, reference.packageMode)
  const directory = join(root, 'qa-exact-mac')
  mkdirSync(directory)
  run('/usr/bin/ditto', ['-x', '-k', archive, directory])
  return { directory, updaterMode }
}
