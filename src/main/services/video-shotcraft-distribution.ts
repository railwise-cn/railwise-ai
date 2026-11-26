import { readFile, unlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import { inspectPackageDirectory, packageInstallLimitsFor } from './package-installation-service'

export const VIDEO_SHOTCRAFT_COMMIT = '1152363da5c824b32dba6d8a2ef7f935b677e445'
export const VIDEO_SHOTCRAFT_DISTRIBUTION_VERSION = `${VIDEO_SHOTCRAFT_COMMIT}-railwise.1`
export const VIDEO_SHOTCRAFT_DISTRIBUTION_RECEIPT = 'railwise-distribution.json'
export const VIDEO_SHOTCRAFT_DISTRIBUTION_NOTICE = 'RAILWISE-DISTRIBUTION.md'

const CODE_EXTENSIONS = new Set([
  '.cjs', '.cmd', '.css', '.cts', '.js', '.json', '.jsx', '.md', '.mdx', '.mjs', '.mts',
  '.ps1', '.py', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml'
])
const CODE_ROOTS = [
  'assets/lib/', 'assets/scripts/', 'demos/', 'references/', 'template/',
  'workbench/', 'jianying-export/', 'publish/'
]
const ROOT_SOURCE_FILES = new Set([
  'LICENSE', 'NOTICE', 'COPYING', 'SKILL.md', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vitest.config.ts'
])
const ATTRIBUTION_FILES = new Set([
  'assets/audio/ATTRIBUTION.md',
  'assets/readme/sponsors/ATTRIBUTION.md',
  'references/shots/ATTRIBUTION.md',
  'template/public/audio/ATTRIBUTION.md'
])

function includesCodeOrDocumentation(path: string): boolean {
  if (ATTRIBUTION_FILES.has(path)) return true
  if (ROOT_SOURCE_FILES.has(path) || /^README(?:[._-][A-Za-z0-9-]+)?\.md$/.test(path)) return true
  if (path === 'workbench/index.html') return true
  if (path.startsWith('template/public/') || path.startsWith('workbench/public/')) return false
  return CODE_ROOTS.some(root => path.startsWith(root)) && CODE_EXTENSIONS.has(extname(path))
}

const SETUP = `RailWise AI distributes the Apache-2.0 code and documentation from the pinned upstream commit. The upstream demo, sponsor graphics, historical audio, stock music, fonts, product screenshots and gallery previews are separate media and are excluded. Attribution records are retained.

For a new video, use original or separately licensed media from the current workspace. The historical Ink Press example requires separate media. Start a new Remotion composition or replace all historical media references first.

Rendering requires the user's Node.js and npm, a licensed Remotion 4.0.484 toolchain, a supported headless Chrome executable, and FFmpeg/FFprobe for checks. Set up that rendering environment and licensed media separately. Check the actual prerequisites and task permissions before installing, browsing, rendering, or publishing.`

const INSTALL_NOTICE_CN = `睿威镜像包含 Apache-2.0 授权的代码与文档。上游演示媒体、品牌图片、历史音效、配乐、字体和产品截图未随包分发，相关署名记录保留。请使用工作区中自有或已获授权的素材，并建立新的 Remotion 合成或替换模板中缺失的全部示例素材。

成片渲染需另备 Node.js 与 npm、具备适用许可的 Remotion 4.0.484、受支持的 Chromium 浏览器及用于核验的 FFmpeg / FFprobe。进入任务前先确认本机依赖、浏览器路径及任务权限。技能加载成功仅表示可在聊天中选择。`

export async function curateVideoShotcraftMirror(item: MarketplacePackageV1, stagingDirectory: string): Promise<void> {
  const source = item.source
  if (item.id !== 'video-shotcraft' || item.version !== VIDEO_SHOTCRAFT_DISTRIBUTION_VERSION ||
      item.installation.mode !== 'direct-mirror' || source.kind !== 'github' ||
      source.catalogSourceId !== 'workwise-official' || source.owner !== 'Vincentwei1021' ||
      source.repository !== 'video-shotcraft' || source.resolvedRef !== VIDEO_SHOTCRAFT_COMMIT || source.subpath) {
    throw new Error('Video Shotcraft distribution does not match the reviewed package revision and upstream commit.')
  }
  const tree = await inspectPackageDirectory(stagingDirectory, packageInstallLimitsFor(item))
  const paths = [...tree.paths].sort()
  for (const required of ['LICENSE', 'SKILL.md', 'template/package.json', 'references/pipeline.md', ...ATTRIBUTION_FILES]) {
    if (!paths.includes(required)) throw new Error(`Video Shotcraft reviewed source is incomplete: ${required}`)
  }
  const excludedFiles: string[] = []
  const textDecoder = new TextDecoder('utf-8', { fatal: true })
  for (const path of paths) {
    const fullPath = join(stagingDirectory, ...path.split('/'))
    if (includesCodeOrDocumentation(path)) {
      const source = textDecoder.decode(await readFile(fullPath))
      // Keep the distribution textual. Data URLs containing embedded media
      // are not admitted just because the enclosing file has a code suffix.
      if (!/data:(?:image|audio|video)\/[^;\s]+;base64,[A-Za-z0-9+/]{256}/i.test(source)) continue
    }
    await unlink(fullPath)
    excludedFiles.push(path)
  }
  const entryPath = join(stagingDirectory, 'SKILL.md')
  const entry = await readFile(entryPath, 'utf8')
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(entry)?.[0]
  if (!frontmatter) throw new Error('Video Shotcraft Skill frontmatter does not match the pinned source.')
  const change = 'RailWise AI added the distribution and setup notice below. Original upstream instructions follow.'
  const notice = `# RailWise AI distribution notice\n\nUpstream source commit: ${VIDEO_SHOTCRAFT_COMMIT}\n\n${change}\n\n${SETUP}\n\n${INSTALL_NOTICE_CN}\n`
  await writeFile(entryPath, `${frontmatter}\n> ${change}\n\n${SETUP}\n\n${entry.slice(frontmatter.length)}`)
  await writeFile(join(stagingDirectory, VIDEO_SHOTCRAFT_DISTRIBUTION_NOTICE), notice, { flag: 'wx' })
  await writeFile(join(stagingDirectory, VIDEO_SHOTCRAFT_DISTRIBUTION_RECEIPT), `${JSON.stringify({
    schemaVersion: 1,
    packageId: item.id,
    version: item.version,
    upstream: { repository: source.location, commit: source.resolvedRef },
    license: 'Apache-2.0 (code and documentation)',
    modified: ['SKILL.md'],
    attributionFiles: [...ATTRIBUTION_FILES].sort(),
    excludedFiles
  }, null, 2)}\n`, { flag: 'wx' })
}
