import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const roots: string[] = []
const pngSource = join(process.cwd(), 'src/asset/skills/ppt-master/templates/brands/中国电信/images/logo.png')
const png = readFileSync(pngSource)
const machO = Buffer.from('cffaedfe00000000000000000000000000000000000000000000000000000000', 'hex')

function fixture(signIgnore?: string | string[]) {
  const root = mkdtempSync(join(tmpdir(), 'railwise-mac-resources-'))
  roots.push(root)
  const app = join(root, 'RailWise AI [test].app')
  const resources = join(app, 'Contents/Resources')
  mkdirSync(resources, { recursive: true })
  const options = {
    signIgnore, identity: 'Developer ID Application: Test', timestamp: 'http://timestamp.apple.com/ts01', hardenedRuntime: true,
    forceCodeSigning: true, entitlements: '/build/entitlements.mac.plist', entitlementsInherit: '/build/entitlements.mac.inherit.plist'
  }
  const context = {
    appOutDir: root, electronPlatformName: 'darwin', arch: 'x64',
    packager: { appInfo: { productFilename: 'RailWise AI [test]' }, platformSpecificBuildOptions: options }
  }
  const put = (relative: string, bytes = png, mode = 0o644) => {
    const path = join(resources, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes, { mode })
    return path
  }
  return { root, app, resources, options, context, put }
}

function ignored(options: { signIgnore?: string | string[] }, path: string) {
  const rules = options.signIgnore == null ? [] : Array.isArray(options.signIgnore) ? options.signIgnore : [options.signIgnore]
  return rules.some((rule) => new RegExp(rule).test(path))
}

