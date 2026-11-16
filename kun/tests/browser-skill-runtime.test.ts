import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

describe('BrowserSkill production Runtime admission and Skill reload', () => {
  it('persists a missing-connector task before any Turn and acknowledges new Skill roots in the same Runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-production-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const configPath = join(root, 'config.json')
    const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), configPath,
      runtimeToken: 'synthetic', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'synthetic', endpointFormat: 'chat_completions',
      approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false,
      storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ skills: { enabled: true, roots: [], revision: 0 } }) })
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'synthetic' })
    const blocked = await runtime.taskCoordinator!.command({ threadId: origin.id, idempotencyKey: 'browser-first', request: { prompt: '用浏览器读取 https://example.com 的网页' } })
    expect(blocked).toMatchObject({ kind: 'capability_required', capability: { provider: 'browser-skill', status: 'not_installed' }, task: { status: 'waiting_user', attempts: 0 } })
    expect((await runtime.threadService.get(blocked.task!.threadId))?.turns).toHaveLength(0)
    expect(runtime.taskRepository!.inputs(blocked.task!.id)[0]?.text).toContain('https://example.com')
    const skill = join(root, 'immutable-skill')
    await mkdir(skill)
    await writeFile(join(skill, 'SKILL.md'), '---\nname: browser-skill\ndescription: Chromium browser automation.\n---\nSynthetic Skill installation fixture.\n')
    await writeFile(configPath, JSON.stringify({ capabilities: { skills: { enabled: true, roots: [skill], managedRoots: [skill], revision: 1 } } }))
    expect(await runtime.refreshSkills?.()).toMatchObject({ roots: [skill], skills: [{ name: 'browser-skill' }] })
    expect((await runtime.skills?.())?.skills.map(item => item.name)).toContain('browser-skill')
    await writeFile(configPath, JSON.stringify({ capabilities: { skills: { enabled: true, roots: [], managedRoots: [], revision: 2 } } }))
    expect(await runtime.refreshSkills?.()).toMatchObject({ roots: [], skills: [] })
  })
})
