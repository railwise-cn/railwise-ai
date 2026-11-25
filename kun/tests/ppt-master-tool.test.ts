import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { createPptMasterEnvLocalTool, createPptMasterLocalTool } from '../src/adapters/tool/builtin-ppt-tool.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

const SLIDE_SVG = (index: number): string => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" width="1280" height="720">
  <rect x="0" y="0" width="1280" height="720" fill="#FFFFFF"/>
  <text x="80" y="120" font-size="48" fill="#111827">Slide ${index}</text>
</svg>`

function buildContext(workspace: string): ToolHostContext {
  return {
    threadId: 'thr_ppt',
    turnId: 'turn_ppt',
    workspace,
    approvalPolicy: 'on-request',
    abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

describe('ppt_master built-in tool', () => {
  let workspace: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'kun-ppt-tool-'))
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('writes spec_lock.md and converts svg_output slides through the sidecar', async () => {
    const projectDir = join(workspace, 'deck')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(join(svgDir, 'slide_01.svg'), SLIDE_SVG(1), 'utf8')
    await writeFile(join(svgDir, 'slide_02.svg'), SLIDE_SVG(2), 'utf8')
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note 1', 'utf8')
    await writeFile(join(projectDir, 'notes', 'slide_02.md'), '# note 2', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(join(projectDir, 'spec_lock.md'), '# spec lock', 'utf8')
    const outputPath = join(workspace, 'deck.pptx')

    const tool = createPptMasterLocalTool({
      operations: {
        spawnSidecar: async ({ request, workspaceRoot }) => {
          expect(request.operation).toBe('ppt-master-export-pptx')
          expect(workspaceRoot).toBe(projectDir)
          await writeFile(outputPath, 'PK\x03\x04fake-pptx', 'utf8')
          return { ok: true, outputPath }
        }
      }
    })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )

    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).not.toBe(true)
    expect(result.item.output).toMatchObject({
      outputPath,
      slideCount: 2,
      notesCount: 0,
      bytes: expect.any(Number)
    })
    const specLock = await readFile(join(projectDir, 'spec_lock.md'), 'utf8')
    expect(specLock).toContain('# spec lock')
  })

  it('reports the number of embedded speaker note slides', async () => {
    const projectDir = join(workspace, 'deck-notes')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(join(svgDir, 'slide_01.svg'), SLIDE_SVG(1), 'utf8')
    await writeFile(join(svgDir, 'slide_02.svg'), SLIDE_SVG(2), 'utf8')
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note 1', 'utf8')
    await writeFile(join(projectDir, 'notes', 'slide_02.md'), '# note 2', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(join(projectDir, 'spec_lock.md'), '# spec lock', 'utf8')
    await mkdir(join(projectDir, 'confirm_ui'), { recursive: true })
    await writeFile(
      join(projectDir, 'confirm_ui', 'result.json'),
      JSON.stringify({ proactive_speaker_notes: true }),
      'utf8'
    )
    const outputPath = join(workspace, 'deck-notes.pptx')

    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="x"/>')
    zip.file('ppt/slides/slide2.xml', '<p:sld xmlns:p="x"/>')
    zip.file('ppt/notesSlides/notesSlide1.xml', '<p:notes xmlns:p="x"/>')
    zip.file('ppt/notesSlides/notesSlide2.xml', '<p:notes xmlns:p="x"/>')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })

    const tool = createPptMasterLocalTool({
      operations: {
        spawnSidecar: async ({ request }) => {
          expect(request.operation).toBe('ppt-master-export-pptx')
          await writeFile(outputPath, bytes)
          return { ok: true, outputPath }
        }
      }
    })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_notes', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.output).toMatchObject({
      slideCount: 2,
      notesCount: 2
    })
  })

  it('rejects export when the production gates are incomplete (missing notes)', async () => {
    const projectDir = join(workspace, 'deck-no-notes')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(join(svgDir, 'slide_01.svg'), SLIDE_SVG(1), 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(join(projectDir, 'spec_lock.md'), '# spec lock', 'utf8')
    const outputPath = join(workspace, 'deck-no-notes.pptx')
    const tool = createPptMasterLocalTool({
      operations: {
        spawnSidecar: async ({ request }) => {
          expect(request.operation).toBe('ppt-master-export-pptx')
          await writeFile(outputPath, 'PK\x03\x04fake-pptx')
          return { ok: true, outputPath }
        }
      }
    })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_no_notes', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).toBe(true)
    expect(result.item.output).toMatchObject({
      code: 'tool_execution_failed',
      error: expect.stringContaining('missing speaker notes')
    })
  })

  it('refuses to overwrite an existing output file so each delivery is fresh', async () => {
    const projectDir = join(workspace, 'deck-overwrite')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(join(svgDir, 'slide_01.svg'), SLIDE_SVG(1), 'utf8')
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(join(projectDir, 'spec_lock.md'), '# spec lock', 'utf8')
    const outputPath = join(workspace, 'existing.pptx')
    await writeFile(outputPath, 'old content')

    const tool = createPptMasterLocalTool()
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_overwrite', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).toBe(true)
    expect(result.item.output).toMatchObject({
      code: 'tool_execution_failed',
      error: expect.stringContaining('output_file_exists')
    })
  })

  it('reports the managed PPT Master Python environment for full-access runs', async () => {
    const pythonPath = join(workspace, 'managed', 'bin', 'python')
    const tool = createPptMasterEnvLocalTool({ pythonPath })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_env', toolName: 'ppt_master_env', arguments: {} },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.output).toMatchObject({
      pythonPath,
      venvRoot: join(workspace, 'managed'),
      exists: false,
      installCommand: expect.stringContaining('python3 -m venv')
    })
  })

  it.skipIf(process.platform === 'win32')('runs only the fixed bundled attribution guard without asking for shell access', async () => {
    const skillRoot = join(workspace, 'skill')
    const guardPath = join(skillRoot, 'scripts', 'attribution_guard.py')
    const pythonPath = join(workspace, 'managed-python')
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(guardPath, '# fixed attribution guard marker\n', 'utf8')
    await writeFile(pythonPath, `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const script = process.argv[2]
