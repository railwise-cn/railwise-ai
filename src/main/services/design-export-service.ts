import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import JSZip from 'jszip'
import { documentToSvgStrings } from '../../shared/design-svg-serializer'
import type { DesignDocumentV1 } from '../../shared/design-document'
import { atomicWriteFile } from './durable-file'
import { resolvePptMasterScript } from './design-ppt-master-paths'
import { isPptMasterSidecarAvailable, runPptMasterSidecar } from './ppt-master-sidecar'
import { preserveProtectedPptxContent, validatePptxRoundTrip } from './pptx-integrity'

/**
 * Design 工作区导出服务（main 进程）。
 *
 * 把 DesignDocument 的每页序列化为 SVG → 写入临时项目目录 →
 * 调用 PPT Master 的 svg_to_pptx.py 转为原生可编辑 PPTX。
 *
 * 复用 ppt-master-tool-provider 的 execFile + 超时 + abort 模式
 * （✅ 已核实 ppt-master-tool-provider.ts:244-276）。
 */

const EXPORT_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 // 4MB stdout/stderr
const MAX_PPTX_BYTES = 200 * 1024 * 1024
const MAX_PPTX_ENTRIES = 20_000

export type DesignExportResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

const POWERPOINT_MIN_SIDE_PX = 96
const POWERPOINT_MAX_SIDE_PX = 5_376

export function createFlatPptMasterSpecLock(input: {
  width: number
  height: number
  format: 'ppt169' | 'ppt43'
}): string {
  return [
    '<!-- ppt-master-schema: spec-lock/v1 -->',
    '# Execution Lock',
    '',
    '## canvas',
    `- viewBox: 0 0 ${input.width} ${input.height}`,
    `- format: ${input.format}`,
    '',
    '## colors',
    '- bg: #FFFFFF',
    '- primary: #1E3A5F',
    '- accent: #2563EB',
    '- text: #111827',
    '',
    '## typography',
    '- font_family: Arial',
    '- title_family: Arial',
    '- body_family: Arial',
    '- body: 18',
    '- title: 32',
    '',
    '## pptx_structure',
    '- mode: flat',
    ''
  ].join('\n')
}

export function validatePowerPointCanvasSize(doc: DesignDocumentV1): string | null {
  if (doc.pages.length === 0) return 'The design has no pages to export.'
  const first = doc.pages[0]
  for (let index = 0; index < doc.pages.length; index += 1) {
    const page = doc.pages[index]
    if (
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width < POWERPOINT_MIN_SIDE_PX ||
      page.height < POWERPOINT_MIN_SIDE_PX ||
      page.width > POWERPOINT_MAX_SIDE_PX ||
      page.height > POWERPOINT_MAX_SIDE_PX
    ) {
      return `Page ${index + 1} must be between ${POWERPOINT_MIN_SIDE_PX} and ${POWERPOINT_MAX_SIDE_PX} pixels per side for PowerPoint export.`
    }
    if (page.width !== first.width || page.height !== first.height) {
      return 'PowerPoint export requires every page in a design to use the same canvas size.'
    }
  }
  return null
}

export function validateDesignExportAssets(
  doc: DesignDocumentV1,
  assetDataUrls?: Readonly<Record<string, string>>
): string | null {
  for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex += 1) {
    for (const element of doc.pages[pageIndex].elements) {
      if (element.type !== 'image' || element.hidden) continue
      const dataUrl = element.imageAssetId ? assetDataUrls?.[element.imageAssetId] : undefined
      if (
        !dataUrl ||
        dataUrl.length > 18 * 1024 * 1024 ||
        !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl)
      ) {
        return `Page ${pageIndex + 1} contains a missing or invalid image asset.`
      }
    }
  }
  return null
}

/** 解析 Python 命令（复用 ppt-master-tool-provider 的逻辑） */
function resolvePythonCommand(): string {
  return process.env.WORKWISE_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
}

function isPackagedRuntime(): boolean {
  const resourcesPath = process.resourcesPath?.trim()
  if (!resourcesPath || process.defaultApp === true) return false
  return existsSync(join(resourcesPath, 'app.asar')) ||
    existsSync(join(resourcesPath, 'app.asar.unpacked'))
}

type OoxmlRelationship = {
  id: string
  type: string
  target: string
  external: boolean
}

function xmlAttribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\s)${escaped}=["']([^"']+)["']`, 'i').exec(tag)?.[1]
}

function relationshipBase(relationshipPath: string): string {
  const marker = '/_rels/'
  const index = relationshipPath.indexOf(marker)
  if (index >= 0) return relationshipPath.slice(0, index)
  return relationshipPath.startsWith('_rels/') ? '' : posix.dirname(relationshipPath)
}

function relationshipPartPath(sourcePart: string): string {
  return posix.join(posix.dirname(sourcePart), '_rels', `${posix.basename(sourcePart)}.rels`)
}

function parseRelationships(xml: string): OoxmlRelationship[] {
  return (xml.match(/<Relationship\b[^>]*>/gi) ?? []).map((tag) => ({
    id: xmlAttribute(tag, 'Id') ?? '',
    type: xmlAttribute(tag, 'Type') ?? '',
    target: xmlAttribute(tag, 'Target') ?? '',
    external: xmlAttribute(tag, 'TargetMode')?.toLowerCase() === 'external'
  }))
}

function resolveRelationshipTarget(relationshipPath: string, rawTarget: string): string {
  if (!rawTarget || rawTarget.includes('\0') || rawTarget.includes('\\')) {
    throw new Error(`Unsafe OOXML relationship target in ${relationshipPath}.`)
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(rawTarget)
  } catch {
    throw new Error(`Invalid OOXML relationship target encoding in ${relationshipPath}.`)
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('/')) {
    throw new Error(`Unsafe OOXML relationship target in ${relationshipPath}.`)
  }
  const target = posix.normalize(posix.join(relationshipBase(relationshipPath), decoded))
  if (target === '..' || target.startsWith('../') || target.startsWith('/')) {
    throw new Error(`Unsafe OOXML relationship target in ${relationshipPath}.`)
  }
  return target
}

function isMediaRelationship(type: string): boolean {
  return /\/(?:image|media|audio|video)$/i.test(type)
}

async function validatePowerPointBytes(bytes: Buffer, expectedSlideCount: number): Promise<void> {
  if (bytes.length < 100 || bytes.length > MAX_PPTX_BYTES) {
    throw new Error('Exported PowerPoint package is empty or exceeds the size limit.')
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: true })
  } catch (error) {
    throw new Error(`Invalid PowerPoint OOXML archive: ${error instanceof Error ? error.message : String(error)}`)
  }

  const names = Object.keys(zip.files)
  if (names.length > MAX_PPTX_ENTRIES) {
    throw new Error(`PowerPoint package contains too many entries (${names.length}).`)
  }
  const requiredParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels'
  ]
  const missing = requiredParts.filter((name) => !zip.file(name))
  if (missing.length > 0) {
    throw new Error(`PowerPoint package is missing required OOXML parts: ${missing.join(', ')}.`)
  }

  const relationshipFiles = names.filter((name) => name.endsWith('.rels'))
  for (const relationshipPath of relationshipFiles) {
    const xml = await zip.file(relationshipPath)?.async('string')
    if (!xml) continue
    for (const relationship of parseRelationships(xml)) {
      if (!relationship.id || !relationship.target) {
        throw new Error(`Malformed OOXML relationship in ${relationshipPath}.`)
      }
      if (relationship.external) {
        if (isMediaRelationship(relationship.type)) {
          throw new Error(`PowerPoint contains an external media relationship in ${relationshipPath}.`)
        }
        continue
      }
      const target = resolveRelationshipTarget(relationshipPath, relationship.target)
      if (!zip.file(target)) {
        throw new Error(`Broken OOXML relationship: ${relationshipPath} -> ${relationship.target}.`)
      }
    }
  }

  const presentationXml = await zip.file('ppt/presentation.xml')!.async('string')
  const slideIdTags = presentationXml.match(/<(?:[A-Za-z_][\w.-]*:)?sldId\b[^>]*>/gi) ?? []
  if (slideIdTags.length !== expectedSlideCount) {
    throw new Error(
      `PowerPoint slide count mismatch: expected ${expectedSlideCount}, found ${slideIdTags.length}.`
    )
  }
  const presentationRelsXml = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const presentationRelationships = new Map(
    parseRelationships(presentationRelsXml).map((relationship) => [relationship.id, relationship])
  )
  const slideParts = new Set<string>()
  for (const slideTag of slideIdTags) {
    const relationshipId = xmlAttribute(slideTag, 'r:id')
    const relationship = relationshipId ? presentationRelationships.get(relationshipId) : undefined
    if (!relationship || relationship.external || !/\/slide$/i.test(relationship.type)) {
      throw new Error('PowerPoint presentation contains an invalid slide relationship.')
    }
    const slidePart = resolveRelationshipTarget('ppt/_rels/presentation.xml.rels', relationship.target)
    if (!/^ppt\/slides\/[^/]+\.xml$/i.test(slidePart) || !zip.file(slidePart)) {
      throw new Error(`PowerPoint presentation references an invalid slide part: ${relationship.target}.`)
    }
    slideParts.add(slidePart)
  }
  if (slideParts.size !== expectedSlideCount) {
    throw new Error('PowerPoint presentation contains duplicate or missing slide relationships.')
  }

  const actualSlideParts = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
  if (actualSlideParts.length !== expectedSlideCount) {
    throw new Error(
      `PowerPoint slide package count mismatch: expected ${expectedSlideCount}, found ${actualSlideParts.length}.`
    )
  }

  for (const slidePart of slideParts) {
    const slideXml = await zip.file(slidePart)!.async('string')
    const embeddedImageIds = (slideXml.match(/<(?:[A-Za-z_][\w.-]*:)?blip\b[^>]*>/gi) ?? [])
      .map((tag) => xmlAttribute(tag, 'r:embed') ?? xmlAttribute(tag, 'r:link'))
      .filter((id): id is string => Boolean(id))
    if (embeddedImageIds.length === 0) continue

    const slideRelationshipPath = relationshipPartPath(slidePart)
    const slideRelationshipsXml = await zip.file(slideRelationshipPath)?.async('string')
    if (!slideRelationshipsXml) {
      throw new Error(`PowerPoint slide is missing relationships: ${slidePart}.`)
    }
    const slideRelationships = new Map(
      parseRelationships(slideRelationshipsXml).map((relationship) => [relationship.id, relationship])
    )
    for (const relationshipId of embeddedImageIds) {
      const relationship = slideRelationships.get(relationshipId)
      if (!relationship || relationship.external || !/\/image$/i.test(relationship.type)) {
        throw new Error(`PowerPoint slide contains an invalid image relationship: ${slidePart}.`)
      }
      const mediaPart = resolveRelationshipTarget(slideRelationshipPath, relationship.target)
      if (!/^ppt\/media\/[^/]+$/i.test(mediaPart) || !zip.file(mediaPart)) {
        throw new Error(`PowerPoint slide references missing media: ${slidePart}.`)
      }
    }
  }
}

export async function validateAndCommitPowerPoint(
  candidatePath: string,
  outputPath: string,
  expectedSlideCount: number,
  sourceBytes?: Uint8Array
): Promise<void> {
  const info = await lstat(candidatePath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Exported PowerPoint package is not a regular file.')
  }
  const candidateBytes = await readFile(candidatePath)
  const bytes = sourceBytes ? await preserveProtectedPptxContent(sourceBytes, candidateBytes) : candidateBytes
  await validatePowerPointBytes(bytes, expectedSlideCount)
  if (sourceBytes) await validatePptxRoundTrip(sourceBytes, bytes)
  await atomicWriteFile(outputPath, bytes)
}

export async function validateAndCommitPowerPointBytes(
  candidateBytes: Uint8Array,
  outputPath: string,
  expectedSlideCount: number,
  sourceBytes?: Uint8Array
): Promise<void> {
  if (candidateBytes.byteLength <= 0 || candidateBytes.byteLength > MAX_PPTX_BYTES) {
    throw new Error(`PowerPoint export exceeds the ${MAX_PPTX_BYTES} byte limit.`)
  }
  const bytes = sourceBytes ? await preserveProtectedPptxContent(sourceBytes, candidateBytes) : Buffer.from(candidateBytes)
  await validatePowerPointBytes(bytes, expectedSlideCount)
  if (sourceBytes) await validatePptxRoundTrip(sourceBytes, bytes)
  await atomicWriteFile(outputPath, bytes)
}

/**
 * 导出 DesignDocument 为 PPTX。
 *
 * 流程：
 * 1. 每页序列化为 SVG 字符串（documentToSvgStrings）
 * 2. 写入临时目录的 svg_output/slide_NN.svg
 * 3. 调用 svg_to_pptx.py 转换
 * 4. 校验产出 .pptx
 *
 * @param doc 设计文档
 * @param outputPath 用户选择的输出路径（.pptx）
 */
export async function exportDesignToPptx(
  doc: DesignDocumentV1,
  outputPath: string,
  assetDataUrls?: Readonly<Record<string, string>>
): Promise<DesignExportResult> {
  const canvasError = validatePowerPointCanvasSize(doc)
  if (canvasError) return { ok: false, message: canvasError }
  const assetError = validateDesignExportAssets(doc, assetDataUrls)
  if (assetError) return { ok: false, message: assetError }

  const sidecarAvailable = isPptMasterSidecarAvailable()
  const scriptPath = sidecarAvailable ? null : resolvePptMasterScript('svg_to_pptx.py')
  const developmentFallbackAllowed = !isPackagedRuntime()
  if (!sidecarAvailable && !developmentFallbackAllowed) {
    return { ok: false, message: 'The bundled PPT Master runtime is unavailable.' }
  }
  if (!sidecarAvailable && !scriptPath) {
    return { ok: false, message: 'PPT Master scripts not found. Please ensure PPT Master skill is installed.' }
  }

  // 创建临时项目目录
  const tempProject = await mkdtemp(join(tmpdir(), 'workwise-design-export-'))
  const svgOutputDir = join(tempProject, 'svg_output')
  await mkdir(svgOutputDir, { recursive: true })

  try {
    const firstPage = doc.pages[0]
    const format = firstPage.width / firstPage.height < 1.5 ? 'ppt43' : 'ppt169'
    await writeFile(
      join(tempProject, 'spec_lock.md'),
      createFlatPptMasterSpecLock({
        width: firstPage.width,
        height: firstPage.height,
        format
      }),
      'utf8'
    )

    // 1. 写入每页 SVG
    const svgStrings = documentToSvgStrings(doc, { assetDataUrls })
    for (let i = 0; i < svgStrings.length; i++) {
      const padded = String(i + 1).padStart(2, '0')
      const svgPath = join(svgOutputDir, `slide_${padded}.svg`)
      await writeFile(svgPath, svgStrings[i], 'utf8')
    }

    // 2. sidecar 只能写入受限临时根。完整验证后，atomicWriteFile 会在最终目录
    //    创建同目录临时文件并原子替换，任何失败都保留旧目标。
    const outputDirectory = dirname(outputPath)
    await mkdir(outputDirectory, { recursive: true })
    const candidatePath = join(tempProject, 'workwise-design-export.pptx')
    try {
      if (sidecarAvailable) {
        await runPptMasterSidecar({
          operation: 'ppt-master-export-pptx',
          workspaceRoot: tempProject,
          projectPath: tempProject,
          outputPath: candidatePath,
          source: 'output',
          format
        }, { timeoutMs: EXPORT_TIMEOUT_MS })
      } else {
        await runSvgToPptx(
          scriptPath!,
          tempProject,
          svgOutputDir,
          candidatePath,
          resolvePythonCommand()
        )
      }
      await validateAndCommitPowerPoint(candidatePath, outputPath, svgStrings.length)
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined)
    }

    return { ok: true, path: outputPath }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `design_export_failed: ${message}` }
  } finally {
    // 清理临时目录
    await rm(tempProject, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 执行 svg_to_pptx.py */
function runSvgToPptx(
  scriptPath: string,
  projectPath: string,
  _svgOutputDir: string,
  outputPath: string,
  pythonCmd: string
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const args = [
      scriptPath,
      projectPath,
      '--output', outputPath,
      '--source', 'output',
      '--quiet'
    ]
    const child = execFile(pythonCmd, args, {
      cwd: projectPath,
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: EXPORT_TIMEOUT_MS
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolvePromise()
        return
      }
      const detail = stderr.trim() || error.message
      reject(new Error(detail))
    })
    // 超时自动 kill（execFile 的 timeout 已处理）
    child.on('error', (err) => {
      reject(new Error(`Python execution failed: ${err.message}`))
    })
  })
}
