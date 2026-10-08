#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const PACK = 'metro-monitoring-agent-pack'
const DOMAIN = 'com.wangjiawei508.workgpt'
const LAYOUT = { agent: 'agents', command: 'prompts', skill: 'skills', tool: 'tools', lib: 'lib', template: 'templates', theme: 'themes' }
const MARKER = '.railwise-acceptance-owner.json'
const fail = message => { throw new Error(message) }
const inside = (root, path) => { const r = relative(root, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }
const digest = data => createHash('sha256').update(data).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)

async function exists(path) {
  try { await lstat(path); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
}

function command(executable, args, allowFailure = false) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    if (allowFailure && !result.error) return null
    fail(`Command failed: ${basename(executable)} (status ${result.status ?? 'timeout'}); output omitted.`)
  }
  return result.stdout
}

async function assertNoSymlinks(path) {
  let current = resolve(path)
  while (current !== dirname(current)) {
    if (await exists(current) && (await lstat(current)).isSymbolicLink()) fail(`Symlink path is not supported: ${current}`)
    current = dirname(current)
  }
}

async function fingerprint(path) {
  if (!await exists(path)) return { present: false }
  const entries = []
  async function visit(current, name) {
    const s = await lstat(current)
    if (s.isSymbolicLink()) fail(`Symlink target is not supported: ${current}`)
    const item = { path: name, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid, type: s.isDirectory() ? 'directory' : 'file' }
    if (s.isDirectory()) {
      entries.push(item)
      for (const child of (await readdir(current)).sort()) await visit(join(current, child), name ? `${name}/${child}` : child)
    } else {
      if (!s.isFile()) fail(`Unsupported filesystem entry: ${current}`)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(current)) hash.update(chunk)
      item.sha256 = hash.digest('hex'); item.bytes = s.size
      entries.push(item)
    }
  }
  await visit(path, '')
  return { present: true, hash: digest(canonical(entries)), entries: entries.length, bytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0) }
}

async function privateJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
  await rename(temp, path)
  let parent
  try { parent = await open(dirname(path), 'r'); await parent.sync() } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(error.code)) throw error
  } finally { await parent?.close() }
}

function context(home, installedApp, testing = false) {
  const guardRoot = join(home, 'Library/Application Support/RailWise Acceptance')
  const userData = join(home, 'Library/Application Support/RailWise AI')
  const workwise = join(home, '.workwise')
  const codex = join(home, '.codex')
  const rootPaths = [
    workwise, userData,
    join(home, 'Library/Caches/workwise-updater'),
    join(home, `Library/Caches/${DOMAIN}`),
    join(home, `Library/Caches/${DOMAIN}.ShipIt`),
    join(home, 'Library/Caches/RailWise AI'),
    join(home, 'Library/Logs/RailWise AI'),
    join(home, `Library/Saved Application State/${DOMAIN}.savedState`)
  ]
  return { home, installedApp, guardRoot, userData, workwise, codex, rootPaths, testing,
    packSource: installedApp ? join(installedApp, 'Contents/Resources/src/asset/agent-packs', PACK) : null,
    preferences: join(home, `Library/Preferences/${DOMAIN}.plist`) }
}

async function assertStopped(ctx) {
  if (ctx.testing) return
  const rows = command('/bin/ps', ['-axo', 'pid=,command=']).trim().split('\n')
  const pids = rows.filter(row => /(?:RailWise AI|WorkWise|WorkGPT|WORKGPT|Kun)\.app\/Contents\//i.test(row)
    || ctx.rootPaths.some(path => row.includes(path))).map(row => Number(row.trim().split(/\s+/, 1)[0])).filter(pid => pid !== process.pid)
  for (const port of [8899, 8788]) {
    const result = command('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], true)
    for (const match of result?.matchAll(/^p(\d+)$/gm) ?? []) pids.push(Number(match[1]))
  }
  if (pids.length) fail(`Quit RailWise and its services before continuing; active PIDs: ${[...new Set(pids)].join(', ')}. Commands omitted.`)
}

async function installedIdentity(ctx) {
  if (!ctx.installedApp) fail('--installed-app must point to the frozen installed package.')
  await assertNoSymlinks(ctx.installedApp)
  const info = join(ctx.installedApp, 'Contents/Info.plist')
  const version = ctx.testing ? '0.5.3' : command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info]).trim()
  const bundleId = ctx.testing ? DOMAIN : command('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', info]).trim()
  if (version !== '0.5.3' || bundleId !== DOMAIN) fail('Expected the normal public-identity 0.5.3 bundle.')
  const asar = join(ctx.installedApp, 'Contents/Resources/app.asar')
  return { version, bundleId, asar: await fingerprint(asar), packManifestHash: digest(await readFile(join(ctx.packSource, 'package.json'))), packContents: await fingerprint(ctx.packSource) }
}

