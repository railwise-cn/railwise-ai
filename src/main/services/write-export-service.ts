import { app, BrowserWindow, clipboard, dialog } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createWriteMarkdownIt } from '../../shared/write-advanced-markdown'
import type {
  WriteExportFormat,
  WriteExportPayload,
  WriteExportResult,
  WriteRichClipboardPayload,
  WriteRichClipboardResult
} from '../../shared/write-export'
import { resolveWriteMarkdownResource } from '../../shared/write-markdown-resource'
import type { ExportStyleTemplate } from '../../shared/write-export-templates'
import { resolveWorkspaceFile } from './workspace-service'
import { buildDocxFromMarkdown } from './write-docx-service'
import { parseMarkdownFrontmatter } from './write-document-service'
import { readWriteImageResource } from './write-image-resource'
import { resolveExportTemplate } from './write-docx-styles'
import { loadWriteMathExportCss, renderWriteMermaidDiagrams } from './write-advanced-renderer'
import {
  legacyConverterRoot,
  legacyMarkdownConverterPath,
  legacyPandocPath
} from '../compat/legacy-environment'
import { safeSpawn } from './safe-spawn'
import { atomicWriteFile as durableWriteFile } from './durable-file'

const EXPORT_CSS = `
  :root {
    color-scheme: light;
  }

  * {
    box-sizing: border-box;
  }

  html {
    background: #ffffff;
  }

  body {
    margin: 0;
    background: #ffffff;
    color: #111827;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.72;
  }

  a {
    color: #0f62fe;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  .document-shell {
    padding: 22mm 18mm;
  }

  .markdown-body {
    max-width: 100%;
  }

  .markdown-body > :first-child {
    margin-top: 0;
  }

  .markdown-body > :last-child {
    margin-bottom: 0;
  }

  .markdown-body p,
  .markdown-body ul,
  .markdown-body ol,
  .markdown-body blockquote,
  .markdown-body pre,
  .markdown-body table {
    margin: 0 0 1em;
  }

  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body h4,
  .markdown-body h5,
  .markdown-body h6 {
    margin: 1.45em 0 0.65em;
    line-height: 1.24;
    color: #0f172a;
    font-weight: 700;
  }

  .markdown-body h1 {
    font-size: 2em;
    border-bottom: 1px solid #e5e7eb;
    padding-bottom: 0.3em;
  }

  .markdown-body h2 {
    font-size: 1.55em;
    border-bottom: 1px solid #edf2f7;
    padding-bottom: 0.24em;
  }

  .markdown-body h3 {
    font-size: 1.25em;
  }

  .markdown-body ul,
  .markdown-body ol {
    padding-left: 1.5em;
  }

  .markdown-body li + li {
    margin-top: 0.3em;
  }

  .markdown-body .contains-task-list {
    list-style: none;
    padding-left: 0;
  }

  .markdown-body .task-list-item {
    list-style: none;
  }

  .markdown-body input[type="checkbox"] {
    margin: 0 0.45em 0 0;
    transform: translateY(0.1em);
  }

  .markdown-body blockquote {
    padding: 0.3em 0 0.3em 1em;
    border-left: 4px solid #dbe4ff;
    color: #475569;
    background: #f8fbff;
  }

  .markdown-body code {
    font-family: "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace;
    font-size: 0.92em;
  }

  .markdown-body p code,
  .markdown-body li code,
  .markdown-body td code {
    padding: 0.12em 0.38em;
    border-radius: 0.42em;
    background: #f1f5f9;
    color: #0f172a;
  }

  .markdown-body pre {
    overflow-x: auto;
    padding: 0.95em 1.05em;
    border-radius: 0.9em;
    background: #0f172a;
    color: #e2e8f0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .markdown-body pre code {
    background: transparent;
    color: inherit;
    padding: 0;
  }

  .markdown-body hr {
    height: 1px;
    border: 0;
    background: #e5e7eb;
    margin: 1.6em 0;
  }

  .markdown-body table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.95em;
  }

  .markdown-body th,
  .markdown-body td {
    border: 1px solid #dbe3ee;
    padding: 0.5em 0.7em;
    vertical-align: top;
    text-align: left;
  }

  .markdown-body th {
    background: #f8fafc;
    font-weight: 700;
  }

  .markdown-body img {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 1rem auto;
  }

  .write-math-block { overflow-x: auto; margin: 1em 0; }
  .write-math-error, .katex-error { color: #9b1c1c; white-space: pre-wrap; }
  .write-mermaid { margin: 1em 0; break-inside: avoid; }
  .write-mermaid svg { display: block; max-width: 100%; height: auto; margin: auto; }
  .write-mermaid-error { color: #9b1c1c; font-size: .9em; }
  .footnotes { margin-top: 2em; font-size: .9em; }
  .footnote-ref { font-size: .8em; }

  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body img,
  .markdown-body table,
  .markdown-body pre {
    break-inside: avoid;
  }

  .plain-text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", monospace;
  }

  @page {
    size: A4;
    margin: 0;
  }

  @media print {
    body {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  }
`

