import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { mutateConfigFile } from './config-mutation.js'
import { resolvePreferredOpenClawTmpDir } from './temp-path.js'

let root
let configPath

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'railwise-config-mutation-'))
  configPath = path.join(root, 'openclaw.json')
  process.env.OPENCLAW_CONFIG_PATH = configPath
})

after(async () => {
  delete process.env.OPENCLAW_CONFIG_PATH
  await rm(root, { recursive: true, force: true })
})

test('mutates only the requested channel marker and preserves other config and credentials', async () => {
  const original = {
    models: { selected: 'deepseek' },
    credentials: { weixin: { reference: 'secret-store:key-1' } },
    channels: { 'openclaw-weixin': { accounts: { account1: { routeTag: 'existing' } } }, discord: { enabled: true } }
  }
  await writeFile(configPath, `${JSON.stringify(original)}\n`, 'utf8')

  await mutateConfigFile({
    afterWrite: { mode: 'auto' },
    mutate(draft) {
      draft.channels ??= {}
      const existing = draft.channels['openclaw-weixin'] ?? {}
      draft.channels['openclaw-weixin'] = { ...existing, channelConfigUpdatedAt: '2026-11-25T00:00:00.000Z' }
    }
  })

  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(saved.models.selected, 'deepseek')
  assert.deepEqual(saved.credentials, original.credentials)
  assert.deepEqual(saved.channels.discord, original.channels.discord)
  assert.deepEqual(saved.channels['openclaw-weixin'].accounts, original.channels['openclaw-weixin'].accounts)
  assert.equal(saved.channels['openclaw-weixin'].channelConfigUpdatedAt, '2026-11-25T00:00:00.000Z')
})

test('rejects malformed configuration without replacing the original bytes', async () => {
  const malformed = '{"channels":'
  await writeFile(configPath, malformed, 'utf8')
  await assert.rejects(mutateConfigFile({ mutate: (draft) => { draft.changed = true } }))
  assert.equal(await readFile(configPath, 'utf8'), malformed)
})

test('serializes concurrent mutations so neither update is lost', async () => {
  await writeFile(configPath, '{"channels":{"openclaw-weixin":{}}}\n', 'utf8')
  await Promise.all([
    mutateConfigFile({ mutate: (draft) => { draft.first = true } }),
    mutateConfigFile({ mutate: (draft) => { draft.second = true } })
  ])
  const saved = JSON.parse(await readFile(configPath, 'utf8'))
  assert.equal(saved.first, true)
  assert.equal(saved.second, true)
})

test('uses the configured OpenClaw temp directory and a user-scoped fallback', () => {
  process.env.OPENCLAW_TMP_DIR = path.join(root, 'custom-temp')
  assert.equal(resolvePreferredOpenClawTmpDir(), path.join(root, 'custom-temp'))
  delete process.env.OPENCLAW_TMP_DIR
  assert.equal(resolvePreferredOpenClawTmpDir(), path.join(os.tmpdir(), 'deepseek-gui-openclaw-shim'))
})
