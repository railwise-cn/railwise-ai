import { ZOTERO_PACKAGE, OPTIONAL_ENGINEERING_SKILLS, isApprovedUpstreamPackage } from '../../shared/engineering-marketplace'
import type {
  CatalogSourceV1,
  GithubPackageSourceV1,
  MarketplaceComponentV1,
  MarketplaceCollectionV1,
  MarketplaceIconV1,
  MarketplacePackageV1,
  MarketplaceProductTypeV1,
  NpmPackageRuntimeV1,
  NpmPackageSourceV1,
  PackageCompatibilityV1,
  PackageDependencyV1,
  PackageInstallationV1,
  PackageLicenseEvidenceV1,
  PackagePermissionV1,
  PackagePublisherV1,
  PackageSourceV1,
  PypiPackageSourceV1,
  SimplePackageSourceKindV1,
  SimplePackageSourceV1,
  UvPackageRuntimeV1
} from '../../shared/marketplace'
import { evaluateMarketplaceLicense } from '../../shared/marketplace'

const OFFICIAL_CATALOG_SOURCE_ID = 'workwise-official'
const SHA1_COMMIT = /^[0-9a-f]{40}$/
const MCP_SERVERS_PYTHON_LICENSE_COMMIT = '76d64c822f5125032f89eb71dbdb94e42b434821'

const PINNED_UPDATE = {
  strategy: 'pinned',
  channel: 'stable',
  allowMajor: false
} as const

const MANUAL_UPDATE = {
  strategy: 'manual',
  channel: 'stable',
  allowMajor: false
} as const

const SYSTEM_UPDATE = {
  strategy: 'system-managed',
  channel: 'managed',
  allowMajor: false
} as const

const COMPATIBILITY: PackageCompatibilityV1 = {
  workwise: '>=0.3.6',
  platforms: ['darwin', 'win32', 'linux'],
  architectures: ['arm64', 'x64']
}

const NODE_DEPENDENCY: PackageDependencyV1 = {
  id: 'node',
  kind: 'runtime',
  requirement: '>=22.22.0',
  optional: false,
  managedBy: 'workwise'
}

const UV_DEPENDENCY: PackageDependencyV1 = {
  id: 'uv',
  kind: 'runtime',
  requirement: 'managed',
  optional: false,
  managedBy: 'workwise'
}

const PYTHON_310_DEPENDENCY: PackageDependencyV1 = {
  id: 'python',
  kind: 'runtime',
  requirement: '>=3.10',
  optional: false,
  managedBy: 'workwise'
}

const DIRECT_MIRROR_INSTALL: PackageInstallationV1 = {
  mode: 'direct-mirror',
  installedByDefault: false,
  reinstallable: true
}

const EXTERNAL_INSTALL: PackageInstallationV1 = {
  mode: 'external',
  installedByDefault: false,
  reinstallable: false
}

const PACKAGE_ICON_OVERRIDES: Record<string, MarketplaceIconV1> = {
  'github-mcp': { kind: 'monogram', value: 'GH', tone: 'blue', alt: 'GitHub' },
  'playwright-mcp': { kind: 'monogram', value: 'PW', tone: 'orange', alt: 'Playwright' },
  'playwright-cli-skills': { kind: 'monogram', value: 'PW', tone: 'orange', alt: 'Playwright' },
  'rail-any-station-control-network': { kind: 'monogram', value: '测', tone: 'teal', alt: '任意设站控制网测量' },
  context7: { kind: 'monogram', value: 'C7', tone: 'teal', alt: 'Context7' },
  dbhub: { kind: 'monogram', value: 'DB', tone: 'green', alt: 'DBHub' },
  'antv-chart-mcp': { kind: 'monogram', value: 'AV', tone: 'red', alt: 'AntV' },
  'antv-chart-skill': { kind: 'monogram', value: 'AV', tone: 'red', alt: 'AntV' },
  superpowers: { kind: 'monogram', value: 'SP', tone: 'violet', alt: 'Superpowers' },
  'filesystem-mcp': { kind: 'monogram', value: 'FS', tone: 'slate', alt: 'Filesystem' },
  'memory-mcp': { kind: 'monogram', value: 'MM', tone: 'teal', alt: 'Memory' },
  'sequential-thinking-mcp': { kind: 'monogram', value: 'ST', tone: 'violet', alt: 'Sequential Thinking' },
  schedule: { kind: 'monogram', value: 'SC', tone: 'blue', alt: 'Schedule' },
  'lark-cli': { kind: 'monogram', value: 'LK', tone: 'red', alt: 'Lark' },
  officecli: { kind: 'monogram', value: 'OF', tone: 'blue', alt: 'OfficeCLI' },
  markitdown: { kind: 'monogram', value: 'MD', tone: 'slate', alt: 'MarkItDown' },
  'railwise-kb': { kind: 'monogram', value: 'RK', tone: 'teal', alt: 'RailWise KB' },
  'di-bao-monitoring': { kind: 'monogram', value: 'DB', tone: 'red', alt: 'Metro protection monitoring' },
  'operational-monitoring': { kind: 'monogram', value: 'OM', tone: 'teal', alt: 'Operational monitoring' },
  'tender-master': { kind: 'monogram', value: 'TM', tone: 'blue', alt: 'Tender Master' },
  'document-illustrator': { kind: 'monogram', value: 'DI', tone: 'orange', alt: 'Document Illustrator' },
  'ppt-master': { kind: 'monogram', value: 'PM', tone: 'red', alt: 'PPT Master' },
  'writing-agent': { kind: 'monogram', value: 'WA', tone: 'green', alt: 'Writing Agent' },
  'humanizer-zh': { kind: 'monogram', value: 'HZ', tone: 'violet', alt: 'Humanizer Chinese' },
  'nuwa-skill': { kind: 'monogram', value: 'NW', tone: 'orange', alt: 'Nuwa Skill' },
  'arch-diagram-skill': { kind: 'monogram', value: 'AD', tone: 'violet', alt: 'Arch Diagram' }
}

function defaultPackageIcon(id: string, name: string): MarketplaceIconV1 {
  const override = PACKAGE_ICON_OVERRIDES[id]
  if (override) return override
  const letters = name.replace(/[^A-Za-z0-9]+/g, '').slice(0, 2).toUpperCase() || id.slice(0, 2).toUpperCase()
  return { kind: 'monogram', value: letters, tone: 'slate', alt: name }
}

function defaultCollections(categories: string[] | undefined): MarketplaceCollectionV1[] {
  const mapping: Record<string, MarketplaceCollectionV1> = {
    development: 'development',
    browser: 'productivity',
    'browser-automation': 'productivity',
    'agent-workflows': 'development',
    knowledge: 'development',
    data: 'data',
    visualization: 'data',
    documents: 'documents',
    writing: 'writing',
    collaboration: 'collaboration',
    engineering: 'engineering',
    system: 'productivity'
  }
  const collections = [...new Set((categories ?? []).map((category) => mapping[category]).filter(Boolean))]
  return collections.length ? collections : ['productivity']
}

function defaultProductType(components: ComponentDefinition[]): MarketplaceProductTypeV1 {
  const types = new Set(components.map((component) => component.type))
  if (types.has('skill')) return 'workflow'
  if (types.has('cli')) return 'utility'
  return 'connector'
}

const SYSTEM_MANAGED_INSTALL: Extract<
  PackageInstallationV1,
  { mode: 'system-managed' }
> = {
  mode: 'system-managed',
  installedByDefault: false,
  reinstallable: false
}

const NETWORK_PERMISSION: PackagePermissionV1 = {
  id: 'network.connect',
  kind: 'network',
  access: 'connect',
  default: 'review',
  reviewRequired: true,
  description: 'Connect to the service endpoints declared by this package.'
}

