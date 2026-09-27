const productBrand = require('./src/shared/product-brand.json')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { verifyCandidateSourceTree } = require('./scripts/candidate-source-provenance.cjs')
const { markitdownResourceFilter } = require('./scripts/markitdown-packaging-policy.cjs')
const { agentPackResourceFilter, asarBlockedSkillFilters } = require('./scripts/specialist-skill-audit.cjs')

function loadLocalReleaseEnv() {
  const candidates = [
    process.env.WORKWISE_RELEASE_ENV,
    join(__dirname, 'scripts', 'release.local.env'),
    join(__dirname, 'release.local.env')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    for (const rawLine of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match) continue
      let value = match[2].trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!process.env[match[1]]) process.env[match[1]] = value
    }
    break
  }
}

function managedRuntimeProductionPackageRoots() {
  const lockPath = join(__dirname, 'kun', 'package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const roots = Object.entries(lock.packages || {})
    .filter(([packagePath, metadata]) =>
      packagePath.startsWith('node_modules/') &&
      !metadata.dev &&
      packagePath !== 'node_modules/better-sqlite3'
    )
    .map(([packagePath]) => `kun/${packagePath}`)
    .sort()

  if (!roots.includes('kun/node_modules/zod') || !roots.includes('kun/node_modules/@modelcontextprotocol/sdk')) {
    throw new Error('kun/package-lock.json is missing required production runtime dependencies.')
  }
  return roots
}

loadLocalReleaseEnv()

const managedRuntimeProductionRoots = managedRuntimeProductionPackageRoots()
const sidecarArch = process.env.WORKWISE_SIDECAR_ARCH || process.arch
const markitdownSidecarRoot = join(
  __dirname,
  'build',
  'sidecars',
  `markitdown-${process.platform}-${sidecarArch}`,
  'workwise-markitdown'
)
const markitdownExtraResources = existsSync(markitdownSidecarRoot)
  ? [{
      from: markitdownSidecarRoot,
      to: 'app.asar.unpacked/sidecars/markitdown',
      // FileMatcher uses minimatch({ dot: true }) and preserves symlinks. Keep
      // the PyInstaller archive, notices, hidden PIL dylibs, and framework
      // links explicit so a future filter change cannot silently drop them.
      filter: [...markitdownResourceFilter]
    }]
  : []
if (process.env.WORKWISE_REQUIRE_DOCUMENT_SIDECAR === '1' && markitdownExtraResources.length === 0) {
  throw new Error(`Required MarkItDown sidecar is missing for ${process.platform}-${sidecarArch}: ${markitdownSidecarRoot}`)
}

const hasExplicitMacSigningIdentity = Boolean(
  process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.MAC_SIGN === '1'
)

const hasNotaryToolCredentials = Boolean(
  process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER &&
    (process.env.APPLE_API_KEY || process.env.APPLE_API_KEY_BASE64)
)

const isCandidateBuild = process.env.WORKWISE_CANDIDATE === '1'
const requestedUpdateChannel = normalizeUpdateChannel(
  process.env.WORKWISE_UPDATE_CHANNEL || 'stable'
)
// A candidate never inherits a public feed or channel from its build
// environment. It carries a loopback manifest solely so the isolated updater
// acceptance launcher can replace it with its private HTTPS feed at runtime.
const updateChannel = isCandidateBuild ? 'frontier' : requestedUpdateChannel
const configuredPublicBaseUrl = (process.env.WORKWISE_PUBLIC_BASE_URL || 'https://www.railwise.cn/downloads')
  .trim()
  .replace(/\/+$/, '')
const releasePrefix = (process.env.WORKWISE_RELEASE_PREFIX || 'workwise')
  .trim()
  .replace(/^\/+|\/+$/g, '')
const explicitUpdateUrl = (process.env.WORKWISE_UPDATE_URL || '').trim()
const hasGenericUpdateFeed = true
const updateProvider = (
  process.env.WORKWISE_UPDATE_PROVIDER || (hasGenericUpdateFeed ? 'generic' : 'github')
).trim().toLowerCase()
const configuredGithubRepo = (process.env.WORKWISE_GITHUB_REPO || 'railwise-cn/railwise-ai').trim()
const githubRepoMatch = configuredGithubRepo.match(/^([\w.-]+)\/([\w.-]+)$/)
const genericUpdateUrl = explicitUpdateUrl
  ? explicitUpdateUrl.replace(/\{channel\}/g, updateChannel).replace(/\/?$/, '/')
  : hasGenericUpdateFeed
    ? `${configuredPublicBaseUrl}/${releasePrefix}/channels/${updateChannel}/latest/`
    : ''
const releaseAppVersion = (
  process.env.WORKWISE_APP_VERSION || ''
).trim()
const candidateSourceHead = (
  process.env.WORKWISE_CANDIDATE_SOURCE_HEAD || ''
).trim()
const candidateIdentitySuffix = candidateSourceHead ? `head${candidateSourceHead.slice(0, 12)}` : ''
const packagedProductName = isCandidateBuild
  ? `${productBrand.platform} Candidate ${candidateSourceHead.slice(0, 12)}`
  : productBrand.platform
const artifactVersion = releaseAppVersion || '${version}'
const packagedUpdateProvider = isCandidateBuild ? 'generic' : updateProvider
const packagedGenericUpdateUrl = isCandidateBuild
  ? 'https://127.0.0.1/'
  : genericUpdateUrl

function normalizeUpdateChannel(raw) {
  const value = String(raw || '').trim()
  if (value === 'stable' || value === 'frontier') return value
  throw new Error(`WORKWISE_UPDATE_CHANNEL must be "stable" or "frontier", got: ${raw}`)
}

if (releaseAppVersion && !/^\d+\.\d+\.\d+$/.test(releaseAppVersion)) {
  throw new Error(
    `WORKWISE_APP_VERSION must be a valid x.y.z semver for electron-updater, got: ${releaseAppVersion}`
  )
}
if (candidateSourceHead && !/^[0-9a-f]{40}$/.test(candidateSourceHead)) {
  throw new Error(
    `WORKWISE_CANDIDATE_SOURCE_HEAD must be a 40-character lowercase Git commit, got: ${candidateSourceHead}`
  )
}
if (isCandidateBuild && !candidateSourceHead) {
  throw new Error('Candidate packaging requires WORKWISE_CANDIDATE_SOURCE_HEAD from candidate.env.')
}
if (isCandidateBuild) {
  verifyCandidateSourceTree(__dirname, candidateSourceHead, { label: 'electron-builder' })
}

if (!['github', 'generic', 'none'].includes(updateProvider)) {
  throw new Error(`WORKWISE_UPDATE_PROVIDER must be "github", "generic", or "none", got: ${updateProvider}`)
}
if (updateProvider === 'github' && !githubRepoMatch) {
  throw new Error(`WORKWISE_GITHUB_REPO must look like owner/repo, got: ${configuredGithubRepo}`)
}
if (updateProvider === 'generic' && !genericUpdateUrl) {
  throw new Error('A generic update provider requires WORKWISE_UPDATE_URL or WORKWISE_PUBLIC_BASE_URL.')
}

const builderConfig = {
  // Historical App ID must remain unchanged for in-place NSIS/Squirrel upgrades.
  //  - macOS 端 Squirrel.Mac 校验更新包签名时锚定 bundle identifier,
  //    换了 id 老版本会拒绝安装新版本;
  //  - Windows 端 NSIS 以 appId 派生卸载 GUID,换了 id 升级安装不会
  //    卸载旧版本,用户会装出两份应用;
  //  - macOS TCC 权限、通知授权也都挂在这个 id 上。
  appId: isCandidateBuild
    ? `com.wangjiawei508.workwise.candidate.${candidateIdentitySuffix}`
    : 'com.wangjiawei508.workgpt',
  productName: packagedProductName,
  asar: true,
  asarUnpack: [
    'src/asset/skills/**/*',
    '**/node_modules/better-sqlite3/**/*',
    '**/node_modules/bindings/**/*',
    '**/node_modules/file-uri-to-path/**/*'
  ],
  beforePack: './scripts/before-pack.cjs',
  // WorkWise Runtime is executed with ELECTRON_RUN_AS_NODE, so native modules
  // must match the Node ABI embedded in the packaged Electron binary. A host
  // Node prebuild can have a different ABI even when both report Node 24/26.
  buildDependenciesFromSource: true,
  npmRebuild: true,
  directories: {
    output: process.env.WORKWISE_DIST_DIR || 'dist'
  },
  files: [
    'out/**/*',
    'src/asset/skills/**/*',
    ...asarBlockedSkillFilters(),
    'package.json',
    // @modelcontextprotocol/sdk imports this peer at runtime from the main
    // process. Electron-builder's dependency collector can omit the package
    // when node_modules is supplied through a clean candidate worktree or a
    // symlinked install, so address the production runtime path explicitly.
    'node_modules/@modelcontextprotocol/sdk/**/*',
    'node_modules/zod-to-json-schema/**/*',
    // better-sqlite3 loads these optional native-loader packages at runtime.
    // Keep them explicit because a clean/symlinked install can make npm's
    // dependency collector omit them even though the lockfile requires them.
    'node_modules/bindings/**/*',
    'node_modules/file-uri-to-path/**/*',
    '!**/*.map',
    '!**/*.d.ts',
    '!**/*.ts',
    '!src/asset/skills/**/__pycache__/**',
    '!src/asset/skills/**/*.pyc',
    '!src/asset/skills/**/*.pyo',
    '!**/tsconfig*.json',
    '!**/README*',
    '!**/CHANGELOG*'
    // node_modules/openclaw (the vendor/openclaw-shim file: dep) must ship:
    // the WeChat bridge imports @tencent-weixin/openclaw-weixin/dist at
    // runtime to send media, and that chain resolves openclaw/plugin-sdk/*.
  ],
  extraResources: [
    ...markitdownExtraResources,
    {
      from: 'kun',
      to: 'app.asar.unpacked/kun',
      filter: [
        'dist/**/*',
        'assets/fonts/**/*',
        'package.json',
        'package-lock.json'
      ]
    },
    {
      from: 'kun/node_modules',
      to: 'app.asar.unpacked/kun/runtime-deps',
      filter: [
        ...managedRuntimeProductionRoots.map((root) => `${root.slice('kun/node_modules/'.length)}/**/*`)
      ]
    },
    {
      from: 'src/asset/agent-packs',
      to: 'src/asset/agent-packs',
      filter: agentPackResourceFilter()
    }
  ],
  artifactName: isCandidateBuild
    ? `WorkWise-Candidate-${candidateSourceHead.slice(0, 12)}-${artifactVersion}-\${os}-\${arch}.\${ext}`
    : `WorkWise-${artifactVersion}-\${os}-\${arch}.\${ext}`,
  publish: packagedUpdateProvider === 'github'
    ? [
        {
          provider: 'github',
          owner: githubRepoMatch[1],
          repo: githubRepoMatch[2]
        }
      ]
    : packagedUpdateProvider === 'generic'
      ? [
          {
            provider: 'generic',
            url: packagedGenericUpdateUrl
          }
        ]
      : null,
  afterPack: './scripts/after-pack.cjs',
  afterSign: './scripts/mac-notarize.cjs',
  mac: {
    category: 'public.app-category.developer-tools',
    identity: hasExplicitMacSigningIdentity ? undefined : null,
    // We notarize in scripts/mac-notarize.cjs so APPLE_API_KEY_BASE64 can be supported.
    notarize: false,
    hardenedRuntime: hasExplicitMacSigningIdentity,
    forceCodeSigning: hasExplicitMacSigningIdentity,
    timestamp: hasExplicitMacSigningIdentity ? 'http://timestamp.apple.com/ts01' : null,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    icon: './src/asset/img/workwise.icns',
    // arm64 (Apple Silicon) + x64 (Intel). On M 系列 Mac 本地打包会各出一组 dmg/zip。
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] }
    ]
  },
  dmg: {
    sign: hasExplicitMacSigningIdentity
  },
  win: {
    icon: './src/asset/img/workwise.ico',
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    allowElevation: true,
    selectPerMachineByDefault: false,
    // 明确创建快捷方式；always 在覆盖安装时也会重建（即使用户曾删掉桌面图标）
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: packagedProductName,
    uninstallDisplayName: packagedProductName,
    deleteAppDataOnUninstall: false
  },
  linux: {
    category: 'Development',
    icon: './src/asset/img/workwise.png',
    target: [{ target: 'AppImage', arch: ['x64'] }]
  },
  extraMetadata: {
    ...(releaseAppVersion ? { version: releaseAppVersion } : {}),
    updateChannel,
    ...(candidateSourceHead ? { buildProvenance: { sourceHead: candidateSourceHead } } : {}),
    buildHints: {
      macSigningEnabled: hasExplicitMacSigningIdentity,
      notarizationEnabled: hasNotaryToolCredentials
    }
  }
}

module.exports = builderConfig
