import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Document, Packer, Paragraph, TextRun } from 'docx'

const DOCLING_SERVE_VERSION = '1.39.0'
const DOCLING_MCP_VERSION = '3.5.1'
const DOCLING_CONVERSION_TOOL = 'convert_document_into_docling_document'
const DOCLING_MARKDOWN_TOOL = 'export_docling_document_to_markdown'

const blockedHosts = [
  'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'npmjs.com', 'registry.npmjs.com',
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'pypi.python.org', 'registry.npmmirror.com',
  'cdn.playwright.dev', 'playwright.azureedge.net'
]
const containment = (root, path) => {
  const name = relative(root, path)
  return !!name && !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`)
}
const literal = JSON.stringify

async function withPublicUpstreamsBlocked(run, hosts = blockedHosts) {
  const hostsFile = join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts')
  assert.ok((await lstat(hostsFile)).isFile(), 'Expected the hosted runner system hosts file')
  const before = await readFile(hostsFile)
  const marker = randomUUID()
  const policy = Buffer.concat([before, Buffer.from(`\r\n# RailWise isolated mirror smoke ${marker}\r\n${hosts.map(host => `127.0.0.1 ${host}\r\n::1 ${host}`).join('\r\n')}\r\n`)])
  const flush = () => execFileSync('ipconfig.exe', ['/flushdns'], { windowsHide: true, stdio: 'ignore' })
  try {
    await writeFile(hostsFile, policy)
    flush()
    for (const host of hosts) {
      const result = await lookup(host, { all: true })
      assert.ok(result.length && result.every(entry => ['127.0.0.1', '::1'].includes(entry.address)), `Upstream is still resolvable: ${host}`)
    }
    return await run()
  } finally {
    if ((await readFile(hostsFile)).equals(policy)) {
      await writeFile(hostsFile, before)
      flush()
    }
  }
}

async function invokeInstalledPlaywright(server, workspace, environment) {
  const marker = randomUUID()
  let observed = 0
  const page = createServer((_request, response) => {
    observed++
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>${marker}</title><h1>${marker}</h1>`)
  })
  await new Promise((ready, reject) => { page.on('error', reject); page.listen(0, '127.0.0.1', ready) })
  const client = new Client({ name: 'railwise-installed-connector-acceptance', version: '1.0.0' })
  const env = Object.fromEntries(Object.entries(environment).filter(([, value]) => typeof value === 'string'))
  const transport = new StdioClientTransport({ command: server.command, args: [...server.args, '--headless'], cwd: workspace, env, stderr: 'pipe' })
  transport.stderr?.resume()
  try {
    await client.connect(transport)
    const discovered = await client.listTools()
    assert.ok(discovered.tools.some(item => item.name === 'browser_navigate'))
    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${page.address().port}/` } })
    assert.equal(Boolean(result.isError), false)
    assert.ok(observed > 0 && literal(result.content).includes(marker), 'Installed connector must navigate to and read the local page')
    return { navigated: true, observed, toolsDiscovered: discovered.tools.length, method: 'installed-mcp-stdio' }
  } finally {
    await client.close()
    await new Promise(done => { page.close(done); page.closeAllConnections() })
  }
}

async function verifyInstalledDoclingCsvBackend(cdp, { workspace, environment, ownedRoot }) {
  const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='docling-mcp-server'))`)
  const installed = await cdp.evaluate("window.workwise.listInstalledPlugins().then(all=>all.find(row=>row.packageId==='docling-mcp'))")
  assert.equal(server?.source, 'managed-tool')
  assert.equal(server?.transport, 'stdio')
  assert.deepEqual(server.args.slice(3), ['docling-mcp', 'docling-mcp-server', '--transport', 'stdio'])
  const command = await realpath(server.command)
  const artifact = await realpath(installed.artifact.location)
  const sitePackages = await realpath(server.args[2])
  assert.ok(containment(await realpath(ownedRoot), command))
  assert.ok(containment(artifact, sitePackages))
  const marker = `RailWise-Docling-${randomUUID()}`
  const file = join(workspace, 'Docling synthetic table.csv')
  await writeFile(file, `项目,值\n${marker},42\n`)
  const probe = `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from docling.backend.csv_backend import CsvDocumentBackend