const FILESYSTEM_READ_PERMISSION: PackagePermissionV1 = {
  id: 'filesystem.read',
  kind: 'filesystem',
  access: 'read',
  default: 'review',
  reviewRequired: true,
  description: 'Read files under roots explicitly selected by the user.'
}

const FILESYSTEM_WRITE_PERMISSION: PackagePermissionV1 = {
  id: 'filesystem.write',
  kind: 'filesystem',
  access: 'write',
  default: 'denied',
  reviewRequired: true,
  description: 'Modify files under roots explicitly selected by the user.'
}

const PROCESS_EXECUTE_PERMISSION: PackagePermissionV1 = {
  id: 'process.execute',
  kind: 'process',
  access: 'execute',
  default: 'review',
  reviewRequired: true,
  description: 'Execute the package process for repositories selected by the user.'
}

const DATABASE_READ_PERMISSION: PackagePermissionV1 = {
  id: 'database.read',
  kind: 'database',
  access: 'read',
  default: 'review',
  reviewRequired: true,
  description: 'Read data from databases selected by the user.'
}

const DATABASE_WRITE_PERMISSION: PackagePermissionV1 = {
  id: 'database.write',
  kind: 'database',
  access: 'write',
  default: 'denied',
  reviewRequired: true,
  description: 'Modify data in databases selected by the user.'
}

const catalogSources: CatalogSourceV1[] = [
  {
    schemaVersion: 1,
    id: OFFICIAL_CATALOG_SOURCE_ID,
    name: 'RailWise AI Official Catalog',
    type: 'built-in',
    scope: 'system',
    location: 'workwise://marketplace/official-v1',
    trust: 'system',
    searchable: true,
    auth: { type: 'none' },
    sync: {
      mode: 'bundled',
      state: 'synced',
      mirroredByDefault: false,
      installedByDefault: false
    }
  },
  {
    schemaVersion: 1,
    id: 'mcp-official-registry',
    name: 'Official MCP Registry',
    type: 'mcp-registry',
    scope: 'system',
    location: 'https://registry.modelcontextprotocol.io/v0.1/servers',
    registry: 'official',
    trust: 'official',
    searchable: true,
    auth: { type: 'none' },
    sync: {
      mode: 'watched',
      state: 'idle',
      mirroredByDefault: false,
      installedByDefault: false
    }
  },
  externalCatalogSource('openai-plugins', 'OpenAI Plugins', 'https://github.com/openai/plugins'),
  externalCatalogSource(
    'github-awesome-copilot',
    'GitHub Awesome Copilot',
    'https://github.com/github/awesome-copilot'
  ),
  externalCatalogSource('wshobson-agents', 'wshobson Agents', 'https://github.com/wshobson/agents'),
  externalCatalogSource(
    'terminalskills-skills',
    'TerminalSkills Skills',
    'https://github.com/TerminalSkills/skills'
  ),
  externalCatalogSource(
    'vercel-labs-skills',
    'Vercel Labs Skills',
    'https://github.com/vercel-labs/skills'
  )
]

type SourceDefinition<T extends PackageSourceV1 = PackageSourceV1> =
  T extends PackageSourceV1 ? Omit<T, 'id' | 'catalogSourceId'> : never

type ComponentDefinition<T extends MarketplaceComponentV1 = MarketplaceComponentV1> =
  T extends MarketplaceComponentV1 ? Omit<T, 'sourceId'> & { sourceId?: string } : never

type PackageDefinition = Omit<
  MarketplacePackageV1,
  | 'schemaVersion'
  | 'compatibility'
  | 'dependencies'
  | 'source'
  | 'sources'
  | 'components'
  | 'licenseEvidence'
> & {
  compatibility?: PackageCompatibilityV1
  dependencies?: PackageDependencyV1[]
  licenseEvidence?: PackageLicenseEvidenceV1[]
  source: SourceDefinition
  additionalSources?: SourceDefinition[]
  components: ComponentDefinition[]
}

type NpmArtifact = {
  packageName: string
  version: string
  integrity: string
  executable: string
}

type WheelArtifact = {
  packageName: string
  version: string
  sha256: string
  executable: string
  args?: string[]
}

const NPM_ARTIFACTS = {
  playwrightMcp: {
    packageName: '@playwright/mcp',
    version: '0.0.79',
    integrity: 'sha512-VpqD4a3vFyGQMY9sh3UJiO6wjcurggkljKfAyCHL0QWGY5m6Ehr3MNsAAHPDHO//n13g0PCjpHatAOiulrqdZQ==',
    executable: 'playwright-mcp'
  },
  playwrightCli: {
    packageName: '@playwright/cli',
    version: '0.1.18',
    integrity: 'sha512-ggNfYYH+GsZTGUiBEL8f6N5j0seYEUE52v+fIWqK/A36QG36cL0EJ79qWTXYO2uZMUU7vm+jk3x0fKCPL6UuIw==',
    executable: 'playwright-cli'
  },
  context7: {
    packageName: '@upstash/context7-mcp',
    version: '4.0.0',
    integrity: 'sha512-7TlB85xbKbSHzI4G//3Qm+g8ryW11WZLd7PAOFdH5IxzAv1Yk+lcSBgDM4lDoYHXltzSwK7iUciiFNbFj7493Q==',
    executable: 'context7-mcp'
  },
  dbhub: {
    packageName: '@bytebase/dbhub',
    version: '1.2.0',
    integrity: 'sha512-EaSkcaDpVTF8zOjOGEZlowSTt8jjvLG8pxJ06J1ib46mdl63ryxz4Ga+xhPR2Z6opMf7G5F2d9CWgwG53QlRSQ==',
    executable: 'dbhub'
  },
  antvChart: {
    packageName: '@antv/mcp-server-chart',
    version: '0.9.10',
    integrity: 'sha512-km14tIp6xoTw2whXpFvmm9dVlC+8G+W+uORb0xcRan+0zos8GgQl7D2Vxn+D6OEQZmSHd/vNbRP9/4vaXiBfLQ==',
    executable: 'mcp-server-chart'
  },
  filesystem: {
    packageName: '@modelcontextprotocol/server-filesystem',
    version: '2026.7.10',
    integrity: 'sha512-Mmjg4anFBD5OzbPnGJOA0jPPN8645ERhQk38HQLpSenx1ox9bfdPkmAzUnNjeQtqQGFLtKe13J20RtLBmUKMZA==',
    executable: 'mcp-server-filesystem'
  },
  memory: {
    packageName: '@modelcontextprotocol/server-memory',
    version: '2026.7.4',
    integrity: 'sha512-D+NNzChsOHN72y58ngDmO+TzjJijGi/sSY/gBydhB3TJCcm1XQEozVWwEpruHeXt/HSkMV3Z/BpHDhdt1MLD5w==',
    executable: 'mcp-server-memory'
  },
  sequentialThinking: {
    packageName: '@modelcontextprotocol/server-sequential-thinking',
    version: '2026.7.4',
    integrity: 'sha512-tmR/ieGaeweffLNBrDp1H1w4sn4M6TN5yWSbMS+YMfS+0GDyPjnNKzqCl2uqfdRiX3D44PJUhwiDGqtJp6tFhw==',
    executable: 'mcp-server-sequential-thinking'
  },
  mongodb: {
    packageName: 'mongodb-mcp-server',
    version: '2.0.0',
    integrity: 'sha512-5G1m202mFTfYRpIxYYkdRWzjerB48GEQIdgQOYUy9jeXUEwHakWN4vY+Aayyz/r7PChYf0fM3Ei02FcKIhEyIg==',
    executable: 'mongodb-mcp-server'
  }
} as const satisfies Record<string, NpmArtifact>

