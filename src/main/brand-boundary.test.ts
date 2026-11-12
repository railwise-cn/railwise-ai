import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('RailWise AI brand boundary', () => {
  it('allows legacy path guards in the isolated candidate authorization script', () => {
    expect(() => execFileSync(process.execPath, ['scripts/verify-brand-boundary.mjs'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })).not.toThrow()
  })

  it.each(['docs/qa/release-gates/review.md', 'docs/qa/harness-implementation-status-2026-11-10.md'])('preserves exact compatibility identities only in QA evidence (%s)', evidencePath => {
    const root = mkdtempSync(join(tmpdir(), 'railwise-brand-evidence-'))
    try {
      for (const dir of ['src', 'scripts', '.github', 'docs/qa/release-gates', 'release', 'website']) mkdirSync(join(root, dir), { recursive: true })
      for (const file of ['README.md', 'README.en.md', 'DESIGN.md', 'DESIGN.zh-CN.md', 'electron-builder.cjs', 'package.json']) writeFileSync(join(root, file), '')
      const script = join(root, 'scripts/verify-brand-boundary.mjs')
      const checker = readFileSync('scripts/verify-brand-boundary.mjs', 'utf8')
      writeFileSync(script, checker)
      // Materialize the checker's explicit prospective-output fixtures. Their
      // paths are fixtures; the assertions below exercise the exception boundary.
      for (const name of ['publicIdentityFiles', 'publicCopyFiles']) {
        const list = checker.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`))?.[1] || ''
        for (const match of list.matchAll(/'([^']+)'/g)) {
          const path = join(root, match[1])
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, '')
        }
      }
      const evidence = join(root, evidencePath)
      const run = (): void => { execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe' }) }
      const legacyId = 'com.wangjiawei508.' + 'work' + 'gpt'
      writeFileSync(evidence, `Bundle ID: ${legacyId}\nApp ID: ${legacyId}.candidate.head9527ec5f1bcb\n`)
      expect(run).not.toThrow()
      writeFileSync(evidence, `Bundle ID: ${legacyId}; product name: ${'Work' + 'GPT'}\n`)
      expect(run).toThrow()
      writeFileSync(evidence, '')
      writeFileSync(join(root, 'src/visible.ts'), legacyId)
      expect(run).toThrow()
      writeFileSync(join(root, 'src/visible.ts'), '')

      const legacyNamespace = '.' + 'work' + 'gpt'
      const legacyProduct = 'Work' + 'GPT'
      const contract = join(root, 'src/shared/workspace-migration.ts')
      mkdirSync(dirname(contract), { recursive: true })
      writeFileSync(contract, `export type WorkspaceNamespace = '${legacyNamespace}' | '.workwise'\n`)
      expect(run).not.toThrow()
      writeFileSync(contract, `export type WorkspaceNamespace = '${legacyNamespace}' | '.workwise'; const title = '${legacyProduct}'\n`)
      expect(run).toThrow()
      writeFileSync(contract, '')

      const locale = join(root, 'src/renderer/src/locales/zh/settings.json')
      mkdirSync(dirname(locale), { recursive: true })
      // Locale exceptions are line/key-specific, so real JSON formatting is
      // required rather than permitting every legacy identity in this file.
      writeFileSync(locale, JSON.stringify({ workspaceMigrationDescription: `检查 ${legacyNamespace} 下的工作区` }, null, 2))
      expect(run).not.toThrow()
      writeFileSync(locale, JSON.stringify({ workspaceMigrationDescription: `检查 ${legacyNamespace}；欢迎使用 ${legacyProduct}` }, null, 2))
      expect(run).toThrow()
      writeFileSync(locale, JSON.stringify({ title: legacyNamespace }, null, 2))
      expect(run).toThrow()
      writeFileSync(locale, '')

      const migrationDoc = join(root, 'docs/harness-trusted-execution.md')
      writeFileSync(migrationDoc, `迁移服务盘点 \`${legacyNamespace}\`，保留原件。\n`)
      expect(run).not.toThrow()
      writeFileSync(migrationDoc, `迁移服务盘点 \`${legacyNamespace}\`，产品名称 ${legacyProduct}。\n`)
      expect(run).toThrow()
      writeFileSync(migrationDoc, '')
      writeFileSync(join(root, 'src/main/services/plugin-package-formats.ts'), "throw new Error('WorkWise package signature verification failed.')")
      expect(run).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
