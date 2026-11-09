#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { PUBLIC_IDENTITY } from './verify-reviewed-release-artifacts.mjs'
import publication from './release-publication.cjs'

const require = createRequire(import.meta.url)
const NSIS_NAMESPACE = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')
const fail = message => { throw new Error(`[windows-install-smoke] ${message}`) }
function equal(actual, expected, label) { if (actual !== expected) fail(`${label}: expected ${expected}, received ${actual}`) }
function digest(bytes, algorithm = 'sha256', encoding = 'hex') { return createHash(algorithm).update(bytes).digest(encoding) }

// electron-builder 26.x derives the stable NSIS identity from appId with this
// namespace. Verify the actual registry key; changing only DisplayName is not
// enough to prove compatibility with existing Windows installations.
export function nsisGuid(appId = PUBLIC_IDENTITY.bundleId) {
  const bytes = createHash('sha1').update(NSIS_NAMESPACE).update(appId).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function installIdentity(version, sourceHead) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('a stable package version is required')
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) fail('an exact source HEAD is required')
  const guid = nsisGuid()
  return {
    version, sourceHead, ...PUBLIC_IDENTITY, guid,
    installerName: publication.expectedReleaseFiles(version).find(file => file.platform === 'win32-x64' && file.name.endsWith('.exe'))?.name,
    executableName: `${PUBLIC_IDENTITY.productName}.exe`,
    uninstallerName: `Uninstall ${PUBLIC_IDENTITY.productName}.exe`,
    shortcutName: `${PUBLIC_IDENTITY.productName}.lnk`,
    installRegistryKey: `Software\\${guid}`,
    uninstallRegistryKey: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
  }
}

export function inspectInstaller(path, identity) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail('installer must be a nonempty regular file')
  equal(basename(path), identity.installerName, 'installer filename')
  const bytes = readFileSync(path)
  const metadata = parse(readFileSync(join(resolve(path, '..'), 'latest.yml'), 'utf8'))
  equal(metadata.version, identity.version, 'Windows update version')
  const entry = metadata.files?.find(file => file.url === identity.installerName)
  if (!entry) fail('exact installer is missing from latest.yml')
  equal(entry.size, stat.size, 'Windows update size')
  equal(entry.sha512, digest(bytes, 'sha512', 'base64'), 'Windows update SHA-512')
  return { path: resolve(path), name: basename(path), sha256: digest(bytes), size: stat.size }
}

export function inspectInstalledPackage(directory, identity) {
  const path = join(directory, 'resources', 'app.asar')
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail('installed ASAR must be a nonempty regular file')
  const metadata = JSON.parse(require('@electron/asar').extractFile(path, 'package.json').toString('utf8'))
  const result = { name: metadata.name, productName: metadata.productName, version: metadata.version,
    sourceHead: metadata.buildProvenance?.sourceHead, asarSha256: digest(readFileSync(path)), asarSize: stat.size }
  for (const key of ['version', 'sourceHead', 'productName']) equal(result[key], identity[key], `installed package ${key}`)
  equal(result.name, identity.packageName, 'installed package legacy name')
  return result
}

function samePath(actual, expected, label) {
  if (typeof actual !== 'string' || !win32.isAbsolute(actual)) fail(`${label} must be an absolute Windows path`)
  equal(win32.resolve(actual).toLowerCase(), win32.resolve(expected).toLowerCase(), label)
}
function hash(value, label) { if (!/^[a-f0-9]{64}$/.test(value ?? '')) fail(`${label} requires a SHA-256`) }
function versionInfo(info, identity, label) {
  equal(info?.productName, identity.productName, `${label} product name`)
  for (const key of ['productVersion', 'fileVersion']) {
    if (![identity.version, `${identity.version}.0`].includes(info?.[key])) fail(`${label} ${key} does not match ${identity.version}`)
  }
}
function signature(info, label) {
  // This repository does not configure a Windows signing certificate. Report
  // NotSigned explicitly; an invalid or indeterminate signature cannot pass.
  if (!['Valid', 'NotSigned'].includes(info?.status)) fail(`${label} Authenticode status is ${info?.status ?? 'missing'}`)
  if (info.status === 'Valid' && !info.signerThumbprint) fail(`${label} signer identity is missing`)
}