const LOCAL_IMAGE_PATTERN = /(<img\b[^>]*?\bsrc=")([^"]+)(")/gi

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath)
}

function basenameWithoutExtension(filePath: string): string {
  const name = basename(filePath)
  const extension = extname(name)
  return extension ? name.slice(0, -extension.length) : name
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function exportExtension(format: WriteExportFormat): string {
  if (format === 'html') return '.html'
  if (format === 'pdf') return '.pdf'
  if (format === 'doc') return '.doc'
  return '.docx'
}

function exportDialogFilter(format: WriteExportFormat): Electron.FileFilter {
  if (format === 'html') return { name: 'HTML', extensions: ['html'] }
  if (format === 'pdf') return { name: 'PDF', extensions: ['pdf'] }
  if (format === 'doc') return { name: 'DOC', extensions: ['doc'] }
  return { name: 'DOCX', extensions: ['docx'] }
}

function platformConverterDirName(): string {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  return `${process.platform}-${process.arch}`
}

function converterSearchRoots(): string[] {
  const envRoot = process.env.WORKWISE_CONVERTER_ROOT?.trim() || legacyConverterRoot()
  return [
    envRoot,
    join(process.resourcesPath || '', 'converters'),
    join(app.getAppPath(), 'converters'),
    join(process.cwd(), 'converters')
  ].filter((value): value is string => Boolean(value))
}

function firstExistingPath(candidates: string[]): string {
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? ''
}

function configuredPandocPath(): string {
  const direct = process.env.WORKWISE_PANDOC_PATH?.trim() || legacyPandocPath() || process.env.PANDOC_PATH?.trim()
  if (direct) return direct

  const executable = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'
  const platformDir = platformConverterDirName()
  return firstExistingPath(
    converterSearchRoots().flatMap((root) => [
      join(root, platformDir, executable),
      join(root, executable)
    ])
  )
}

export function resolveBundledMarkdownConverter(): { pandocPath: string; md2docxPath: string } {
  const md2docxDirect = process.env.WORKWISE_MD2DOCX_PATH?.trim() || legacyMarkdownConverterPath()
  const executable = process.platform === 'win32' ? 'md2docx.exe' : 'md2docx.bin'
  const platformDir = platformConverterDirName()
  const md2docxPath = md2docxDirect || firstExistingPath(
    converterSearchRoots().flatMap((root) => [
      join(root, platformDir, executable),
      join(root, executable)
    ])
  )
  return {
    pandocPath: configuredPandocPath(),
    md2docxPath
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<void> {
  return safeSpawn(command, args, {
      cwd: options.cwd,
      workspaceRoot: options.cwd,
      stdio: ['ignore', 'ignore', 'pipe']
    }).then((child: ChildProcess) => new Promise((resolve, reject) => {
    let stderr = ''
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM')
          reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`))
        }, options.timeoutMs)
      : null

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr.trim()}` : ''}`))
    })
    }))
}

function ensureExportExtension(targetPath: string, format: WriteExportFormat): string {
  const extension = exportExtension(format)
  return extname(targetPath).trim() ? targetPath : `${targetPath}${extension}`
}

function defaultExportPath(sourcePath: string, format: WriteExportFormat): string {
  return join(dirname(sourcePath), `${basenameWithoutExtension(sourcePath)}${exportExtension(format)}`)
}

export async function inlineLocalImagesInHtml(html: string, sourcePath?: string, workspaceRoot?: string): Promise<string> {
  // React 19 emits eager image preload links during static rendering. The image src is
  // validated below; generated preload URLs must not bypass that same resource policy.
  html = html.replace(/<link\b[^>]*\brel="preload"[^>]*\bas="image"[^>]*\/?\s*>/gi, '')
  const matches = [...html.matchAll(LOCAL_IMAGE_PATTERN)]
  if (matches.length === 0) return html

  const replacements = new Map<string, string>()
  await Promise.all(
    matches.map(async (match) => {
      const rawSrc = match[2]
      if (!rawSrc || replacements.has(rawSrc)) return
      const image = sourcePath ? await readWriteImageResource({ src: rawSrc.replaceAll('&amp;', '&'), sourcePath, workspaceRoot }) : null
      replacements.set(rawSrc, image ? `data:${image.mimeType};base64,${image.data.toString('base64')}` : '')
    })
  )

  return html.replace(LOCAL_IMAGE_PATTERN, (fullMatch, prefix, rawSrc, suffix) => {
    return `${prefix}${replacements.get(rawSrc) ?? ''}${suffix}`
  })
}

function renderPlainTextFragment(content: string): string {
  return renderToStaticMarkup(
    createElement(
      'pre',
      {
        className: 'plain-text'
      },
      content
    )
  )
}

async function renderMarkdownFragment(content: string, sourcePath: string): Promise<string> {
  const markdown = createWriteMarkdownIt({ html: false, linkify: false })
  const link = markdown.renderer.rules.link_open ?? ((tokens, index, options, _env, renderer) => renderer.renderToken(tokens, index, options))
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const href = tokens[index].attrGet('href')
    if (href && !href.startsWith('#')) tokens[index].attrSet('href', resolveWriteMarkdownResource(href, sourcePath) ?? href)
    return link(tokens, index, options, env, renderer)
  }
  const image = markdown.renderer.rules.image!
  markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const src = tokens[index].attrGet('src') ?? ''
    tokens[index].attrSet('src', /^https?:\/\//i.test(src) || /^data:/i.test(src) ? '' : resolveWriteMarkdownResource(src, sourcePath) ?? '')
    return image(tokens, index, options, env, renderer)
  }
  let fragment = markdown.render(content)
  const placeholders = [...fragment.matchAll(/<div class="write-mermaid" data-write-mermaid="([^"]*)"><pre>[\s\S]*?<\/pre><\/div>/g)]
  if (placeholders.length) {
    const sources = placeholders.map((match) => decodeURIComponent(match[1]))
    const diagrams = await renderWriteMermaidDiagrams(sources)
    placeholders.forEach((match, index) => {
      const diagram = diagrams.get(sources[index])
      const replacement = diagram
        ? `<figure class="write-mermaid">${diagram.svg}</figure>`
        : `<figure class="write-mermaid"><p class="write-mermaid-error">Mermaid 图表未能绘制，保留原始代码。</p><pre><code class="language-mermaid">${escapeHtml(sources[index])}</code></pre></figure>`
      fragment = fragment.replace(match[0], replacement)
    })
  }
  return fragment
}

export async function buildWriteClipboardHtmlFragment(options: {
  sourcePath: string
  content: string
  workspaceRoot?: string
}): Promise<string> {
  const frontmatter = parseMarkdownFrontmatter(options.content)
  const fragment = isMarkdownFile(options.sourcePath)
    ? await renderMarkdownFragment(frontmatter.endOffset ? frontmatter.body : options.content, options.sourcePath)
    : renderPlainTextFragment(options.content)
  const body = await inlineLocalImagesInHtml(fragment, options.sourcePath, options.workspaceRoot)
  const mathStyles = body.includes('class="katex"') ? `<style>${await loadWriteMathExportCss()}</style>` : ''
  return `<article class="markdown-body">${mathStyles}${body}</article>`
}

export function buildWriteExportFileName(sourcePath: string, format: WriteExportFormat): string {
  return `${basenameWithoutExtension(sourcePath)}${exportExtension(format)}`
}

export async function buildWriteExportHtmlDocument(options: {
  sourcePath: string
  content: string
  title?: string
  wordCompatible?: boolean
  workspaceRoot?: string
}): Promise<string> {
  const title = options.title?.trim() || basenameWithoutExtension(options.sourcePath)
  const body = await buildWriteClipboardHtmlFragment({
    sourcePath: options.sourcePath,
    workspaceRoot: options.workspaceRoot,
    content: options.content
  })
  const namespaces = options.wordCompatible
    ? ' xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"'
    : ''

  return [
    '<!DOCTYPE html>',
    `<html lang="zh-CN"${namespaces}>`,
    '<head>',
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; font-src data:; style-src \'unsafe-inline\'; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'" />',
    `  <title>${escapeHtml(title)}</title>`,
    `  <style>${EXPORT_CSS}</style>`,
    '</head>',
    '<body>',
    '  <main class="document-shell">',
    `    ${body}`,
    '  </main>',
    '</body>',
    '</html>'
  ].join('\n')
}

export async function copyWriteDocumentAsRichText(
  payload: WriteRichClipboardPayload
): Promise<WriteRichClipboardResult> {
  try {
    const resolved = await resolveWorkspaceFile({
      path: payload.path,
      workspaceRoot: payload.workspaceRoot
    })
    if (!resolved.ok) {
      return {
        ok: false,
        message: resolved.message
      }
    }

    const html = await buildWriteClipboardHtmlFragment({
      sourcePath: resolved.path,
      workspaceRoot: payload.workspaceRoot,
      content: payload.content
    })

    clipboard.write({
      html,
      text: payload.content
    })

    return {
      ok: true,
      copiedAt: new Date().toISOString()
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

async function exportDocxWithPandoc(options: {
  sourcePath: string
  content: string
  title: string
  targetPath: string
}): Promise<boolean> {
  const pandoc = resolveBundledMarkdownConverter().pandocPath
  if (!pandoc || !isMarkdownFile(options.sourcePath)) return false

  const tempDir = await mkdtemp(join(tmpdir(), 'workwise-pandoc-'))
  const tempMarkdownPath = join(tempDir, basename(options.sourcePath) || 'document.md')
  try {
    await writeFile(tempMarkdownPath, options.content, 'utf8')
    await runCommand(
      pandoc,
      [
        tempMarkdownPath,
        '--from',
        'gfm+yaml_metadata_block+tex_math_dollars+tex_math_single_backslash',
        '--to',
        'docx',
        '--standalone',
        '--resource-path',
        dirname(options.sourcePath),
        '--metadata',
        `title=${options.title}`,
        '--output',
        options.targetPath
      ],
      {
        cwd: dirname(options.sourcePath),
        timeoutMs: 90_000
      }
    )
    return true
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function exportDocxWithMd2docx(options: {
  sourcePath: string
  content: string
  targetPath: string
}): Promise<boolean> {
  const md2docx = resolveBundledMarkdownConverter().md2docxPath
  if (!md2docx || !isMarkdownFile(options.sourcePath)) return false

  const tempDir = await mkdtemp(join(tmpdir(), 'workwise-md2docx-'))
  const tempMarkdownPath = join(tempDir, basename(options.sourcePath) || 'document.md')
  try {
    await writeFile(tempMarkdownPath, options.content, 'utf8')
    await runCommand(
      md2docx,
      [
        tempMarkdownPath,
        options.targetPath
      ],
      {
        cwd: dirname(options.sourcePath),
        timeoutMs: 45_000
      }
    )
    return existsSync(options.targetPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function renderWriteExportHtmlToPdf(html: string): Promise<Buffer> {
  const tempDir = await mkdtemp(join(tmpdir(), 'kun-export-'))
  const tempHtmlPath = join(tempDir, 'document.html')
  await writeFile(tempHtmlPath, html, 'utf8')

  const hiddenWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      partition: `workwise-export-${randomUUID()}`
    }
  })

  const requestFilter = { urls: ['*://*/*', 'http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }
  const denyNetwork = (_details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void): void => callback({ cancel: true })
  hiddenWindow.webContents.session.webRequest.onBeforeRequest(requestFilter, denyNetwork)
  hiddenWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  hiddenWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const denyNavigation = (event: Electron.Event, url: string): void => {
    if (url !== pathToFileURL(tempHtmlPath).href) event.preventDefault()
  }
  hiddenWindow.webContents.on('will-navigate', denyNavigation)
  hiddenWindow.webContents.on('will-redirect', denyNavigation)

  try {
    await hiddenWindow.loadURL(pathToFileURL(tempHtmlPath).href)
    await hiddenWindow.webContents.executeJavaScript(`
      Promise.all([
        document.fonts?.ready ?? Promise.resolve(),
        Promise.all(
          Array.from(document.images).map((image) => {
            if (image.complete) return Promise.resolve()
            return new Promise((resolve) => {
              const done = () => resolve(undefined)
              image.addEventListener('load', done, { once: true })
              image.addEventListener('error', done, { once: true })
            })
          })
        )
      ]).then(() => undefined)
    `)
    await delay(120)
    const pdf = await hiddenWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    return Buffer.from(pdf)
  } finally {
    hiddenWindow.webContents.removeListener('will-navigate', denyNavigation)
    hiddenWindow.webContents.removeListener('will-redirect', denyNavigation)
    if (!hiddenWindow.isDestroyed()) hiddenWindow.destroy()
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function showExportSaveDialog(
  sourcePath: string,
  format: WriteExportFormat,
  parentWindow?: BrowserWindow | null
): Promise<Electron.SaveDialogReturnValue> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export document',
    defaultPath: defaultExportPath(sourcePath, format),
    filters: [exportDialogFilter(format)]
  }
  return parentWindow
    ? dialog.showSaveDialog(parentWindow, options)
    : dialog.showSaveDialog(options)
}

export async function exportWriteDocument(
  payload: WriteExportPayload,
  options?: {
    parentWindow?: BrowserWindow | null
    /** 用户自定义导出模板列表（来自设置），用于 docx 导出解析模板 */
    userExportTemplates?: ExportStyleTemplate[]
    /** 默认导出模板 id（来自设置） */
    defaultExportTemplateId?: string
  }
): Promise<WriteExportResult> {
  try {
    const resolved = await resolveWorkspaceFile({
      path: payload.path,
      workspaceRoot: payload.workspaceRoot
    })
    if (!resolved.ok) {
      return {
        ok: false,
        canceled: false,
        message: resolved.message
      }
    }

    const sourcePath = resolved.path
    const exportDialogResult = await showExportSaveDialog(sourcePath, payload.format, options?.parentWindow)
    if (exportDialogResult.canceled || !exportDialogResult.filePath) {
      return {
        ok: false,
        canceled: true
      }
    }

    const targetPath = ensureExportExtension(exportDialogResult.filePath, payload.format)
    const title = basenameWithoutExtension(sourcePath)
    const html = payload.format === 'docx' ? '' : await buildWriteExportHtmlDocument({
      sourcePath,
      workspaceRoot: payload.workspaceRoot,
      content: payload.content,
      title,
      wordCompatible: payload.format === 'doc'
    })

    if (payload.format === 'html' || payload.format === 'doc') {
      await durableWriteFile(targetPath, html)
    } else if (payload.format === 'docx') {
      if (isMarkdownFile(sourcePath)) {
        // 解析导出模板：合并内置模板 + 用户模板 + 本次 styleOverride
        // defaultExportTemplateId 为空时 resolveExportTemplate 会用内置默认
        const effectiveTemplateId = payload.templateId ?? options?.defaultExportTemplateId
        const template = resolveExportTemplate(
          effectiveTemplateId,
          options?.userExportTemplates,
          payload.styleOverride
        )
        await durableWriteFile(targetPath, await buildDocxFromMarkdown({
          sourcePath,
          workspaceRoot: payload.workspaceRoot,
          content: payload.content,
          title,
          template
        }))
      } else {
        await durableWriteFile(targetPath, await buildDocxFromMarkdown({
          sourcePath,
          workspaceRoot: payload.workspaceRoot,
          content: payload.content,
          title,
          template: resolveExportTemplate(
            payload.templateId ?? options?.defaultExportTemplateId,
            options?.userExportTemplates,
            payload.styleOverride
          )
        }))
      }
    } else {
      await durableWriteFile(targetPath, await renderWriteExportHtmlToPdf(html))
    }

    return {
      ok: true,
      path: targetPath,
      format: payload.format,
      exportedAt: new Date().toISOString()
    }
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
