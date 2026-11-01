import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TRUSTED_SKILL_DISCOVERY_LIMITS, validateSkillPackage } from './skill-package-security'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'workwise-skill-security-'))
  roots.push(value)
  return value
}

describe('Skill package security', () => {
  it('accepts a bounded ordinary package', async () => {
    const dir = await root()
    await writeFile(join(dir, 'SKILL.md'), '# Safe')
    await expect(validateSkillPackage(dir)).resolves.toEqual({ files: 1, totalBytes: 6 })
  })

  it('rejects links, submodules, special depth, and oversized files', async () => {
    const linked = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret'), 'x')
    await symlink(join(outside, 'secret'), join(linked, 'SKILL.md'))
    await expect(validateSkillPackage(linked)).rejects.toThrow(/links and junctions/)

    const submodule = await root()
    await writeFile(join(submodule, 'SKILL.md'), '# Safe')
    await writeFile(join(submodule, '.git'), 'gitdir: elsewhere')
    await expect(validateSkillPackage(submodule)).rejects.toThrow(/submodules/)

    const deep = await root()
    let current = deep
    for (let index = 0; index < 18; index += 1) {
      current = join(current, `d${index}`)
      await mkdir(current)
    }
    await writeFile(join(current, 'SKILL.md'), '# Deep')
    await expect(validateSkillPackage(deep)).rejects.toThrow(/depth/)

    const large = await root()
    await writeFile(join(large, 'SKILL.md'), Buffer.alloc(1024 * 1024 + 1))
    await expect(validateSkillPackage(large)).rejects.toThrow(/1 MiB/)
  })

  it('allows bounded reference assets only under the trusted discovery profile', async () => {
    const dir = await root()
    await writeFile(join(dir, 'SKILL.md'), '# Template')
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'assets', 'reference.pptx'), Buffer.alloc(2 * 1024 * 1024))

    await expect(validateSkillPackage(dir)).rejects.toThrow(/1 MiB/)
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS)).resolves.toEqual({
      files: 2,
      totalBytes: 2 * 1024 * 1024 + 10
    })
  })

  it('skips unsafe non-entry references during trusted discovery without following them', async () => {
    const dir = await root()
    const outside = await root()
    await writeFile(join(outside, 'secret'), 'do not read')
    await writeFile(join(dir, 'SKILL.md'), '# Template')
    await symlink(join(outside, 'secret'), join(dir, 'ETHOS.md'))
    await writeFile(join(dir, 'examples.webp'), Buffer.alloc(17 * 1024 * 1024))

    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS)).rejects.toThrow(/links and junctions/)
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS, {
      skipUnsafeNonEntryFiles: true
    })).resolves.toEqual({
      files: 1,
      totalBytes: 10
    })
  })

  it('only follows an entry symlink when trusted discovery explicitly allows it', async () => {
    const dir = await root()
    const outside = await root()
    await writeFile(join(outside, 'SKILL.md'), '# Outside')
    await symlink(join(outside, 'SKILL.md'), join(dir, 'SKILL.md'))
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS, {
      skipUnsafeNonEntryFiles: true
    })).rejects.toThrow(/links and junctions/)
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS, {
      skipUnsafeNonEntryFiles: true,
      allowTrustedEntryLinks: true,
      trustedEntryLinkRoots: [outside]
    })).resolves.toEqual({ files: 1, totalBytes: 9 })
    const aliasRoot = await root()
    const alias = join(aliasRoot, 'trusted-alias')
    await symlink(outside, alias)
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS, {
      allowTrustedEntryLinks: true,
      trustedEntryLinkRoots: [alias]
    })).resolves.toEqual({ files: 1, totalBytes: 9 })
    await expect(validateSkillPackage(dir, TRUSTED_SKILL_DISCOVERY_LIMITS, {
      allowTrustedEntryLinks: true,
      trustedEntryLinkRoots: [aliasRoot]
    })).rejects.toThrow(/escapes trusted roots/)
  })
})
