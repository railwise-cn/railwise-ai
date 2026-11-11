import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillRuntime } from './skill-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(name = 'autocad-image-redraw', content = 'pip install opencv-python-headless') {
  const root = await mkdtemp(join(tmpdir(), 'railwise-skill-catalog-'))
  roots.push(root)
  const directory = join(root, 'installed-skill')
  await mkdir(directory)
  const entry = `---\nname: ${name}\ndescription: Synthetic Skill fixture\n---\n${content}`
  await writeFile(join(directory, 'SKILL.md'), entry)
  return { root, directory, entry }
}

function metadata(name = 'autocad-image-redraw') {
  return {
    schemaVersion: 1,
    components: [{ type: 'skill', skillNames: [name] }],
    dependencies: [{ id: 'image-redraw-python', kind: 'package', requirement: 'opencv-python-headless==4.14.0.94', optional: false, managedBy: 'user' }],
    permissions: [{ access: 'full-access' }],
    allowedTools: ['bash']
  }
}

async function writeCatalog(directory: string, value: unknown) {
  await writeFile(join(directory, 'workwise.catalog.json'), JSON.stringify(value))
}

describe('installed Skill dependency instructions', () => {
  it('injects the reviewed OpenCV requirement even when the original entry is excerpted', async () => {
    const f = await fixture('autocad-image-redraw', `pip install opencv-python-headless\n${'upstream text '.repeat(3000)}`)
    await writeCatalog(f.directory, metadata())
    const runtime = await SkillRuntime.create({ enabled: true, roots: [f.directory], legacySkillMd: true }, { instructionBudgetBytes: 2000 })
    const result = runtime.resolveTurn({ prompt: '使用 autocad-image-redraw', workspace: f.root })
    expect(result.instructions).toHaveLength(1)
    expect(result.instructions[0]).toContain('opencv-python-headless==4.14.0.94')
    expect(result.instructions[0]).toContain('Check actual dependency availability')
    expect(result.instructions[0]).toContain('explicitly authorized task-local environment')
    expect(result.instructions[0]).toContain('[Skill excerpt truncated]')
    expect(result.instructions[0]).not.toContain('full-access')
    expect(result.allowedToolNames).toBeUndefined()
    expect(result.injectedBytes).toBeLessThanOrEqual(2000)
    expect(await readFile(join(f.directory, 'SKILL.md'), 'utf8')).toBe(f.entry)
  })

  it('keeps a manifest Skill identity and tool allowlist while adding declared requirements', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, 'skill.json'), JSON.stringify({ id: 'autocad-image-redraw', name: 'CAD image workflow', allowedTools: ['read'] }))
    await writeCatalog(f.directory, metadata())
    const runtime = await SkillRuntime.create({ enabled: true, roots: [f.directory], legacySkillMd: true })
    const result = runtime.resolveTurn({ prompt: '$autocad-image-redraw', workspace: f.root })
    expect(result.activeSkillIds).toEqual(['autocad-image-redraw'])
    expect(result.allowedToolNames).toEqual(['read'])
    expect(result.instructions[0]).toContain('opencv-python-headless==4.14.0.94')
  })

  it('uses a configured parent catalog only for its matching declared Skill', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'manual'))
    await writeFile(join(f.root, 'manual', 'SKILL.md'), '---\nname: manual\n---\nManual content')
    await writeCatalog(f.root, metadata())
    const runtime = await SkillRuntime.create({ enabled: true, roots: [f.root], legacySkillMd: true })
    expect(runtime.resolveTurn({ prompt: '$autocad-image-redraw', workspace: f.root }).instructions[0]).toContain('opencv-python-headless==4.14.0.94')
    expect(runtime.resolveTurn({ prompt: '$manual', workspace: f.root }).instructions[0]).not.toContain('Catalog dependency requirements')
  })

  it('leaves ordinary local Skills unchanged and never reads catalog metadata above the admitted root', async () => {
    const f = await fixture('manual', 'Original manual instructions')
    await writeCatalog(f.root, metadata('manual'))
    const runtime = await SkillRuntime.create({ enabled: true, roots: [f.directory], legacySkillMd: true })
    const result = runtime.resolveTurn({ prompt: '$manual', workspace: f.root })
    expect(result.instructions[0]).toContain('Original manual instructions')
    expect(result.instructions[0]).not.toContain('Catalog dependency requirements')
    expect(result.allowedToolNames).toBeUndefined()
  })

  it.each(['wrong-version', 'wrong-skill', 'too-many-dependencies', 'oversized-requirement', 'oversized-file', 'invalid-json'])(
    'preserves the Skill without injecting %s catalog metadata', async variant => {
      const f = await fixture()
      const catalog = metadata()
      if (variant === 'wrong-version') catalog.schemaVersion = 2
      if (variant === 'wrong-skill') catalog.components[0]!.skillNames = ['another-skill']
      if (variant === 'too-many-dependencies') catalog.dependencies = Array.from({ length: 17 }, () => catalog.dependencies[0]!)
      if (variant === 'oversized-requirement') catalog.dependencies[0]!.requirement = 'x'.repeat(513)
      await writeCatalog(f.directory, catalog)
      if (variant === 'oversized-file') await writeFile(join(f.directory, 'workwise.catalog.json'), ' '.repeat(256001))
      if (variant === 'invalid-json') await writeFile(join(f.directory, 'workwise.catalog.json'), '{')
      const runtime = await SkillRuntime.create({ enabled: true, roots: [f.directory], legacySkillMd: true })
      const result = runtime.resolveTurn({ prompt: '$autocad-image-redraw', workspace: f.root })
      expect(result.instructions[0]).toContain('pip install opencv-python-headless')
      expect(result.instructions[0]).not.toContain('Catalog dependency requirements')
    }
  )

  it.skipIf(process.platform === 'win32')('rejects a catalog metadata symlink outside the skill package', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside.json')
    await writeFile(outside, JSON.stringify(metadata()))
    await symlink(outside, join(f.directory, 'workwise.catalog.json'))
    const runtime = await SkillRuntime.create({ enabled: true, roots: [f.directory], legacySkillMd: true })
    expect(runtime.resolveTurn({ prompt: '$autocad-image-redraw', workspace: f.root }).instructions[0]).not.toContain('Catalog dependency requirements')
  })
})