from docling.datamodel.base_models import InputFormat
from docling.datamodel.document import InputDocument
source = InputDocument(path_or_stream=Path(sys.argv[2]), format=InputFormat.CSV, backend=CsvDocumentBackend)
print(source._backend.convert().export_to_markdown())
`
  const markdown = execFileSync(command, ['-I', '-B', '-X', 'utf8', '-c', probe, win32.toNamespacedPath(sitePackages), file],
    { cwd: workspace, env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 64_000 })
  for (const text of ['项目', '值', marker, '42']) assert.ok(markdown.includes(text), 'The verified Docling backend must preserve the synthetic CSV contents')
  return { method: 'direct-mirrored-csv-backend', fixture: 'synthetic-utf8-csv', preservedChineseCells: true,
    artifactSha256: installed.artifact.sha256 }
}

function escapePdfText(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function makeTextPdf(text) {
  const content = `BT /F1 18 Tf 72 720 Td (${escapePdfText(text)}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}endstream`
  ]
  let document = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document, 'ascii'))
    document += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(document, 'ascii')
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) document += `${String(offset).padStart(10, '0')} 00000 n \n`
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(document, 'ascii')
}

async function createDoclingConversionFixtures(workspace) {
  const nonce = randomUUID()
  const fixtures = [
    { format: 'pdf', marker: `RailWise-PDF-${nonce}`, path: join(workspace, `Docling-${nonce}.pdf`) },
    { format: 'docx', marker: `RailWise-DOCX-${nonce}`, path: join(workspace, `Docling-${nonce}.docx`) }
  ]
  await writeFile(fixtures[0].path, makeTextPdf(fixtures[0].marker), { flag: 'wx' })
  const word = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun(fixtures[1].marker)] })] }] })
  await writeFile(fixtures[1].path, await Packer.toBuffer(word), { flag: 'wx' })
  return fixtures
}

async function waitForDoclingServe(child, url, getSpawnError) {
  const deadline = Date.now() + 300_000
  let lastError
  while (Date.now() < deadline) {
    if (getSpawnError()) throw new Error(`Docling Serve could not start: ${getSpawnError().message}`)
    if (child.exitCode !== null) throw new Error(`Docling Serve exited before readiness (code ${child.exitCode})`)
    try {
      const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(3_000) })
      if (response.ok && (await response.json()).status === 'ok') return
      lastError = new Error(`Docling Serve readiness probe returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error(`Docling Serve did not become ready: ${lastError?.message ?? 'timeout'}`)
}

async function startPinnedDoclingServe({ workspace, ownedRoot }) {
  const python = process.env.RAILWISE_DOCLING_SERVE_PYTHON
  assert.ok(python, 'The isolated pinned Docling Serve Python environment must be configured by the Windows workflow')
  const pythonPath = await realpath(python)
  assert.ok(containment(await realpath(process.env.RUNNER_TEMP), pythonPath), 'Docling Serve must run from its isolated runner-temp environment')
  const identity = JSON.parse(execFileSync(pythonPath, ['-c',
    "import importlib.metadata as m, json, platform; print(json.dumps({'python': platform.python_version(), 'serve': m.version('docling-serve'), 'docling': m.version('docling-slim')}))"],
  { cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true }))
  assert.equal(identity.serve, DOCLING_SERVE_VERSION)
  assert.ok(identity.docling)
  const packageFreeze = execFileSync(pythonPath, ['-m', 'pip', 'freeze'],
    { cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  const dependencySetSha256 = createHash('sha256').update(packageFreeze).digest('hex')
  const probe = createServer()
  await new Promise((ready, reject) => { probe.on('error', reject); probe.listen(0, '127.0.0.1', ready) })
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  const serviceUrl = `http://127.0.0.1:${port}`
  const artifactsPath = join(ownedRoot, 'docling-artifacts')
  const environment = {
    ...process.env,
    // Docling Serve uses Rich during startup. GitHub-hosted Windows runners
    // can expose cp1252 pipes, which makes an otherwise healthy service exit
    // when a status line contains a non-ASCII glyph. Force the child Python
    // process to use UTF-8 so readiness reflects the service, not the runner
    // console code page.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    UVICORN_HOST: '127.0.0.1',
    UVICORN_PORT: String(port),
    DOCLING_SERVE_ENABLE_UI: 'false',
    DOCLING_SERVE_ARTIFACTS_PATH: artifactsPath,
    HF_HOME: join(ownedRoot, 'docling-model-cache'),
    HF_HUB_DISABLE_TELEMETRY: '1'
  }
  await mkdir(artifactsPath, { recursive: true })
  const child = spawn(pythonPath, ['-m', 'docling_serve', 'run', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  })
  let logs = ''
  let spawnError
  const append = chunk => { logs = `${logs}${chunk}`.slice(-12_000) }
  child.on('error', error => { spawnError = error; append(error.message) })
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  try {
    await waitForDoclingServe(child, serviceUrl, () => spawnError)
  } catch (error) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
      child.once('close', () => { clearTimeout(timeout); resolve() })
      child.kill()
    })
    throw new Error(`${error.message}\n${logs}`)
  }
  return {
    serviceUrl,
    identity: { package: 'docling-serve', version: identity.serve, doclingVersion: identity.docling,
      pythonVersion: identity.python, dependencySetSha256 },
    child,
    get logs() { return logs },
    async stop() {
      if (child.exitCode !== null) return
      await new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 10_000)
        child.once('close', () => { clearTimeout(timeout); resolve() })
        child.kill()
      })
    }
  }
}

