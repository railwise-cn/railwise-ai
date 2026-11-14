import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { browserCommandDiagnostics, runBrowserCommand, supportsBrowserTargetPolicy, supportsBrowserNativeRead } from './browser-skill-cli.js'

it('retains only typed vendor reason/effect scalars from the real CLI error JSON envelope', async () => {
  const executableHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  const output = { code: 'permission_denied', message: 'Synthetic page detail must not become a diagnostic scalar',
    data: { reason: 'cooperation_sync_required', effect_state: 'none', recovery: 'Untrusted data' } }
  const result = await runBrowserCommand({ executablePath: process.execPath, executableHash },
    ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(1)`, '--'])
  expect(result).toMatchObject({ ok: false, code: 'permission_denied', vendorReason: 'cooperation_sync_required', effectState: 'none', outcomeUnknown: false })
  expect(browserCommandDiagnostics(result)).toEqual({ vendorCode: 'permission_denied', vendorReason: 'cooperation_sync_required', effectState: 'none' })
  expect(browserCommandDiagnostics({ ok: false, output: { data: { reason: 'arbitrary page text', effect_state: 'success' } } })).toEqual({})
})

it('classifies the fixed content-change refusal without persisting raw page messages or changing unknown outcomes', async () => {
  const executableHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  const output = { code: 'permission_denied', message: "The action's observed content changed; synchronize and replan",
    data: { reason: 'cooperation_sync_required', effect_state: 'unknown', recovery: 'Untrusted page detail' } }
  const result = await runBrowserCommand({ executablePath: process.execPath, executableHash },
    ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(1)`, '--'])
  expect(result).toMatchObject({ ok: false, code: 'permission_denied', effectState: 'unknown', vendorFailureKind: 'observed_content_changed' })
  const diagnostic = browserCommandDiagnostics(result)
  expect(diagnostic).toEqual({ vendorCode: 'permission_denied', vendorReason: 'cooperation_sync_required', effectState: 'unknown', vendorFailureKind: 'observed_content_changed' })
  expect(JSON.stringify(diagnostic)).not.toContain('Untrusted page detail')
  expect(browserCommandDiagnostics({ ok: false, output: { message: output.message + '\nprivate page value' } })).toEqual({})
  expect(browserCommandDiagnostics({ ok: false, output: { message: 'constructor' } })).toEqual({})
})


it('requires the official target-policy CLI and both protocol peers before advertising public target control', () => {
  expect(supportsBrowserTargetPolicy('0.5.0', '1.9', '1.8')).toBe(true)
  for (const args of [['0.4.0', '1.9', '1.9'], ['0.5.0', '1.7', '1.9'], ['0.5.0', '1.9', '1.7'], ['0.5.0', '2.0', '1.9'], [undefined, '1.9', '1.9']]) {
    expect(supportsBrowserTargetPolicy(...args)).toBe(false)
  }
})

it('requires both live protocol 1.9 peers for native read while preserving bare target policy 1.8', () => {
  expect(supportsBrowserNativeRead('0.5.0', '1.9', '1.10')).toBe(true)
  for (const args of [['0.4.0', '1.9', '1.9'], ['0.5.0', '1.8', '1.9'], ['0.5.0', '1.9', '1.8'], ['0.5.0', '2.0', '1.9'], ['0.5.0', undefined, '1.9']]) expect(supportsBrowserNativeRead(...args)).toBe(false)
  expect(supportsBrowserTargetPolicy('0.5.0', '1.8', '1.8')).toBe(true)
})

it('preserves official dispatch proof scalars without downgrading the vendor unknown effect', async () => {
  const executableHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  const output = { code: 'permission_denied', data: { reason: 'target_covered', effect_state: 'unknown', phase: 'preparation',
    press_sent: false, dispatched: false, operation_id: 'op-test:123', recovery: 'untrusted page detail' } }
  const result = await runBrowserCommand({ executablePath: process.execPath, executableHash },
    ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(1)`, '--'])
  expect(result).toMatchObject({ ok: false, outcomeUnknown: false, effectState: 'unknown', vendorPressSent: false, vendorDispatched: false,
    vendorPhase: 'preparation', vendorOperationId: 'op-test:123' })
  expect(browserCommandDiagnostics(result)).toEqual({ vendorCode: 'permission_denied', vendorReason: 'target_covered', effectState: 'unknown',
    vendorPressSent: false, vendorDispatched: false, vendorPhase: 'preparation', vendorOperationId: 'op-test:123' })
  expect(browserCommandDiagnostics({ ok: false, output: { data: { press_sent: 'false', dispatched: 0, phase: 'page secret', operation_id: 'secret value' } } })).toEqual({})
  expect(browserCommandDiagnostics({ ok: false, output: { data: { press_sent: true, dispatched: true } } })).toEqual({ vendorPressSent: true, vendorDispatched: true })
})
