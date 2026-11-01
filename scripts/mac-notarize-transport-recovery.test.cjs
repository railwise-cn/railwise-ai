const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { runStapler, notarizeArchive, notaryError } = require('./mac-notarize.cjs')._internals
const creds = { keyPath: '/private/test.p8', keyId: 'test-key-id', issuer: 'test-issuer' }
const id = 'a1234567-1234-1234-1234-123456789abc'
const network = 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." URL=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup'

function toolFailure(status = 68, stderr = network) {
  return Object.assign(new Error('tool failure'), { status, stderr })
}
function transient() {
  return Object.assign(notaryError('stapler-failure', 'stapler validate failed (exit 68)'), { retryableStaplerTransport: true })
}
function fixture(t, name) {
  const root = mkdtempSync(join(tmpdir(), 'railwise-stapler-retry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const archive = join(root, `${name}.zip`)
  writeFileSync(archive, 'exact frozen package bytes')
  let clock = Date.parse('2026-11-01T00:00:00Z')
  const evidencePath = join(root, 'notary.json')
  return { archive, app: join(root, `${name}.app`), evidence: () => JSON.parse(readFileSync(evidencePath)), options: {
    evidencePath, now: () => clock, wait: async ms => { clock += ms },
    settings: { uploadTimeoutMs: 100, queryTimeoutMs: 20, processingTimeoutMs: 100, pollIntervalMs: 10, staplerTimeoutMs: 30 }
  } }
}

test('classifies only observed CloudKit -1005 connection loss; generic exit 68, timeout, missing ticket, and non-Apple hosts fail immediately', () => {
  for (const [error, retryable] of [
    [toolFailure(), true], [toolFailure(68, 'Ticket is invalid'), false],
    [toolFailure(68, network.replace('api.apple-cloudkit.com', 'example.com')), false],
    [toolFailure(68, network.replace('Code=-1005', 'Code=-1001')), false],
    [toolFailure(1), false], [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), false]
  ]) {
    assert.throws(() => runStapler(['validate', 'Candidate.app'], { timeoutMs: 30, run: () => { throw error } }), failure => {
      assert.equal(failure.retryableStaplerTransport, retryable)
      return true
    })
  }
})

for (const name of ['baseline', 'target']) {
  test(`${name}: preserves failure history and same submission/bundle while recovering transient validation`, async t => {
    const f = fixture(t, name)
    const actions = []
    let validations = 0
    const result = await notarizeArchive(f.archive, f.app, creds, { ...f.options,
      run: args => { actions.push(args[0]); return { id, status: 'Accepted' } },
      staple: args => { actions.push(args[0]); assert.equal(args[1], f.app); if (args[0] === 'validate' && ++validations <= 2) throw transient() }
    })
    assert.deepEqual(actions, ['submit', 'staple', 'validate', 'validate', 'validate'])
    assert.equal(result.stapled, true)
    assert.equal(result.stapleValidated, true)
    assert.equal(result.phase, 'complete')
    assert.equal(result.submissionId, id)
    assert.equal(result.events.filter(event => event.phase === 'stapler-attempt-failed').length, 2)
    assert.equal(result.events.filter(event => event.phase === 'stapler-transport-retry').length, 2)
  })
  test(`${name}: exhausts at three transient attempts and leaves strict validation gate failed`, async t => {
    const f = fixture(t, name)
    let validations = 0
    await assert.rejects(notarizeArchive(f.archive, f.app, creds, { ...f.options,
      run: () => ({ id, status: 'Accepted' }),
      staple: args => { if (args[0] === 'validate') { validations++; throw transient() } }
    }), /validate failed/)
    const result = f.evidence()
    assert.equal(validations, 3)
    assert.equal(result.stapled, true)
    assert.equal(result.stapleValidated, false)
    assert.equal(result.phase, 'failed')
    assert.equal(result.failure.stage, 'validating-staple')
    assert.equal(result.events.filter(event => event.phase === 'stapler-attempt-failed').length, 3)
  })
}

test('genuine ticket failure is never retried or marked validated', async t => {
  const f = fixture(t, 'target')
  let validations = 0
  await assert.rejects(notarizeArchive(f.archive, f.app, creds, { ...f.options,
    run: () => ({ id, status: 'Accepted' }),
    staple: args => { if (args[0] === 'validate') { validations++; throw notaryError('stapler-failure', 'invalid ticket') } }
  }), /invalid ticket/)
  assert.equal(validations, 1)
  assert.equal(f.evidence().stapleValidated, false)
})

test('staple operation uses same bounded transport retry without resubmitting Apple archive', async t => {
  const f = fixture(t, 'target')
  const actions = []
  let staples = 0
  const result = await notarizeArchive(f.archive, f.app, creds, { ...f.options,
    run: args => { actions.push(args[0]); return { id, status: 'Accepted' } },
    staple: args => { actions.push(args[0]); if (args[0] === 'staple' && ++staples === 1) throw transient() }
  })
  assert.deepEqual(actions, ['submit', 'staple', 'staple', 'validate'])
  assert.equal(result.stapleValidated, true)
})