// Run the actual afterPack hook without native sidecar smoke/signing processes.
function loadAfterPackWithVerificationStubs() {
  const stubs = [
    ['verify-packaged-markitdown.cjs', { verifyMarkItDownSidecar: () => {} }],
    ['verify-packaged-asar.cjs', { verifyAsarArchive: () => ({ files: 1, compiledFiles: 1 }) }],
    ['dependency-artifact-policy.cjs', { verifyBundledDependencyArtifacts: () => {} }],
    ['verify-packaged-markdown-rendering.cjs', { verifyPackagedMarkdownRendering: () => ({ assets: 8, notices: 5 }) }],
    ['runtime-package-packaging.cjs', { verifyPackagedCanvas: () => ({ packages: 6, platform: 'darwin', arch: 'x64' }) }]
  ] as const
  const saved = new Map<string, NodeJS.Module | undefined>()
  const hook = require.resolve('../../scripts/after-pack.cjs')
  saved.set(hook, require.cache[hook])
  try {
    for (const [name, exports] of stubs) {
      const path = require.resolve(`../../scripts/${name}`)
      require(path)
      const entry = require.cache[path]!
      saved.set(path, entry)
      require.cache[path] = { ...entry, exports: { ...entry.exports, ...exports } }
    }
    delete require.cache[hook]
    return require(hook)
  } finally {
    for (const [path, entry] of saved) {
      if (entry) require.cache[path] = entry
      else delete require.cache[path]
    }
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// These packing fixtures require POSIX paths, file modes and symlinks.
describe.skipIf(process.platform === 'win32')('macOS PNG resource signing exclusions', () => {
  it('configures the normal signer after packing the actual failed PNG without changing resource bytes or signing requirements', async () => {
    vi.stubEnv('MAC_SIGN', '1')
    const f = fixture('\\.kext$')
    const hook = loadAfterPackWithVerificationStubs()
    const unpacked = join(f.resources, 'app.asar.unpacked')
    for (const path of hook.MANAGED_RUNTIME_REQUIRED_PATHS) {
      const staged = path.replace('kun/node_modules/', 'kun/runtime-deps/')
      mkdirSync(dirname(join(unpacked, staged)), { recursive: true })
      writeFileSync(join(unpacked, staged), '{}')
    }
    f.put('app.asar.unpacked/node_modules/better-sqlite3/package.json', Buffer.from('{}'))
    f.put('app.asar.unpacked/sidecars/markitdown/workwise-markitdown', machO, 0o755)
    const logo = f.put('app.asar.unpacked/sidecars/markitdown/_internal/ppt-master/templates/brands/中国电信/images/logo.png')
    const before = { ...f.options }
    await hook(f.context)

    expect(ignored(f.options, logo)).toBe(true)
    expect(ignored(f.options, `${logo}.node`)).toBe(false)
    expect(ignored(f.options, join(f.resources, 'device.kext'))).toBe(true)
    expect(f.options).toMatchObject({ identity: before.identity, timestamp: before.timestamp, hardenedRuntime: before.hardenedRuntime })
    expect(f.options).toMatchObject({ forceCodeSigning: before.forceCodeSigning, entitlements: before.entitlements, entitlementsInherit: before.entitlementsInherit })
    expect(readFileSync(logo)).toEqual(readFileSync(pngSource))
    expect(statSync(logo).mode & 0o777).toBe(0o644)
  })

  it('retains executable, native, unknown, malformed, linked and out-of-scope files', () => {
    const hook = require('../../scripts/after-pack.cjs')
    const f = fixture()
    const good = f.put('data/logo.png')
    const paths = [
      f.put('native/disguised.png', machO),
      f.put('native/script.png', Buffer.from('#!/bin/sh\necho executable\n')),
      f.put('native/addon.node', machO),
      f.put('native/lib.dylib', machO),
      f.put('native/data.node'),
      f.put('native/extensionless', machO),
      f.put('data/executable.png', png, 0o755),
      f.put('data/unknown.png', Buffer.from([0, 1, 2, 3])),
      f.put('data/truncated.png', png.subarray(0, png.length - 1)),
      f.put('data/trailing.png', Buffer.concat([png, machO])),
      f.put('data/header-only.png', png.subarray(0, 33)),
      f.put('data/unreadable.png'),
      f.put('data/oversized.png'),
      join(f.resources, 'data/missing.png'),
      join(f.resources, 'data/symlink.png'),
      join(f.resources, 'linked/logo.png'),
      join(f.app, 'Contents/MacOS/logo.png'),
      join(f.root, 'outside.png')
    ]
    chmodSync(join(f.resources, 'data/unreadable.png'), 0o000)
    truncateSync(join(f.resources, 'data/oversized.png'), 16 * 1024 * 1024 + 1)
    symlinkSync(good, join(f.resources, 'data/symlink.png'))
    symlinkSync(dirname(good), join(f.resources, 'linked'))
    mkdirSync(join(f.app, 'Contents/MacOS'), { recursive: true })
    copyFileSync(pngSource, join(f.app, 'Contents/MacOS/logo.png'))
    copyFileSync(pngSource, join(f.root, 'outside.png'))
    mkdirSync(join(f.resources, 'directory.png'))

    hook._internals.configureMacResourceSigning(f.context)
    expect(ignored(f.options, good)).toBe(true)
    for (const path of [...paths, f.app, join(f.resources, 'directory.png')]) expect(ignored(f.options, path), path).toBe(false)
    expect(ignored(f.options, good.replace('[test]', 'xtestx'))).toBe(false)
    expect(ignored(f.options, `${good}\n`)).toBe(false)
  })

  it('rejects invalid PNG chunk lengths, CRCs and IHDR fields', () => {
    const hook = require('../../scripts/after-pack.cjs')
    const f = fixture()
    const invalidCrc = Buffer.from(png)
    invalidCrc[29] ^= 1
    const invalidLength = Buffer.from(png)
    invalidLength.writeUInt32BE(0xffffffff, 8)
    const invalidHeader = Buffer.from(png)
    invalidHeader[24] = 3
    invalidHeader.writeUInt32BE(crc32(invalidHeader.subarray(12, 29)), 29)
    const paths = [f.put('crc.png', invalidCrc), f.put('length.png', invalidLength), f.put('header.png', invalidHeader)]
    hook._internals.configureMacResourceSigning(f.context)
    for (const path of paths) expect(ignored(f.options, path)).toBe(false)
  })

  it('refreshes exact-path exclusions on repeated packing and preserves user exclusions', () => {
    const hook = require('../../scripts/after-pack.cjs')
    const f = fixture(['custom-user-rule'])
    const good = f.put('logo.png')
    hook._internals.configureMacResourceSigning(f.context)
    const firstRules = [...f.options.signIgnore!]
    hook._internals.configureMacResourceSigning(f.context)
    expect(f.options.signIgnore).toEqual(firstRules)
    writeFileSync(good, machO)
    hook._internals.configureMacResourceSigning(f.context)
    expect(ignored(f.options, good)).toBe(false)
    expect(f.options.signIgnore).toEqual(['custom-user-rule'])
  })

  it('leaves other platforms and absent options unchanged', () => {
    const hook = require('../../scripts/after-pack.cjs')
    const f = fixture()
    f.put('logo.png')
    f.context.electronPlatformName = 'win32'
    hook._internals.configureMacResourceSigning(f.context)
    expect(f.options.signIgnore).toBeUndefined()
    expect(() => hook._internals.configureMacResourceSigning({
      ...f.context, electronPlatformName: 'darwin',
      packager: { ...f.context.packager, platformSpecificBuildOptions: undefined }
    })).not.toThrow()
  })
})
