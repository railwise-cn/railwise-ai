import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builderConfig = require('../../electron-builder.cjs')
const beforePack = require('../../scripts/before-pack.cjs')
const afterPack = require('../../scripts/after-pack.cjs')
const packagedAsar = require('../../scripts/verify-packaged-asar.cjs')
const macReleaseArtifacts = require('../../scripts/verify-mac-release-artifacts.cjs')
const asar = require('@electron/asar')
const macNotarize = require('../../scripts/mac-notarize.cjs')

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ds-gui-packaging-'))
  tempRoots.push(root)
  return root
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '{}\n', 'utf8')
}

function loadBuilderConfigWithEnv(env: Record<string, string | undefined>): typeof builderConfig {
  const configPath = require.resolve('../../electron-builder.cjs')
  const previous = new Map<string, string | undefined>()
  const isolatedReleaseEnv = join(tempRoot(), 'release.local.env')
  writeFileSync(isolatedReleaseEnv, '# isolated packaging test\n', 'utf8')
  const isolatedEnv = {
    WORKWISE_RELEASE_ENV: isolatedReleaseEnv,
    ...env
  }
  for (const [key, value] of Object.entries(isolatedEnv)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  delete require.cache[configPath]
  try {
    return require(configPath)
  } finally {
    delete require.cache[configPath]
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    require(configPath)
  }
}

function createCandidatePackagingRepo(): { repo: string; sourceHead: string } {
  const fixtureRoot = tempRoot()
  const repo = join(fixtureRoot, 'repo')
  mkdirSync(join(repo, 'kun'), { recursive: true })
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'src', 'shared'), { recursive: true })
  copyFileSync(join(process.cwd(), 'src/shared/product-brand.json'), join(repo, 'src/shared/product-brand.json'))
  mkdirSync(join(repo, 'src', 'asset', 'agent-packs', 'metro-monitoring-agent-pack'), { recursive: true })
  copyFileSync(join(process.cwd(), 'electron-builder.cjs'), join(repo, 'electron-builder.cjs'))
  copyFileSync(join(process.cwd(), 'kun', 'package-lock.json'), join(repo, 'kun', 'package-lock.json'))
  copyFileSync(
    join(process.cwd(), 'scripts', 'candidate-source-provenance.cjs'),
    join(repo, 'scripts', 'candidate-source-provenance.cjs')
  )
  copyFileSync(
    join(process.cwd(), 'scripts', 'markitdown-packaging-policy.cjs'),
    join(repo, 'scripts', 'markitdown-packaging-policy.cjs')
  )
  copyFileSync(
    join(process.cwd(), 'scripts', 'specialist-skill-audit.cjs'),
    join(repo, 'scripts', 'specialist-skill-audit.cjs')
  )
  copyFileSync(
    join(process.cwd(), 'src', 'asset', 'agent-packs', 'metro-monitoring-agent-pack', 'skill-provenance.json'),
    join(repo, 'src', 'asset', 'agent-packs', 'metro-monitoring-agent-pack', 'skill-provenance.json')
  )
  execFileSync('git', ['init', '-b', 'candidate-test'], { cwd: repo, stdio: 'pipe' })
  execFileSync('git', ['config', 'user.name', 'WorkWise Test'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@workwise.invalid'], { cwd: repo })
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' })
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  return { repo, sourceHead }
}

function loadCandidateBuilderConfig(
  repo: string,
  sourceHead: string,
  updateEnv: Record<string, string | undefined> = {}
): typeof builderConfig {
  const configPath = join(repo, 'electron-builder.cjs')
  const previous = new Map<string, string | undefined>()
  const releaseEnv = join(tempRoot(), 'release.local.env')
  writeFileSync(releaseEnv, '# isolated candidate packaging test\n')
  const isolatedEnv = {
    WORKWISE_CANDIDATE: '1',
    WORKWISE_CANDIDATE_SOURCE_HEAD: sourceHead,
    WORKWISE_RELEASE_ENV: releaseEnv,
    WORKWISE_UPDATE_PROVIDER: undefined,
    WORKWISE_UPDATE_URL: undefined,
    WORKWISE_PUBLIC_BASE_URL: undefined,
    WORKWISE_UPDATE_CHANNEL: undefined,
    ...updateEnv
  }
  for (const [key, value] of Object.entries(isolatedEnv)) {
    previous.set(key, process.env[key])
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  delete require.cache[configPath]
  try {
    return require(configPath)
  } finally {
    delete require.cache[configPath]
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

function createMacPackContext(root: string): {
  appOutDir: string
  electronPlatformName: string
  arch: string
  packager: { appInfo: { productFilename: string } }
} {
  return {
    appOutDir: join(root, 'mac-arm64'),
    electronPlatformName: 'darwin',
    arch: 'arm64',
    packager: {
      appInfo: {
        productFilename: 'WorkWise Runtime'
      }
    }
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('electron-builder WorkWise packaging', () => {
  it('normalizes the Intel architecture name reported by lipo', () => {
    expect(macReleaseArtifacts._internals.normalizeLipoArchitecture('x86_64')).toBe('x64')
    expect(macReleaseArtifacts._internals.normalizeLipoArchitecture('arm64')).toBe('arm64')
  })

  it('reads versions from internal and reviewed candidate macOS installer names', () => {
    expect(macReleaseArtifacts._internals.versionFromArtifactName('WorkWise-0.3.6-mac-arm64.dmg')).toBe('0.3.6')
    expect(macReleaseArtifacts._internals.versionFromArtifactName('WorkWise-0.3.6-mac-Apple-Silicon.dmg')).toBe('0.3.6')
    expect(macReleaseArtifacts._internals.versionFromArtifactName('WorkWise-0.3.6-mac-Intel.dmg')).toBe('0.3.6')
  })

  it('includes WorkWise Runtime runtime dependencies in the packaged app', () => {
    expect(builderConfig.beforePack).toBe('./scripts/before-pack.cjs')
    expect(builderConfig.buildDependenciesFromSource).toBe(true)
    expect(builderConfig.npmRebuild).toBe(true)
    expect(builderConfig.asarUnpack).toEqual(expect.arrayContaining([
      'src/asset/skills/**/*'
    ]))
    expect(builderConfig.files).not.toEqual(expect.arrayContaining([
      'kun/dist/**/*',
      'kun/node_modules/**/*',
      'kun/node_modules/typescript/**/*',
      'kun/node_modules/vitest/**/*',
      'kun/node_modules/better-sqlite3/**/*'
    ]))
    expect(builderConfig.files).toEqual(expect.arrayContaining([
      'node_modules/@modelcontextprotocol/sdk/**/*',
      'node_modules/zod-to-json-schema/**/*'
    ]))
    expect(builderConfig.asarUnpack).not.toEqual(expect.arrayContaining([
      '**/kun/node_modules/**/*'
    ]))
    expect(builderConfig.asarUnpack).not.toEqual(expect.arrayContaining([
      '**/node_modules/node-bin-darwin-*/*',
      '**/node_modules/node-bin-linux-*/*',
      '**/node_modules/node-bin-win-*/*',
      '**/node_modules/openclaw/**/*',
      '**/node_modules/@tencent-weixin/openclaw-weixin/**/*'
    ]))
    // The openclaw shim (vendor/openclaw-shim) must ship: the WeChat bridge
    // imports the bundled plugin's dist at runtime to send media, and that
    // import chain resolves openclaw/plugin-sdk/*.
    expect(builderConfig.files).not.toEqual(expect.arrayContaining([
      '!**/node_modules/openclaw/**/*'
    ]))
    expect(builderConfig.extraResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'kun',
        to: 'app.asar.unpacked/kun',
        filter: expect.arrayContaining([
          'dist/**/*',
          'assets/fonts/**/*',
          'package.json',
          'package-lock.json'
        ])
      }),
      expect.objectContaining({
        from: 'kun/node_modules',
        to: 'app.asar.unpacked/kun/runtime-deps',
        filter: expect.arrayContaining([
          'zod/**/*',
          'pdfkit/**/*',
          'fontkit/**/*',
          '@modelcontextprotocol/sdk/**/*'
        ])
      }),
      {
        from: 'src/asset/agent-packs',
        to: 'src/asset/agent-packs',
        filter: ['**/*']
      }
    ]))
  })

  it('normalizes native rebuild target architectures', () => {
    expect(beforePack._internals.normalizeArch('arm64')).toBe('arm64')
    expect(beforePack._internals.normalizeArch(3)).toBe('arm64')
    expect(beforePack._internals.normalizeArch('x64')).toBe('x64')
    expect(beforePack._internals.normalizeArch(0)).toBe('x64')
    expect(() => beforePack._internals.normalizeArch('ia32')).toThrow(
      'Unsupported target architecture'
    )
  })

  it('uses the Windows ICO asset for NSIS installers', () => {
    expect(builderConfig.win.icon).toBe('./src/asset/img/workwise.ico')
    expect(builderConfig.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
  })

  it('uses the official railwise.cn feed by default and keeps enterprise mirrors opt-in', () => {
    const githubConfig = loadBuilderConfigWithEnv({
      WORKWISE_UPDATE_PROVIDER: undefined,
      WORKWISE_UPDATE_URL: undefined,
      WORKWISE_PUBLIC_BASE_URL: undefined,
      WORKWISE_GITHUB_REPO: undefined
    })
    expect(githubConfig.publish).toEqual([{ provider: 'generic', url: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/' }])

    const genericConfig = loadBuilderConfigWithEnv({
      WORKWISE_UPDATE_PROVIDER: 'generic',
      WORKWISE_UPDATE_URL: 'https://downloads.example.test/{channel}/latest',
      WORKWISE_PUBLIC_BASE_URL: undefined
    })
    expect(genericConfig.publish).toEqual([
      {
        provider: 'generic',
        url: 'https://downloads.example.test/stable/latest/'
      }
    ])
  })

  it('validates the unpacked managed runtime before release artifacts are created', () => {
    const root = tempRoot()
    const context = createMacPackContext(root)
    const unpackedRoot = afterPack._internals.unpackedAppRoot(context)

    for (const relativePath of afterPack.MANAGED_RUNTIME_REQUIRED_PATHS) {
      touch(join(unpackedRoot, relativePath))
    }
    touch(join(unpackedRoot, 'node_modules/better-sqlite3/package.json'))

    expect(() => afterPack._internals.validateBundledKunRuntime(context)).not.toThrow()

    rmSync(join(unpackedRoot, 'kun/node_modules/zod'), { recursive: true, force: true })

    expect(() => afterPack._internals.validateBundledKunRuntime(context)).toThrow(
      /kun\/node_modules\/zod\/package\.json/
    )
  })

  it('makes the packaged macOS MarkItDown sidecar executable before signing', () => {
    const root = tempRoot()
    const context = createMacPackContext(root)
    const executable = join(
      afterPack._internals.unpackedAppRoot(context),
      'sidecars/markitdown/workwise-markitdown'
    )
    touch(executable)
    chmodSync(executable, 0o644)

    expect(() =>
      afterPack._internals.ensureBundledMarkItDownExecutable(context)
    ).not.toThrow()
    expect(statSync(executable).mode & 0o111).not.toBe(0)
  })

  it('detects missing unpacked ASAR entries after packaging hooks', async () => {
    const root = tempRoot()
    const source = join(root, 'source')
    const archive = join(root, 'app.asar')
    touch(join(source, 'out/main/index.js'))
    touch(join(source, 'native/addon.node'))
    await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' })

    expect(packagedAsar.verifyAsarArchive(archive, join(source, 'out'))).toMatchObject({
      compiledFiles: 1
    })

    rmSync(`${archive}.unpacked`, { recursive: true, force: true })
    expect(() => packagedAsar.verifyAsarArchive(archive, join(source, 'out'))).toThrow(
      /ASAR entry is unreadable/
    )
  })

  it('verifies that packaged candidate provenance matches the expected source HEAD', async () => {
    const root = tempRoot()
    const source = join(root, 'source')
    const archive = join(root, 'app.asar')
    const sourceHead = '1234567890abcdef1234567890abcdef12345678'
    touch(join(source, 'out/main/index.js'))
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'package.json'), JSON.stringify({
      name: 'workwise',
      buildProvenance: { sourceHead }
    }))
    await asar.createPackage(source, archive)

    expect(packagedAsar.verifyAsarArchive(archive, join(source, 'out'), sourceHead))
      .toMatchObject({ sourceHead })
    expect(() => packagedAsar.verifyAsarArchive(
      archive,
      join(source, 'out'),
      '0000000000000000000000000000000000000000'
    )).toThrow(/source HEAD/i)
  })

  it('carries the authorized source HEAD into candidate package metadata', () => {
    const { repo, sourceHead } = createCandidatePackagingRepo()
    const config = loadCandidateBuilderConfig(repo, sourceHead, {
      WORKWISE_UPDATE_PROVIDER: 'none',
      WORKWISE_UPDATE_URL: 'https://public.example.test/should-not-ship',
      WORKWISE_PUBLIC_BASE_URL: 'https://another-public.example.test',
      WORKWISE_UPDATE_CHANNEL: 'stable'
    })
    const shortHead = sourceHead.slice(0, 12)

    expect(config.extraMetadata).toMatchObject({
      buildProvenance: { sourceHead },
      updateChannel: 'frontier'
    })
    expect(config.appId).toBe(`com.wangjiawei508.workwise.candidate.head${shortHead}`)
    expect(config.productName).toBe(`RailWise AI Candidate ${shortHead}`)
    expect(config.artifactName).toContain(`WorkWise-Candidate-${shortHead}-`)
    expect(config.nsis.shortcutName).toBe(`RailWise AI Candidate ${shortHead}`)
    expect(config.nsis.uninstallDisplayName).toBe(`RailWise AI Candidate ${shortHead}`)
    expect(config.publish).toEqual([
      { provider: 'generic', url: 'https://127.0.0.1/' }
    ])
  })

  it('rejects candidate config loading at a stale source HEAD', () => {
    const { repo } = createCandidatePackagingRepo()
    expect(() => loadCandidateBuilderConfig(repo, '0'.repeat(40)))
      .toThrow(/does not match expected source HEAD/i)
  })

  it.each([
    {
      label: 'tracked',
      dirty(repo: string) {
        writeFileSync(join(repo, 'electron-builder.cjs'), '\n', { flag: 'a' })
      }
    },
    {
      label: 'staged',
      dirty(repo: string) {
        writeFileSync(join(repo, 'staged.ts'), 'export {}\n')
        execFileSync('git', ['add', 'staged.ts'], { cwd: repo })
      }
    },
    {
      label: 'untracked',
      dirty(repo: string) {
        writeFileSync(join(repo, 'untracked.ts'), 'export {}\n')
      }
    }
  ])('rejects candidate config loading from a $label source tree', ({ dirty }) => {
    const { repo, sourceHead } = createCandidatePackagingRepo()
    dirty(repo)
    expect(() => loadCandidateBuilderConfig(repo, sourceHead))
      .toThrow(/uncommitted changes/i)
  })

  it('normalizes Windows separators returned by the ASAR listing API', () => {
    expect(packagedAsar._internals.normalizeArchiveEntry('\\node_modules\\better-sqlite3\\package.json'))
      .toBe(join('node_modules', 'better-sqlite3', 'package.json'))
    expect(packagedAsar._internals.normalizeArchiveEntry('/out/main/index.js'))
      .toBe(join('out', 'main', 'index.js'))
  })

  it('selects only the matching platform Markdown converter directory', () => {
    expect(afterPack._internals.converterDirNameForContext({
      electronPlatformName: 'darwin',
      arch: 'arm64'
    })).toBe('darwin-arm64')
    expect(afterPack._internals.converterDirNameForContext({
      electronPlatformName: 'darwin',
      arch: 0
    })).toBe('darwin-x64')
    expect(afterPack._internals.converterDirNameForContext({
      electronPlatformName: 'win',
      arch: 'x64'
    })).toBe('win32-x64')
    expect(afterPack._internals.converterDirNameForContext({
      electronPlatformName: 'linux',
      arch: 'x64'
    })).toBeNull()
  })

  it('requires Apple secure timestamps when Developer ID signing is enabled', () => {
    const signedConfig = loadBuilderConfigWithEnv({
      MAC_SIGN: '1'
    })

    expect(signedConfig.mac.identity).toBeUndefined()
    expect(signedConfig.mac.hardenedRuntime).toBe(true)
    expect(signedConfig.mac.forceCodeSigning).toBe(true)
    expect(signedConfig.mac.timestamp).toBe('http://timestamp.apple.com/ts01')
    expect(signedConfig.mac.signIgnore).toBeUndefined()
  })

  it('checks timestamp candidates across nested macOS signed code', () => {
    const root = tempRoot()
    const appBundle = join(root, 'RailWise AI.app')
    const mainExecutable = join(appBundle, 'Contents/MacOS/RailWise AI')
    const framework = join(appBundle, 'Contents/Frameworks/Electron Framework.framework')
    const nativeAddon = join(
      appBundle,
      'Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
    )
    const resourceScript = join(appBundle, 'Contents/Resources/postinstall.sh')
    const pythonFramework = join(
      appBundle,
      'Contents/Resources/app.asar.unpacked/sidecars/markitdown/_internal/Python.framework'
    )
    const pythonBinary = join(pythonFramework, 'Versions/3.12/Python')

    touch(mainExecutable)
    touch(join(framework, 'Versions/A/Electron Framework'))
    touch(nativeAddon)
    touch(resourceScript)
    touch(pythonBinary)
    chmodSync(mainExecutable, 0o755)
    chmodSync(resourceScript, 0o755)
    chmodSync(pythonBinary, 0o755)

    expect(macNotarize._internals.collectSignedCodeCandidates(appBundle)).toEqual([
      appBundle,
      framework,
      mainExecutable,
      nativeAddon,
      pythonFramework,
      pythonBinary
    ])
  })
})
