import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { defineLocalTool } from './local-tool-definition.js'
import type { LocalTool } from './local-tool-host.js'

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024
const executeFile = promisify(execFile)

export type PptMasterSpawnResult = {
  ok: boolean
  outputPath?: string
  message?: string
}

export type PptMasterLocalToolOptions = {
  sidecarPath?: string
  timeoutMs?: number
  operations?: {
    spawnSidecar?: (input: {
      request: Record<string, unknown>
      workspaceRoot: string
      timeoutMs: number
      signal: AbortSignal
    }) => Promise<PptMasterSpawnResult>
  }
}

function resolveSidecarPath(options: PptMasterLocalToolOptions): string {
  const explicit = options.sidecarPath?.trim()
  if (explicit) return explicit
  const fromEnv = process.env.WORKWISE_PPT_MASTER_SIDECAR?.trim()
  if (fromEnv) return fromEnv
  return join(
    process.cwd(),
    'build',
    'sidecars',
    `markitdown-${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'workwise-markitdown.exe' : 'workwise-markitdown'
  )
}

function createSpecLock(width: number, height: number, format: 'ppt169' | 'ppt43'): string {
  return [
    '<!-- ppt-master-schema: spec-lock/v1 -->',
    '# Execution Lock',
    '',
    '## canvas',
    `- viewBox: 0 0 ${width} ${height}`,
    `- format: ${format}`,
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

function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const hex = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  }
}

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const linear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}

function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

type RgbaColor = { r: number; g: number; b: number; a: number }
type SvgRect = { x: number; y: number; width: number; height: number; fill: string; color: string | null; rgba: RgbaColor | null; order: number }
type SvgText = { x: number; y: number; fill: string; color: string | null; rgba: RgbaColor | null; order: number }

function parseSvgAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z:_-]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(tag)) !== null) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function numAttr(attrs: Record<string, string>, name: string, fallback: number): number {
  const parsed = Number.parseFloat(attrs[name])
  return Number.isFinite(parsed) ? parsed : fallback
}

function collectGradientStops(svg: string): Map<string, string> {
  const stops = new Map<string, string>()
  const re = /<(?:linear|radial)Gradient\b([^>]*)>([\s\S]*?)<\/(?:linear|radial)Gradient>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(svg)) !== null) {
    const attrs = parseSvgAttrs(match[1])
    const id = attrs.id
    const first = match[2].match(/stop-color="(#[0-9a-fA-F]{6})"/i)
    if (id && first) stops.set(id, first[1])
  }
  return stops
}

function resolveFillColor(fill: string, gradientStops: Map<string, string>): string | null {
  if (!fill) return null
  if (fill.startsWith('url(#')) {
    const id = fill.slice(5, fill.indexOf(')')).replace('#', '')
    return gradientStops.get(id) ?? null
  }
  return /^#[0-9a-fA-F]{6}$/.test(fill) ? fill : null
}

function parseSvgColor(value: string): RgbaColor | null {
  const trimmed = value.trim()
  let match = trimmed.match(/^#([0-9a-fA-F]{6})$/)
  if (match) {
    return {
      r: parseInt(match[1].slice(0, 2), 16),
      g: parseInt(match[1].slice(2, 4), 16),
      b: parseInt(match[1].slice(4, 6), 16),
      a: 1
    }
  }
  match = trimmed.match(/^#([0-9a-fA-F]{3})$/)
  if (match) {
    const r = parseInt(match[1][0] + match[1][0], 16)
    const g = parseInt(match[1][1] + match[1][1], 16)
    const b = parseInt(match[1][2] + match[1][2], 16)
    return { r, g, b, a: 1 }
  }
  match = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (match) {
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4])
    }
  }
  return null
}

function blendColors(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = Math.min(1, Math.max(0, foreground.a))
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1
  }
}

function luminanceOf(color: RgbaColor): number {
  return relativeLuminance({ r: color.r, g: color.g, b: color.b })
}

async function readSpecLockBackground(projectDir: string): Promise<string | null> {
  try {
    const spec = await readFile(join(projectDir, 'spec_lock.md'), 'utf8')
    const lock = spec.match(/^\|\s*background\s*\|\s*(#[0-9a-fA-F]{6})\s*\|/m)
    if (lock) return lock[1]
    const design = await readFile(join(projectDir, 'design_spec.md'), 'utf8')
    const specDesign = design.match(/`background`\s*\|\s*`?(#[0-9a-fA-F]{6})`?/i)
    if (specDesign) return specDesign[1]
  } catch {
    // missing/unreadable spec files fall back to SVG-derived background
  }
  return null
}

function svgPageBackground(svg: string, specBackground: string | null): string | null {
  const gradientStops = collectGradientStops(svg)
  const viewBox = svg.match(/viewBox="([0-9.\s]+)"/i)
  const viewValues = viewBox ? viewBox[1].trim().split(/[\s,]+/) : []
  const viewW = viewValues.length >= 3 ? Number.parseFloat(viewValues[2]) : Number.NaN
  const viewH = viewValues.length >= 4 ? Number.parseFloat(viewValues[3]) : Number.NaN
  const re = /<rect\b([^>]*)\/?>/gi
  let match: RegExpExecArray | null
  let fallback: string | null = null
  while ((match = re.exec(svg)) !== null) {
    const attrs = parseSvgAttrs(match[1])
    const fill = attrs.fill
    if (!fill) continue
    const x = numAttr(attrs, 'x', 0)
    const y = numAttr(attrs, 'y', 0)
    const width = numAttr(attrs, 'width', 0)
    const height = numAttr(attrs, 'height', 0)
    const resolved = resolveFillColor(fill, gradientStops)
    if (
      Number.isFinite(viewW) &&
      Number.isFinite(viewH) &&
      x === 0 &&
      y === 0 &&
      Math.abs(width - viewW) < 1 &&
      Math.abs(height - viewH) < 1
    ) {
      if (resolved) return resolved
      if (fill.startsWith('#')) return fill
    }
    if (!fallback && fill.startsWith('#')) fallback = fill
  }
  return specBackground ?? fallback
}

function svgContrastWarnings(svg: string, pageBackground: string | null): string[] {
  const bg = pageBackground ? parseHexColor(pageBackground) : null
  if (!bg) return []
  const gradientStops = collectGradientStops(svg)
  const rects: SvgRect[] = []
  const texts: SvgText[] = []
  let order = 0
  const rectRe = /<rect\b([^>]*)\/?>/gi
  let match: RegExpExecArray | null
  while ((match = rectRe.exec(svg)) !== null) {
    const attrs = parseSvgAttrs(match[1])
    const fill = attrs.fill ?? ''
    const opacity = numAttr(attrs, 'opacity', 1)
    const fillOpacity = numAttr(attrs, 'fill-opacity', 1)
    const rgba = parseSvgColor(fill)
    if (rgba) rgba.a *= Math.min(1, Math.max(0, opacity * fillOpacity))
    rects.push({
      x: numAttr(attrs, 'x', 0),
      y: numAttr(attrs, 'y', 0),
      width: numAttr(attrs, 'width', 0),
      height: numAttr(attrs, 'height', 0),
      fill,
      color: resolveFillColor(fill, gradientStops),
      rgba,
      order
    })
    order += 1
  }
  const textRe = /<text\b([^>]*)>/gi
  while ((match = textRe.exec(svg)) !== null) {
    const attrs = parseSvgAttrs(match[1])
    const fill = attrs.fill ?? ''
    const opacity = numAttr(attrs, 'opacity', 1)
    const fillOpacity = numAttr(attrs, 'fill-opacity', 1)
    const rgba = parseSvgColor(fill)
    if (rgba) rgba.a *= Math.min(1, Math.max(0, opacity * fillOpacity))
    texts.push({
      x: numAttr(attrs, 'x', 0),
      y: numAttr(attrs, 'y', 0),
      fill,
      color: resolveFillColor(fill, gradientStops),
      rgba,
      order
    })
    order += 1
  }

  const warnings: string[] = []
  let index = 0
  for (const text of texts) {
    index += 1
    if (!text.rgba) continue
    // Find the most specific background rect painted before this text that
    // contains the text anchor. Rects painted after the text are overlays and
    // must not be treated as the page background.
    let containing: SvgRect | null = null
    for (const rect of rects) {
      if (rect.order >= text.order) break
      if (!rect.rgba) continue
      if (
        text.x >= rect.x &&
        text.x <= rect.x + rect.width &&
        text.y >= rect.y &&
        text.y <= rect.y + rect.height
      ) {
        if (!containing || rect.width * rect.height < containing.width * containing.height) {
          containing = rect
        }
      }
    }
    const pageRgba: RgbaColor = { ...bg, a: 1 }
    const rawBg = containing?.rgba ? containing.rgba : pageRgba
    const effectiveBg = rawBg.a < 1 ? blendColors(rawBg, pageRgba) : rawBg
    const effectiveText = text.rgba.a < 1 ? blendColors(text.rgba, effectiveBg) : text.rgba
    const ratio = contrastRatio(luminanceOf(effectiveText), luminanceOf(effectiveBg))
    const backgroundLabel = containing ? containing.fill : (pageBackground ?? '')
    if (ratio < 2.5) {
      warnings.push(`low_contrast: text #${index} fill ${text.fill} on background ${backgroundLabel} has contrast ${ratio.toFixed(2)}:1 (below 2.5:1)`)
    } else if (ratio < 4.5) {
      warnings.push(`low_contrast_warning: text #${index} fill ${text.fill} on background ${backgroundLabel} has contrast ${ratio.toFixed(2)}:1 (below 4.5:1)`)
    }
  }
  return warnings
}

function assertInsideWorkspace(target: string, workspace: string): void {
  const rel = relative(resolve(workspace), resolve(target))
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${target}`)
  }
}

function spawnSidecar(
  executable: string,
  request: Record<string, unknown>,
  workspaceRoot: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<PptMasterSpawnResult> {
  return new Promise<PptMasterSpawnResult>((resolvePromise, reject) => {
    const child = spawn(executable, [], {
      cwd: workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error('PPT Master export timed out.'))
      }
    }, timeoutMs)
    const onAbort = (): void => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error('PPT Master export was cancelled.'))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes <= MAX_PROTOCOL_BYTES) stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes <= MAX_ERROR_BYTES) stderr.push(chunk)
    })
    child.stdin?.end(JSON.stringify(request))
    child.once('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    })
    child.once('exit', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      let response: PptMasterSpawnResult
      try {
        response = JSON.parse(text) as PptMasterSpawnResult
      } catch {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)
        reject(new Error(`PPT Master runtime exited with ${exitCode ?? 'unknown'}${detail ? `: ${detail}` : ''}`))
        return
      }
      if (exitCode !== 0 || !response.ok) {
        reject(new Error(response.message || 'PPT Master export failed.'))
        return
      }
      resolvePromise(response)
    })
  })
}

async function executePptMasterExport(
  args: Record<string, unknown>,
  context: ToolHostContext,
  options: PptMasterLocalToolOptions
): Promise<{ output: unknown; isError?: boolean }> {
  const projectDir = typeof args.projectDir === 'string' ? args.projectDir.trim() : ''
  const outputPath = typeof args.outputPath === 'string' ? args.outputPath.trim() : ''
  const format = args.format === 'ppt43' ? 'ppt43' : 'ppt169'
  if (!projectDir || !outputPath) {
    throw new Error('projectDir and outputPath are required')
  }
  assertInsideWorkspace(projectDir, context.workspace)
  assertInsideWorkspace(outputPath, context.workspace)
  if (!outputPath.toLowerCase().endsWith('.pptx')) {
    throw new Error('outputPath must end with .pptx')
  }
  if (existsSync(outputPath)) {
    throw new Error(
      'output_file_exists: choose a NEW output file name for each delivery so the user always gets a fresh, verifiable file. Refusing to overwrite the existing .pptx.'
    )
  }

  const svgDir = join(projectDir, 'svg_output')
  await mkdir(svgDir, { recursive: true })
  const slides = (await readdir(svgDir))
    .filter((name) => /^slide_\d+\.svg$/i.test(name))
    .sort()
  if (slides.length === 0) {
    throw new Error('svg_output must contain slide_01.svg, slide_02.svg, ...')
  }

  // Production-flow gates: the deck must be designed and locked before export.
  const designSpecPath = join(projectDir, 'design_spec.md')
  const specLockPath = join(projectDir, 'spec_lock.md')
  if (!existsSync(designSpecPath)) {
    throw new Error('missing design_spec.md: author the design spec from the confirmed result before exporting.')
  }
  if (!existsSync(specLockPath)) {
    throw new Error('missing spec_lock.md: author the execution lock from the design spec before exporting.')
  }

  // Speaker notes gate: notes are required for every slide unless the confirmed
  // result explicitly disables proactive speaker notes.
  const confirmedResultPath = join(projectDir, 'confirm_ui', 'result.json')
  let speakerNotesEnabled = true
  if (existsSync(confirmedResultPath)) {
    try {
      const confirmed = JSON.parse(await readFile(confirmedResultPath, 'utf8')) as Record<string, unknown>
      if (confirmed.proactive_speaker_notes === false) speakerNotesEnabled = false
    } catch {
      // unreadable result.json -> treat as pending confirmation and require notes
    }
  }
  if (speakerNotesEnabled) {
    const missingNotes: string[] = []
    for (const slide of slides) {
      const noteName = slide.replace(/\.svg$/i, '.md')
      if (!existsSync(join(projectDir, 'notes', noteName))) {
        missingNotes.push(`notes/${noteName}`)
      }
    }
    if (missingNotes.length > 0) {
      throw new Error(
        `missing speaker notes for ${missingNotes.length}/${slides.length} slides: ${missingNotes.join(', ')}. Write notes/<slide>.md for every slide before exporting.`
      )
    }
  }

  // Contrast gate: severe low-contrast text blocks export; weaker violations warn.
  const severeContrast: string[] = []
  const contrastWarnings: string[] = []
  const specBackground = await readSpecLockBackground(projectDir)
  for (const slide of slides) {
    const svg = await readFile(join(svgDir, slide), 'utf8')
    const background = svgPageBackground(svg, specBackground)
    for (const warning of svgContrastWarnings(svg, background)) {
      if (warning.startsWith('low_contrast:')) severeContrast.push(`${slide}: ${warning}`)
      else contrastWarnings.push(`${slide}: ${warning}`)
    }
  }
  if (severeContrast.length > 0) {
    throw new Error(
      `low_contrast_text: ${severeContrast.join('; ')}. Increase text contrast before exporting.`
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const spawnOperation = options.operations?.spawnSidecar
  const result = spawnOperation
    ? await spawnOperation({
        request: {
          operation: 'ppt-master-export-pptx',
          workspaceRoot: projectDir,
          projectPath: projectDir,
          outputPath,
          source: 'output',
          format
        },
        workspaceRoot: projectDir,
        timeoutMs,
        signal: context.abortSignal
      })
    : await spawnSidecar(
        resolveSidecarPath(options),
        {
          operation: 'ppt-master-export-pptx',
          workspaceRoot: projectDir,
          projectPath: projectDir,
          outputPath,
          source: 'output',
          format
        },
        projectDir,
        timeoutMs,
        context.abortSignal
      )

  if (!result.ok) {
    throw new Error(result.message || 'PPT Master export failed.')
  }
  const outputStat = await stat(outputPath)
  if (!outputStat.isFile() || outputStat.size === 0) {
    throw new Error('PPT Master export produced no output file.')
  }
  let pptxSlideCount = 0
  let notesCount = 0
  try {
    const zip = await JSZip.loadAsync(await readFile(outputPath))
    pptxSlideCount = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .length
    notesCount = Object.keys(zip.files)
      .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .length
  } catch {
    // A malformed output is still surfaced by the caller as a file; keep the
    // SVG-derived slide count and report notes as unverified.
    notesCount = 0
  }
  if (pptxSlideCount > 0 && pptxSlideCount !== slides.length) {
    throw new Error(`ppt_master output slide count mismatch: expected ${slides.length}, got ${pptxSlideCount}.`)
  }
  if (speakerNotesEnabled && pptxSlideCount > 0 && notesCount !== pptxSlideCount) {
    throw new Error(
      `speaker_notes_missing_in_output: expected ${pptxSlideCount} notes slides, got ${notesCount}. Add notes/<slide>.md files and re-export.`
    )
  }
  return {
    output: {
      outputPath,
      slideCount: pptxSlideCount > 0 ? pptxSlideCount : slides.length,
      notesCount,
      bytes: outputStat.size,
      warnings: contrastWarnings
    }
  }
}

export function createPptMasterLocalTool(
  options: PptMasterLocalToolOptions = {}
): LocalTool {
  return defineLocalTool({
    name: 'ppt_master',
    description:
      'Convert a completed PPT Master project into a NEW editable .pptx using the bundled runtime. Production gates are enforced before export: the project MUST contain design_spec.md (authored from the confirmed result), spec_lock.md, every page in svg_output/slide_XX.svg, and notes/slide_XX.md for every slide unless the confirmed result disables proactive speaker notes. The outputPath must not already exist (each delivery needs a fresh file name). Text contrast below 2.5:1 on the page background blocks export and 2.5-4.5:1 is returned as warnings. The tool returns outputPath, slideCount, notesCount and warnings so you can verify the deliverable. Use this tool instead of shell or Python when generating PPTX files.',
    inputSchema: {
      type: 'object',
      properties: {
        projectDir: {
          type: 'string',
          description: 'Absolute workspace directory containing svg_output/*.svg'
        },
        outputPath: {
          type: 'string',
          description: 'Absolute .pptx output path inside the workspace'
        },
        format: {
          type: 'string',
          enum: ['ppt169', 'ppt43'],
          description: 'Slide aspect ratio; defaults to ppt169'
        }
      },
      required: ['projectDir', 'outputPath']
    },
    policy: 'on-request',
    execute: (args, toolContext) => executePptMasterExport(args, toolContext, options)
  })
}

export const builtinPptToolInternals = {
  resolveSidecarPath,
  createSpecLock,
  assertInsideWorkspace,
  spawnSidecar,
  executePptMasterExport
}

export type PptMasterEnvLocalToolOptions = {
  pythonPath?: string
  skillRoot?: string
}

export function createPptMasterEnvLocalTool(
  options: PptMasterEnvLocalToolOptions = {}
): LocalTool {
  const managedPython =
    options.pythonPath?.trim() ||
    process.env.WORKWISE_PPT_MASTER_PYTHON?.trim() ||
    join(
      homedir(),
      '.workwise',
      'ppt-master-python',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    )
  const skillRoot = options.skillRoot?.trim() || process.env.WORKWISE_PPT_MASTER_ROOT?.trim() || join(process.cwd(), 'src', 'asset', 'skills', 'ppt-master')
  const requirementsPath = join(skillRoot, 'requirements.txt')
  const venvRoot = dirname(dirname(managedPython))
  return defineLocalTool({
    name: 'ppt_master_env',
    description:
      'Inspect the managed PPT Master runtime or verify the bundled Skill attribution and integrity gates. The integrity check runs the fixed bundled script with the managed interpreter and does not access the user workspace. Use action="verify_integrity" before executing PPT Master instructions; do not run the attribution check through a host shell.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'verify_integrity'] }
      },
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args) => {
      const exists = existsSync(managedPython)
      const action = typeof args.action === 'string' ? args.action : 'inspect'
      if (action === 'verify_integrity') {
        try {
          const skillRootPath = await realpath(skillRoot)
          const guardPath = join(skillRootPath, 'scripts', 'attribution_guard.py')
          const guardInfo = await lstat(guardPath)
          if (!guardInfo.isFile()) throw new Error('integrity_guard_unavailable')
          const resolvedGuardPath = await realpath(guardPath)
          const guardRelativePath = relative(skillRootPath, resolvedGuardPath)
          if (!guardRelativePath || guardRelativePath.startsWith('..') || isAbsolute(guardRelativePath)) {
            throw new Error('integrity_guard_outside_skill')
          }
          const integrityPython = exists ? managedPython : process.platform === 'win32' ? 'python' : 'python3'
          await executeFile(integrityPython, [resolvedGuardPath], {
            cwd: skillRootPath,
            shell: false,
            windowsHide: true,
            timeout: 10_000,
            maxBuffer: 16 * 1024
          })
          return { output: { verified: true, skillId: 'ppt-master' } }
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? String(error.code) : ''
          return {
            output: {
              verified: false,
              skillId: 'ppt-master',
              reason: code === 'ENOENT' && !exists ? 'managed_python_unavailable' : code === 'ENOENT' ? 'integrity_guard_unavailable' :
                error instanceof Error && ['managed_python_unavailable', 'integrity_guard_unavailable', 'integrity_guard_outside_skill'].includes(error.message)
                  ? error.message
                  : 'integrity_check_failed'
            },
            isError: true
          }
        }
      }
      const installCommand = exists
        ? null
        : [
            `${process.platform === 'win32' ? 'py -3' : 'python3'} -m venv "${venvRoot}"`,
            `"${managedPython}" -m pip install -r "${requirementsPath}"`
          ].join(' && ')
      return {
        output: {
          pythonPath: managedPython,
          venvRoot,
          requirementsPath,
          exists,
          ...(installCommand ? { installCommand } : {})
        }
      }
    }
  })
}
