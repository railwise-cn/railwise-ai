import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { validateStapleWithTransportRetry } from './run-private-macos-updater-acceptance.mjs'
const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." URL=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup'

test('captures both streams, retries only same-bundle observed Apple transport loss and preserves failed attempts', () => {
  const events = [], actions = [], delays = []
  const app = '/private/runner/baseline/Candidate.app'
  validateStapleWithTransportRetry(app, event => events.push(event), {
    run(command, args) {
      actions.push({ command, args })
      return actions.length === 3 ? { status: 0 } : { status: 68, stdout: network, stderr: 'diagnostic on stderr' }
    }, wait: ms => delays.push(ms)
  })
  assert.equal(actions.length, 3)
  for (const action of actions) assert.deepEqual(action, { command: '/usr/bin/xcrun', args: ['stapler', 'validate', app] })
  assert.deepEqual(delays, [2000, 4000])
  assert.equal(events.filter(event => event.operation === 'stapler-validation' && event.status === 'failed').length, 2)
  assert.ok(events.some(event => event.diagnostic?.includes('diagnostic on stderr')))
  assert.equal(events.at(-1).status, 'completed')
})

test('never masks invalid tickets, unknown exit68, nonApple hosts or exhausted transient validation', () => {
  for (const diagnostic of ['Ticket is invalid', network.replace('api.apple-cloudkit.com', 'example.com'), network.replace('Code=-1005', 'Code=-1001'), network]) {
    let attempts = 0
    assert.throws(() => validateStapleWithTransportRetry('/private/runner/target/Candidate.app', () => {}, {
      run() { attempts++; return { status: 68, stdout: diagnostic } }, wait() {}
    }), /stapler validation failed/)
    assert.equal(attempts, diagnostic === network ? 3 : 1)
  }
})

test('retained diagnostics redact credentials while preserving network classifier facts', () => {
  const previous = process.env.TEST_RECOVERY_API_KEY
  process.env.TEST_RECOVERY_API_KEY = 'TEST-CREDENTIAL-NOT-FOR-LOGS'
  try {
    const events = []
    assert.throws(() => validateStapleWithTransportRetry('/private/runner/Candidate.app', event => events.push(event), {
      run: () => ({ status: 68, stdout: 'invalid ticket TEST-CREDENTIAL-NOT-FOR-LOGS', stderr: 'authorization: Bearer abcsecret' })
    }))
    const text = JSON.stringify(events)
    assert.ok(!text.includes('TEST-CREDENTIAL-NOT-FOR-LOGS'))
    assert.ok(!text.includes('abcsecret'))
    assert.ok(text.includes('[redacted]'))
  } finally {
    if (previous === undefined) delete process.env.TEST_RECOVERY_API_KEY
    else process.env.TEST_RECOVERY_API_KEY = previous
  }
})

test('recovery workflow pins immutable db75 product and authenticated target, external hook and baseline retention before probe', () => {
  const raw = readFileSync(new URL('../.github/workflows/private-updater-acceptance.yml', import.meta.url), 'utf8')
  const workflow = parse(raw)
  const job = workflow.jobs['native-macos']
  const steps = job.steps
  assert.equal(job.env.PRODUCT_SOURCE_HEAD, 'db75a1fd2f48c6ba6878c81b67daec5191929362')
  const checkout = steps.find(step => step.name === 'Check out immutable product source separately')
  assert.equal(checkout.with.ref, job.env.PRODUCT_SOURCE_HEAD)
  const download = steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(download.with['artifact-ids'], '13083680905')
  assert.equal(download.with['run-id'], '41302196344')
  const verify = steps.find(step => step.name === 'Verify retained target and separate helper provenance')
  assert.ok(verify.run.includes('actual !== process.env.RETAINED_TARGET_ZIP_SHA256'))
  const sign = steps.find(step => step.id === 'signed')
  assert.equal(sign['working-directory'], 'product-source')
  assert.ok(sign.run.includes('--config.afterSign="${GITHUB_WORKSPACE}/scripts/mac-notarize.cjs"'))
  assert.ok(sign.run.includes('test -z "$(git status --porcelain=v1 --untracked-files=all)"'))
  const retainedIndex = steps.findIndex(step => step.name === 'Retain authenticated baseline before native probe')
  assert.ok(retainedIndex < steps.findIndex(step => step.name === 'Exercise actual private HTTPS download and Squirrel relaunch'))
  assert.ok(!raw.includes('--publish always'))
  assert.ok(!raw.includes('stable/latest'))
})