const WHEEL_ARTIFACTS = {
  redis: {
    packageName: 'redis-mcp-server',
    version: '0.5.1',
    sha256: '335d9089d4c87a055b362effa7fd718334ccd88b2545d93c4ed9bc2b738b3ed8',
    executable: 'redis-mcp-server'
  },
  docling: {
    packageName: 'docling-mcp',
    version: '3.0.0',
    sha256: '595da70b9de2265f1f14e575fad65ff4213c5c7e2dbb255184d606505fa49f23',
    executable: 'docling-mcp-server'
  },
  fetch: {
    packageName: 'mcp-server-fetch',
    version: '2026.7.10',
    sha256: '6991b9a8133726b9f0b76d8c5e9607c8207e19e7c3a47c9e174a8b2e0742fc70',
    executable: 'mcp-server-fetch'
  },
  git: {
    packageName: 'mcp-server-git',
    version: '2026.7.10',
    sha256: '6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5',
    executable: 'mcp-server-git'
  },
  time: {
    packageName: 'mcp-server-time',
    version: '2026.7.10',
    sha256: 'b99cb0ecfe94ec8e05d4abb65c617b591a21e61a17a084ac782af0fa9e82c944',
    executable: 'mcp-server-time'
  }
} as const satisfies Record<string, WheelArtifact>

function externalCatalogSource(id: string, name: string, location: string): CatalogSourceV1 {
  const [owner, repository] = location.replace('https://github.com/', '').split('/')
  if (!owner || !repository) throw new Error(`Invalid GitHub catalog location: ${location}`)
  return {
    schemaVersion: 1,
    id,
    name,
    type: 'github',
    scope: 'system',
    location,
    owner,
    repository,
    defaultBranch: 'main',
    trust: 'external',
    searchable: true,
    auth: { type: 'none' },
    sync: {
      mode: 'search-on-demand',
      state: 'idle',
      mirroredByDefault: false,
      installedByDefault: false
    }
  }
}

function definePackage(definition: PackageDefinition): MarketplacePackageV1 {
  const {
    compatibility = COMPATIBILITY,
    dependencies = [],
    source: primaryDefinition,
    additionalSources = [],
    components: componentDefinitions,
    licenseEvidence = [],
    ...metadata
  } = definition
  const sources = [primaryDefinition, ...additionalSources].map((sourceDefinition, index) => ({
    ...sourceDefinition,
    id: `${metadata.id}-source-${index + 1}`,
    catalogSourceId: OFFICIAL_CATALOG_SOURCE_ID
  })) as PackageSourceV1[]
  const source = sources[0]
  if (!source) throw new Error(`${metadata.id} must declare a primary source.`)

  const components = componentDefinitions.map((component) => ({
    ...component,
    sourceId: component.sourceId ?? source.id
  })) as MarketplaceComponentV1[]

  return {
    schemaVersion: 1,
    ...metadata,
    collections: metadata.collections ?? defaultCollections(metadata.categories),
    productType: metadata.productType ?? defaultProductType(componentDefinitions),
    icon: metadata.icon ?? defaultPackageIcon(metadata.id, metadata.name),
    source,
    sources,
    components,
    licenseEvidence,
    dependencies,
    compatibility
  }
}

function publisher(
  id: string,
  name: string,
  url: string,
  verified = false
): PackagePublisherV1 {
  return { id, name, url, verified }
}

function simpleSource(
  kind: SimplePackageSourceKindV1,
  location: string
): SourceDefinition<SimplePackageSourceV1> {
  return { kind, location }
}

function npmSource(artifact: NpmArtifact): SourceDefinition<NpmPackageSourceV1> {
  return {
    kind: 'npm',
    location: `https://www.npmjs.com/package/${artifact.packageName}/v/${artifact.version}`,
    packageName: artifact.packageName,
    version: artifact.version,
    resolvedRef: artifact.version,
    digest: { algorithm: 'sha512-sri', value: artifact.integrity }
  }
}

function npmRuntime(artifact: NpmArtifact, args: string[] = []): NpmPackageRuntimeV1 {
  return {
    kind: 'npm',
    packageName: artifact.packageName,
    version: artifact.version,
    executable: artifact.executable,
    args,
    install: {
      strategy: 'managed-download',
      verify: 'sri-before-activation',
      digestSource: 'component-source'
    }
  }
}

function pypiSource(
  artifact: WheelArtifact,
  location = `https://pypi.org/project/${artifact.packageName}/${artifact.version}/`
): SourceDefinition<PypiPackageSourceV1> {
  return {
    kind: 'pypi',
    location,
    packageName: artifact.packageName,
    version: artifact.version,
    resolvedRef: artifact.version,
    digest: { algorithm: 'sha256', value: artifact.sha256 }
  }
}

function mcpServersLicenseSource(
  commit: string
): SourceDefinition<GithubPackageSourceV1> {
  return {
    kind: 'github',
    location: 'https://github.com/modelcontextprotocol/servers',
    owner: 'modelcontextprotocol',
    repository: 'servers',
    defaultBranch: 'main',
    requestedRef: commit,
    resolvedRef: commit
  }
}

function wheelRuntime(artifact: WheelArtifact): UvPackageRuntimeV1 {
  return {
    kind: 'uv',
    packageName: artifact.packageName,
    version: artifact.version,
    executable: artifact.executable,
    args: artifact.args ?? [],
    install: {
      strategy: 'managed-wheel',
      verify: 'sha256-before-activation',
      digest: { algorithm: 'sha256', value: artifact.sha256 }
    }
  }
}

