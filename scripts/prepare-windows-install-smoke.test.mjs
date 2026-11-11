import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'
import { validateWindowsSmokeSource } from './prepare-windows-install-smoke.mjs'
import { windowsSmokeProvenance } from './verify-windows-install-smoke.mjs'

function source() {
  return {
    repository: 'railwise-cn/railwise-ai', runId: '1234', runAttempt: 1,
    workflow: '.github/workflows/release.yml', packageSourceHead: 'a'.repeat(40), driverSourceHead: 'b'.repeat(40),
    windowsBuildConclusion: 'success', artifactId: 4567, artifactName: 'release-win',
    artifactDigest: `sha256:${'c'.repeat(64)}`, artifactExpired: false,
    changedFiles: ['scripts/run-windows-ui-smoke.mjs', 'scripts/windows-ui-smoke.test.mjs',
      '.github/workflows/windows-install-smoke.yml', '.github/workflows/release.yml', 'scripts/deploy-website-release.mjs',
      'src/renderer/src/components/connectors/ManagedLarkConnection.test.ts']
  }
}

test('existing Windows acceptance binds separate driver and package heads to the original immutable artifact', () => {
  assert.deepEqual(validateWindowsSmokeSource(source()), source())
  assert.throws(() => validateWindowsSmokeSource(source(), { packageSourceHead: 'd'.repeat(40), driverSourceHead: source().driverSourceHead }))
  assert.throws(() => validateWindowsSmokeSource(source(), { packageSourceHead: source().packageSourceHead, driverSourceHead: 'd'.repeat(40) }))
})

for (const file of ['src/renderer/src/components/HelpReader.tsx', 'kun/package.json', 'package-lock.json',
  'electron-builder.config.cjs', 'build/icon.ico', 'scripts/prepare-runtime.cjs']) {
  test(`existing artifact cannot stand in for changed application source ${file}`, () => {
    assert.throws(() => validateWindowsSmokeSource({ ...source(), changedFiles: [file] }), /application or build source changed/)
  })
}

for (const [field, value] of [['windowsBuildConclusion', 'failure'], ['artifactExpired', true],
  ['artifactName', 'release-mac'], ['artifactDigest', ''], ['workflow', '.github/workflows/other.yml']]) {
  test(`existing artifact rejects invalid ${field}`, () => {
    assert.throws(() => validateWindowsSmokeSource({ ...source(), [field]: value }))
  })
}

test('Windows provenance keeps the actual workflow SHA and requires source evidence for an older package', t => {
  const root = mkdtempSync(join(tmpdir(), 'windows-package-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'source.json')
  const original = source()
  writeFileSync(file, JSON.stringify(original))
  const environment = { GITHUB_SHA: original.driverSourceHead, GITHUB_RUN_ID: '7890', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REPOSITORY: original.repository, WORKWISE_WINDOWS_SMOKE_SOURCE_FILE: file }
  const result = windowsSmokeProvenance(original.packageSourceHead, environment)
  assert.equal(result.sourceHead, original.driverSourceHead)
  assert.equal(result.driverSourceHead, original.driverSourceHead)
  assert.equal(result.packageSourceHead, original.packageSourceHead)
  assert.equal(result.packageBuild.runId, original.runId)
  assert.throws(() => windowsSmokeProvenance(original.packageSourceHead, { ...environment, WORKWISE_WINDOWS_SMOKE_SOURCE_FILE: undefined }))
  assert.throws(() => windowsSmokeProvenance(original.packageSourceHead, { ...environment, GITHUB_REPOSITORY: 'other/repo' }))
  assert.equal(windowsSmokeProvenance(original.driverSourceHead, { ...environment, WORKWISE_WINDOWS_SMOKE_SOURCE_FILE: undefined }).sourceHead, original.driverSourceHead)
})

test('Windows acceptance workflow downloads the original artifact and performs no packaging or publication', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['package_run_id'])
  assert.deepEqual(workflow.on.workflow_call.inputs, workflow.on.workflow_dispatch.inputs)
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  const steps = workflow.jobs['windows-install'].steps
  const download = steps.find(step => step.uses === 'actions/download-artifact@v4')
  assert.equal(download.with['artifact-ids'], '${{ steps.source.outputs.artifact_id }}')
  assert.equal(download.with['run-id'], '${{ inputs.package_run_id }}')
  const commands = steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /prepare-windows-install-smoke/)
  assert.match(commands, /run-windows-install-smoke\.ps1/)
  assert.doesNotMatch(commands, /dist:|publish-r2|gh release|deploy-/)
})

test('existing Windows package routing excludes every other release action and has independent concurrency', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.existing_windows_package_run_id.default, '')
  const acceptance = workflow.jobs['existing-windows-package-acceptance']
  assert.equal(acceptance.uses, './.github/workflows/windows-install-smoke.yml')
  assert.equal(acceptance.with.package_run_id, '${{ inputs.existing_windows_package_run_id }}')
  assert.equal(acceptance.if, "${{ github.event_name == 'workflow_dispatch' && inputs.existing_windows_package_run_id != '' }}")
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'existing-windows-package-acceptance') continue
    assert.ok(job.if.endsWith(" && inputs.existing_windows_package_run_id == '' }}"), `${name} must skip during existing-package inspection`)
  }
  assert.match(workflow.concurrency.group, /inputs.existing_windows_package_run_id != '' && format\('windows-package-\{0\}', github.run_id\)/)
})