async function inventory(ctx) {
  const identity = await installedIdentity(ctx)
  const manifest = JSON.parse(await readFile(join(ctx.packSource, 'package.json'), 'utf8'))
  const audit = manifest.skillAudit ? JSON.parse(await readFile(join(ctx.packSource, safeRelative(manifest.skillAudit)), 'utf8')) : null
  const assets = new Map()
  for (const asset of manifest.agentAssets ?? []) {
    if (asset.kind === 'skill' && audit && !audit.skills.some(s => s.id === asset.name && s.packaged === true && s.status === 'available')) continue
    const layout = LAYOUT[asset.kind] ?? fail('Unknown asset kind.')
    const path = join(ctx.codex, layout, safeRelative(asset.target || asset.name))
    const sourcePath = join(ctx.packSource, safeRelative(asset.dir))
    await assertNoSymlinks(sourcePath)
    const sourceStats = await lstat(sourcePath)
    assets.set(path, { kind: asset.kind, name: asset.name, directory: sourceStats.isDirectory() })
  }
  const manifestPaths = ['.workwise-agent-packs', '.workgpt-agent-packs'].map(dir => join(ctx.codex, dir, `${PACK}.json`))
  for (const path of manifestPaths) {
    if (!await exists(path)) continue
    await assertNoSymlinks(path)
    const installed = JSON.parse(await readFile(path, 'utf8'))
    if (installed.id !== PACK || resolve(installed.rootPath) !== ctx.codex) fail('Installed pack manifest identity mismatch.')
    for (const asset of installed.assets ?? []) {
      const target = resolve(asset.destination)
      const layout = LAYOUT[asset.kind] ?? fail('Unknown installed asset kind.')
      if (!inside(join(ctx.codex, layout), target)) fail('Installed manifest destination escapes its asset layout.')
      if (!assets.has(target)) assets.set(target, { kind: asset.kind, name: asset.name, directory: asset.targetKind === 'directory' })
    }
  }
  const targets = new Set()
  for (const [path, asset] of assets) {
    targets.add(path)
    if (!asset.directory) for (const suffix of ['.workwise-agent-pack-source.json', '.workgpt-agent-pack-source.json']) targets.add(`${path}${suffix}`)
  }
  for (const path of manifestPaths) { targets.add(path); targets.add(`${path}.workwise-backup`) }
  const paths = [...targets].sort()
  for (const path of paths) {
    if (!inside(ctx.codex, path)) fail('A pack target escapes the Codex root.')
    await assertNoSymlinks(path)
    if (paths.some(other => other !== path && inside(other, path))) fail('Overlapping pack targets are unsupported.')
  }
  const entries = []
  for (const path of ctx.rootPaths) { await assertNoSymlinks(path); entries.push({ path, kind: 'root', before: await fingerprint(path) }) }
  for (const path of paths) entries.push({ path, kind: 'pack', before: await fingerprint(path) })
  await assertNoSymlinks(ctx.preferences)
  entries.push({ path: ctx.preferences, kind: 'preferences', before: await fingerprint(ctx.preferences) })
  return { identity, packVersion: manifest.version, currentAssets: (manifest.agentAssets ?? []).filter(a => a.kind !== 'skill' || !audit || audit.skills.some(s => s.id === a.name && s.packaged === true && s.status === 'available')).length,
    unionAssets: assets.size, entries, transients: await transients(ctx, assets), assets: [...assets].map(([path, asset]) => ({ path, ...asset })) }
}

function safeRelative(raw) {
  if (typeof raw !== 'string' || !raw || isAbsolute(raw) || raw.includes('\\') || raw.split('/').some(p => !p || p === '.' || p === '..')) fail('Unsafe relative asset path.')
  return raw
}

async function transients(ctx, assets) {
  const paths = []
  const prefixes = new Map()
  for (const [path, asset] of assets) {
    const names = prefixes.get(dirname(path)) ?? new Set()
    names.add(`.workwise-install-${asset.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'}-`)
    prefixes.set(dirname(path), names)
  }
  for (const dir of ['.workwise-agent-packs', '.workgpt-agent-packs']) {
    prefixes.set(join(ctx.codex, dir), new Set([`.${PACK}.json.workwise-`]))
  }
  for (const [dir, names] of prefixes) {
    if (!await exists(dir)) continue
    await assertNoSymlinks(dir)
    for (const name of await readdir(dir)) if ([...names].some(prefix => name.startsWith(prefix))) paths.push(join(dir, name))
  }
  for (const path of paths) await assertNoSymlinks(path)
  return paths.sort()
}