const officialPackages: MarketplacePackageV1[] = [
  definePackage({
    id: 'github-mcp',
    name: 'GitHub MCP',
    productType: 'connector',
    summary: 'Connect to the official GitHub MCP service with a securely stored personal access token and an explicit repository permission scope.',
    tier: 'recommended',
    categories: ['development'],
    version: 'remote',
    publisher: publisher('github', 'GitHub', 'https://github.com', true),
    license: 'MIT',
    source: simpleSource('remote', 'https://api.githubcopilot.com/mcp/'),
    components: [{
      id: 'github-mcp-server',
      name: 'GitHub MCP Server',
      type: 'mcp',
      runtime: {
        kind: 'remote',
        transport: 'streamable-http',
        endpoint: 'https://api.githubcopilot.com/mcp/'
      }
    }],
    permissions: [NETWORK_PERMISSION],
    auth: { type: 'token', provider: 'github', environmentVariables: [] },
    updatePolicy: MANUAL_UPDATE,
    availability: { status: 'available' },
    installation: EXTERNAL_INSTALL
  }),
  definePackage({
    id: 'amap-maps', name: '高德地图', productType: 'connector',
    summary: '通过高德官方 MCP 查询地点、路线、距离和天气。Key 在本机受保护存储中保存，仅开放已核对的只读工具。',
    tier: 'recommended', categories: ['engineering'], version: 'official-http',
    publisher: publisher('amap', '高德开放平台', 'https://developer.amap.com/api/mcp-server/gettingstarted', true),
    license: null, source: simpleSource('remote', 'https://developer.amap.com/api/mcp-server/gettingstarted'),
    components: [{ id: 'amap-maps-server', name: '高德地图', type: 'mcp', runtime: { kind: 'remote', transport: 'streamable-http', endpoint: 'https://mcp.amap.com/mcp' } }],
    permissions: [{ id: 'amap.read', kind: 'network', access: 'read', default: 'review', reviewRequired: true, description: '查询高德官方地图服务。', resources: ['https://mcp.amap.com'] }],
    auth: { type: 'token', provider: 'amap', environmentVariables: [] },
    dependencies: [], updatePolicy: MANUAL_UPDATE, availability: { status: 'available' }, installation: EXTERNAL_INSTALL,
    usage: { howToUse: '在连接器详情中填写高德 Web 服务 Key，检查连接后查询地点或规划路线。', requirements: ['高德 Web 服务 Key'], examples: ['查询指定项目地址附近的地铁站。'] }
  }),
  (() => {
    const item = wheelMcpPackage({ id: ZOTERO_PACKAGE.id, name: 'Zotero 本机文献',
      summary: '读取本机 Zotero 的文献、集合、笔记和全文。社区连接器独立安装，保留完整混合许可证，仅开放只读工具。',
      artifact: { packageName: ZOTERO_PACKAGE.packageName, version: ZOTERO_PACKAGE.version, sha256: ZOTERO_PACKAGE.sha256, executable: 'zotero-mcp', args: ['serve'] },
      publisher: publisher('54yyyu', 'Zotero MCP 社区', 'https://github.com/54yyyu/zotero-mcp', false),
      license: ZOTERO_PACKAGE.license, categories: ['documents', 'engineering'], permissions: [{ id: 'zotero.local.read', kind: 'network', access: 'read', default: 'review', reviewRequired: true, description: '读取已开启本地 API 的 Zotero 文献库。', resources: ['http://127.0.0.1:23119'] }] })
    return { ...item, productType: 'connector' as const, installation: { mode: 'upstream-only' as const, installedByDefault: false, reinstallable: true as const },
      usage: { howToUse: '安装此固定版本后，打开 Zotero 并在高级设置中允许本机应用连接。随后在连接器详情中检查只读工具。', requirements: ['运行中的 Zotero 本地 API', 'MIT AND AGPL-3.0-or-later 上游许可证'], examples: ['搜索文献库中关于盾构施工监测的资料，并列出来源。'] } }
  })(),
  ...OPTIONAL_ENGINEERING_SKILLS.map(skill => managedSkillPackage({ ...skill,
    publisher: publisher('railwise', 'RailWise AI', 'https://github.com/railwise-cn/railwise-ai', true),
    location: 'https://github.com/railwise-cn/railwise-ai', license: 'MIT', category: 'engineering', tier: 'recommended', installedByDefault: false
  })),
  npmMcpPackage({
    id: 'playwright-mcp',
    name: 'Playwright MCP',
    summary: 'Automate and inspect real browsers through Playwright.',
    artifact: NPM_ARTIFACTS.playwrightMcp,
    publisher: publisher('microsoft', 'Microsoft', 'https://github.com/microsoft', true),
    license: 'Apache-2.0',
    categories: ['browser-automation'],
    permissions: [{
      id: 'browser.control',
      kind: 'browser',
      access: 'control',
      default: 'review',
      reviewRequired: true,
      description: 'Control browser pages and sessions selected by the user.'
    }]
  }),
  definePackage({
    id: 'playwright-cli-skills',
    name: 'Playwright CLI + Skills',
    summary: 'Run the pinned Playwright CLI with its official agent Skills.',
    tier: 'advanced',
    categories: ['browser-automation'],
    version: NPM_ARTIFACTS.playwrightCli.version,
    publisher: publisher('microsoft', 'Microsoft', 'https://github.com/microsoft', true),
    license: 'Apache-2.0',
    source: npmSource(NPM_ARTIFACTS.playwrightCli),
    components: [
      {
        id: 'playwright-cli',
        name: 'Playwright CLI',
        type: 'cli',
        runtime: npmRuntime(NPM_ARTIFACTS.playwrightCli)
      },
      {
        id: 'playwright-cli-skills-bundle',
        name: 'Playwright CLI Skills',
        type: 'skill',
        skillNames: ['playwright-cli'],
        runtime: npmRuntime(NPM_ARTIFACTS.playwrightCli)
      }
    ],
    permissions: [{
      id: 'browser.control',
      kind: 'browser',
      access: 'control',
      default: 'review',
      reviewRequired: true,
      description: 'Control browser pages and sessions selected by the user.'
    }],
    auth: { type: 'none' },
    dependencies: [NODE_DEPENDENCY],
    updatePolicy: PINNED_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  }),
  npmMcpPackage({
    id: 'context7-mcp',
    name: 'Context7',
    summary: 'Retrieve current library documentation for coding work.',
    artifact: NPM_ARTIFACTS.context7,
    publisher: publisher('upstash', 'Upstash', 'https://github.com/upstash', true),
    license: 'MIT',
    categories: ['knowledge'],
    permissions: [NETWORK_PERMISSION]
  }),
  npmMcpPackage({
    id: 'dbhub',
    name: 'DBHub',
    summary: 'Connect to supported databases through the maintained DBHub MCP server.',
    artifact: NPM_ARTIFACTS.dbhub,
    publisher: publisher('bytebase', 'Bytebase', 'https://github.com/bytebase', true),
    license: 'MIT',
    categories: ['data'],
    permissions: [DATABASE_READ_PERMISSION, DATABASE_WRITE_PERMISSION],
    auth: { type: 'tool-managed', provider: 'database' }
  }),
  npmMcpPackage({
    id: 'antv-chart-mcp',
    name: 'AntV Chart MCP',
    summary: 'Generate data visualizations with the AntV chart MCP server.',
    artifact: NPM_ARTIFACTS.antvChart,
    publisher: publisher('antv', 'AntV', 'https://github.com/antvis', true),
    license: 'MIT',
    categories: ['visualization']
  }),
  definePackage({
    id: 'antv-chart-skill',
    name: 'AntV Chart Skill',
    summary: 'Guide agents in selecting and producing AntV charts.',
    tier: 'advanced',
    categories: ['visualization'],
    version: 'b47f2feae59b1e792462d0edd8d1a7ea87c9bdfc',
    publisher: publisher('antv', 'AntV', 'https://github.com/antvis', true),
    license: 'MIT',
    source: {
      kind: 'github',
      location: 'https://github.com/antvis/chart-visualization-skills',
      owner: 'antvis',
      repository: 'chart-visualization-skills',
      defaultBranch: 'master',
      requestedRef: 'master',
      resolvedRef: 'b47f2feae59b1e792462d0edd8d1a7ea87c9bdfc',
      subpath: 'skills/chart-visualization'
    },
    components: [{
      id: 'antv-chart-skill',
      name: 'AntV Chart Skill',
      type: 'skill',
      skillNames: ['chart-visualization'],
      runtime: {
        kind: 'github',
        repository: 'https://github.com/antvis/chart-visualization-skills',
        resolvedCommit: 'b47f2feae59b1e792462d0edd8d1a7ea87c9bdfc',
        subpath: 'skills/chart-visualization',
        install: { strategy: 'managed-git', verifyBeforeActivation: true }
      }
    }],
    permissions: [],
    auth: { type: 'none' },
    updatePolicy: PINNED_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  }),
  definePackage({
    id: 'superpowers',
    name: 'Superpowers',
    summary: 'Add the Superpowers development workflow Skills.',
    tier: 'recommended',
    categories: ['agent-workflows'],
    version: '44c9b2d6e889982ac18c27d05a19fefe335194e1',
    publisher: publisher('obra', 'Jesse Vincent', 'https://github.com/obra', true),
    license: 'MIT',
    source: {
      kind: 'github',
      location: 'https://github.com/obra/superpowers',
      owner: 'obra',
      repository: 'superpowers',
      defaultBranch: 'main',
      requestedRef: 'main',
      resolvedRef: '44c9b2d6e889982ac18c27d05a19fefe335194e1',
      subpath: 'skills'
    },
    components: [{
      id: 'superpowers-skills',
      name: 'Superpowers Skills',
      type: 'skill',
      skillNames: ['superpowers'],
      runtime: {
        kind: 'github',
        repository: 'https://github.com/obra/superpowers',
        resolvedCommit: '44c9b2d6e889982ac18c27d05a19fefe335194e1',
        subpath: 'skills',
        install: { strategy: 'managed-git', verifyBeforeActivation: true }
      }
    }],
    permissions: [],
    auth: { type: 'none' },
    updatePolicy: PINNED_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  }),
  npmMcpPackage({
    id: 'filesystem-mcp',
    name: 'Filesystem MCP',
    summary: 'Provide explicitly scoped local filesystem access.',
    artifact: NPM_ARTIFACTS.filesystem,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['system'],
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION],
    args: ['${workspaceRoot}'],
    licenseEvidenceCommit: '9a96ea6e5913736f92b88345bf51caeaaa8e719f'
  }),
  npmMcpPackage({
    id: 'memory-mcp',
    name: 'Memory MCP',
    summary: 'Store and retrieve a local knowledge graph.',
    artifact: NPM_ARTIFACTS.memory,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['knowledge'],
    tier: 'advanced',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION],
    licenseEvidenceCommit: '6dd0a683e198783e30feabf7abaf42f925bd18b1'
  }),
  npmMcpPackage({
    id: 'sequential-thinking-mcp',
    name: 'Sequential Thinking MCP',
    summary: 'Support structured step-by-step reasoning workflows.',
    artifact: NPM_ARTIFACTS.sequentialThinking,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['agent-workflows'],
    tier: 'advanced',
    licenseEvidenceCommit: '6dd0a683e198783e30feabf7abaf42f925bd18b1'
  }),
  managedPackage(
    'schedule',
    'Schedule',
    'RailWise AI built-in scheduling and recurring task capability.',
    'RailWise AI',
    'workwise://managed-tools/schedule',
    null,
    true,
    true,
    'system'
  ),
  managedPackage(
    'lark-cli',
    'Lark CLI',
    'Official Lark CLI and its companion Skills, managed outside the marketplace installer.',
    'Lark',
    'https://github.com/larksuite/cli',
    'MIT',
    false,
    true,
    'collaboration'
  ),
  managedPackage(
    'officecli',
    'OfficeCLI',
    'Office document CLI and Skills, managed outside the marketplace installer.',
    'iOfficeAI',
    'https://github.com/iOfficeAI/OfficeCLI',
    'Apache-2.0',
    false,
    true,
    'documents'
  ),
  managedPackage(
    'ego-browser',
    'Ego Browser',
    'External browser integration discovered and managed by RailWise AI.',
    'Cintro Labs',
    'https://lite.ego.app/',
    null,
    false,
    false,
    'browser-automation',
    'advanced',
    'app'
  ),
  managedPackage(
    'markitdown',
    'MarkItDown',
    'Bundled local document conversion runtime.',
    'Microsoft',
    'https://github.com/microsoft/markitdown',
    'MIT',
    true,
    true,
    'documents'
  ),
  managedPackage(
    'railwise-kb',
    'RailWise KB',
    'RailWise AI-managed connection to the official RailWise public knowledge base.',
    'RailWise',
    'https://kb.railwise.cn/products/workwise/',
    null,
    true,
    true,
    'documents',
    'advanced',
    'connector'
  ),
  managedSkillPackage({
    id: 'di-bao-monitoring',
    name: 'Metro Protection Monitoring',
    summary: 'Produce metro protection-zone monitoring plans, reports, warnings, and review responses.',
    publisher: publisher('workwise', 'RailWise AI', 'https://github.com/railwise-cn/railwise-ai', true),
    location: 'https://github.com/railwise-cn/railwise-ai',
    license: 'MIT',
    category: 'engineering',
    tier: 'recommended',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'operational-monitoring',
    name: 'Operational Monitoring',
    summary: 'Prepare long-term deformation monitoring plans, period reports, alerts, and archives.',
    publisher: publisher('workwise', 'RailWise AI', 'https://github.com/railwise-cn/railwise-ai', true),
    location: 'https://github.com/railwise-cn/railwise-ai',
    license: 'MIT',
    category: 'engineering',
    tier: 'advanced',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'rail-any-station-control-network',
    name: '任意设站控制网测量',
    summary: '导入任意设站控制网观测文件，执行预检、确定性平差、精度解释和成果交付。',
    publisher: publisher('workwise-user-provided', 'RailWise AI 用户提供专项技能', 'workwise://skills/rail-any-station-control-network', false),
    location: 'workwise://skills/rail-any-station-control-network',
    license: 'User-provided internal source',
    category: 'engineering',
    tier: 'recommended',
    version: '0.5.0',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'tender-master',
    name: 'Tender Master',
    summary: 'Turn tender documents into traceable response matrices, drafts, and compliance checks.',
    publisher: publisher('workwise', 'RailWise AI', 'https://github.com/railwise-cn/railwise-ai', true),
    location: 'https://github.com/railwise-cn/railwise-ai',
    license: 'MIT',
    category: 'documents',
    tier: 'recommended',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'document-illustrator',
    name: 'Document Illustrator',
    summary: 'Plan and generate consistent cover, section, and explanatory images for documents.',
    publisher: publisher('guizang', 'Guizang', 'https://github.com/op7418', true),
    location: 'https://github.com/op7418/Document-illustrator-skill',
    license: 'MIT',
    category: 'documents',
    tier: 'recommended',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION, NETWORK_PERMISSION]
  }),
  managedSkillPackage({
    id: 'ppt-master',
    name: 'PPT Master',
    summary: 'Create, fill, and refine editable PPTX decks through a structured presentation workflow.',
    publisher: publisher('hugohe3', 'Hugo He', 'https://github.com/hugohe3', true),
    location: 'https://github.com/hugohe3/ppt-master',
    license: 'MIT',
    category: 'documents',
    tier: 'recommended',
    version: '6.8.0',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION, PROCESS_EXECUTE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'writing-agent',
    name: 'Writing Agent',
    summary: 'Guide Chinese long-form writing from topic and outline through review and publication checks.',
    publisher: publisher('dongbeixiaohuo', 'Dongbei Xiaohuo', 'https://github.com/dongbeixiaohuo', true),
    location: 'https://github.com/dongbeixiaohuo/writing-agent',
    license: 'MIT',
    category: 'writing',
    tier: 'recommended',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION]
  }),
  managedSkillPackage({
    id: 'humanizer-zh',
    name: 'Humanizer Chinese',
    summary: 'Identify and rewrite common AI writing patterns in Chinese while preserving meaning and tone.',
    publisher: publisher('op7418', 'op7418', 'https://github.com/op7418', true),
    location: 'https://github.com/op7418/Humanizer-zh',
    license: 'MIT',
    category: 'writing',
    tier: 'advanced'
  }),
  managedSkillPackage({
    id: 'nuwa-skill',
    name: 'Nuwa Skill',
    summary: 'Research a person or topic and distill its thinking framework into a reusable Skill.',
    publisher: publisher('alchaincyf', 'alchaincyf', 'https://github.com/alchaincyf', true),
    location: 'https://github.com/alchaincyf/nuwa-skill',
    license: 'MIT',
    category: 'agent-workflows',
    tier: 'advanced',
    permissions: [FILESYSTEM_READ_PERMISSION, FILESYSTEM_WRITE_PERMISSION, NETWORK_PERMISSION]
  }),
  wheelMcpPackage({
    id: 'git-mcp',
    name: 'Git MCP',
    summary: 'Git repository inspection and operations.',
    artifact: WHEEL_ARTIFACTS.git,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['development'],
    permissions: [
      FILESYSTEM_READ_PERMISSION,
      FILESYSTEM_WRITE_PERMISSION,
      PROCESS_EXECUTE_PERMISSION
    ],
    dependencies: [UV_DEPENDENCY, PYTHON_310_DEPENDENCY],
    licenseEvidenceCommit: MCP_SERVERS_PYTHON_LICENSE_COMMIT
  }),
  wheelMcpPackage({
    id: 'fetch-mcp',
    name: 'Fetch MCP',
    summary: 'Retrieve web resources through managed uv.',
    artifact: WHEEL_ARTIFACTS.fetch,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['system'],
    permissions: [NETWORK_PERMISSION],
    dependencies: [UV_DEPENDENCY, PYTHON_310_DEPENDENCY],
    licenseEvidenceCommit: MCP_SERVERS_PYTHON_LICENSE_COMMIT
  }),
  wheelMcpPackage({
    id: 'time-mcp',
    name: 'Time MCP',
    summary: 'Timezone and current-time utilities.',
    artifact: WHEEL_ARTIFACTS.time,
    publisher: publisher(
      'model-context-protocol',
      'Model Context Protocol',
      'https://github.com/modelcontextprotocol',
      true
    ),
    license: 'MIT',
    categories: ['system'],
    permissions: [],
    dependencies: [UV_DEPENDENCY, PYTHON_310_DEPENDENCY],
    licenseEvidenceCommit: MCP_SERVERS_PYTHON_LICENSE_COMMIT
  }),
  definePackage({
    id: 'lark-openapi-mcp',
    name: 'Lark OpenAPI MCP',
    summary: 'Use Lark OpenAPI capabilities exposed by the managed Lark toolchain.',
    tier: 'advanced',
    categories: ['collaboration'],
    version: 'managed',
    publisher: publisher('lark', 'Lark', 'https://open.larksuite.com', true),
    license: 'Apache-2.0',
    source: simpleSource('system', 'workwise://managed-tools/lark-openapi-mcp'),
    components: [{
      id: 'lark-openapi-mcp-server',
      name: 'Lark OpenAPI MCP Server',
      type: 'mcp',
      runtime: { kind: 'system', provider: 'lark-cli', capability: 'openapi-mcp' }
    }],
    permissions: [NETWORK_PERMISSION],
    auth: { type: 'tool-managed', provider: 'lark-cli' },
    dependencies: [{
      id: 'lark-cli',
      kind: 'package',
      requirement: 'managed',
      optional: false,
      managedBy: 'workwise'
    }],
    updatePolicy: SYSTEM_UPDATE,
    availability: { status: 'managed', managedBy: 'RailWise AI' },
    installation: SYSTEM_MANAGED_INSTALL
  }),
  wheelMcpPackage({
    id: 'docling-mcp',
    name: 'Docling MCP',
    summary: 'Parse complex local documents with Docling.',
    artifact: WHEEL_ARTIFACTS.docling,
    publisher: publisher(
      'docling-project',
      'Docling Project',
      'https://github.com/docling-project/docling-mcp',
      true
    ),
    license: 'MIT',
    categories: ['documents'],
    permissions: [FILESYSTEM_READ_PERMISSION],
    dependencies: [UV_DEPENDENCY, PYTHON_310_DEPENDENCY]
  }),
  wheelMcpPackage({
    id: 'redis-mcp',
    name: 'Redis MCP',
    summary: 'Connect to Redis data stores.',
    artifact: WHEEL_ARTIFACTS.redis,
    publisher: publisher('redis', 'Redis', 'https://pypi.org/project/redis-mcp-server/', true),
    license: 'MIT',
    categories: ['data'],
    permissions: [DATABASE_READ_PERMISSION, DATABASE_WRITE_PERMISSION],
    auth: { type: 'tool-managed', provider: 'redis-mcp' }
  }),
  npmMcpPackage({
    id: 'mongodb-mcp',
    name: 'MongoDB MCP',
    summary: 'Connect to MongoDB data stores.',
    artifact: NPM_ARTIFACTS.mongodb,
    publisher: publisher('mongodb', 'MongoDB', 'https://www.mongodb.com', true),
    license: 'Apache-2.0',
    categories: ['data'],
    permissions: [DATABASE_READ_PERMISSION, DATABASE_WRITE_PERMISSION],
    auth: { type: 'tool-managed', provider: 'mongodb-mcp' },
    tier: 'advanced'
  }),
  pendingOauthRemote(
    'notion-mcp',
    'Notion MCP',
    'Notion',
    'https://mcp.notion.com/mcp',
    'https://www.notion.so',
    'collaboration'
  ),
  pendingOauthRemote(
    'linear-mcp',
    'Linear MCP',
    'Linear',
    'https://mcp.linear.app/mcp',
    'https://linear.app',
    'collaboration'
  ),
  githubSkillPackage({
    id: 'browser-skill',
    name: 'BrowserSkill',
    summary: '通过 BrowserSkill 操作已登录的 Chrome 或 Edge 浏览器，读取页面并执行网页任务。',
    publisher: publisher('tencent', 'Tencent', 'https://github.com/Tencent/BrowserSkill'),
    owner: 'Tencent',
    repository: 'BrowserSkill',
    commit: '9cfba53582cb04d48da36aabd0a5017987d4daea',
    subpath: 'crates/bsk-cli/skill',
    skillNames: ['browser-skill'],
    license: 'MIT',
    categories: ['browser-automation'],
    usage: { howToUse: '安装后，让 RailWise AI 操作已登录的 Chrome 或 Edge 页面；先说明要查看或执行的网页任务，再让它读取页面、点击控件或整理结果。', requirements: ['BrowserSkill CLI', 'Chrome 或 Edge 扩展'], examples: ['读取当前浏览器页面，把可见表格整理成摘要。'] },
    dependencies: [
      { id: 'bsk-cli', kind: 'system', requirement: 'BrowserSkill CLI', optional: false, managedBy: 'user' },
      { id: 'browser-extension', kind: 'system', requirement: 'Chrome or Edge extension', optional: false, managedBy: 'user' }
    ]
  }),
  githubSkillPackage({
    id: 'blender-skills',
    name: 'Blender Skills',
    summary: '面向 Blender 的建模、材质、动画和导出工作流技能包。',
    publisher: publisher('arjun988', 'arjun988', 'https://github.com/arjun988/blender-skills'),
    owner: 'arjun988',
    repository: 'blender-skills',
    commit: '8f778d2405a214b508d4c7d80742be8e43acdd52',
    subpath: '.claude/skills',
    skillNames: ['blender-skills'],
    license: 'MIT',
    categories: ['development'],
    usage: { howToUse: '安装 Skill 和 Blender MCP 插件后，直接描述场景、建模、材质、动画或导出任务；AI 会在 Blender 中执行并反馈结果。', requirements: ['Blender', 'Blender MCP 插件'], examples: ['创建一个低多边形地铁车站场景并导出预览。'] },
    dependencies: [
      { id: 'blender', kind: 'system', requirement: 'Blender', optional: false, managedBy: 'user' },
      { id: 'blender-mcp', kind: 'system', requirement: 'Blender MCP add-on', optional: false, managedBy: 'user' }
    ]
  }),
  githubSkillPackage({
    id: 'video-shotcraft',
    name: 'Video Shotcraft',
    summary: '用分镜方案、Remotion、节奏同步和声音设计制作可编辑的产品视频。',
    publisher: publisher('vincentwei1021', 'Vincent Wei', 'https://github.com/Vincentwei1021/video-shotcraft'),
    owner: 'Vincentwei1021',
    repository: 'video-shotcraft',
    commit: '1266a3ec4831289c4d893d42dd5102723658039a',
    skillNames: ['video-shotcraft'],
    license: 'Apache-2.0',
    categories: ['visualization'],
    usage: { howToUse: '准备好 Node.js 后安装 Skill，给出视频 brief、时长、画幅和镜头要求；它会生成可继续修改的 Remotion 工程和分镜方案。', requirements: ['Node.js'], examples: ['把这份产品 brief 做成 30 秒、节奏同步的镜头表。'] },
    dependencies: [{ id: 'node', kind: 'runtime', requirement: 'Node.js', optional: false, managedBy: 'user' }]
  }),
  githubSkillPackage({
    id: 'diagram-design',
    name: 'Diagram Design',
    summary: '制作适合报告和演示的高质量 HTML/SVG 图表，并支持继续修改。',
    publisher: publisher('cathrynlavery', 'Cathryn Lavery', 'https://github.com/cathrynlavery/diagram-design'),
    owner: 'cathrynlavery',
    repository: 'diagram-design',
    commit: '0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1',
    skillNames: ['diagram-design'],
    license: 'MIT',
    categories: ['visualization'],
    usage: { howToUse: '安装后，描述仓库、文章、PDF 或本地项目，并说明想要的图形或输出格式。Skill 会生成可交互的架构图，并可继续修改规格后重新导出。', requirements: ['Node.js ≥18', 'Chrome/Chromium/Edge', '生成 MP4/GIF 时需要 ffmpeg'], examples: ['把 https://github.com/plausible/analytics 画成架构图', '把这篇文章画成流程图并输出 30 秒视频', '把刚才的图输出成 Mermaid'] },
    dependencies: [{ id: 'node', kind: 'runtime', requirement: 'Node.js', optional: true, managedBy: 'user' }]
  }),
  githubSkillPackage({
    id: 'arch-diagram-skill',
    name: 'Arch Diagram',
    summary: '把仓库、文章、PDF 或本地项目生成可交互的架构图，并导出 HTML、PNG、MP4、GIF 或 Mermaid。',
    publisher: publisher('bassnova42', 'bassnova42', 'https://github.com/bassnova42/arch-diagram-skill'),
    owner: 'bassnova42',
    repository: 'arch-diagram-skill',
    commit: '879ca7fa503a64ab46b5bc77d2062ded32fadc84',
    subpath: 'skills/arch-diagram',
    skillNames: ['arch-diagram'],
    license: 'MIT',
    categories: ['visualization'],
    usage: {
      howToUse: '安装后直接描述要分析的仓库、文章、PDF 或本地项目，再指定输出 HTML、PNG、Mermaid、MP4 或 GIF。需要调整时，修改生成的 spec.json 后重新运行构建或导出。',
      requirements: ['Node.js ≥18', 'Chrome/Chromium/Edge', '生成 MP4/GIF 时需要 ffmpeg'],
      examples: ['把 https://github.com/plausible/analytics 画成架构图', '把这篇文章画成流程图并输出 30 秒视频', '把刚才的图输出成 Mermaid']
    },
    dependencies: [
      { id: 'node', kind: 'runtime', requirement: 'Node.js >=18', optional: false, managedBy: 'user' },
      { id: 'browser', kind: 'system', requirement: 'Chrome/Chromium/Edge', optional: false, managedBy: 'user' },
      { id: 'ffmpeg', kind: 'system', requirement: 'ffmpeg（仅 MP4/GIF）', optional: true, managedBy: 'user' }
    ]
  })
]

