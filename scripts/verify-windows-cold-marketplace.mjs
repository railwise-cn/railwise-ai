import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join, relative, sep } from 'node:path'
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

async function verifyMarketplaceSkillSelection(cdp, composer, skillId, label) {
  await cdp.fill(composer, `/${skillId}`)
  await cdp.click('[role="option"] .truncate', label)
  await cdp.wait(`Array.from(document.querySelectorAll('[data-composer-skill]')).some(chip => chip.textContent.includes(${literal(label)}))
    && !document.querySelector(${literal(composer)})?.value.includes('/skill:')`, `the ${label} selection chip`)
  await cdp.click('[data-composer-skill] button', `移除 ${label}`)
  await cdp.fill(composer, '')
}

export async function verifyWindowsColdMarketplace(cdp, { workspace, environment, ownedRoot, videoOnly = false }) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows', 'Use only an ephemeral hosted Windows acceptance runner')
  assert.ok(containment(await realpath(process.env.RUNNER_TEMP), await realpath(ownedRoot)))
  const lock = JSON.parse(await readFile(new URL('../src/shared/marketplace-mirror-lock.json', import.meta.url), 'utf8'))
  const expected = new Map(lock.packages.filter(row => row.platform === 'win32' && row.arch === 'x64').map(row => [row.packageId, row]))
  assert.ok(expected.size, 'The exact release requires a complete Windows marketplace lock')
  const selection = videoOnly ? new Map([['video-shotcraft', expected.get('video-shotcraft')]]) : expected

  return withPublicUpstreamsBlocked(async () => {
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
    const current = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result=>result.ok&&JSON.parse(result.body).skills.find(row=>row.name==='video-shotcraft'))`, 'Video Shotcraft loaded in the active workspace', 90_000)
    const skill = await readFile(join(current.root, 'SKILL.md'))
    const videoArtifact = await cdp.evaluate(`window.workwise.listInstalledPlugins().then(all=>all.find(row=>row.packageId==='video-shotcraft'))`)
    assert.ok(containment(await realpath(videoArtifact.artifact.location), await realpath(join(current.root, 'SKILL.md'))),
      'The runtime Skill entry must be inside the reviewed installed mirror payload')
    assert.match(skill.toString('utf8'), /^name:\s*video-shotcraft\s*$/m)
    await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
    const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
    await verifyMarketplaceSkillSelection(cdp, composer, current.id, 'Video Shotcraft')
    const evidence = { status: 'passed', releaseComplete: false, blockedHosts, installed: reports,
      videoShotcraft: { runtimeSkillId: current.id, slashSelectionVerified: true, entrySha256: createHash('sha256').update(skill).digest('hex'),
        render: 'pending-licensed-remotion-and-video-runtime' } }
    if (videoOnly) return { ...evidence, scope: 'video-shotcraft' }

    const getRuntimeServer = id => `window.workwise.runtimeRequest('/v1/runtime/tools','GET').then(result=>{
      if(!result.ok)return null;
      const row=JSON.parse(result.body).mcpServers.find(item=>item.id===${literal(id)});
      return row?.enabled&&row.available&&row.status==='connected'&&row.toolCount>0?row.toolCount:null;
    })`
    const doclingTools = await cdp.wait(getRuntimeServer('docling-mcp-server'), 'the installed Docling MCP starting from its locked wheelhouse', 150_000)
    await cdp.wait(getRuntimeServer('playwright-mcp-server'), 'the installed Playwright MCP in KUN', 90_000)
    const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(all=>all.find(row=>row.id==='playwright-mcp-server'))`)
    assert.equal(server?.source, 'managed-tool')
    assert.equal(server?.transport, 'stdio')
    const playwright = await invokeInstalledPlaywright(server, workspace, environment)
    const superpowers = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result =>
      result.ok && JSON.parse(result.body).skills.find(row => row.id === 'using-superpowers' && row.scope === 'project'))`,
      'Superpowers loaded in the workspace that installed it', 90_000)
    const blender = await cdp.wait(`window.workwise.runtimeRequest(${literal(scope)},'GET').then(result =>
      result.ok && JSON.parse(result.body).skills.find(row => row.id === 'blender-director' && row.scope === 'global'))`,
      'Blender Skills loaded from the user installation', 90_000)
    await verifyMarketplaceSkillSelection(cdp, composer, superpowers.id, 'Using Superpowers')
    await verifyMarketplaceSkillSelection(cdp, composer, blender.id, 'Blender Director')

    return { ...evidence, playwright, docling: { toolsDiscovered: doclingTools },
      superpowers: { runtimeSkillId: superpowers.id, offline: true, slashSelectionVerified: true },
      blender: { runtimeSkillId: blender.id, slashSelectionVerified: true } }
  })
}