async function locked(ctx, session, action) {
  session = resolve(session)
  if (!inside(ctx.guardRoot, session)) fail(`Session must be inside the dedicated RailWise Acceptance directory: ${ctx.guardRoot}`)
  await assertNoSymlinks(ctx.guardRoot); await assertNoSymlinks(session)
  await mkdir(ctx.guardRoot, { recursive: true, mode: 0o700 }); await chmod(ctx.guardRoot, 0o700)
  const lock = join(ctx.guardRoot, '.operation-lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch (e) { if (e.code === 'EEXIST') fail('Another protection operation is active; inspect the private lock owner before recovery.'); throw e }
  try {
    await privateJson(join(lock, 'owner.json'), { pid: process.pid, session, createdAt: new Date().toISOString() })
    const active = join(ctx.guardRoot, '.active-session.json')
    if (await exists(active) && JSON.parse(await readFile(active, 'utf8')).session !== session) fail('Another unresolved acceptance session is reserved.')
    await assertStopped(ctx)
    return await action(session, active)
  } finally { await rm(lock, { recursive: true }) }
}

async function copy(ctx, source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (await exists(destination)) fail('Refusing to replace an existing backup.')
  command('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', source, destination])
  assert.deepEqual(await fingerprint(destination), await fingerprint(source), 'Backup verification failed.')
}

async function evidence(path) {
  if (!path) fail('Provide the private CUA login-item evidence file.')
  const absolute = resolve(path)
  await assertNoSymlinks(absolute)
  if (!await exists(absolute)) fail('Login-item evidence file is missing.')
  return { path: absolute, fingerprint: await fingerprint(absolute) }
}

async function defaultsExport(ctx, destination) {
  if (ctx.testing) { await privateJson(destination, ctx.fakeDefaults); return { present: true, hash: digest(canonical(ctx.fakeDefaults)) } }
  const result = command('/usr/bin/defaults', ['export', DOMAIN, destination], true)
  if (result === null) {
    if (await exists(ctx.preferences)) fail('Defaults export failed while a preferences file exists.')
    return { present: false }
  }
  await chmod(destination, 0o600)
  const json = command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', destination])
  return { present: true, hash: digest(canonical(JSON.parse(json))) }
}

async function snapshot(ctx, session, options = {}) {
  return locked(ctx, session, async (root, active) => {
    if (await exists(root)) fail('Use a new acceptance session directory for snapshot.')
    await mkdir(root, { mode: 0o700 })
    const data = await inventory(ctx)
    for (const [index, entry] of data.entries.entries()) entry.id = String(index).padStart(4, '0')
    const journal = { schema: 'railwise.normal-profile-protection.v1', status: 'snapshotting', session: root, home: ctx.home,
      installedApp: ctx.installedApp, createdAt: new Date().toISOString(), loginOpenAtLogin: options.loginOpenAtLogin,
      loginBefore: await evidence(options.loginBeforeEvidence), ...data }
    if (typeof journal.loginOpenAtLogin !== 'boolean') fail('Record the observed original Open at Login state as true or false.')
    await privateJson(join(root, 'journal.json'), journal)
    if (ctx.testing && ctx.fault === 'snapshot-journal') fail('Synthetic interruption after snapshot journal.')
    await privateJson(active, { session: root, createdAt: journal.createdAt })
    if (ctx.testing && ctx.fault === 'snapshot-active') fail('Synthetic interruption after active reservation.')
    for (const entry of journal.entries) {
      if (entry.before.present) await copy(ctx, entry.path, join(root, 'snapshot', entry.id))
    }
    journal.defaults = await defaultsExport(ctx, join(root, 'defaults-before.plist'))
    journal.status = 'snapshotted'
    await privateJson(join(root, 'journal.json'), journal)
    return { status: journal.status, session: root, protectedEntries: journal.entries.length, unionAssets: journal.unionAssets }
  })
}

async function loadJournal(ctx, root) {
  await assertNoSymlinks(join(root, 'journal.json'))
  const journal = JSON.parse(await readFile(join(root, 'journal.json'), 'utf8'))
  if (journal.schema !== 'railwise.normal-profile-protection.v1' || journal.session !== root || journal.home !== ctx.home || journal.installedApp !== ctx.installedApp) fail('Journal identity mismatch.')
  const expected = new Set([...ctx.rootPaths, ctx.preferences])
  for (const asset of journal.assets) {
    const layout = LAYOUT[asset.kind] ?? fail('Unknown journal asset kind.')
    if (!inside(join(ctx.codex, layout), asset.path)) fail('Journal asset destination escapes its layout.')
    expected.add(asset.path)
    if (!asset.directory) for (const suffix of ['.workwise-agent-pack-source.json', '.workgpt-agent-pack-source.json']) expected.add(`${asset.path}${suffix}`)
  }
  for (const dir of ['.workwise-agent-packs', '.workgpt-agent-packs']) {
    const path = join(ctx.codex, dir, `${PACK}.json`)
    expected.add(path); expected.add(`${path}.workwise-backup`)
  }
  if (journal.entries.length !== expected.size || new Set(journal.entries.map(e => e.path)).size !== expected.size || new Set(journal.entries.map(e => e.id)).size !== expected.size) fail('Journal target union or identifiers are incomplete or duplicated.')
  for (const entry of journal.entries) {
    if (!/^\d{4}$/.test(entry.id)) fail('Unsafe journal entry identifier.')
    if (!expected.has(entry.path)) fail('Journal contains an unexpected target.')
    const expectedKind = ctx.rootPaths.includes(entry.path) ? 'root' : entry.path === ctx.preferences ? 'preferences' : 'pack'
    if (entry.kind !== expectedKind) fail('Journal entry kind differs from its target.')
    await assertNoSymlinks(entry.path)
  }
  return journal
}