function npmMcpPackage(options: {
  id: string
  name: string
  summary: string
  artifact: NpmArtifact
  publisher: PackagePublisherV1
  license: string
  categories: string[]
  permissions?: PackagePermissionV1[]
  auth?: MarketplacePackageV1['auth']
  args?: string[]
  tier?: MarketplacePackageV1['tier']
  licenseEvidenceCommit?: string
}): MarketplacePackageV1 {
  const licenseSourceId = `${options.id}-source-2`
  return definePackage({
    id: options.id,
    name: options.name,
    summary: options.summary,
    tier: options.tier ?? 'recommended',
    categories: options.categories,
    version: options.artifact.version,
    publisher: options.publisher,
    license: options.license,
    source: npmSource(options.artifact),
    additionalSources: options.licenseEvidenceCommit
      ? [mcpServersLicenseSource(options.licenseEvidenceCommit)]
      : [],
    components: [{
      id: `${options.id}-server`,
      name: `${options.name} Server`,
      type: 'mcp',
      runtime: npmRuntime(options.artifact, options.args)
    }],
    permissions: options.permissions ?? [],
    auth: options.auth ?? { type: 'none' },
    licenseEvidence: options.licenseEvidenceCommit
      ? [{
          license: options.license,
          sourceId: licenseSourceId,
          path: 'LICENSE',
          includeInInstall: true,
          required: true
        }]
      : [],
    dependencies: [NODE_DEPENDENCY],
    updatePolicy: PINNED_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  })
}

