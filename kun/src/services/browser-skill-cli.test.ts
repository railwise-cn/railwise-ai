import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { browserCommandDiagnostics, runBrowserCommand } from './browser-skill-cli.js'

it('retains only typed vendor reason/effect scalars from the real CLI error JSON envelope', async () => {
  const executableHash = createHash('sha256').update(await readFile(process.execPath)).digest('hex')
  const output = { code: 'permission_denied', message: 'Synthetic page detail must not become a diagnostic scalar',
    data: { reason: 'cooperation_sync_required', effect_state: 'none', recovery: 'Untrusted data' } }
  const result = await runBrowserCommand({ executablePath: process.execPath, executableHash },
    ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(1)`, '--'])
  expect(result).toMatchObject({ ok: false, code: 'permission_denied', vendorReason: 'cooperation_sync_required', effectState: 'none', outcomeUnknown: false })
  expect(browserCommandDiagnostics(result)).toEqual({ vendorReason: 'cooperation_sync_required', effectState: 'none' })
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
  expect(diagnostic).toEqual({ vendorReason: 'cooperation_sync_required', effectState: 'unknown', vendorFailureKind: 'observed_content_changed' })
  expect(JSON.stringify(diagnostic)).not.toContain('Untrusted page detail')
  expect(browserCommandDiagnostics({ ok: false, output: { message: output.message + '\nprivate page value' } })).toEqual({})
  expect(browserCommandDiagnostics({ ok: false, output: { message: 'constructor' } })).toEqual({})
})