async function verifyBackups(ctx, journal) {
  for (const entry of journal.entries) if (entry.before.present) {
    assert.deepEqual(await fingerprint(join(journal.session, 'snapshot', entry.id)), entry.before, `Snapshot changed: entry ${entry.id}`)
  }
}

async function freshSettings(ctx, journal, reuseDeepseek) {
  const settings = { schema: 'workwise.settings', version: 2, revision: 0,
    workspaceRoot: join(ctx.workwise, 'default_workspace'),
    agents: { kun: { dataDir: join(ctx.workwise, 'runtime') } },
    write: { defaultWorkspaceRoot: join(ctx.workwise, 'write_workspace') },
    appBehavior: { openAtLogin: journal.loginOpenAtLogin, startMinimized: false, closeToTray: false },
    claw: { enabled: false, channels: [], tasks: [], im: { enabled: false } }, schedule: { enabled: false, tasks: [] } }
  if (reuseDeepseek) {
    const profileEntry = journal.entries.find(e => e.path === ctx.userData)
    let original
    try { original = JSON.parse(await readFile(join(journal.session, 'snapshot', profileEntry.id, 'workwise-settings.json'), 'utf8')) }
    catch { fail('The original private settings file is unavailable or invalid; its contents are omitted.') }
    const selected = original.provider?.providers?.find(p => p.id === 'deepseek')
    const baseUrl = selected?.baseUrl || original.provider?.baseUrl
    if (!baseUrl || new URL(baseUrl).hostname !== 'api.deepseek.com') fail('Only the existing approved official DeepSeek provider can be seeded.')
    const apiKey = selected?.apiKey || original.provider?.apiKey
    if (typeof apiKey !== 'string' || !apiKey.trim()) fail('The existing DeepSeek credential is unavailable.')
    settings.provider = { apiKey, baseUrl, providers: selected ? [{ id: 'deepseek', name: 'DeepSeek', apiKey, baseUrl,
      endpointFormat: selected.endpointFormat, models: selected.models }] : [] }
  }
  return settings
}

async function activate(ctx, session, options = {}) {
  return locked(ctx, session, async root => {
    const journal = await loadJournal(ctx, root)
    if (journal.status !== 'snapshotted') fail('Only a complete untouched snapshot can be activated.')
    assert.deepEqual(await installedIdentity(ctx), journal.identity, 'The frozen installed package changed.')
    await verifyBackups(ctx, journal)
    for (const entry of journal.entries) assert.deepEqual(await fingerprint(entry.path), entry.before, `Original changed since snapshot: entry ${entry.id}`)
    const settings = await freshSettings(ctx, journal, options.reuseDeepseek)
    journal.status = 'activating'; journal.reusedApprovedDeepseek = options.reuseDeepseek === true
    await privateJson(join(root, 'journal.json'), journal)
    await mkdir(join(root, 'held-originals'), { mode: 0o700 })
    for (const entry of journal.entries.filter(e => e.kind === 'root')) {
      if (entry.before.present) {
        if ((await stat(entry.path)).dev !== (await stat(root)).dev) fail('The original and session must share a filesystem for atomic preservation.')
        entry.moveStarted = true; await privateJson(join(root, 'journal.json'), journal)
        await rename(entry.path, join(root, 'held-originals', entry.id))
        if (ctx.testing && ctx.fault === 'root-moved') fail('Synthetic interruption after first root move.')
      }
      entry.activated = true; await privateJson(join(root, 'journal.json'), journal)
    }
    for (const path of [ctx.workwise, ctx.userData]) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      await privateJson(join(path, MARKER), { session: root })
    }
    for (const sub of ['runtime', 'default_workspace', 'claw', 'write_workspace']) await mkdir(join(ctx.workwise, sub), { mode: 0o700 })
    await privateJson(join(ctx.userData, 'workwise-settings.json'), settings)
    if (ctx.testing) ctx.fakeDefaults = {}
    else {
      const deleted = command('/usr/bin/defaults', ['delete', DOMAIN], true)
      if (deleted === null && journal.defaults.present) fail('Original preferences could not be cleared; stop and restore the partial activation.')
    }
    journal.defaultsActivated = true; journal.status = 'active'
    await privateJson(join(root, 'journal.json'), journal)
    return { status: journal.status, session: root, normalPublicIdentity: true, candidateEnvironment: false, deepseekSeeded: journal.reusedApprovedDeepseek }
  })
}