function wheelMcpPackage(options: {
  id: string
  name: string
  summary: string
  artifact: WheelArtifact
  publisher: PackagePublisherV1
  license: string
  categories: string[]
  permissions: PackagePermissionV1[]
  auth?: MarketplacePackageV1['auth']
  dependencies?: PackageDependencyV1[]
  licenseEvidenceCommit?: string
}): MarketplacePackageV1 {
  const licenseSourceId = `${options.id}-source-2`
  return definePackage({
    id: options.id,
    name: options.name,
    summary: options.summary,
    tier: 'advanced',
    categories: options.categories,
    version: options.artifact.version,
    publisher: options.publisher,
    license: options.license,
    source: pypiSource(options.artifact),
    additionalSources: options.licenseEvidenceCommit
      ? [mcpServersLicenseSource(options.licenseEvidenceCommit)]
      : [],
    components: [{
      id: `${options.id}-server`,
      name: `${options.name} Server`,
      type: 'mcp',
      runtime: wheelRuntime(options.artifact)
    }],
    permissions: options.permissions,
    auth: options.auth ?? { type: 'none' },
    licenseEvidence: options.licenseEvidenceCommit
      ? [{
          license: options.license,
          sourceId: licenseSourceId,
          path: 'LICENSE',
          includeInInstall: true,
          required: true
        }]
      : [],
    dependencies: options.dependencies ?? [UV_DEPENDENCY],
    updatePolicy: PINNED_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  })
}