function findStructuredField(value, field, seen = new Set()) {
  if (typeof value === 'string') {
    try { return findStructuredField(JSON.parse(value), field, seen) } catch { return undefined }
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  if (Object.hasOwn(value, field) && value[field] !== undefined) return value[field]
  for (const child of Object.values(value)) {
    const found = findStructuredField(child, field, seen)
    if (found !== undefined) return found
  }
  return undefined
}

async function invokeInstalledDoclingConversion(cdp, { workspace, environment, ownedRoot, service }) {
  const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='docling-mcp-server'))`)
  const installed = await cdp.evaluate("window.workwise.listInstalledPlugins().then(all=>all.find(row=>row.packageId==='docling-mcp'))")
  assert.equal(server?.source, 'managed-tool')
  assert.equal(server?.transport, 'stdio')
  assert.deepEqual(server.args.slice(3), ['docling-mcp', 'docling-mcp-server', '--transport', 'stdio'])
  assert.equal(installed.version, DOCLING_MCP_VERSION)
  const command = await realpath(server.command)
  const artifact = await realpath(installed.artifact.location)
  const sitePackages = await realpath(server.args[2])
  assert.ok(containment(await realpath(ownedRoot), command))
  assert.ok(containment(artifact, sitePackages))

  const fixtures = await createDoclingConversionFixtures(workspace)
  const client = new Client({ name: 'railwise-installed-docling-conversion-acceptance', version: '1.0.0' })
  const env = Object.fromEntries(Object.entries({ ...process.env, ...environment,
    DOCLING_MCP_CONVERSION_MODE: 'remote',
    DOCLING_MCP_SERVICE_URL: service.serviceUrl,
    DOCLING_MCP_SERVICE_TIMEOUT: '600',
    DOCLING_MCP_SERVICE_MAX_RETRIES: '0',
    DOCLING_MCP_DO_OCR: 'false'
  }).filter(([, value]) => typeof value === 'string'))
  const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: workspace, env, stderr: 'pipe' })
  transport.stderr?.resume()
  try {
    await client.connect(transport)
    const discovered = await client.listTools()
    const available = new Set(discovered.tools.map(item => item.name))
    assert.ok(available.has(DOCLING_CONVERSION_TOOL), 'Installed Docling MCP must expose its document conversion tool')
    assert.ok(available.has(DOCLING_MARKDOWN_TOOL), 'Installed Docling MCP must expose its Markdown export tool')
    const documents = []
    for (const fixture of fixtures) {
      const converted = await client.callTool({ name: DOCLING_CONVERSION_TOOL, arguments: { source: fixture.path } }, undefined, { timeout: 600_000 })
      assert.equal(Boolean(converted.isError), false, `Docling MCP conversion failed for ${fixture.format}: ${JSON.stringify(converted.content).slice(0, 1_500)}`)
      const convertedPayload = converted.structuredContent ?? converted.content
      const convertedText = JSON.stringify(convertedPayload)
      const documentKey = findStructuredField(convertedPayload, 'document_key')
        ?? /(?:["']?document_key["']?\s*[:=]\s*["'])([^"']+)["']/.exec(convertedText)?.[1]
      assert.equal(typeof documentKey, 'string', `Docling MCP did not return a document cache key for ${fixture.format}`)
      const exported = await client.callTool({ name: DOCLING_MARKDOWN_TOOL,
        arguments: { document_key: documentKey, max_size: 20_000 } }, undefined, { timeout: 120_000 })
      assert.equal(Boolean(exported.isError), false, `Docling MCP Markdown export failed for ${fixture.format}`)
      const markdown = findStructuredField(exported.structuredContent ?? exported.content, 'markdown')
        ?? (typeof exported.content?.[0]?.text === 'string' ? exported.content[0].text : '')
      assert.equal(typeof markdown, 'string')
      assert.ok(markdown.includes(fixture.marker), `The converted ${fixture.format} Markdown must preserve its unique source text`)
      const source = await readFile(fixture.path)
      documents.push({ format: fixture.format, sourceSha256: createHash('sha256').update(source).digest('hex'),
        documentKey, markerSha256: createHash('sha256').update(fixture.marker).digest('hex'),
        extractedMarker: true, markdownSha256: createHash('sha256').update(markdown).digest('hex') })
    }
    return {
      method: 'installed-mcp-stdio-to-pinned-docling-serve',
      service: { ...service.identity, endpoint: service.serviceUrl },
      mcp: { packageVersion: installed.version, artifactSha256: installed.artifact.sha256,
        toolsDiscovered: discovered.tools.length, conversionTool: DOCLING_CONVERSION_TOOL, markdownTool: DOCLING_MARKDOWN_TOOL },
      documents
    }
  } finally {
    await client.close()
  }
}

export function validateDoclingConversionEvidence(docling, expectedArtifactSha256) {
  assert.ok(docling?.toolsDiscovered > 0)
  assert.equal(docling.conversion?.method, 'installed-mcp-stdio-to-pinned-docling-serve')
  assert.equal(docling.conversion?.service?.package, 'docling-serve')
  assert.equal(docling.conversion?.service?.version, DOCLING_SERVE_VERSION)
  assert.match(docling.conversion?.service?.dependencySetSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(docling.conversion?.mcp?.packageVersion, DOCLING_MCP_VERSION)
  assert.equal(docling.conversion?.mcp?.artifactSha256, expectedArtifactSha256)
  assert.equal(docling.conversion?.mcp?.conversionTool, DOCLING_CONVERSION_TOOL)
  assert.equal(docling.conversion?.mcp?.markdownTool, DOCLING_MARKDOWN_TOOL)
  assert.deepEqual(docling.conversion?.documents?.map(item => item.format).sort(), ['docx', 'pdf'])
  for (const document of docling.conversion.documents) {
    assert.equal(document.extractedMarker, true)
    assert.match(document.documentKey, /^[A-Za-z0-9:._-]+$/)
    assert.match(document.sourceSha256, /^[a-f0-9]{64}$/)
    assert.match(document.markerSha256, /^[a-f0-9]{64}$/)
    assert.match(document.markdownSha256, /^[a-f0-9]{64}$/)
  }
  return true
}

export function createMarketplaceModelAcceptance() {
  const probes = new Map()
  return {
    expectSkill({ skill, entry }) {
      const marker = `market-skill-${randomUUID()}`
      const body = entry.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*/, '')
      const excerpt = body.match(/[a-z][a-z ]{28,64}/i)?.[0].trim()
      assert.ok(excerpt, `Expected an instruction excerpt in the installed ${skill.id} entry`)
      const probe = { marker, excerpt, skill, reply: `已核验技能 ${skill.id}`, resourceVerified: false, stages: [] }
      probes.set(marker, probe)
      return probe
    },
    modelAction(body) {
      const messages = body.messages ?? []
      const lastUser = literal(messages.findLast(message => message.role === 'user')?.content ?? '')
      const probe = [...probes.values()].find(item => lastUser.includes(item.marker))
      if (!probe) return null
      const header = `Active Skill: ${probe.skill.name} (${probe.skill.id})`
      const injected = messages.some(message => message.role === 'system' &&
        literal(message.content).includes(header) && literal(message.content).includes(probe.excerpt))
      if (!injected) {
        probe.stages.push('skill-injection-missing')
        return { content: `验收暂停：当前会话未加载 ${probe.skill.name}。` }
      }
      const callId = `${probe.skill.id}-market-read`
      const readback = messages.find(item => item.role === 'tool' && item.tool_call_id === callId)
      if (readback) {
        if (!literal(readback.content).includes(probe.excerpt)) {
          probe.stages.push('skill-resource-content-mismatch')
          return { content: `验收暂停：当前会话无法读取 ${probe.skill.name} 的安装说明。` }
        }
        probe.stages.push('skill-resource-read')
        probe.resourceVerified = true
        return { content: probe.reply }
      }
      if (!body.tools?.some(item => item.function?.name === 'read_skill_resource')) {
        probe.stages.push('skill-resource-tool-unavailable')
        return { content: `验收暂停：当前会话未提供读取 ${probe.skill.name} 说明的工具。` }
      }
      probe.stages.push('skill-resource-tool-available')
      return { tool_calls: [{ index: 0, id: callId, type: 'function',
        function: { name: 'read_skill_resource', arguments: literal({ skill_id: probe.skill.id, path: 'SKILL.md' }) } }] }
    },
    diagnostics() {
      return [...probes.values()].map(probe => ({ skillId: probe.skill.id, stages: [...probe.stages], resourceVerified: probe.resourceVerified }))
    }
  }
}

async function installMarketplacePackageViaUi(cdp, id, name, { useUserScope = false, offline = false } = {}) {
  await cdp.fill('input[placeholder="搜索插件、发布者和能力"]', name)
  await cdp.click(`[data-marketplace-package="${id}"] button`, '安装')
  if (offline) {
    await cdp.wait(`document.querySelector('[role="dialog"]')?.textContent.includes('安装包随应用提供，已通过验证')`,
      'the verified bundled archive in the installation review')
  }
  if (useUserScope) await cdp.click('[role="dialog"] button', '个人')
  await cdp.click('[role="dialog"] button', '安装')
  await cdp.wait(`!document.querySelector('[role="dialog"]')`, `the completed ${name} review`, 240_000)
  return cdp.wait(`window.workwise.listInstalledPlugins().then(all => all.find(row => row.packageId === ${literal(id)}))`,
    `the installed ${name} receipt`, 240_000)
}

async function selectMarketplaceSkill(cdp, composer, skillId, label) {
  await cdp.fill(composer, `/${skillId}`)
  await cdp.click('[role="option"] .truncate', label)
  await cdp.wait(`Array.from(document.querySelectorAll('[data-composer-skill]')).some(chip => chip.textContent.includes(${literal(label)}))
    && !document.querySelector(${literal(composer)})?.value.includes('/skill:')`, `the ${label} selection chip`)
}

async function verifyMarketplaceSkillSelection(cdp, composer, skillId, label) {
  await selectMarketplaceSkill(cdp, composer, skillId, label)
  await cdp.click('[data-composer-skill] button', `移除 ${label}`)
  await cdp.fill(composer, '')
}

async function verifyMarketplaceSkillExecution(cdp, { composer, label, skill, scope, packageId, acceptance }) {
  const installed = await cdp.evaluate(`window.workwise.listInstalledPlugins().then(all => all.find(row => row.packageId === ${literal(packageId)}))`)
  const path = await realpath(join(skill.root, 'SKILL.md'))
  assert.ok(containment(await realpath(installed.artifact.location), path), 'The actual skill entry must come from its exact installed package')
  const entry = await readFile(path)
  const probe = acceptance.expectSkill({ skill, entry: entry.toString('utf8') })
  assert.equal(skill.scope, scope)

  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  await cdp.wait(`document.querySelector(${literal(composer)})?.value === ''`, 'the empty market validation chat composer')
  const prompt = `${probe.marker} 请阅读所选技能的使用说明。`
  await selectMarketplaceSkill(cdp, composer, skill.id, label)
  await cdp.fill(composer, prompt)
  await cdp.wait(`Array.from(document.querySelectorAll('[data-composer-skill]')).some(item=>item.textContent.includes(${literal(label)}))`,
    `selected ${label} before sending`)
  await cdp.click('button[aria-label="发送"]:not(:disabled)')
  await cdp.wait(`document.body.innerText.includes(${literal(probe.reply)}) &&
    Array.from(document.querySelectorAll('[data-loaded-skill]')).some(chip=>chip.textContent.includes(${literal(label)}))`,
    `the ${label} real resource read and loaded skill badge`, 120_000)
  // New chat reuses an untouched draft, which may only be listed after Send.
  const turn = await cdp.wait(`(async () => {
    const list = await window.workwise.runtimeRequest('/v1/threads','GET');
    if (!list.ok) return null;
    for (const {id} of JSON.parse(list.body).threads) {
      const result = await window.workwise.runtimeRequest('/v1/threads/' + encodeURIComponent(id),'GET');
      if (!result.ok) continue;
      const turn = JSON.parse(result.body).turns.find(item=>item.prompt === ${literal(prompt)} && item.status === 'completed');
      if (turn) return turn;
    }
    return null;
  })()`, `the completed ${label} turn receipt`, 30_000)
  assert.ok(turn.activeSkillIds.includes(skill.id) && turn.skillInjectionBytes > 0)
  assert.ok(turn.capabilityReferences.some(reference => reference.kind === 'skill' && reference.id === skill.id))
  assert.ok(turn.items.some(item => item.kind === 'tool_result' && item.callId === `${skill.id}-market-read`))
  assert.equal(probe.resourceVerified, true)
  return { runtimeSkillId: skill.id, slashSelectionVerified: true, executedInConversation: true,
    entrySha256: createHash('sha256').update(entry).digest('hex'), installedResourceRead: true, turnId: turn.id }
}

export async function verifyWindowsColdMarketplace(cdp, { workspace, environment, ownedRoot, videoOnly = false, focused = false, acceptance }) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows', 'Use only an ephemeral hosted Windows acceptance runner')
  assert.ok(containment(await realpath(process.env.RUNNER_TEMP), await realpath(ownedRoot)))
  const lock = JSON.parse(await readFile(new URL('../src/shared/marketplace-mirror-lock.json', import.meta.url), 'utf8'))
  const expected = new Map(lock.packages.filter(row => row.platform === 'win32' && row.arch === 'x64').map(row => [row.packageId, row]))
  assert.ok(expected.size, 'The exact release requires a complete Windows marketplace lock')
  const focusedIds = ['superpowers', 'blender-skills', 'docling-mcp']
  const onlyIds = videoOnly ? ['video-shotcraft'] : focused ? focusedIds : null
  const selection = onlyIds ? new Map(onlyIds.map(id => [id, expected.get(id)])) : expected

  const doclingService = focused ? await startPinnedDoclingServe({ workspace, ownedRoot }) : undefined
  try {
    return await withPublicUpstreamsBlocked(async () => {
    const catalog = (await cdp.evaluate('window.workwise.listCatalogPackages()')).packages
    const initial = await cdp.evaluate('window.workwise.listInstalledPlugins()')
    const reports = []
    if (!videoOnly) {
      await cdp.click('.ds-sidebar-shell button', '技能与连接器')
      await cdp.click('[role="tab"]', '插件')
    }
    for (const [id, row] of selection) {
      assert.ok(row, `The mirror lock must include ${id}`)
      assert.ok(!initial.some(item => item.packageId === id), `A cold profile must not have ${id}`)
      const catalogEntry = catalog.find(item => item.package.id === id)
      assert.equal(catalogEntry?.reviewSha256, row.reviewSha256)
      if (id === 'superpowers' || id === 'blender-skills') {
        const offline = id === 'superpowers'
        const install = () => installMarketplacePackageViaUi(cdp, id, catalogEntry.package.name, { useUserScope: !offline, offline })
        const installed = offline ? await withPublicUpstreamsBlocked(install, ['www.railwise.cn']) : await install()
        assert.equal(installed.reviewSha256, row.reviewSha256)
        assert.equal(installed.scope, offline ? 'workspace' : 'user')
        if (offline) assert.equal(await realpath(installed.workspaceRoot), await realpath(workspace))
        const sourceReceipt = JSON.parse(await readFile(join(installed.artifact.location, 'workwise.mirror.json'), 'utf8'))
        assert.deepEqual(sourceReceipt.parts, row.parts)
        assert.ok(containment(await realpath(ownedRoot), await realpath(installed.artifact.location)))
        reports.push({ id, version: installed.version, reviewSha256: installed.reviewSha256,
          artifactSha256: installed.artifact.sha256, lockedParts: row.parts.length, scope: installed.scope, offline, installedViaUi: true })
        continue
      }
      const handle = await cdp.evaluate(`window.workwise.prepareCatalogPlugin(${literal({ sourceId: catalogEntry.sourceId, packageId: id })})`, 360_000)
      assert.equal(handle.reviewSha256, row.reviewSha256)
      const requested = {
        preparedId: handle.id, reviewSha256: handle.reviewSha256, expectedCurrentVersion: null, scope: 'user',
        permissions: handle.package.permissions.map(permission => ({ permissionId: permission.id,
          decision: ['playwright-mcp', 'docling-mcp'].includes(id) ? 'granted' : 'denied' })), idempotencyKey: randomUUID()
      }
      const installed = await cdp.evaluate(`window.workwise.installPreparedPlugin(${literal(requested)})`, 480_000)
      await cdp.evaluate(`window.workwise.cancelPluginImport(${literal(handle.id)})`)
      assert.equal(installed.artifact.sha256, handle.contentSha256)
      assert.ok(containment(await realpath(ownedRoot), await realpath(installed.artifact.location)))
      reports.push({ id, version: installed.version, reviewSha256: installed.reviewSha256, artifactSha256: installed.artifact.sha256, lockedParts: row.parts.length })
    }

    const scope = `/v1/skills?${new URLSearchParams({ scope: 'available', workspace })}`
    const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
    const evidence = { status: 'passed', releaseComplete: false, blockedHosts, installed: reports }
    if (!focused) {
      const current = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result=>result.ok&&JSON.parse(result.body).skills.find(row=>row.name==='video-shotcraft'))`, 'Video Shotcraft loaded in the active workspace', 90_000)
      const skill = await readFile(join(current.root, 'SKILL.md'))
      const videoArtifact = await cdp.evaluate(`window.workwise.listInstalledPlugins().then(all=>all.find(row=>row.packageId==='video-shotcraft'))`)
      assert.ok(containment(await realpath(videoArtifact.artifact.location), await realpath(join(current.root, 'SKILL.md'))),
        'The runtime Skill entry must be inside the reviewed installed mirror payload')
      assert.match(skill.toString('utf8'), /^name:\s*video-shotcraft\s*$/m)
      await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
      await verifyMarketplaceSkillSelection(cdp, composer, current.id, 'Video Shotcraft')
      evidence.videoShotcraft = { runtimeSkillId: current.id, slashSelectionVerified: true, entrySha256: createHash('sha256').update(skill).digest('hex'),
        render: 'pending-licensed-remotion-and-video-runtime' }
    }
    if (videoOnly) return { ...evidence, scope: 'video-shotcraft' }

    const getRuntimeServer = id => `window.workwise.runtimeRequest('/v1/runtime/tools','GET').then(result=>{
      if(!result.ok)return null;
      const row=JSON.parse(result.body).mcpServers.find(item=>item.id===${literal(id)});
      return row?.enabled&&row.available&&row.status==='connected'&&row.toolCount>0?row.toolCount:null;
    })`
    const doclingTools = await cdp.wait(getRuntimeServer('docling-mcp-server'), 'the installed Docling MCP starting from its locked wheelhouse', 150_000)
    const docling = { toolsDiscovered: doclingTools }
    if (focused) {
      evidence.scope = 'docling-and-two-installed-skills'
      docling.csvBackend = await verifyInstalledDoclingCsvBackend(cdp, { workspace, environment, ownedRoot })
      docling.conversion = await invokeInstalledDoclingConversion(cdp, { workspace, environment, ownedRoot, service: doclingService })
    } else {
      await cdp.wait(getRuntimeServer('playwright-mcp-server'), 'the installed Playwright MCP in KUN', 90_000)
      const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='playwright-mcp-server'))`)
      assert.equal(server?.source, 'managed-tool')
      assert.equal(server?.transport, 'stdio')
      evidence.playwright = await invokeInstalledPlaywright(server, workspace, environment)
    }
    const superpowers = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result =>
      result.ok && JSON.parse(result.body).skills.find(row => row.id === 'using-superpowers' && row.scope === 'project'))`,
      'Superpowers loaded in the workspace that installed it', 90_000)
    const blender = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result =>
      result.ok && JSON.parse(result.body).skills.find(row => row.id === 'blender-director' && row.scope === 'global'))`,
      'Blender Skills loaded from the user installation', 90_000)
    assert.ok(acceptance, 'Full marketplace acceptance requires isolated KUN model readback')
    const superpowersExecution = await verifyMarketplaceSkillExecution(cdp, {
      composer, label: 'Using Superpowers', skill: superpowers, scope: 'project', packageId: 'superpowers', acceptance
    })
    const blenderExecution = await verifyMarketplaceSkillExecution(cdp, {
      composer, label: 'Blender Director', skill: blender, scope: 'global', packageId: 'blender-skills', acceptance
    })

    return { ...evidence, docling,
      superpowers: { ...superpowersExecution, offline: true }, blender: blenderExecution }
    })
  } finally {
    await doclingService?.stop()
  }
}
