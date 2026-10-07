import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('WorkWise brand boundary', () => {
  it('allows legacy path guards in the isolated candidate authorization script', () => {
    expect(() => execFileSync(process.execPath, ['scripts/verify-brand-boundary.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })).not.toThrow()
  })

  it('preserves historical package identities only in release evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'railwise-brand-evidence-'))
    try {
      for (const dir of ['src', 'scripts', '.github', 'docs/qa/release-gates', 'release']) mkdirSync(join(root, dir), { recursive: true })
      for (const file of ['README.md', 'README.en.md', 'DESIGN.md', 'DESIGN.zh-CN.md', 'electron-builder.cjs', 'package.json']) writeFileSync(join(root, file), '')
      const script = join(root, 'scripts/verify-brand-boundary.mjs')
      writeFileSync(script, readFileSync('scripts/verify-brand-boundary.mjs'))
      const evidence = join(root, 'docs/qa/release-gates/review.md')
      const run = (): void => { execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' }) }
      const legacyId = 'com.wangjiawei508.' + 'work' + 'gpt'
      writeFileSync(evidence, `Bundle ID: ${legacyId}\nApp ID: ${legacyId}.candidate.head9527ec5f1bcb\n`)
      expect(run).not.toThrow()
      writeFileSync(evidence, `Bundle ID: ${legacyId}; product name: ${'Work' + 'GPT'}\n`)
      expect(run).toThrow()
      writeFileSync(evidence, '')
      writeFileSync(join(root, 'src/visible.ts'), legacyId)
      expect(run).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