async function archive(ctx, path, destination) {
  if (!await exists(path)) return
  await assertNoSymlinks(path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  if (await exists(destination)) fail('An archived acceptance item already exists; inspect before resuming.')
  await rename(path, destination)
}

async function verifyOriginals(ctx, journal) {
  for (const entry of journal.entries.filter(e => e.kind !== 'preferences')) {
    assert.deepEqual(await fingerprint(entry.path), entry.before, `Original restoration differs: entry ${entry.id}`)
  }
  const result = await defaultsExport(ctx, join(journal.session, `defaults-verify-${randomUUID()}.plist`))
  assert.deepEqual(result, journal.defaults, 'The original preferences domain differs.')
}

async function abortSnapshot(ctx, session) {
  return locked(ctx, session, async (root, active) => {
    const journal = await loadJournal(ctx, root)
    if (!['snapshotting', 'snapshotted', 'aborted-unactivated'].includes(journal.status)) fail('An activated session must be restored, not aborted.')
    for (const entry of journal.entries) assert.deepEqual(await fingerprint(entry.path), entry.before, 'An original changed; preserve the reservation for investigation.')
    if (await exists(join(root, 'held-originals'))) fail('Held originals exist; use restoration instead.')
    journal.status = 'aborted-unactivated'; journal.abortedAt = new Date().toISOString()
    await privateJson(join(root, 'journal.json'), journal)
    if (ctx.testing && ctx.fault === 'abort-terminal') fail('Synthetic interruption after terminal abort journal.')
    await rm(active, { force: true })
    return { status: journal.status, session: root, privateIncompleteSnapshotRetained: true }
  })
}

async function restorePackEntry(ctx, journal, entry) {
  if (canonical(await fingerprint(entry.path)) === canonical(entry.before)) return
  const archivePath = join(journal.session, 'acceptance-archive', entry.id)
  const stagePath = join(journal.session, 'restore-staging', entry.id)
  if (entry.before.present) {
    if (await exists(stagePath) && canonical(await fingerprint(stagePath)) !== canonical(entry.before)) {
      await archive(ctx, stagePath, join(journal.session, 'acceptance-archive', `incomplete-restore-${entry.id}-${randomUUID()}`))
    }
    if (!await exists(stagePath)) await copy(ctx, join(journal.session, 'snapshot', entry.id), stagePath)
    assert.deepEqual(await fingerprint(stagePath), entry.before, 'The restoration staging copy changed.')
  }
  if (await exists(archivePath)) {
    if (await exists(entry.path)) fail(`Unresolved current target after archival: entry ${entry.id}; preserve it for investigation.`)
    if (entry.archiveFingerprint) assert.deepEqual(await fingerprint(archivePath), entry.archiveFingerprint, 'Archived acceptance data changed.')
  } else if (await exists(entry.path)) {
    entry.archiveFingerprint = await fingerprint(entry.path)
    await privateJson(join(journal.session, 'journal.json'), journal)
    await archive(ctx, entry.path, archivePath)
  }
  if (entry.before.present) {
    await mkdir(dirname(entry.path), { recursive: true })
    await rename(stagePath, entry.path)
  }
  assert.deepEqual(await fingerprint(entry.path), entry.before, 'A pack entry was not restored.')
  entry.restored = true
  await privateJson(join(journal.session, 'journal.json'), journal)
}

async function restore(ctx, session) {
  return locked(ctx, session, async (root, active) => {
    const journal = await loadJournal(ctx, root)
    if (!['activating', 'active', 'restoring', 'restored-pending-login'].includes(journal.status)) fail('There is no active or partial activation to restore.')
    await verifyBackups(ctx, journal)
    journal.status = 'restoring'; await privateJson(join(root, 'journal.json'), journal)
    for (const entry of journal.entries.filter(e => e.kind === 'root')) {
      const held = join(root, 'held-originals', entry.id)
      if (entry.before.present && await exists(held)) {
        assert.deepEqual(await fingerprint(held), entry.before, 'A held original changed.')
        await archive(ctx, entry.path, join(root, 'acceptance-archive', entry.id))
        await rename(held, entry.path)
      } else if (!entry.before.present && entry.activated) {
        await archive(ctx, entry.path, join(root, 'acceptance-archive', entry.id))
      } else assert.deepEqual(await fingerprint(entry.path), entry.before, 'An unowned root changed; do not overwrite it.')
      entry.restored = true; await privateJson(join(root, 'journal.json'), journal)
    }
    for (const entry of journal.entries.filter(e => e.kind === 'pack')) {
      await restorePackEntry(ctx, journal, entry)
    }
    const oldTransients = new Set(journal.transients)
    for (const path of await transients(ctx, new Map(journal.assets.map(a => [a.path, a])))) {
      if (!oldTransients.has(path)) await archive(ctx, path, join(root, 'acceptance-archive', `transient-${digest(path)}`))
    }
    if (ctx.testing) ctx.fakeDefaults = journal.defaults.present ? JSON.parse(await readFile(join(root, 'defaults-before.plist'), 'utf8')) : {}
    else if (journal.defaults.present) command('/usr/bin/defaults', ['import', DOMAIN, join(root, 'defaults-before.plist')])
    else command('/usr/bin/defaults', ['delete', DOMAIN], true)
    await verifyOriginals(ctx, journal)
    journal.status = 'restored-pending-login'; journal.originalsVerifiedAt = new Date().toISOString()
    await privateJson(join(root, 'journal.json'), journal)
    return { status: journal.status, session: root, originalContentModesAndAbsenceVerified: true, loginItemCUAVerificationRequired: true }
  })
}

async function verify(ctx, session, loginAfterEvidence) {
  return locked(ctx, session, async (root, active) => {
    const journal = await loadJournal(ctx, root)
    if (!['restored-pending-login', 'restored'].includes(journal.status)) fail('Restore original data before final verification.')
    await verifyOriginals(ctx, journal)
    journal.loginAfter = await evidence(loginAfterEvidence)
    journal.status = 'restored'; journal.finalVerifiedAt = new Date().toISOString()
    await privateJson(join(root, 'journal.json'), journal)
    if (ctx.testing && ctx.fault === 'verify-terminal') fail('Synthetic interruption after terminal verify journal.')
    await rm(active, { force: true })
    return { status: journal.status, session: root, boundary: 'Data restoration only; CUA reviewer must compare login evidence. This is not product acceptance or release approval.' }
  })
}

async function recoverLock(ctx, session) {
  session = resolve(session)
  if (!inside(ctx.guardRoot, session)) fail('The recovery session is outside the dedicated acceptance directory.')
  const lock = join(ctx.guardRoot, '.operation-lock')
  await assertNoSymlinks(lock)
  const ownerPath = join(lock, 'owner.json')
  if (!await exists(ownerPath)) fail('Lock owner is missing; preserve the lock for read-only/manual recovery review.')
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.session !== session) fail('Malformed or mismatched lock owner; preserve it for recovery review.')
  try { process.kill(owner.pid, 0); fail('The lock owner process is still active.') } catch (error) { if (error.code !== 'ESRCH') throw error }
  await assertStopped(ctx)
  const active = join(ctx.guardRoot, '.active-session.json')
  if (await exists(active) && JSON.parse(await readFile(active, 'utf8')).session !== session) fail('Another unresolved session owns the reservation.')
  const destination = join(ctx.guardRoot, `.recovered-operation-lock-${randomUUID()}`)
  await rename(lock, destination)
  await privateJson(join(destination, 'recovery.json'), { session, originalOwnerPid: owner.pid, recoveredAt: new Date().toISOString() })
  return { status: 'dead-operation-lock-archived', session, ownerWasDefinitelyAbsent: true, nextStep: 'Retry the same session abort-snapshot or restore; no protected data was changed.' }
}

