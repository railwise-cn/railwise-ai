#!/usr/bin/env node
/** Explicit live acceptance: synthetic inputs only; credentials stay in memory. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const output = option('--output-dir')
const settingsPath = option('--settings-file')
const selectedTemplate = option('--template')
const templateIds = selectedTemplate ? [selectedTemplate] : ['monitoring-report', 'tender-document', 'research-document']
if(templateIds.some(id=>!['monitoring-report','tender-document','research-document'].includes(id)))throw new Error('Unknown acceptance template')
if (!output || !settingsPath) throw new Error('Usage: node scripts/run-task-delivery-live.mjs --settings-file <local settings> --output-dir <private evidence directory>')
const root = resolve(output)
if (root === repo || root.startsWith(repo + '/')) throw new Error('Live evidence must be outside the repository.')
await mkdir(root, { recursive: true, mode: 0o700 })
const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const diffHash = createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: repo })).digest('hex')
const report = { schemaVersion: 1, kind: 'actual-model-synthetic-acceptance', source, trackedDiffSha256: diffHash, runtimeEntrySha256:createHash('sha256').update(await readFile(join(repo,'kun/dist/server/runtime-factory.js'))).digest('hex'), modelRequested: 'deepseek-flash', startedAt: new Date().toISOString(), sampleCount: templateIds.length, samples: [], requests: [], cost: null, costNote: 'Provider-billed cost is not returned; no estimate substituted.' }
const secretFile = join(root, '.export-bridge.json')
const bridgeEntry = join(root, '.export-bridge.cjs')
const trustEntry = join(root, '.workspace-trust.mjs')
await build({ entryPoints: [join(repo, 'src/main/services/workspace-trust-service.ts')], outfile: trustEntry, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const { WorkspaceTrustService } = await import(pathToFileURL(trustEntry))
const workspaceTrustPath = join(root, 'workspace-trust.json')
const workspaceTrust = new WorkspaceTrustService(workspaceTrustPath)
await build({ stdin: { contents: `const {app}=require('electron');const fs=require('node:fs/promises');const {startTaskDocumentExportBridge}=require(${JSON.stringify(join(repo, 'src/main/services/task-document-export-service.ts'))});app.setPath('userData',${JSON.stringify(join(root, 'electron-profile'))});app.on('window-all-closed',()=>{});app.whenReady().then(async()=>{const bridge=await startTaskDocumentExportBridge();await fs.writeFile(${JSON.stringify(secretFile)},JSON.stringify({url:bridge.url,token:bridge.token}),{mode:0o600});});process.on('SIGTERM',()=>app.exit(0));`, resolveDir: repo, loader: 'ts' }, outfile: bridgeEntry, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' })
report.exportBridgeSha256=createHash('sha256').update(await readFile(bridgeEntry)).digest('hex')
// Dependencies resolve from this explicit private test link, not the user's profile.
const { symlink } = await import('node:fs/promises')
await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
const bridge = spawn(join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [bridgeEntry], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
let bridgeError = ''
bridge.stderr.on('data', chunk => { bridgeError = (bridgeError + chunk.toString()).slice(-8192) })
let runtime
const realFetch = globalThis.fetch
const responseReads = []
try {
  let capability
  for (let index = 0; index < 100; index++) {
    try { capability = JSON.parse(await readFile(secretFile, 'utf8')); break } catch { /* Wait for actual Electron startup. */ }
    if (bridge.exitCode !== null) throw new Error(`Export Electron exited (${bridge.exitCode}): ${bridgeError}`)
    await delay(200)
  }
  if (!capability) throw new Error('Actual Electron export bridge did not start.')
  process.env.RAILWISE_DOCUMENT_EXPORT_URL = capability.url
  process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = capability.token
  await rm(secretFile)
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'))
  const providers = settings.provider?.providers ?? []
  const provider = (Array.isArray(providers) ? providers : Object.values(providers)).find(item => new URL(item.baseUrl).hostname === 'api.deepseek.com' && item.apiKey)
  if (!provider) throw new Error('No configured official DeepSeek provider credential is available.')
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const isModel = url.hostname === 'api.deepseek.com'
    const request = isModel ? { startedAt: new Date().toISOString(), elapsedMs: 0, modelRequested: JSON.parse(init?.body ?? '{}').model, modelsReturned: [], tools: [], usage: null, status: 0 } : undefined
    const began = Date.now()
    const response = await realFetch(input, init)
    if (request) {
      report.requests.push(request)
      request.status = response.status
      const copy = response.clone()
      responseReads.push((async () => {
        const text = await copy.text()
        const payloads = text.split('\n').flatMap(line => { try { return [JSON.parse(line.startsWith('data: ') ? line.slice(6) : line)] } catch { return [] } })
        for (const payload of payloads) {
          if (typeof payload.model === 'string' && !request.modelsReturned.includes(payload.model)) request.modelsReturned.push(payload.model)
          if (payload.usage) request.usage = payload.usage
          for (const choice of payload.choices ?? []) for (const call of choice.delta?.tool_calls ?? []) if (call.function?.name) request.tools.push(call.function.name)
        }
        request.elapsedMs = Date.now() - began
        await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2))
      })())
    }
    return response
  }
  const { createKunServeRuntime } = await import(pathToFileURL(join(repo, 'kun/dist/server/runtime-factory.js')))
  const { KunCapabilitiesConfig } = await import(pathToFileURL(join(repo, 'kun/dist/contracts/capabilities.js')))
  const { deliveryFlow } = await import(pathToFileURL(join(repo, 'kun/dist/delivery/templates.js')))
  const { verifyTaskDelivery } = await import(pathToFileURL(join(repo, 'kun/dist/delivery/verification.js')))
  for (const templateId of templateIds) {
    const workspace = join(root, templateId)
    await mkdir(workspace, { recursive: true })
    const trust = await workspaceTrust.get(workspace)
    await workspaceTrust.set({ workspaceRoot: workspace, level: 'workspace-write', expectedRevision: trust.revision, confirmed: true, idempotencyKey: `synthetic-acceptance:${templateId}` })
    await writeFile(join(workspace, 'source.md'), templateId === 'tender-document'
      ? '# 合成招标资料\n1. 技术文件须包含监测实施方法、质量控制与交付清单。\n2. 项目人员及资质未提供，须列待补。\n3. 本资料不含价格，不得推测报价。\n'
      : '# 合成研究资料\n观察A：本机文档保存为 Markdown 可供外部编辑器读取。\n观察B：任务等待用户时无需发送模型请求。\n限制：以上为合成验收事实，不构成实际效率提升数据。\n')
    if(templateId === 'monitoring-report') {
    await writeFile(join(workspace, 'data.csv'), 'point,time,value,unit\nP1,2026-11-01,1,mm\nP1,2026-11-02,3,mm\nP2,2026-11-01,2,mm\nP2,2026-11-02,4,mm\n')
    await writeFile(join(workspace, 'project.json'), JSON.stringify({ name: '合成监测验收项目', monitoringType: 'deformation', unit: 'mm', thresholds: { default: 10 }, reportPeriod: {start:'2026-11-01',end:'2026-11-02'}, taskContext: { standard: '合成验收规则，不作工程结论', standardVersion: 'fixture-v1' } }))
    }
    const route = { id: provider.id, baseUrl: 'https://api.deepseek.com', apiKey: provider.apiKey, endpointFormat: 'chat_completions', model: 'deepseek-flash' }
    runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtimes',templateId), workspaceTrustPath, runtimeToken: 'synthetic-local-only', ...route, modelProviders: [route], defaultModelProviderId: provider.id, approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
    const sample = { templateId, startedAt: new Date().toISOString(), elapsedMs: 0, userInterventions: 0, verified: false }
    report.samples.push(sample)
    const started = Date.now()
    const sceneGoal=templateId==='monitoring-report'?'完成监测报告，调用确定性工具并引用返回图表。':templateId==='tender-document'?'完成投标技术响应文件，包含响应矩阵。':'仅研究 source.md 中的两条观察及适用限制，按事实、判断、不确定性组织研究报告，不包含无关工程分析或投标章节。'
    const graph = deliveryFlow(templateId, { workspaceRoot: workspace, sourcePaths: templateId === 'monitoring-report' ? ['data.csv', 'project.json'] : ['source.md'], model: 'deepseek-flash', providerId: provider.id, goal: `使用上述固定合成资料生成600字以内的中文可审阅草稿、来源及待确认项。${sceneGoal}再真实导出 DOCX 和 PDF。无需用户补资料，缺项列入草稿。禁止联网检索、外发或访问工作区外文件；不要编造完成。` }, `live:${templateId}:${report.startedAt}`)
    runtime.flowService.create(graph)
    if (!runtime.flowService.publish(graph.id).published) throw new Error(`Could not publish synthetic ${templateId} flow`)
    const flow = await runtime.flowService.run(graph.id, {})
    let task
    while (Date.now() - started < 300_000) {
      if (bridge.exitCode !== null) throw new Error(`Export Electron exited (${bridge.exitCode}): ${bridgeError}`)
      task = runtime.taskRepository.list({ workspaceRoot: workspace }).find(task => task.flowRunId === flow.id)
      if (task && ['completed', 'failed', 'cancelled', 'waiting_user', 'waiting_approval', 'stalled'].includes(task.status)) break
      await delay(250)
    }
    if (!task) throw new Error('The production Flow did not create a task.')
    sample.taskStatus = task.status
    sample.flowRunId = flow.id
    sample.taskId = task.id
    sample.elapsedMs = Date.now() - started
    sample.verification = verifyTaskDelivery(runtime.taskRepository, task)
    sample.artifacts = task.artifacts
    sample.verified = sample.verification.complete && task.status === 'completed'
    sample.finalResponse = task.finalResponse ?? null
    if (!['completed','failed','cancelled'].includes(task.status) && task.activeTurnId) await runtime.turnService.interruptTurn({threadId: task.threadId,turnId:task.activeTurnId})
    await runtime.shutdown?.(); runtime = undefined
    await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2))
    process.stdout.write(`${templateId}: ${sample.taskStatus}, verified=${sample.verified}\n`)
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  await runtime?.shutdown?.()
  await Promise.allSettled(responseReads)
  globalThis.fetch = realFetch
  delete process.env.RAILWISE_DOCUMENT_EXPORT_URL
  delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
  bridge.kill('SIGTERM')
  await rm(secretFile, { force: true })
  report.finishedAt = new Date().toISOString()
  report.passed = !report.error && report.samples.length === templateIds.length && report.samples.every(sample => sample.verified)
  await writeFile(join(root, 'results.json'), JSON.stringify(report, null, 2))
  if (!report.passed) process.exitCode = 1
  process.stdout.write(`Evidence: ${join(root, 'results.json')}\n`)
}
