import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { resolveWorkspacePath, withToolBoundary } from './builtin-tool-utils.js'
import { LocalToolHost } from './local-tool-host.js'
import {
  runRuntimePptMasterSidecar,
  runtimePptMasterSidecarAvailable
} from './ppt-master-sidecar-runner.js'

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const MAX_SVG_FILES = 200
const MAX_SVG_BYTES = 5 * 1024 * 1024
const MAX_PPTX_BYTES = 200 * 1024 * 1024
const MAX_EXPORT_OUTPUT_BYTES = 2 * 1024 * 1024
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000
const CANVAS_FORMATS = ['ppt169', 'ppt43'] as const
const SOURCE_DIRECTORIES = ['output', 'final'] as const

type CanvasFormat = typeof CANVAS_FORMATS[number]
type SourceDirectory = typeof SOURCE_DIRECTORIES[number]

export type PptMasterExportRunnerInput = {
  workspaceRoot: string
  pythonCommand: string
  scriptPath: string
  projectPath: string
  outputPath: string
  source: SourceDirectory
  format: CanvasFormat
  signal: AbortSignal
}

export type PptMasterExportRunner = (input: PptMasterExportRunnerInput) => Promise<void>

export type PptMasterToolProviderOptions = {
  skillRoot?: string
  pythonCommand?: string
  runner?: PptMasterExportRunner
  beforeMutation?: (input: {
    absolutePath: string
    relativePath: string
    workspaceRoot: string
    threadId: string
    turnId: string
  }) => Promise<void> | void
}

export type PptMasterToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  available: boolean
  reason?: string
}

export function buildPptMasterToolProviders(
  options: PptMasterToolProviderOptions = {}
): PptMasterToolProviderBuildResult {
  const skillRoot = options.skillRoot?.trim() || process.env.WORKWISE_PPT_MASTER_ROOT?.trim() || ''
  const scriptPath = skillRoot ? join(skillRoot, 'scripts', 'svg_to_pptx.py') : ''
  const available = Boolean(scriptPath && existsSync(scriptPath))
  const reason = available
    ? undefined
    : 'The bundled PPT Master exporter is unavailable.'
  const provider: CapabilityToolProvider = {
    id: 'ppt-master',
    kind: 'skill',
    enabled: true,
    available,
    ...(reason ? { reason } : {}),
    tools: [createPptMasterExportTool({
      scriptPath,
      pythonCommand: options.pythonCommand ?? defaultPythonCommand(),
      runner: options.runner ?? runPptMasterExport,
      beforeMutation: options.beforeMutation
    })]
  }
  return {
    providers: [provider],
    available,
    ...(reason ? { reason } : {})
  }
}