function managedPackage(
  id: string,
  name: string,
  summary: string,
  publisherName: string,
  location: string,
  license: string | null,
  installedByDefault: boolean,
  publisherVerified = false,
  category = 'system',
  tier: MarketplacePackageV1['tier'] = 'recommended',
  productType: MarketplaceProductTypeV1 = 'utility'
): MarketplacePackageV1 {
  return definePackage({
    id,
    name,
    summary,
    tier,
    productType,
    categories: [category],
    version: 'managed',
    publisher: publisher(id, publisherName, location, publisherVerified),
    license,
    source: simpleSource('system', location),
    components: [{
      id: `${id}-managed-component`,
      name,
      type: 'cli',
      runtime: { kind: 'system', provider: 'workwise', capability: id }
    }],
    permissions: [],
    auth: { type: 'tool-managed', provider: id },
    updatePolicy: SYSTEM_UPDATE,
    availability: { status: 'managed', managedBy: 'RailWise AI' },
    installation: { ...SYSTEM_MANAGED_INSTALL, installedByDefault }
  })
}

function managedSkillPackage(options: {
  id: string
  name: string
  summary: string
  publisher: PackagePublisherV1
  location: string
  license: string
  category: string
  tier: MarketplacePackageV1['tier']
  version?: string
  installedByDefault?: boolean
  permissions?: PackagePermissionV1[]
}): MarketplacePackageV1 {
  return definePackage({
    id: options.id,
    name: options.name,
    summary: options.summary,
    tier: options.tier,
    productType: 'workflow',
    categories: [options.category],
    version: options.version ?? 'bundled',
    publisher: options.publisher,
    license: options.license,
    source: simpleSource('system', options.location),
    components: [{
      id: `${options.id}-skill`,
      name: options.name,
      type: 'skill',
      skillNames: [options.id],
      runtime: { kind: 'system', provider: 'workwise', capability: `skill:${options.id}` }
    }],
    permissions: options.permissions ?? [],
    auth: { type: 'none' },
    updatePolicy: SYSTEM_UPDATE,
    availability: { status: 'managed', managedBy: 'RailWise AI' },
    installation: { ...SYSTEM_MANAGED_INSTALL, installedByDefault: options.installedByDefault ?? true }
  })
}

