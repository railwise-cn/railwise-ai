#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Deliberately opt-in: this script makes real billable model requests using the
// already configured provider. It never prints or serializes a credential.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argument = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
if (!args.includes('--real-provider')) {
  throw new Error('Use --real-provider to explicitly request live service acceptance.')
}
const settingsPath = argument('--settings')
const outputPath = argument('--output')
if (!settingsPath || !outputPath) {
  throw new Error('--settings and --output are required; never pass an API key as an argument.')
}
const allowedOrigin = argument('--allow-origin') ?? 'https://api.deepseek.com'
const scratch = await mkdtemp(join(tmpdir(), 'railwise-write-live-model-'))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const report = {
  schema: 'railwise.write.real-model-service-acceptance.v1',
  startedAt: new Date().toISOString(),
  scope: 'Real model service integration using the production Write request builder and service; not installed GUI E2E.',
  credentialHandling: 'Existing configured key read in memory only; no credential/header/source settings are serialized.',
  syntheticFixtureOnly: true,
  operations: []
}

try {
  const bundlePath = join(scratch, 'write-live-service.cjs')
  await build({
    stdin: {
      contents: [
        "export { normalizeAppSettings, resolveWriteInlineCompletionApiKey, resolveWriteInlineCompletionBaseUrl, resolveWriteInlineCompletionModel } from './src/shared/app-settings.ts'",
        "export { requestWriteInlineCompletion, listWriteInlineCompletionDebugEntries, clearWriteInlineCompletionDebugEntries } from './src/main/services/write-inline-completion-service.ts'",
        "export { buildWriteInlineEditDraft, buildWriteInlineEditCompletionRequest, applyWriteInlineEditReplacement } from './src/renderer/src/write/inline-edit.ts'"
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'write-live-acceptance-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundlePath,
    tsconfig: join(root, 'tsconfig.web.json'),
    logLevel: 'silent'
  })
  const service = createRequire(import.meta.url)(bundlePath)
  const storedBytes = await readFile(settingsPath)
  const settings = service.normalizeAppSettings(JSON.parse(storedBytes.toString('utf8')))
  const baseUrl = service.resolveWriteInlineCompletionBaseUrl(settings)
  const url = new URL(baseUrl)
  if (url.origin !== allowedOrigin || url.username || url.password) {
    throw new Error('Configured provider does not match --allow-origin; no request was sent.')
  }
  if (!service.resolveWriteInlineCompletionApiKey(settings)) {
    throw new Error('Configured provider credential is unavailable; no request was sent.')
  }
  // No workspace or knowledge content may enter this opt-in probe.
  settings.write.inlineCompletion.enabled = true
  settings.write.inlineCompletion.retrievalEnabled = false
  settings.write.knowledgeBase.enabled = false
  settings.write.inlineCompletion.longMaxTokens = 512
  const model = service.resolveWriteInlineCompletionModel(settings)
  report.provider = { origin: url.origin, model, configuredCredentialPresent: true }

  const original = '# 软件验收合成报告\n\n本周5个测点均完成2轮测量。最大累计沉降为2.1毫米，低于3.0毫米预警值。以上均为合成验收数据。\n'
  const workspace = join(scratch, 'workspace')
  const file = join(workspace, 'synthetic-report.md')
  await mkdir(workspace)
  await writeFile(file, original, { mode: 0o600 })
  const selectionFrom = original.indexOf('本周')
  const selectionTo = original.lastIndexOf('\n')
  const requests = [
    {
      name: 'selected-formal-rewrite',
      from: selectionFrom,
      to: selectionTo,
      instruction: '将选区改写为正式工程报告风格，并以“监测结果：”开头。保持5、2、2.1、3.0这四个阿拉伯数字的原样写法，保留合成验收数据声明，不增加数据或结论。只返回替换文字。'
    },
    {
      name: 'whole-document-summary-append',
      from: original.length,
      to: original.length,
      instruction: '根据前文完整文档，在文末追加一个简短的“## 摘要”段落，提及最大累计沉降2.1毫米低于3.0毫米预警值，并说明是合成验收数据。只返回要追加的Markdown，不重写现有正文。'
    }
  ]
  for (const item of requests) {
    const range = {
      from: item.from, to: item.to, text: original.slice(item.from, item.to),
      charCount: item.to - item.from, startLine: 3, startColumn: 1, endLine: 3, endColumn: 1
    }
    const draft = service.buildWriteInlineEditDraft(original, range, item.instruction, {
      workspaceRoot: workspace, currentFilePath: file, language: 'markdown', model
    })
    const request = service.buildWriteInlineEditCompletionRequest(draft.request)
    const started = Date.now()
    const result = await service.requestWriteInlineCompletion(settings, request)
    const diskBeforeReview = await readFile(file, 'utf8')
    const debug = service.listWriteInlineCompletionDebugEntries()[0]
    const entry = {
      name: item.name,
      durationMs: Date.now() - started,
      ok: result.ok,
      sourceSha256Before: sha(original),
      sourceSha256AfterRequest: sha(diskBeforeReview),
      diskUnchangedBeforeReview: diskBeforeReview === original,
      referenceCount: debug?.referenceCount ?? null,
      mode: result.ok ? result.mode : undefined
    }
    if (!result.ok) {
      // Only a status category is persisted; remote error bodies can be arbitrary.
      entry.failureCategory = /\(401\)|\(403\)/.test(result.message) ? 'authorization' : /timeout|abort/i.test(result.message) ? 'timeout' : 'provider-or-network-error'
      report.operations.push(entry)
      continue
    }
    const replacement = result.action?.kind === 'edit' ? result.action.replacement : result.completion
    const acceptedPreview = service.applyWriteInlineEditReplacement(original, draft.scope, replacement)
    entry.proposal = replacement
    entry.proposalSha256 = sha(replacement)
    entry.proposalNonempty = replacement.trim().length > 0
    entry.proposalChangesScope = replacement !== draft.scope.text
    entry.rejectionPreservesOriginal = (await readFile(file, 'utf8')) === original
    entry.acceptPreviewPreservesPrefix = acceptedPreview.startsWith(original.slice(0, item.from))
    entry.acceptPreviewPreservesSuffix = acceptedPreview.endsWith(original.slice(item.to))
    entry.acceptPreviewSha256 = sha(acceptedPreview)
    entry.syntheticDataDeclarationPresent = /合成|软件验收|synthetic/i.test(replacement)
    entry.numericFactsRetained = /2\.1/.test(replacement) && /3\.0/.test(replacement)
    report.operations.push(entry)
  }
  report.productionSettingsUnchanged = sha(await readFile(settingsPath)) === sha(storedBytes)
  report.fixture = { source: original, sha256: sha(original) }
  report.allChecksPassed = report.operations.length === 2 && report.operations.every((entry) =>
    entry.ok && entry.diskUnchangedBeforeReview && entry.referenceCount === 0 && entry.proposalNonempty && entry.proposalChangesScope &&
    entry.rejectionPreservesOriginal && entry.acceptPreviewPreservesPrefix && entry.acceptPreviewPreservesSuffix &&
    entry.syntheticDataDeclarationPresent && entry.numericFactsRetained
  ) && report.productionSettingsUnchanged
  service.clearWriteInlineCompletionDebugEntries()
} catch (error) {
  // Do not serialize exception messages from arbitrary providers or settings.
  report.failure = { category: error instanceof Error ? error.name : 'unknown', detailsOmittedToProtectCredentials: true }
  report.allChecksPassed = false
} finally {
  report.finishedAt = new Date().toISOString()
  await mkdir(dirname(resolve(outputPath)), { recursive: true })
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  await rm(scratch, { recursive: true, force: true })
}

console.log(JSON.stringify({
  report: resolve(outputPath),
  scope: report.scope,
  provider: report.provider,
  operations: report.operations.map(({ name, ok, durationMs, diskUnchangedBeforeReview, failureCategory }) => ({ name, ok, durationMs, diskUnchangedBeforeReview, failureCategory })),
  allChecksPassed: report.allChecksPassed
}, null, 2))
if (!report.allChecksPassed) process.exitCode = 1