if (process.argv.length !== 3 || path.resolve(script) !== path.resolve(process.cwd(), 'scripts/attribution_guard.py')) process.exit(2)
if (!fs.readFileSync(script, 'utf8').includes('fixed attribution guard marker')) process.exit(3)
`, 'utf8')
    await chmod(pythonPath, 0o755)

    const tool = createPptMasterEnvLocalTool({ pythonPath, skillRoot })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_integrity', toolName: 'ppt_master_env', arguments: { action: 'verify_integrity' } },
      buildContext(workspace)
    )

    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).not.toBe(true)
    expect(result.item.output).toEqual({ verified: true, skillId: 'ppt-master' })
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, properties: { action: { enum: ['inspect', 'verify_integrity'] } } })
  })

  it('rejects an attribution guard that resolves outside the bundled skill directory', async () => {
    const skillRoot = join(workspace, 'skill')
    const guardPath = join(skillRoot, 'scripts', 'attribution_guard.py')
    const outsideDirectory = join(workspace, 'outside-scripts')
    await mkdir(skillRoot, { recursive: true })
    await mkdir(outsideDirectory, { recursive: true })
    await writeFile(join(outsideDirectory, 'attribution_guard.py'), '# outside guard\n', 'utf8')
    await symlink(outsideDirectory, join(skillRoot, 'scripts'), 'dir')

    const tool = createPptMasterEnvLocalTool({ pythonPath: join(workspace, 'unused-python'), skillRoot })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_integrity_escape', toolName: 'ppt_master_env', arguments: { action: 'verify_integrity' } },
      buildContext(workspace)
    )

    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).toBe(true)
    expect(result.item.output).toMatchObject({ verified: false, reason: 'integrity_guard_outside_skill' })
  })

  it('rejects output paths that escape the workspace', async () => {
    const projectDir = join(workspace, 'deck')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(join(svgDir, 'slide_01.svg'), SLIDE_SVG(1), 'utf8')
    const tool = createPptMasterLocalTool()
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      {
        callId: 'call_ppt_escape',
        toolName: 'ppt_master',
        arguments: { projectDir, outputPath: join(tmpdir(), 'outside.pptx') }
      },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).toBe(true)
  })

  it('does not treat a small decorative bar as the page background for contrast', async () => {
    const projectDir = join(workspace, 'deck-contrast-false-positive')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(
      join(svgDir, 'slide_01.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <rect x="0" y="0" width="960" height="540" fill="#FFFFFF"/>
  <rect x="0" y="0" width="40" height="4" fill="#1B3A5C"/>
  <text x="40" y="62" font-size="28" fill="#1D2430">执行摘要</text>
</svg>`,
      'utf8'
    )
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(
      join(projectDir, 'spec_lock.md'),
      '# spec lock\n\n## color\n\n| Key | Value |\n|---|---|\n| background | #FFFFFF |\n',
      'utf8'
    )
    const outputPath = join(workspace, 'deck-contrast-false-positive.pptx')
    const tool = createPptMasterLocalTool({
      operations: {
        spawnSidecar: async ({ request }) => {
          expect(request.operation).toBe('ppt-master-export-pptx')
          await writeFile(outputPath, 'PK\x03\x04fake-pptx')
          return { ok: true, outputPath }
        }
      }
    })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_contrast_fp', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).not.toBe(true)
  })

  it('blocks text that genuinely sits on a low-contrast card', async () => {
    const projectDir = join(workspace, 'deck-contrast-real')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(
      join(svgDir, 'slide_01.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <rect x="0" y="0" width="960" height="540" fill="#FFFFFF"/>
  <rect x="40" y="40" width="400" height="200" fill="#1B3A5C"/>
  <text x="60" y="100" font-size="20" fill="#1D2430">暗卡片上的深色文字</text>
</svg>`,
      'utf8'
    )
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(
      join(projectDir, 'spec_lock.md'),
      '# spec lock\n\n## color\n\n| Key | Value |\n|---|---|\n| background | #FFFFFF |\n',
      'utf8'
    )
    const outputPath = join(workspace, 'deck-contrast-real.pptx')
    const tool = createPptMasterLocalTool()
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_contrast_real', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).toBe(true)
    expect(result.item.output).toMatchObject({
      error: expect.stringContaining('low_contrast_text')
    })
  })

  it('accepts a full-page gradient background with high-contrast text', async () => {
    const projectDir = join(workspace, 'deck-gradient')
    const svgDir = join(projectDir, 'svg_output')
    await mkdir(svgDir, { recursive: true })
    await writeFile(
      join(svgDir, 'slide_01.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540">
  <defs>
    <linearGradient id="bgGrad01" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0F1F38"/>
      <stop offset="100%" stop-color="#1B3A5C"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="960" height="540" fill="url(#bgGrad01)"/>
  <text x="480" y="100" font-size="48" fill="#FFFFFF">封面标题</text>
</svg>`,
      'utf8'
    )
    await mkdir(join(projectDir, 'notes'), { recursive: true })
    await writeFile(join(projectDir, 'notes', 'slide_01.md'), '# note', 'utf8')
    await writeFile(join(projectDir, 'design_spec.md'), '# design spec', 'utf8')
    await writeFile(join(projectDir, 'spec_lock.md'), '# spec lock', 'utf8')
    const outputPath = join(workspace, 'deck-gradient.pptx')
    const tool = createPptMasterLocalTool({
      operations: {
        spawnSidecar: async ({ request }) => {
          expect(request.operation).toBe('ppt-master-export-pptx')
          await writeFile(outputPath, 'PK\x03\x04fake-pptx')
          return { ok: true, outputPath }
        }
      }
    })
    const host = new LocalToolHost({ tools: [tool] })
    const result = await host.execute(
      { callId: 'call_ppt_gradient', toolName: 'ppt_master', arguments: { projectDir, outputPath } },
      buildContext(workspace)
    )
    expect(result.item.kind).toBe('tool_result')
    if (result.item.kind !== 'tool_result') throw new Error('expected tool_result')
    expect(result.item.isError).not.toBe(true)
  })
})