function pendingOauthRemote(
  id: string,
  name: string,
  publisherName: string,
  endpoint: string,
  publisherUrl: string,
  category: string
): MarketplacePackageV1 {
  return definePackage({
    id,
    name,
    summary: `${name} is disabled until OAuth discovery is supported.`,
    tier: 'advanced',
    categories: [category],
    version: 'remote',
    publisher: publisher(id, publisherName, publisherUrl),
    license: null,
    source: simpleSource('remote', endpoint),
    components: [{
      id: `${id}-server`,
      name: `${name} Server`,
      type: 'mcp',
      runtime: { kind: 'remote', transport: 'streamable-http', endpoint }
    }],
    permissions: [NETWORK_PERMISSION],
    auth: { type: 'oauth', provider: id, discovery: 'pending' },
    updatePolicy: MANUAL_UPDATE,
    availability: {
      status: 'unavailable',
      reasonCode: 'oauth-discovery-pending',
      message: 'OAuth discovery is not available in RailWise AI yet.'
    },
    installation: EXTERNAL_INSTALL
  })
}

function githubSkillPackage(options: {
  id: string
  name: string
  summary: string
  publisher: PackagePublisherV1
  owner: string
  repository: string
  commit: string
  subpath?: string
  skillNames: string[]
  license: string
  categories: string[]
  dependencies?: PackageDependencyV1[]
  usage?: MarketplacePackageV1['usage']
}): MarketplacePackageV1 {
  return definePackage({
    id: options.id,
    name: options.name,
    summary: options.summary,
    tier: 'advanced',
    productType: 'workflow',
    categories: options.categories,
    version: options.commit,
    publisher: options.publisher,
    license: options.license,
    source: {
      kind: 'github',
      location: `https://github.com/${options.owner}/${options.repository}`,
      owner: options.owner,
      repository: options.repository,
      defaultBranch: 'main',
      requestedRef: 'main',
      resolvedRef: options.commit,
      ...(options.subpath ? { subpath: options.subpath } : {})
    },
    additionalSources: [{
      kind: 'github',
      location: `https://github.com/${options.owner}/${options.repository}`,
      owner: options.owner,
      repository: options.repository,
      defaultBranch: 'main',
      requestedRef: 'main',
      resolvedRef: options.commit
    }],
    components: [{
      id: `${options.id}-skill`,
      name: options.name,
      type: 'skill',
      skillNames: options.skillNames,
      runtime: {
        kind: 'github',
        repository: `https://github.com/${options.owner}/${options.repository}`,
        resolvedCommit: options.commit,
        ...(options.subpath ? { subpath: options.subpath } : {}),
        install: { strategy: 'managed-git', verifyBeforeActivation: true }
      }
    }],
    permissions: [],
    auth: { type: 'none' },
    licenseEvidence: [{
      license: options.license,
      sourceId: `${options.id}-source-2`,
      path: 'LICENSE',
      includeInInstall: true,
      required: true
    }],
    dependencies: options.dependencies ?? [],
    usage: options.usage,
    updatePolicy: MANUAL_UPDATE,
    availability: { status: 'available' },
    installation: DIRECT_MIRROR_INSTALL
  })
}

function assertUnique(label: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} ID in marketplace catalog.`)
}

function assertCatalogInvariants(): void {
  assertUnique('catalog source', catalogSources.map((source) => source.id))
  assertUnique('package', officialPackages.map((item) => item.id))
  assertUnique(
    'component',
    officialPackages.flatMap((item) => item.components.map((component) => component.id))
  )

  for (const item of officialPackages) {
    assertUnique(`${item.id} source`, item.sources.map((source) => source.id))
    if (!item.sources.some((source) => source.id === item.source.id)) {
      throw new Error(`${item.id} primary source is absent from sources.`)
    }

    for (const source of item.sources) {
      if ((source.kind === 'github' || source.kind === 'git') &&
          !SHA1_COMMIT.test(source.resolvedRef)) {
        throw new Error(`${item.id} Git source is not pinned to an immutable commit.`)
      }
    }

    for (const evidence of item.licenseEvidence) {
      const source = item.sources.find((candidate) => candidate.id === evidence.sourceId)
      if (!source ||
          (source.kind !== 'github' && source.kind !== 'git') ||
          !SHA1_COMMIT.test(source.resolvedRef) ||
          evidence.license !== item.license ||
          !evidence.includeInInstall ||
          !evidence.required) {
        throw new Error(`${item.id} license evidence is incomplete or mutable.`)
      }
    }

    for (const component of item.components) {
      const source = item.sources.find((candidate) => candidate.id === component.sourceId)
      if (!source) throw new Error(`${item.id}/${component.id} has no matching source.`)

      if (component.runtime.kind === 'npm') {
        if (source.kind !== 'npm' ||
            source.packageName !== component.runtime.packageName ||
            source.version !== component.runtime.version ||
            source.digest.algorithm !== 'sha512-sri' ||
            component.runtime.install.digestSource !== 'component-source' ||
            item.version !== component.runtime.version) {
          throw new Error(`${item.id}/${component.id} npm provenance is incoherent.`)
        }
      }
      if (component.runtime.kind === 'uv' && source.kind === 'pypi') {
        if (source.packageName !== component.runtime.packageName ||
            source.version !== component.runtime.version ||
            source.digest.value !== component.runtime.install.digest.value ||
            item.version !== component.runtime.version) {
          throw new Error(`${item.id}/${component.id} wheel provenance is incoherent.`)
        }
      }
      if (component.runtime.kind === 'github') {
        if (source.kind !== 'github' ||
            source.resolvedRef !== component.runtime.resolvedCommit ||
            item.version !== component.runtime.resolvedCommit) {
          throw new Error(`${item.id}/${component.id} Git provenance is incoherent.`)
        }
      }
    }

    const installationMode = item.installation.mode
    if (installationMode === 'direct-mirror') {
      if (item.availability.status !== 'available' ||
          evaluateMarketplaceLicense(item.license).disposition !== 'direct-mirror') {
        throw new Error(`${item.id} is not eligible for direct mirroring.`)
      }
      if (item.components.some((component) =>
        component.runtime.kind === 'remote' ||
        component.runtime.kind === 'system'
      )) {
        throw new Error(`${item.id} has an install mode inconsistent with its runtime.`)
      }
    } else if (installationMode === 'upstream-only') {
      if (!isApprovedUpstreamPackage(item)) throw new Error(`${item.id} upstream installation is not approved.`)
    } else if (item.installation.reinstallable) {
      throw new Error(`${item.id} cannot be reinstallable in ${installationMode} mode.`)
    }

    if (item.installation.mode === 'system-managed' &&
        (item.availability.status !== 'managed' ||
         item.components.some((component) => component.runtime.kind !== 'system'))) {
      throw new Error(`${item.id} has inconsistent system-managed metadata.`)
    }
  }
}

assertCatalogInvariants()

export function getMarketplaceCatalogSources(): CatalogSourceV1[] {
  return structuredClone(catalogSources)
}

export function getOfficialMarketplaceCatalog(): MarketplacePackageV1[] {
  return structuredClone(officialPackages)
}
