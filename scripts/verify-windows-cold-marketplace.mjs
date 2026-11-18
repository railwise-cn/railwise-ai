import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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

async function withPublicUpstreamsBlocked(run) {
  const hostsFile = join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts')
  assert.ok((await lstat(hostsFile)).isFile(), 'Expected the hosted runner system hosts file')
  const before = await readFile(hostsFile)
  const marker = randomUUID()
  const policy = Buffer.concat([before, Buffer.from(`\r\n# RailWise isolated mirror smoke ${marker}\r\n${blockedHosts.map(host => `127.0.0.1 ${host}\r\n::1 ${host}`).join('\r\n')}\r\n`)])
  const flush = () => execFileSync('ipconfig.exe', ['/flushdns'], { windowsHide: true, stdio: 'ignore' })
  try {
    await writeFile(hostsFile, policy)
    flush()
    for (const host of blockedHosts) {
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

async function inspectDoclingLaunch(cdp, workspace, ownedRoot) {
  const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='docling-mcp-server'))`)
  assert.equal(server?.source, 'managed-tool')
  assert.equal(server?.transport, 'stdio')
  const canonicalRoot = await realpath(ownedRoot)
  assert.ok(containment(canonicalRoot, await realpath(server.command)))
  assert.deepEqual(server.env ?? {}, {})
  const probe = async args => {
    const transport = new StdioClientTransport({ command: server.command, args, cwd: server.cwd, env: {}, stderr: 'pipe' })
    const client = new Client({ name: 'railwise-installed-docling-startup-diagnostic', version: '1.0.0' })
    const begin = Date.now()
    let stderr = ''
    transport.stderr?.on('data', data => { stderr = (stderr + data.toString()).slice(-4096) })
    const result = {}
    try {
      await client.connect(transport, { timeout: 60_000 })
      const discovered = await client.listTools(undefined, { timeout: 15_000 })
      result.tools = discovered.tools.length
    } catch (error) {
      result.error = error instanceof Error ? error.message.slice(0, 300) : 'unknown child error'
    } finally {
      await client.close().catch(() => undefined)
    }
    return { ...result, elapsedMs: Date.now() - begin, stderr: stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replaceAll(ownedRoot, '<owned-runner-profile>').replaceAll(workspace, '<workspace>')
      .replace(/\b(token|password|authorization|api[_-]?key)[\s=:]+[^\s,]+/gi, '$1=<redacted>').slice(-2200) }
  }
  const native = await probe(server.args)
  const evidence = { ...native, launchedFromOwnedProfile: true,
    stdioArgPresent: server.args.some((arg, i) => arg === '--transport' && server.args[i + 1] === 'stdio'),
    configuredStartupTimeoutMs: server.startupTimeoutMs }
  if (native.tools || !/filename or extension is too long/i.test(native.stderr)) return evidence
  const [isolated, launcher, sitePackages, ...remaining] = server.args
  assert.equal(isolated, '-I')
  assert.ok(launcher.endsWith('workwise-python-launcher.py') && sitePackages.endsWith('site-packages'))
  for (const path of [launcher, sitePackages]) assert.ok(containment(canonicalRoot, await realpath(path)))
  const extendedLauncher = win32.toNamespacedPath(launcher)
  const extendedPackages = win32.toNamespacedPath(sitePackages)
  assert.notEqual(extendedLauncher, launcher)
  assert.notEqual(extendedPackages, sitePackages)
  evidence.extendedPaths = await probe([isolated, extendedLauncher, extendedPackages, ...remaining])
  if (!evidence.extendedPaths.tools && /(?:pywintypes|pythoncom|win32api|win32con|win32job)/i.test(evidence.extendedPaths.stderr)) {
    const pythonPaths = ['win32', 'win32/lib', 'pythonwin']
    const module = 'win32/lib/pywin32_bootstrap.py'
    for (const path of [...pythonPaths, 'pywin32_system32', module]) {
      assert.ok(containment(await realpath(sitePackages), await realpath(join(sitePackages, path))))
    }
    const bootstrap = ['import runpy, sys', 'from pathlib import Path', 'sys.argv = sys.argv[1:]', 'site_packages = Path(sys.argv[1])',
      `sys.path[0:0] = [str(site_packages), *(str(site_packages / path) for path in ${literal(pythonPaths)})]`,
      `runpy.run_path(str(site_packages / ${literal(module)}))`, 'runpy.run_path(sys.argv[0], run_name="__main__")'].join('\n')
    evidence.extendedPathsWithPinnedBootstrap = await probe([isolated, '-c', bootstrap, extendedLauncher, extendedPackages, ...remaining])
  }
  return evidence
}

export async function verifyWindowsColdMarketplace(cdp, { workspace, environment, ownedRoot, mode = 'marketplace', observe }) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows', 'Use only an ephemeral hosted Windows acceptance runner')
  assert.ok(containment(await realpath(process.env.RUNNER_TEMP), await realpath(ownedRoot)))
  const lock = JSON.parse(await readFile(new URL('../src/shared/marketplace-mirror-lock.json', import.meta.url), 'utf8'))
  assert.ok(['marketplace', 'connectors', 'video'].includes(mode))
  const selected = mode === 'video' ? ['video-shotcraft'] : mode === 'connectors' ? ['docling-mcp', 'playwright-mcp'] : undefined
  const expected = new Map(lock.packages.filter(row => row.platform === 'win32' && row.arch === 'x64' &&
    (!selected || selected.includes(row.packageId))).map(row => [row.packageId, row]))
  assert.ok(expected.size, 'The exact release requires a complete Windows marketplace lock')
  if (selected) assert.deepEqual([...expected.keys()].sort(), selected)

  const proof = { status: 'running', mode, releaseComplete: false, blockedHosts, installed: [], expectedPackages: expected.size }
  observe(proof)
  return withPublicUpstreamsBlocked(async () => {
    const catalog = (await cdp.evaluate('window.workwise.listCatalogPackages()')).packages
    const initial = await cdp.evaluate('window.workwise.listInstalledPlugins()')
    for (const [id, row] of expected) {
      proof.currentPackage = id
      assert.ok(!initial.some(item => item.packageId === id), `A cold profile must not have ${id}`)
      const catalogEntry = catalog.find(item => item.package.id === id)
      assert.equal(catalogEntry?.reviewSha256, row.reviewSha256)
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
      proof.installed.push({ id, version: installed.version, reviewSha256: installed.reviewSha256, artifactSha256: installed.artifact.sha256, lockedParts: row.parts.length })
    }
    delete proof.currentPackage

    if (mode !== 'connectors') {
      const scope = `/v1/skills?${new URLSearchParams({ scope: 'available', workspace })}`
      const current = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result=>result.ok&&JSON.parse(result.body).skills.find(row=>row.name==='video-shotcraft'))`, 'Video Shotcraft loaded in the active workspace', 90_000)
      const skill = await readFile(join(current.root, 'SKILL.md'))
      const videoArtifact = await cdp.evaluate(`window.workwise.listInstalledPlugins().then(all=>all.find(row=>row.packageId==='video-shotcraft'))`)
      assert.ok(containment(await realpath(videoArtifact.artifact.location), await realpath(join(current.root, 'SKILL.md'))),
        'The runtime Skill entry must be inside the reviewed installed mirror payload')
      assert.match(skill.toString('utf8'), /^name:\s*video-shotcraft\s*$/m)
      await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
      const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
      await cdp.fill(composer, '/video-shotcraft')
      await cdp.click('[role="option"] .truncate', current.name)
      await cdp.wait(`document.querySelector(${literal(composer)})?.value === ${literal(`/skill:${current.id} `)}`, 'the exact installed Skill token after choosing /')
      await cdp.fill(composer, '')

      proof.videoShotcraft = { runtimeSkillId: current.id, slashSelectionVerified: true,
        entrySha256: createHash('sha256').update(skill).digest('hex'), render: 'pending-licensed-remotion-and-video-runtime' }
    }

    if (mode !== 'video') {
      const runtimeServer = id => `window.workwise.runtimeRequest('/v1/runtime/tools','GET').then(result=>
        result.ok?JSON.parse(result.body).mcpServers.find(item=>item.id===${literal(id)}):null)`
      const outcomes = await Promise.allSettled(['docling-mcp-server', 'playwright-mcp-server'].map(async id => {
        const tools = await cdp.wait(`${runtimeServer(id)}.then(row=>
          row?.enabled&&row.available&&row.status==='connected'&&row.toolCount>0?row.toolCount:null)`,
        `the exact installed ${id} registering tools in KUN`, 150_000).catch(async error => {
          const row = await cdp.evaluate(runtimeServer(id)).catch(() => null)
          proof.connectorDiagnostics ??= {}
          proof.connectorDiagnostics[id] = row ? { enabled: row.enabled, available: row.available, status: row.status,
            tools: row.toolCount, lastError: row.lastError?.slice(0, 300) } : { registered: false }
          if (id === 'docling-mcp-server') proof.connectorDiagnostics[id].directInstalledLaunch = await inspectDoclingLaunch(cdp, workspace, ownedRoot)
            .catch(error => ({ diagnosticError: error instanceof Error ? error.message : 'unavailable' }))
          throw error
        })
        if (id === 'docling-mcp-server') {
          proof.docling = { toolsDiscovered: tools }
          return
        }
        const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='playwright-mcp-server'))`)
        assert.equal(server?.source, 'managed-tool')
        assert.equal(server?.transport, 'stdio')
        proof.playwright = await invokeInstalledPlaywright(server, workspace, environment)
      }))
      const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason.message)
      assert.equal(failures.length, 0, failures.join(' / '))
    }
    proof.status = 'passed'
    return proof
  }).catch(error => {
    proof.status = 'failed'
    throw error
  })
}
