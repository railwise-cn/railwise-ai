import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OPTIONAL_ENGINEERING_SKILLS, isApprovedUpstreamPackage } from '../../shared/engineering-marketplace'
import { evaluateMarketplaceLicense } from '../../shared/marketplace'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { installBundledSkill } from './skill-service'
import { validateSkillPackage, BUNDLED_SKILL_LIMITS } from './skill-package-security'

describe('engineering marketplace additions', () => {
  it('allows only the exact upstream Zotero artifact without broadening license policy', () => {
    const item = getOfficialMarketplaceCatalog().find(item => item.id === 'zotero-mcp')!
    expect(evaluateMarketplaceLicense(item.license).disposition).toBe('rejected')
    expect(isApprovedUpstreamPackage(item)).toBe(true)
    for (const altered of [
      { ...item, id: 'another-package' }, { ...item, version: '0.18.0' },
      { ...item, source: { ...item.source, digest: { algorithm: 'sha256', value: 'a'.repeat(64) } } },
      { ...item, components: [...item.components, item.components[0]] }
    ]) expect(isApprovedUpstreamPackage(altered as typeof item)).toBe(false)
  })

  it.each(OPTIONAL_ENGINEERING_SKILLS)('installs optional $id with its intact sample into the isolated tools root', async skill => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-optional-skill-'))
    vi.stubEnv('WORKWISE_TOOLS_ROOT', root)
    try {
      const entry = getOfficialMarketplaceCatalog().find(item => item.id === skill.id)!
      expect(entry.installation.installedByDefault).toBe(false)
      const source = resolve('src/asset/optional-skills', skill.id)
      await validateSkillPackage(source, BUNDLED_SKILL_LIMITS)
      const sample = JSON.parse(await readFile(join(source, 'samples/case.json'), 'utf8')) as { inputs: string[]; expected: Record<string, unknown> }
      expect(sample.inputs.length).toBeGreaterThan(0)
      for (const input of sample.inputs) expect((await readFile(join(source, 'samples', input))).length).toBeGreaterThan(0)
      expect(Object.keys(sample.expected).length).toBeGreaterThan(1)
      expect(await installBundledSkill('railwise:global-skills', { id: skill.id })).toMatchObject({ ok: true, path: join(root, 'skills', skill.id, 'SKILL.md') })
      expect(await readFile(join(root, 'skills', skill.id, 'samples/case.json'), 'utf8')).toBe(await readFile(join(source, 'samples/case.json'), 'utf8'))
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  })
})