async function selfTest() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'railwise-profile-guard-selftest-')))
  const ctx = context(join(temp, 'home'), join(temp, 'RailWise AI.app'), true)
  ctx.fakeDefaults = { panel: { width: 900 }, retained: true }
  const originalDefaults = structuredClone(ctx.fakeDefaults)
  await mkdir(ctx.packSource, { recursive: true })
  await writeFile(join(ctx.installedApp, 'Contents/Resources/app.asar'), 'synthetic-package')
  const assetFile = join(ctx.packSource, 'assets/example.md')
  await mkdir(dirname(assetFile), { recursive: true }); await writeFile(assetFile, 'new pack example')
  await privateJson(join(ctx.packSource, 'package.json'), { name: PACK, version: '1.2.34', agentAssets: [{ kind: 'agent', name: 'example', dir: 'assets/example.md', target: 'example.md' }] })
  for (const path of ctx.rootPaths.slice(0, 3)) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'original.txt'), `original ${basename(path)}`) }
  await privateJson(join(ctx.userData, 'workwise-settings.json'), { provider: { apiKey: 'synthetic-not-a-real-secret', baseUrl: 'https://api.deepseek.com', providers: [] } })
  await mkdir(join(ctx.codex, 'agents'), { recursive: true })
  const packFile = join(ctx.codex, 'agents/example.md'); await writeFile(packFile, 'original pack')
  await writeFile(`${packFile}.workgpt-agent-pack-source.json`, 'legacy metadata')
  const obsolete = join(ctx.codex, 'skills/old-example'); await mkdir(obsolete, { recursive: true }); await writeFile(join(obsolete, 'SKILL.md'), 'original obsolete')
  const installedManifest = join(ctx.codex, '.workwise-agent-packs', `${PACK}.json`)
  await mkdir(dirname(installedManifest), { recursive: true }); await privateJson(installedManifest, { id: PACK, rootPath: ctx.codex, assets: [{ kind: 'skill', name: 'old-example', destination: obsolete, targetKind: 'directory' }] })
  const unrelated = join(ctx.codex, 'agents/unrelated.md'); await writeFile(unrelated, 'unrelated unchanged')
  const login = join(temp, 'login-before.txt'); await writeFile(login, 'synthetic CUA login state')
  const session = join(ctx.guardRoot, 'synthetic-session')
  const before = await inventory(ctx)
  const checks = []
  await snapshot(ctx, session, { loginOpenAtLogin: false, loginBeforeEvidence: login })
  await assert.rejects(snapshot(ctx, join(ctx.guardRoot, 'conflicting-session'), { loginOpenAtLogin: false, loginBeforeEvidence: login }), /unresolved/); checks.push('concurrent-session-conflict')
  await writeFile(packFile, 'external change before activation')
  await assert.rejects(activate(ctx, session), /Original changed/); checks.push('changed-original-blocks-activation')
  await writeFile(packFile, 'original pack')
  await activate(ctx, session, { reuseDeepseek: true })
  for (const name of ['runtime', 'default_workspace', 'claw', 'write_workspace']) assert.ok(await exists(join(ctx.workwise, name)))
  const seeded = JSON.parse(await readFile(join(ctx.userData, 'workwise-settings.json'), 'utf8'))
  assert.equal(seeded.provider.apiKey, 'synthetic-not-a-real-secret'); assert.equal(seeded.appBehavior.openAtLogin, false)
  await writeFile(join(ctx.workwise, 'runtime/new-data.txt'), 'acceptance data')
  await writeFile(packFile, 'acceptance pack changed'); await writeFile(`${packFile}.workwise-agent-pack-source.json`, 'acceptance metadata')
  await writeFile(join(obsolete, 'SKILL.md'), 'acceptance replaced obsolete')
  await mkdir(ctx.rootPaths[3], { recursive: true }); await writeFile(join(ctx.rootPaths[3], 'acceptance-cache.txt'), 'cache')
  // Reproduce interruption after archival, with an incomplete restoration copy.
  const interrupted = JSON.parse(await readFile(join(session, 'journal.json'), 'utf8'))
  const packEntry = interrupted.entries.find(e => e.path === packFile)
  packEntry.archiveFingerprint = await fingerprint(packFile)
  await mkdir(join(session, 'acceptance-archive'), { recursive: true })
  await rename(packFile, join(session, 'acceptance-archive', packEntry.id))
  await mkdir(join(session, 'restore-staging'), { recursive: true })
  await writeFile(join(session, 'restore-staging', packEntry.id), 'partial copy')
  interrupted.status = 'restoring'; await privateJson(join(session, 'journal.json'), interrupted)
  await restore(ctx, session)
  for (const entry of before.entries.filter(e => e.kind !== 'preferences')) assert.deepEqual(await fingerprint(entry.path), entry.before)
  assert.deepEqual(ctx.fakeDefaults, originalDefaults); assert.equal(await readFile(unrelated, 'utf8'), 'unrelated unchanged')
  checks.push('full-reversible-cycle', 'absence-restored', 'legacy-metadata-and-obsolete-union-restored', 'unrelated-codex-file-preserved', 'fresh-settings-and-migration-targets', 'interrupted-pack-archive-and-partial-copy-recovery')
  ctx.fault = 'verify-terminal'
  await assert.rejects(verify(ctx, session, login), /Synthetic interruption/)
  delete ctx.fault
  await verify(ctx, session, login); assert.equal(await exists(join(ctx.guardRoot, '.active-session.json')), false)
  checks.push('final-login-evidence-required')
  const abortedSession = join(ctx.guardRoot, 'abort-snapshot-session')
  await snapshot(ctx, abortedSession, { loginOpenAtLogin: false, loginBeforeEvidence: login })
  const abortJournal = JSON.parse(await readFile(join(abortedSession, 'journal.json'), 'utf8'))
  abortJournal.status = 'snapshotting'; await privateJson(join(abortedSession, 'journal.json'), abortJournal)
  ctx.fault = 'abort-terminal'
  await assert.rejects(abortSnapshot(ctx, abortedSession), /Synthetic interruption/)
  delete ctx.fault
  await abortSnapshot(ctx, abortedSession)
  assert.equal(await exists(join(ctx.guardRoot, '.active-session.json')), false)
  checks.push('interrupted-unactivated-snapshot-can-be-aborted')
  checks.push('verify-and-abort-terminal-journal-retry')
  for (const fault of ['snapshot-journal', 'snapshot-active']) {
    const faultSession = join(ctx.guardRoot, fault)
    ctx.fault = fault
    await assert.rejects(snapshot(ctx, faultSession, { loginOpenAtLogin: false, loginBeforeEvidence: login }), /Synthetic interruption/)
    delete ctx.fault
    await abortSnapshot(ctx, faultSession)
    assert.equal(await exists(join(ctx.guardRoot, '.active-session.json')), false)
  }
  checks.push('snapshot-journal-and-reservation-crash-recovery')
  const partialSession = join(ctx.guardRoot, 'partial-activation')
  await snapshot(ctx, partialSession, { loginOpenAtLogin: false, loginBeforeEvidence: login })
  ctx.fault = 'root-moved'
  await assert.rejects(activate(ctx, partialSession), /Synthetic interruption/)
  delete ctx.fault
  await restore(ctx, partialSession); await verify(ctx, partialSession, login)
  checks.push('partial-activation-root-move-recovery')
  const deadOwner = spawnSync('/usr/bin/true').pid
  const operationLock = join(ctx.guardRoot, '.operation-lock')
  await mkdir(operationLock)
  await privateJson(join(operationLock, 'owner.json'), { pid: process.pid, session })
  await assert.rejects(recoverLock(ctx, session), /still active/)
  await privateJson(join(operationLock, 'owner.json'), { pid: deadOwner, session })
  await recoverLock(ctx, session)
  assert.equal(await exists(operationLock), false)
  checks.push('dead-lock-recovery-and-live-owner-rejection')
  const { symlink } = await import('node:fs/promises')
  await symlink(join(temp, 'outside'), join(ctx.codex, 'agents/escape.md'))
  await assert.rejects(assertNoSymlinks(join(ctx.codex, 'agents/escape.md')), /Symlink/)
  checks.push('symlink-escape-rejected')
  return { status: 'passed', scope: 'Temporary synthetic directories only; no live profile activation or product acceptance.', checks, privateSyntheticSession: session }
}