export function validateInstallReport(report, identity) {
  equal(report?.schemaVersion, 1, 'report schema')
  equal(report.scope, 'private-exact-package-install', 'report scope')
  equal(report.platform, 'win32', 'platform')
  equal(report.arch, 'x64', 'architecture')
  equal(report.version, identity.version, 'version')
  equal(report.sourceHead, identity.sourceHead, 'source HEAD')
  equal(report.runner?.environment, 'github-hosted', 'runner environment')
  equal(report.runner?.os, 'Windows', 'runner OS')
  equal(report.provenance?.sourceHead, identity.sourceHead, 'workflow source HEAD')
  for (const key of ['runId', 'runAttempt']) if (!/^[1-9]\d*$/.test(String(report.provenance?.[key] ?? ''))) fail(`workflow ${key} is missing`)
  equal(report.productionTouched, false, 'production mutation')
  if (!Array.isArray(report.errors) || report.errors.length) fail(`execution errors: ${report.errors?.join('; ') ?? 'missing'}`)
  for (const key of ['registryAbsent', 'shortcutsAbsent', 'targetAbsent']) equal(report.cleanScope?.[key], true, `clean scope ${key}`)
  equal(report.install?.exitCode, 0, 'installer exit code')
  const installer = report.installer
  equal(installer?.name, identity.installerName, 'installer name')
  hash(installer.sha256, 'installer')
  if (!Number.isSafeInteger(installer.size) || installer.size < 1) fail('installer size is missing')
  versionInfo(installer.versionInfo, identity, 'installer')
  signature(installer.authenticode, 'installer')
  const directory = report.target?.directory
  const tempRoot = report.runner?.tempRoot
  if (!win32.isAbsolute(directory ?? '') || !win32.isAbsolute(tempRoot ?? '')) fail('target and runner temp paths are required')
  const relative = win32.relative(tempRoot, directory)
  if (!relative || relative.startsWith('..') || win32.isAbsolute(relative)) fail('installation must remain inside the runner temporary directory')
  samePath(report.target.executable, win32.join(directory, identity.executableName), 'installed executable')
  samePath(report.target.uninstaller, win32.join(directory, identity.uninstallerName), 'owned uninstaller')
  versionInfo(report.target.versionInfo, identity, 'installed executable')
  signature(report.target.authenticode, 'installed executable')
  const metadata = report.target.package
  for (const key of ['version', 'sourceHead', 'productName']) equal(metadata?.[key], identity[key], `ASAR ${key}`)
  equal(metadata?.name, identity.packageName, 'ASAR legacy package name')
  hash(metadata.asarSha256, 'installed ASAR')
  if (!Number.isSafeInteger(metadata.asarSize) || metadata.asarSize < 1) fail('installed ASAR size is missing')
  for (const [name, key] of [['install', identity.installRegistryKey], ['uninstall', identity.uninstallRegistryKey]]) {
    const entry = report.registry?.[name]
    equal(entry?.hive, 'CurrentUser', `${name} registry hive`)
    equal(entry?.view, 'Registry64', `${name} registry view`)
    equal(entry?.key, key, `${name} registry identity`)
  }
  samePath(report.registry.install.values?.InstallLocation, directory, 'registry install location')
  equal(report.registry.install.values?.ShortcutName, identity.productName, 'registry shortcut name')
  equal(report.registry.uninstall.values?.DisplayName, identity.productName, 'uninstall display name')
  equal(report.registry.uninstall.values?.DisplayVersion, identity.version, 'uninstall display version')
  equal(report.registry.uninstall.values?.UninstallString, `"${report.target.uninstaller}" /currentuser`, 'uninstall command')
  if (!Array.isArray(report.shortcuts) || report.shortcuts.length !== 2) fail('desktop and Start Menu shortcut evidence is required')
  for (const kind of ['desktop', 'start-menu']) {
    const entry = report.shortcuts.find(item => item.kind === kind)
    equal(entry?.name, identity.shortcutName, `${kind} shortcut name`)
    equal(win32.basename(entry.path), identity.shortcutName, `${kind} shortcut file`)
    equal(entry.scope, 'current-user', `${kind} shortcut scope`)
    samePath(entry.target, report.target.executable, `${kind} shortcut target`)
  }
  for (const key of ['attempted', 'ownedInstanceVerified', 'registryAbsent', 'shortcutsAbsent', 'appExecutableAbsent']) equal(report.cleanup?.[key], true, `cleanup ${key}`)
  equal(report.cleanup?.exitCode, 0, 'uninstaller exit code')
  if (!Array.isArray(report.profileSentinels) || report.profileSentinels.length !== 2) fail('profile preservation evidence is required')
  for (const sentinel of report.profileSentinels) {
    hash(sentinel.beforeSha256, 'profile sentinel')
    equal(sentinel.afterSha256, sentinel.beforeSha256, 'profile sentinel preservation')
  }
  return { status: 'passed', installerSha256: installer.sha256, installedAsarSha256: metadata.asarSha256,
    windowsSigning: [installer.authenticode.status, report.target.authenticode.status].every(value => value === 'Valid') ? 'verified' : 'not-configured',
    signatureStatuses: { installer: installer.authenticode.status, installedExecutable: report.target.authenticode.status } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, version, sourceHead, path] = process.argv.slice(2)
  const identity = installIdentity(version, sourceHead)
  if (command === 'config') console.log(JSON.stringify({ ...identity, installer: inspectInstaller(path, identity) }))
  else if (command === 'inspect') console.log(JSON.stringify(inspectInstalledPackage(path, identity)))
  else if (command === 'verify') {
    const report = JSON.parse(readFileSync(path, 'utf8'))
    report.verification = validateInstallReport(report, identity)
    report.status = 'passed'
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report.verification))
  } else fail('expected config, inspect or verify command')
}