function createPptMasterExportTool(input: {
  scriptPath: string
  pythonCommand: string
  runner: PptMasterExportRunner
  beforeMutation?: PptMasterToolProviderOptions['beforeMutation']
}) {
  return LocalToolHost.defineTool({
    name: 'ppt_master_export',
    description: 'Export a PPT Master project containing svg_output/ or svg_final/ into a real PowerPoint .pptx file. HTML is not a valid substitute.',
    toolKind: 'file_change',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Workspace-relative PPT Master project directory.'
        },
        output_path: {
          type: 'string',
          description: 'Optional workspace-relative .pptx output path.'
        },
        source: {
          type: 'string',
          enum: [...SOURCE_DIRECTORIES],
          description: 'Use svg_output (output) or svg_final (final).'
        },
        format: {
          type: 'string',
          enum: [...CANVAS_FORMATS],
          description: 'PowerPoint canvas aspect ratio.'
        }
      },
      required: ['project_path'],
      additionalProperties: false
    },
    policy: 'auto',
    shouldAdvertise: (context) => context.activeSkillIds?.includes('ppt-master') === true,
    execute: async (args, context) => withToolBoundary(async () => {
      if (!input.scriptPath) throw new Error('ppt_master_unavailable: bundled exporter path is missing')
      const canonicalScriptPath = await realpath(input.scriptPath)
      const scriptInfo = await lstat(canonicalScriptPath)
      if (!scriptInfo.isFile()) throw new Error('ppt_master_unavailable: bundled exporter is not a regular file')

      const rawProjectPath = requiredString(args.project_path, 'project_path')
      const project = await resolveWorkspacePath(rawProjectPath, context)
      const projectInfo = await stat(project.absolutePath)
      if (!projectInfo.isDirectory()) throw new Error('invalid_project: project_path must be a directory')

      const source = enumValue(args.source, SOURCE_DIRECTORIES, 'output')
      const format = enumValue(args.format, CANVAS_FORMATS, 'ppt169')
      const sourceFolder = source === 'final' ? 'svg_final' : 'svg_output'
      const svgDirectory = await resolveWorkspacePath(join(project.absolutePath, sourceFolder), context)
      await validateSvgDirectory(svgDirectory.absolutePath, context)

      const defaultOutputName = `${safeOutputStem(basename(project.absolutePath))}.pptx`
      const rawOutputPath = optionalString(args.output_path) || join(project.relativePath, defaultOutputName)
      if (extname(rawOutputPath).toLowerCase() !== '.pptx') {
        throw new Error('invalid_output: output_path must end in .pptx')
      }
      const output = await resolveWorkspacePath(rawOutputPath, context)
      await input.beforeMutation?.({
        absolutePath: output.absolutePath,
        relativePath: output.relativePath,
        workspaceRoot: context.workspace,
        threadId: context.threadId,
        turnId: context.turnId
      })
      await mkdir(dirname(output.absolutePath), { recursive: true })
      await resolveWorkspacePath(output.absolutePath, context)

      await input.runner({
        workspaceRoot: context.workspace,
        pythonCommand: input.pythonCommand,
        scriptPath: canonicalScriptPath,
        projectPath: project.absolutePath,
        outputPath: output.absolutePath,
        source,
        format,
        signal: context.abortSignal
      })

      const outputInfo = await stat(output.absolutePath)
      if (!outputInfo.isFile() || outputInfo.size === 0) {
        throw new Error('ppt_master_export_failed: exporter did not create a valid .pptx file')
      }
      if (outputInfo.size > MAX_PPTX_BYTES) {
        throw new Error(`resource_limit: exported PPTX exceeds ${MAX_PPTX_BYTES} bytes`)
      }
      const verifiedOutput = await resolveWorkspacePath(output.absolutePath, context)
      return {
        output: {
          ok: true,
          format: 'pptx',
          generatedFiles: [{
            name: basename(verifiedOutput.absolutePath),
            path: verifiedOutput.relativePath,
            relativePath: verifiedOutput.relativePath,
            absolutePath: verifiedOutput.absolutePath,
            mimeType: PPTX_MIME_TYPE,
            byteSize: outputInfo.size
          }]
        }
      }
    })
  })
}

async function validateSvgDirectory(path: string, context: ToolHostContext): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  const svgEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith('.svg'))
  if (svgEntries.length === 0) throw new Error('invalid_project: no SVG slides were found')
  if (svgEntries.length > MAX_SVG_FILES) {
    throw new Error(`resource_limit: PPT project exceeds ${MAX_SVG_FILES} SVG slides`)
  }
  for (const entry of svgEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`unsafe_path: SVG slide is not a regular file: ${entry.name}`)
    }
    const svgPath = resolve(path, entry.name)
    const info = await lstat(svgPath)
    if (info.size > MAX_SVG_BYTES) {
      throw new Error(`resource_limit: SVG slide exceeds ${MAX_SVG_BYTES} bytes: ${entry.name}`)
    }
    const svg = await readFile(svgPath, 'utf8')
    await validateSvgReferences(svg, path, context)
  }
}

async function validateSvgReferences(
  svg: string,
  svgDirectory: string,
  context: ToolHostContext
): Promise<void> {
  const referencePattern = /(?:href|xlink:href)\s*=\s*["']([^"']+)["']/gi
  for (const match of svg.matchAll(referencePattern)) {
    const reference = match[1]?.trim() ?? ''
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) continue
    if (/^(?:https?:|file:|\\\\|[a-zA-Z]:)/i.test(reference)) {
      throw new Error('unsafe_path: SVG contains an external resource reference')
    }
    await resolveWorkspacePath(resolve(svgDirectory, reference), context)
  }
}

