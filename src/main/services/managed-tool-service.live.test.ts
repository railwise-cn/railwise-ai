import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  _internals,
  installManagedTool,
  managedToolsSkillRoot,
  removeManagedTool
} from './managed-tool-service'

const enabled = process.env.WORKWISE_LIVE_MANAGED_TOOL_TEST === '1'
let toolsRoot = ''

describe.runIf(enabled)('managed-tool-service official upstreams', () => {
  beforeAll(() => {
    toolsRoot = mkdtempSync(join(tmpdir(), 'workwise-live-managed-tools-'))
    process.env.WORKWISE_TOOLS_ROOT = toolsRoot
  })

  afterAll(async () => {
    for (const id of ['lark-cli', 'officecli', 'ego-browser'] as const) {
      await removeManagedTool(id).catch(() => undefined)
    }
    delete process.env.WORKWISE_TOOLS_ROOT
    rmSync(toolsRoot, { recursive: true, force: true })
  })

  it('downloads, verifies, installs, diagnoses, and removes every supported managed tool', async () => {
    const lark = await installManagedTool('lark-cli')
    if (!lark.ok) throw new Error(lark.message)
    expect(lark).toMatchObject({ ok: true, status: { id: 'lark-cli' } })
    expect(['installed', 'needs_login']).toContain(lark.status.state)
    for (const name of _internals.larkSkills) {
      expect(existsSync(join(managedToolsSkillRoot(), name, 'SKILL.md')), `${name}: ${lark.status.message ?? 'companion Skill missing'}`).toBe(true)
    }

    const office = await installManagedTool('officecli')
    if (!office.ok) throw new Error(office.message)
    expect(office).toMatchObject({
      ok: true,
      status: { id: 'officecli', state: 'installed' }
    })
    expect(existsSync(join(managedToolsSkillRoot(), 'officecli-pptx', 'SKILL.md'))).toBe(true)

    const ego = await installManagedTool('ego-browser')
    if (!ego.ok) throw new Error(ego.message)
    expect(ego).toMatchObject({ ok: true, status: { id: 'ego-browser' } })
    expect(['installed', 'needs_external_app']).toContain(ego.status.state)
    expect(existsSync(join(managedToolsSkillRoot(), 'ego-browser', 'SKILL.md'))).toBe(true)

    for (const id of ['lark-cli', 'officecli', 'ego-browser'] as const) {
      await expect(removeManagedTool(id)).resolves.toMatchObject({ ok: true })
    }
  }, 300_000)
})
