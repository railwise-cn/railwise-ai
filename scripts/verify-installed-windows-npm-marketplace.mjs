import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const packageId = 'playwright-mcp'
const packageName = '@playwright/mcp'
const packageVersion = '0.0.86'
const integrity = 'sha512-4SL9OSINmik3+EObCYJIxH8BkhcqqGU6CM8XIgztW015iBVR9WR6Q0xF180Ery+xuEVyyK5r6nC2bOg3zjgCoA=='
const serverId = `${packageId}-server`
const modal = 'div.fixed.inset-0.z-50:has(header > h2)'
const literal = JSON.stringify

function within(root, path) {
  const value = relative(root, path)
  return Boolean(value && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Drives the real packaged marketplace UI and reads its owned installation. */
export async function verifyInstalledWindowsNpmMarketplace(cdp, { workspace }) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const ownedRoot = await realpath(process.env.RUNNER_TEMP)
  assert.ok(within(ownedRoot, await realpath(workspace)), 'Marketplace acceptance requires an owned temporary workspace')

  const entry = await cdp.evaluate(`Promise.all([window.workwise.listCatalogPackages(),window.workwise.listCatalogSources()]).then(([catalog,sources]) => {
    const entry = catalog.packages.find(item => item.package.id === ${literal(packageId)});
    return entry && {source:entry.package.source,reviewSha256:entry.reviewSha256,
      sourceType:sources.find(item => item.id === entry.sourceId)?.type,components:entry.package.components};
  })`)
  assert.equal(entry?.sourceType, 'built-in')
  assert.equal(entry.source.kind, 'npm')
  assert.equal(entry.source.packageName, packageName)
  assert.equal(entry.source.version, packageVersion)
  assert.equal(entry.source.digest?.value, integrity)
  assert.ok(entry.components.some(component => component.id === serverId && component.type === 'mcp'))
  const installedExpression = `window.workwise.listInstalledPlugins().then(installed => installed.find(item => item.packageId === ${literal(packageId)}))`
  assert.equal(await cdp.evaluate(installedExpression), undefined, 'Marketplace smoke needs a fresh plugin installation')

  const chinese = await cdp.evaluate(`window.workwise.getSettings().then(settings => settings.locale === 'zh')`)
  const install = chinese ? '安装' : 'Install'
  await cdp.click('button', chinese ? '技能与连接器' : 'Skills & connectors')
  await cdp.click('[role="tab"]', chinese ? '插件' : 'Plugins')
  await cdp.click('main [role="button"] .truncate', 'Playwright MCP')
  await cdp.wait(`Array.from(document.querySelectorAll('aside > header > h2')).some(header => header.textContent.trim() === 'Playwright MCP')`, 'Playwright MCP details')
  await cdp.click('aside button', install)
  const title = chinese ? '审查 Playwright MCP' : 'Review Playwright MCP'
  const contentSha256 = await cdp.wait(`(() => {
    const modal = document.querySelector(${literal(modal)});
    if (!modal || modal.querySelector('h2')?.textContent.trim() !== ${literal(title)} || modal.querySelectorAll('input[type="checkbox"]').length !== 1) return null;
    return modal.textContent.match(/SHA-256\\s+([a-f0-9]{64})/)?.[1];
  })()`, 'the Playwright MCP permission and content review', 240_000)
  const permission = `${modal} input[type="checkbox"]`
  if (!await cdp.evaluate(`document.querySelector(${literal(permission)})?.checked === true`)) await cdp.click(permission)
  assert.equal(await cdp.evaluate(`document.querySelector(${literal(permission)})?.checked === true`), true)
  await cdp.click(`${modal} button`, chinese ? '个人' : 'User')
  await cdp.click(`${modal} button`, install)

  const installed = await cdp.wait(installedExpression, 'the installed Playwright MCP receipt', 90_000)
  assert.equal(installed.scope, 'user')
  assert.equal(installed.version, packageVersion)
  assert.equal(installed.reviewSha256, entry.reviewSha256)
  assert.equal(installed.artifact.sha256, contentSha256)
  assert.ok(installed.permissions.some(permission => permission.permissionId === 'browser.control' && permission.decision === 'granted'))
  const artifact = await realpath(installed.artifact.location)
  assert.ok(within(ownedRoot, artifact), 'The npm artifact must be installed inside the owned temporary root')
  const packageDirectory = join(artifact, 'node_modules', '@playwright', 'mcp')
  const manifest = await jsonFile(join(packageDirectory, 'package.json'))
  const lock = await jsonFile(join(artifact, 'package-lock.json'))
  assert.equal(manifest.name, packageName)
  assert.equal(manifest.version, packageVersion)
  assert.equal(lock.packages?.[`node_modules/${packageName}`]?.integrity, integrity)
  assert.equal(lock.packages?.[`node_modules/${packageName}`]?.version, packageVersion)
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[packageId]
  assert.ok(typeof bin === 'string' && bin.length, 'The installed manifest must expose the curated executable')
  const entrypoint = await realpath(join(packageDirectory, bin))
  assert.ok(within(artifact, entrypoint), 'The MCP entrypoint must resolve inside the installed artifact')

  const server = await cdp.evaluate(`window.workwise.listMcpServers(${literal(workspace)}).then(servers => servers.find(item => item.id === ${literal(serverId)}))`)
  assert.equal(server?.source, 'managed-tool')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.enabled, true)
  assert.equal(server.command, 'node.exe')
  assert.equal((await realpath(server.args[0])).toLowerCase(), entrypoint.toLowerCase())
  const discovered = await cdp.wait(`window.workwise.runtimeRequest('/v1/runtime/tools','GET').then(result => {
    if (!result.ok) return null;
    const server = JSON.parse(result.body).mcpServers.find(item => item.id === ${literal(serverId)});
    return server?.enabled && server.available && server.status === 'connected' && server.toolCount > 0 ? server.toolCount : null;
  })`, 'Runtime Playwright MCP initialization and tool discovery', 60_000)
  return {
    status: 'passed', method: 'trusted-pointer-on-marketplace', packageId, packageName, version: packageVersion,
    integrity, artifactSha256: contentSha256, reviewSha256: installed.reviewSha256,
    installedInOwnedProfile: true, registeredCommand: 'node.exe', serverId, toolsDiscovered: discovered, browserToolCalls: 0
  }
}
