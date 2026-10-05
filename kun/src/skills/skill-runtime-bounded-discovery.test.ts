import { readdir, readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillRuntime } from './skill-runtime.js'

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), readFile: vi.fn(), stat: vi.fn() }))

const files = new Map<string, string>()
const config = { enabled: true, roots: ['/skills/first', '/skills/second'], legacySkillMd: true }

function addSkill(root: string, name: string, instruction = `${name} instructions`) {
  files.set(`${root}/SKILL.md`, `---\nname: ${name}\n---\n${instruction}`)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  files.clear()
  vi.mocked(stat).mockImplementation(async (path) => {
    if (!files.has(String(path))) throw new Error('missing file')
    return {} as Awaited<ReturnType<typeof stat>>
  })
  vi.mocked(readdir).mockResolvedValue([])
  vi.mocked(readFile).mockImplementation(async (path) => {
    const content = files.get(String(path))
    if (content === undefined) throw new Error('missing file')
    return content
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('bounded optional skill discovery', () => {
  it('returns loaded skills when a later root never settles, without repeating pending reads on refresh', async () => {
    addSkill(config.roots[0]!, 'first')
    vi.mocked(readdir).mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise(() => {}))
    const pending = SkillRuntime.create(config, { discoveryWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const runtime = await pending
    expect(runtime.diagnostics().roots).toEqual(config.roots)
    expect(runtime.diagnostics().skills.map((skill) => skill.id)).toEqual(['first'])
    expect(vi.mocked(readdir)).toHaveBeenCalledTimes(2)

    await Promise.all(Array.from({ length: 20 }, () => runtime.refresh()))
    await vi.advanceTimersByTimeAsync(20_000)
    await runtime.refresh()
    expect(vi.mocked(readdir)).toHaveBeenCalledTimes(2)
    expect(runtime.count()).toBe(1)
    expect(vi.mocked(console.info).mock.calls.filter(([text]) => String(text).includes('continuing in background'))).toHaveLength(1)
  })

  it('automatically commits late discovery results after startup has continued', async () => {
    addSkill(config.roots[0]!, 'first')
    addSkill(config.roots[1]!, 'second')
    let complete!: (value: []) => void
    vi.mocked(readdir).mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const pending = SkillRuntime.create(config, { discoveryWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const runtime = await pending
    expect(runtime.count()).toBe(1)
    complete([])
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.diagnostics().skills.map((skill) => skill.id)).toEqual(['first', 'second'])
    expect(runtime.resolveTurn({ prompt: '$second', workspace: '/test' }).instructions.join('\n')).toContain('second instructions')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the usable catalog during a blocked refresh and replaces it when the same scan completes', async () => {
    const firstOnly = { ...config, roots: [config.roots[0]!] }
    addSkill(firstOnly.roots[0]!, 'first', 'original instructions')
    const runtime = await SkillRuntime.create(firstOnly, { discoveryWaitMs: 100 })
    addSkill(firstOnly.roots[0]!, 'first', 'updated instructions')
    let complete!: (value: []) => void
    vi.mocked(readdir).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const refresh = runtime.refresh()
    await vi.advanceTimersByTimeAsync(100)
    await refresh
    await runtime.refresh()
    expect(runtime.resolveTurn({ prompt: '$first', workspace: '/test' }).instructions.join('\n')).toContain('original instructions')
    expect(vi.mocked(readdir)).toHaveBeenCalledTimes(2)
    complete([])
    await vi.advanceTimersByTimeAsync(0)
    const instructions = runtime.resolveTurn({ prompt: '$first', workspace: '/test' }).instructions.join('\n')
    expect(instructions).toContain('updated instructions')
    expect(instructions).not.toContain('original instructions')
  })

  it('retains skills on a failed root read and permits a subsequent successful recovery', async () => {
    const firstOnly = { ...config, roots: [config.roots[0]!] }
    addSkill(firstOnly.roots[0]!, 'first', 'original instructions')
    const runtime = await SkillRuntime.create(firstOnly)
    vi.mocked(readdir).mockRejectedValueOnce(new Error('temporarily unavailable'))
    await runtime.refresh()
    expect(runtime.count()).toBe(1)
    expect(runtime.diagnostics().validationErrors).toEqual([{ root: firstOnly.roots[0], message: 'temporarily unavailable' }])
    addSkill(firstOnly.roots[0]!, 'first', 'recovered instructions')
    await runtime.refresh()
    expect(runtime.diagnostics().validationErrors).toEqual([])
    expect(runtime.resolveTurn({ prompt: '$first', workspace: '/test' }).instructions.join('\n')).toContain('recovered instructions')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains the prior skill if its entry becomes unreadable', async () => {
    const firstOnly = { ...config, roots: [config.roots[0]!] }
    addSkill(firstOnly.roots[0]!, 'first', 'original instructions')
    const runtime = await SkillRuntime.create(firstOnly)
    vi.mocked(readFile).mockRejectedValueOnce(new Error('entry unavailable'))
    await runtime.refresh()
    expect(runtime.count()).toBe(1)
    expect(runtime.diagnostics().validationErrors).toEqual([{ root: firstOnly.roots[0], message: 'entry unavailable' }])
    expect(runtime.resolveTurn({ prompt: '$first', workspace: '/test' }).instructions.join('\n')).toContain('original instructions')
  })

  it('drops a queued workspace switch when the latest refresh returns to the active workspace', async () => {
    const firstOnly = { ...config, roots: [config.roots[0]!] }
    addSkill(firstOnly.roots[0]!, 'first')
    const runtime = await SkillRuntime.create(firstOnly, { discoveryWaitMs: 100 })
    const workspaceA = '/workspace-a'
    const workspaceB = '/workspace-b'
    const rootA = `${workspaceA}/.agents/skills`
    const rootB = `${workspaceB}/.agents/skills`
    files.set(rootA, '')
    files.set(rootB, '')
    addSkill(rootA, 'workspace-a')
    addSkill(rootB, 'workspace-b')
    vi.clearAllMocks()
    let complete!: (value: []) => void
    vi.mocked(readdir).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const refreshA = runtime.refresh(workspaceA)
    const refreshB = runtime.refresh(workspaceB)
    const returnToA = runtime.refresh(workspaceA)
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([refreshA, refreshB, returnToA])
    complete([])
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.diagnostics().skills.map((skill) => skill.id)).toEqual(['first', 'skills'])
    expect(runtime.diagnostics().skills.find((skill) => skill.id === 'skills')?.name).toBe('workspace-a')
    expect(vi.mocked(stat)).not.toHaveBeenCalledWith(rootB)
    expect(vi.mocked(readdir)).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