async function runPptMasterExport(input: PptMasterExportRunnerInput): Promise<void> {
  if (runtimePptMasterSidecarAvailable()) {
    try {
      await runRuntimePptMasterSidecar({
        operation: 'ppt-master-export-pptx',
        workspaceRoot: input.workspaceRoot,
        projectPath: input.projectPath,
        outputPath: input.outputPath,
        source: input.source,
        format: input.format
      }, {
        timeoutMs: EXPORT_TIMEOUT_MS,
        signal: input.signal
      })
      return
    } catch (sidecarError) {
      if (input.signal.aborted) throw new Error('operation_cancelled: PPT export was cancelled')
      // Development builds may not have a frozen sidecar yet. Keep the
      // audited Python and portable fallbacks for contributors, but packaged
      // clients always receive WORKWISE_PPT_MASTER_SIDECAR.
      if (process.env.WORKWISE_PPT_MASTER_SIDECAR?.trim()) throw sidecarError
    }
  }
  try {
    await runPythonPptMasterExport(input)
    return
  } catch (pythonError) {
    if (input.signal.aborted) throw new Error('operation_cancelled: PPT export was cancelled')
    try {
      await runPortablePptxExport(input)
      return
    } catch (portableError) {
      throw new Error([
        `ppt_master_export_failed: ${errorMessage(portableError)}`,
        `Python exporter also failed: ${errorMessage(pythonError)}`
      ].join(' '))
    }
  }
}

async function runPythonPptMasterExport(input: PptMasterExportRunnerInput): Promise<void> {
  const args = [
    input.scriptPath,
    input.projectPath,
    '--output', input.outputPath,
    '--source', input.source,
    '--format', input.format,
    '--quiet'
  ]
  await new Promise<void>((resolvePromise, reject) => {
    const child = execFile(input.pythonCommand, args, {
      cwd: input.projectPath,
      encoding: 'utf8',
      maxBuffer: MAX_EXPORT_OUTPUT_BYTES,
      timeout: EXPORT_TIMEOUT_MS
    }, (error, _stdout, stderr) => {
      input.signal.removeEventListener('abort', abort)
      if (!error) {
        resolvePromise()
        return
      }
      const detail = stderr.trim() || error.message
      reject(new Error(`ppt_master_export_failed: ${detail}`))
    })
    const abort = (): void => {
      child.kill()
    }
    if (input.signal.aborted) abort()
    else input.signal.addEventListener('abort', abort, { once: true })
  })
}

async function runPortablePptxExport(input: PptMasterExportRunnerInput): Promise<void> {
  if (input.signal.aborted) throw new Error('operation_cancelled: PPT export was cancelled')
  const sourceFolder = input.source === 'final' ? 'svg_final' : 'svg_output'
  const svgRoot = join(input.projectPath, sourceFolder)
  const svgFiles = (await readdir(svgRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.svg'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  if (svgFiles.length === 0) throw new Error('no SVG slides were found for portable export')

  const pptx = new PptxGenJS()
  pptx.layout = input.format === 'ppt43' ? 'LAYOUT_4X3' : 'LAYOUT_WIDE'
  pptx.author = 'RailWise AI PPT Master'
  pptx.company = 'RailWise AI'
  pptx.subject = 'RailWise AI presentation export'
  pptx.title = basename(input.outputPath, '.pptx')
  const width = input.format === 'ppt43' ? 10 : 13.333
  const height = 7.5
  for (const fileName of svgFiles) {
    if (input.signal.aborted) throw new Error('operation_cancelled: PPT export was cancelled')
    const svg = await readFile(join(svgRoot, fileName), 'utf8')
    const slide = pptx.addSlide()
    slide.addImage({
      data: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      x: 0,
      y: 0,
      w: width,
      h: height
    })
  }
  await pptx.writeFile({ fileName: input.outputPath, compression: true })
}

function requiredString(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`invalid_input: ${name} is required`)
  return normalized
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  fallback: T[number]
): T[number] {
  return typeof value === 'string' && values.includes(value as T[number])
    ? value as T[number]
    : fallback
}

function safeOutputStem(value: string): string {
  const normalized = value.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '')
  return normalized || 'presentation'
}

function defaultPythonCommand(): string {
  return process.env.WORKWISE_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
