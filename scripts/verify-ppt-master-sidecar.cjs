const { spawnSync } = require('node:child_process')
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} = require('node:fs')
const { tmpdir, arch, platform } = require('node:os')
const { join, resolve } = require('node:path')
const JSZip = require('jszip')

const root = resolve(__dirname, '..')
const targetArch = process.env.WORKWISE_SIDECAR_ARCH || arch()
const targetPlatform = process.env.WORKWISE_SIDECAR_PLATFORM || platform()
const artifact = `markitdown-${targetPlatform}-${targetArch}`
const executableName = targetPlatform === 'win32'
  ? 'workwise-markitdown.exe'
  : 'workwise-markitdown'
const executable = process.env.WORKWISE_PPT_MASTER_SIDECAR
  ? resolve(process.env.WORKWISE_PPT_MASTER_SIDECAR)
  : join(
      root,
      'build',
      'sidecars',
      artifact,
      'workwise-markitdown',
      executableName
    )

if (!existsSync(executable)) {
  throw new Error(`PPT Master sidecar executable is missing: ${executable}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'workwise-ppt-master-sidecar-'))

function invoke(request) {
  const result = spawnSync(executable, [], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 90_000,
    windowsHide: true
  })
  if (result.error) throw result.error
  let response
  try {
    response = JSON.parse(result.stdout || '{}')
  } catch {
    throw new Error(`PPT Master sidecar returned invalid JSON: ${result.stdout || result.stderr}`)
  }
  if (result.status !== 0 || response.ok !== true) {
    throw new Error(
      `PPT Master sidecar failed (${result.status}): ${response.message || result.stderr || result.stdout}`
    )
  }
  return response
}

function countSvgFiles(directory) {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) count += countSvgFiles(path)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) count += 1
  }
  return count
}

async function main() {
  try {
    const svgDirectory = join(workspace, 'svg_output')
    mkdirSync(svgDirectory, { recursive: true })
    writeFileSync(
      join(svgDirectory, 'slide_01.svg'),
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">',
        '<rect width="1280" height="720" fill="#FFFFFF"/>',
        '<rect x="96" y="96" width="1088" height="528" rx="32" fill="#E8F0FA" stroke="#1E3A5F" stroke-width="4"/>',
        '<text x="640" y="360" text-anchor="middle" font-family="Arial" font-size="48" fill="#111827">WorkWise PPT Master</text>',
        '</svg>'
      ].join(''),
      'utf8'
    )
    writeFileSync(
      join(workspace, 'spec_lock.md'),
      [
        '<!-- ppt-master-schema: spec-lock/v1 -->',
        '# Execution Lock',
        '',
        '## canvas',
        '- viewBox: 0 0 1280 720',
        '- format: ppt169',
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
      ].join('\n'),
      'utf8'
    )

    const pptxPath = join(workspace, 'roundtrip.pptx')
    invoke({
      operation: 'ppt-master-quality-check',
      workspaceRoot: workspace,
      projectPath: workspace,
      stage: 'final'
    })
    invoke({
      operation: 'ppt-master-export-pptx',
      workspaceRoot: workspace,
      projectPath: workspace,
      outputPath: pptxPath,
      source: 'output',
      format: 'ppt169'
    })
    if (!existsSync(pptxPath) || statSync(pptxPath).size === 0) {
      throw new Error('PPT Master sidecar did not create a nonempty PPTX')
    }
    const zip = await JSZip.loadAsync(readFileSync(pptxPath), { checkCRC32: true })
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    if (slides.length !== 1 || !zip.file('ppt/presentation.xml')) {
      throw new Error(`PPT Master sidecar created an invalid slide package: ${slides.length}`)
    }

    const importDirectory = join(workspace, 'imported')
    invoke({
      operation: 'ppt-master-import-pptx',
      workspaceRoot: workspace,
      inputPath: pptxPath,
      outputDirectory: importDirectory
    })
    const importedSvgCount = countSvgFiles(importDirectory)
    if (importedSvgCount < 1) {
      throw new Error('PPT Master sidecar did not import the PPTX back to SVG')
    }
    console.log(
      `PPT Master sidecar roundtrip passed (${artifact}, ${statSync(pptxPath).size} bytes, ${importedSvgCount} SVG, ${executable}).`
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