async function main() {
  const argv = process.argv.slice(2)
  const operation = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'inventory'
  const options = {}
  while (argv.length) {
    const name = argv.shift()
    if (!name?.startsWith('--')) fail('Expected a named option.')
    if (name === '--reuse-deepseek') options.reuseDeepseek = true
    else { const value = argv.shift(); if (!value || value.startsWith('--')) fail(`Missing value: ${name}`); options[name.slice(2)] = value }
  }
  if (operation === 'self-test') return selfTest()
  if (process.platform !== 'darwin') fail('Normal-profile protection is only supported on macOS.')
  for (const name of ['HOME', 'home', 'CODEX_HOME', 'WORKWISE_CANDIDATE', 'WORKWISE_CANDIDATE_HOME', 'WORKWISE_UPDATE_URL']) {
    if (name.startsWith('WORKWISE_') && process.env[name]) fail('Use normal public mode; remove candidate/updater override variables from the invoking environment.')
  }
  const ctx = context(homedir(), options['installed-app'] ? resolve(options['installed-app']) : null)
  if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== ctx.codex) fail('The active Codex root differs; do not overwrite or redefine CODEX_HOME.')
  if (operation === 'inventory') {
    const data = await inventory(ctx)
    return { operation, readOnly: true, identity: data.identity, packVersion: data.packVersion, currentAssets: data.currentAssets,
      unionAssets: data.unionAssets, protectedEntries: data.entries.length, existingEntries: data.entries.filter(e => e.before.present).length,
      existingTransientItems: data.transients.length, boundary: 'No profile activation, credentials read, or product acceptance.' }
  }
  if (!options.session) fail('--session is required for mutation and restoration operations.')
  if (operation === 'recover-lock') return recoverLock(ctx, options.session)
  if (operation === 'snapshot') {
    if (!['true', 'false'].includes(options['login-open-at-login'])) fail('--login-open-at-login requires true or false from CUA observation.')
    return snapshot(ctx, options.session, { loginOpenAtLogin: options['login-open-at-login'] === 'true', loginBeforeEvidence: options['login-before-evidence'] })
  }
  if (operation === 'activate') return activate(ctx, options.session, options)
  if (operation === 'abort-snapshot') return abortSnapshot(ctx, options.session)
  if (operation === 'restore') return restore(ctx, options.session)
  if (operation === 'verify') return verify(ctx, options.session, options['login-after-evidence'])
  fail(`Unknown operation: ${operation}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1
  })
}
