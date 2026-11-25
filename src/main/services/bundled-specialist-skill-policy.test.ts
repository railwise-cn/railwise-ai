import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const bundledRoot = resolve(process.cwd(), 'src', 'asset', 'skills')

function bundledTextFiles(root: string): Array<{ path: string; content: string }> {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name)
    const stats = statSync(path)
    if (stats.isDirectory()) return bundledTextFiles(path)
    if (stats.size > 2 * 1024 * 1024) return []
    try {
      return [{ path, content: readFileSync(path, 'utf8') }]
    } catch {
      return []
    }
  })
}

function bundledSymbolicLinks(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name)
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) return [path]
    if (stats.isDirectory()) return bundledSymbolicLinks(path)
    return []
  })
}

describe('bundled specialist Skill source policy', () => {
  it('pins the reviewed Humanizer-zh and Shuorenhua revisions with retained MIT notices', () => {
    const pins = [
      {
        id: 'humanizer-zh',
        sha: 'f4518a8eab97b8bfebc66a89d34320a89bef6930',
        version: '2026-09-23',
        files: {
          'SKILL.md': '95627fd4437d886f98032ccc62d79136e6310f1fc04e354bb86431795ff206df',
          'LICENSE': 'aa00e74769e1b9d8e7fa7094dbfcca9b129a0ded6dce1cf4da050b99146d2fa7'
        }
      },
      {
        id: 'shuorenhua',
        sha: '709acdd71ea841186b6bcd75f8f40849474ea4ba',
        version: 'v2.7.1',
        files: {
          'references/editing-guide.md': 'cdf10ae3c26d77ec0a69258af0d29179af1db3b09d4b0a3a20dee9a8e4fbb7bf',
          'references/examples.md': '5acdcb3625996727774475b943194fe669a7af18191b0ec956fcbb323975c6c1',
          'references/revision.md': '7becb59459517490cf61fb088d33827abeec685201ee7c34c7c3ccf3aabd6616',
          'LICENSE': 'd26eebf6104e9770ca097771022767da18fc07ca73a542469d2748b2e3186878'
        }
      }
    ]

    for (const pin of pins) {
      const skillRoot = resolve(bundledRoot, pin.id)
      const source = JSON.parse(readFileSync(resolve(skillRoot, '.workwise-skill-source.json'), 'utf8')) as {
        installedSha?: string
        upstreamVersion?: string
        autoUpdate?: boolean
        workwiseOverlays?: string[]
        verifiedUpstreamSha256?: Record<string, string>
      }
      expect(source).toMatchObject({
        installedSha: pin.sha,
        upstreamVersion: pin.version,
        autoUpdate: false
      })

      for (const [path, expectedHash] of Object.entries(pin.files)) {
        const actualHash = createHash('sha256').update(readFileSync(resolve(skillRoot, path))).digest('hex')
        expect(actualHash, `${pin.id}/${path}`).toBe(expectedHash)
        expect(source.verifiedUpstreamSha256?.[path], `${pin.id}/${path} provenance`)
          .toBe(expectedHash)
      }
      expect(readFileSync(resolve(skillRoot, 'LICENSE'), 'utf8')).toContain('MIT License')

      if (pin.id === 'shuorenhua') {
        expect(source.workwiseOverlays).toContain('SKILL.md')
        expect(readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8'))
          .toContain('有歧义的原文在修订稿正文中保持原样')
        expect(readFileSync(resolve(skillRoot, 'references/revision.md'), 'utf8'))
          .toContain('港台书面语、方言习惯用法不算语病')
      }
    }
  })

  it('bundles the audited MIT document illustrator with its exact upstream revision', () => {
    const skillRoot = resolve(bundledRoot, 'document-illustrator')
    expect(existsSync(resolve(skillRoot, 'SKILL.md'))).toBe(true)
    expect(readFileSync(resolve(skillRoot, 'LICENSE'), 'utf8')).toContain('MIT License')
    expect(readFileSync(resolve(skillRoot, 'references', 'upstream.md'), 'utf8'))
      .toContain('8344815d407cc25cc04c327557f36ed839f0aaef')
    expect(existsSync(resolve(skillRoot, 'scripts'))).toBe(false)
    const packagedText = bundledTextFiles(skillRoot).map((file) => file.content).join('\n')
    expect(packagedText).not.toContain('GEMINI_API_KEY')
    expect(packagedText).not.toContain('~/.claude/skills')
    expect(packagedText).not.toContain('load_dotenv')
  })

  it('does not redistribute sources that lack the required platform license', () => {
    for (const blockedId of [
      'guizang-social-card-skill',
      'guizang-material-illustration',
      'logo-generator-skill'
    ]) {
      expect(existsSync(resolve(bundledRoot, blockedId)), blockedId).toBe(false)
    }

    const forbiddenSourceMarkers = [
      'cf4b810fac1c73fb65a2bb31d8c9278d82cbc4c5',
      'cf26e194ce075cd205329abab29cc71fda3e78b2',
      'bf4e9ac4d4428bda261afcfe981871ceb92d94e6',
      'github.com/op7418/guizang-social-card-skill',
      'github.com/op7418/guizang-material-illustration',
      'github.com/op7418/logo-generator-skill'
    ]
    for (const file of bundledTextFiles(bundledRoot)) {
      for (const marker of forbiddenSourceMarkers) {
        expect(file.content, `${file.path} contains restricted source marker ${marker}`)
          .not.toContain(marker)
      }
    }
  })

  it('keeps bundled Skills self-contained and disables third-party auto-update', () => {
    expect(bundledSymbolicLinks(bundledRoot)).toEqual([])
    const source = JSON.parse(readFileSync(resolve(bundledRoot, 'shuorenhua', '.workwise-skill-source.json'), 'utf8')) as {
      autoUpdate?: unknown
    }
    expect(source.autoUpdate).toBe(false)
  })
})
