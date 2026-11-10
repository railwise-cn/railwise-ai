import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { ModelClient } from '../ports/model-client.js'
import type { FlowNodeAdapter } from './executor.js'
import { assertFlowNodeExecutable, FlowExecutionPolicyError } from './execution-policy.js'
import { externalProviderAmbiguity, externalTaskIntent } from '../services/external-task-capability.js'

const MAX_MODEL_TEXT = 256_000
const MAX_HTTP_BYTES = 1024 * 1024

export type RuntimeFlowAdapterDependencies = {
  model: ModelClient
  defaultModel: string
  attachments?: AttachmentStore
  runSubagent?: (input: { parentThreadId: string; parentTurnId: string; label: string; prompt: string; workspace?: string; model?: string; signal: AbortSignal; maxDurationMs: number }) => Promise<unknown>
  fetch?: typeof globalThis.fetch
}

export function buildRuntimeFlowAdapters(deps: RuntimeFlowAdapterDependencies): Map<string, FlowNodeAdapter> {
  const adapters = new Map<string, FlowNodeAdapter>()
  adapters.set('agent', modelAdapter(deps, 'Respond to the Flow input and configured prompt.'))
  adapters.set('classification', modelAdapter(deps, 'Classify the input. Return one JSON object with a category field.', true))
  adapters.set('parameter_extraction', modelAdapter(deps, 'Extract the requested parameters. Return one JSON object only.', true))
  adapters.set('subagent', async ({ run, node, input, signal, definition }) => {
    assertFlowNodeExecutable('subagent')
    if (!deps.runSubagent) throw new Error('subagent capability is unavailable')
    return { kind: 'output', output: await deps.runSubagent({ parentThreadId: run.id, parentTurnId: node.id, label: node.label, prompt: promptFor(node.config, input), workspace: definition.workspace, model: stringValue(node.config.model), signal, maxDurationMs: node.policy.timeoutMs }) }
  })
  adapters.set('knowledge_retrieval', async ({ node, input, definition }) => {
    if (!deps.attachments) throw new Error('attachment retrieval capability is unavailable')
    const record = objectValue(input); const attachmentId = stringValue(node.config.attachmentId) ?? stringValue(record.attachmentId) ?? stringValue(record.document); const query = stringValue(node.config.query) ?? stringValue(record.query)
    if (!attachmentId || !query) throw new Error('knowledge retrieval requires attachmentId and query')
    const results = await deps.attachments.searchSections(attachmentId, query, { workspace: definition.workspace }, integer(node.config.limit, 8))
    return { kind: 'output', output: { untrusted: true, attachmentId, query, results } }
  })
  adapters.set('http', httpAdapter(deps.fetch ?? globalThis.fetch))
  for (const format of ['docx', 'xlsx', 'pdf', 'pptx'] as const) adapters.set(`${format}_output`, outputAdapter(format))
  return adapters
}

function modelAdapter(deps: RuntimeFlowAdapterDependencies, instruction: string, json = false): FlowNodeAdapter {
  return async ({ run, node, input, signal }) => {
    // A generic text-generation node has no task authority, typed connector or
    // receipt ledger. It cannot turn an external action into a successful answer.
    if (!json && [stringValue(node.config.prompt) ?? '', ...flowRequestTexts(input)].some(text => externalTaskIntent(text) || externalProviderAmbiguity(text))) {
      throw new FlowExecutionPolicyError('A generic Agent node cannot execute or verify DingTalk or Feishu/Lark work. The model was not called.')
    }
    const text = await collectModelText(deps.model, { threadId: run.id, turnId: `${run.id}_${node.id}`, model: stringValue(node.config.model) ?? deps.defaultModel, prompt: `${instruction}\n\n${promptFor(node.config, input)}`, signal, json })
    if (!json) return { kind: 'output', output: { role: 'assistant', text, model: stringValue(node.config.model) ?? deps.defaultModel } }
    try { return { kind: 'output', output: JSON.parse(extractJson(text)) } } catch { throw new Error(`model did not return valid JSON: ${text.slice(0, 500)}`) }
  }
}

/** Preserve user text boundaries so a how-to question stays a knowledge request. */
function flowRequestTexts(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value.slice(0, MAX_MODEL_TEXT)]
  if (!value || typeof value !== 'object' || depth >= 6) return []
  if (Array.isArray(value)) return value.slice(0, 64).flatMap(item => flowRequestTexts(item, depth + 1))
  const entries = Object.entries(value).slice(0, 64)
  const requestKeys = new Set(['displayText', 'prompt', 'request', 'text', 'message', 'instruction', 'goal'])
  const requests = entries.filter(([key, item]) => requestKeys.has(key) && typeof item === 'string').map(([, item]) => String(item).slice(0, MAX_MODEL_TEXT))
  const descriptors = entries.filter(([key, item]) => !requestKeys.has(key) && (typeof item === 'string' || typeof item === 'number')).map(([, item]) => String(item)).join('\n').slice(0, MAX_MODEL_TEXT)
  return [...requests, ...(descriptors ? [descriptors] : []), ...entries.filter(([, item]) => item && typeof item === 'object').flatMap(([, item]) => flowRequestTexts(item, depth + 1))]
}

async function collectModelText(model: ModelClient, input: { threadId: string; turnId: string; model: string; prompt: string; signal: AbortSignal; json: boolean }): Promise<string> {
  let text = ''
  const createdAt = new Date().toISOString()
  for await (const chunk of model.stream({ threadId: input.threadId, turnId: input.turnId, model: input.model, prefix: [], history: [{ id: `flow_input_${input.turnId}`, turnId: input.turnId, threadId: input.threadId, role: 'user', status: 'completed', kind: 'user_message', text: input.prompt, createdAt, finishedAt: createdAt }], tools: [], responseFormat: input.json ? 'json_object' : undefined, temperature: input.json ? 0 : undefined, abortSignal: input.signal })) {
    if (chunk.kind === 'assistant_text_delta') { text += chunk.text; if (text.length > MAX_MODEL_TEXT) throw new Error('Flow model output exceeds limit') }
    if (chunk.kind === 'error') throw new Error(chunk.message)
  }
  return text.trim()
}

function httpAdapter(fetchImpl: typeof globalThis.fetch): FlowNodeAdapter {
  return async ({ node, input, signal }) => {
    const record = objectValue(input); const rawUrl = stringValue(node.config.url) ?? stringValue(record.url); if (!rawUrl) throw new Error('HTTP node requires url')
    const url = new URL(rawUrl); const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    const method = (stringValue(node.config.method) ?? 'GET').toUpperCase()
    if (!['GET', 'HEAD'].includes(method)) throw new FlowExecutionPolicyError(`Generic HTTP supports GET/HEAD reads only; ${method} was not sent.`)
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
    if (['dingtalk.com', 'dingtalk.cn', 'feishu.cn', 'larksuite.com', 'larkoffice.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) {
      throw new FlowExecutionPolicyError('DingTalk and Feishu/Lark operations, including reads, require their own typed Provider; the request was not sent.')
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && node.config.allowLoopback === true)) throw new Error('HTTP node requires HTTPS; loopback HTTP must be explicitly enabled')
    if (url.username || url.password) throw new Error('HTTP URL credentials are forbidden')
    const headers = stringRecord(node.config.headers)
    if (Object.keys(headers).some(name => ['x-http-method', 'x-http-method-override', 'x-method-override'].includes(name.toLowerCase()))) throw new FlowExecutionPolicyError('HTTP method override headers are not allowed; the request was not sent.')
    // Do not follow redirects into platform APIs or another method/authority.
    const response = await fetchImpl(url, { method, headers, redirect: 'error', signal }); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > MAX_HTTP_BYTES) throw new Error('HTTP response exceeds 1 MiB')
    const contentType = response.headers.get('content-type') ?? ''; const responseBody = contentType.includes('json') ? JSON.parse(bytes.toString('utf8') || 'null') : bytes.toString('utf8')
    return { kind: 'output', output: { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers.entries()), body: responseBody } }
  }
}

function outputAdapter(format: 'docx' | 'xlsx' | 'pdf' | 'pptx'): FlowNodeAdapter {
  return async ({ node, input, definition }) => {
    if (!definition.workspace) throw new Error(`${format.toUpperCase()} output requires a Flow workspace`)
    const outputPath = await containedOutput(definition.workspace, stringValue(node.config.outputPath) ?? `flow-output/${node.id}.${format}`, format)
    const text = outputText(input); await mkdir(dirname(outputPath), { recursive: true })
    if (format === 'docx') await writeFile(outputPath, await docxBytes(text))
    else if (format === 'xlsx') await writeFile(outputPath, await xlsxBytes(input))
    else if (format === 'pdf') await writeFile(outputPath, pdfBytes(text))
    else await pptxFile(outputPath, text)
    return { kind: 'output', output: { kind: 'file', format, path: outputPath, relativePath: relative(resolve(definition.workspace), outputPath) } }
  }
}

async function containedOutput(workspace: string, configured: string, format: string): Promise<string> { const root = resolve(workspace); const target = resolve(root, configured); const rel = relative(root, target); if (!rel || rel.startsWith('..') || resolve(target) === root) throw new Error('Flow output path escapes or replaces the workspace root'); if (!target.toLowerCase().endsWith(`.${format}`)) throw new Error(`Flow output path must end in .${format}`); return target }
async function docxBytes(text: string): Promise<Buffer> { const zip = new JSZip(); zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'); zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'); zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split(/\n/).map((line) => `<w:p><w:r><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`); return zip.generateAsync({ type: 'nodebuffer' }) }
async function xlsxBytes(input: unknown): Promise<Buffer> { const rows = Array.isArray(input) ? input : [input]; const values = rows.map((row) => Array.isArray(row) ? row : Object.values(objectValue(row))); const zip = new JSZip(); zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'); zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'); zip.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Flow Output" sheetId="1" r:id="rId1"/></sheets></workbook>'); zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'); zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${values.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${xml(String(value ?? ''))}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`); return zip.generateAsync({ type: 'nodebuffer' }) }
function pdfBytes(text: string): Buffer { const lines = text.split(/\n/).slice(0, 50).map((line) => line.replace(/[()\\]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?')); const stream = `BT /F1 11 Tf 50 790 Td ${lines.map((line, index) => `${index ? '0 -15 Td ' : ''}(${line}) Tj`).join(' ')} ET`; const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]; let output = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` }); const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(output) }
async function pptxFile(path: string, text: string): Promise<void> { const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; const slide = pptx.addSlide(); slide.addText(text.slice(0, 5000), { x: 0.6, y: 0.6, w: 12, h: 6, fontSize: 18, breakLine: false }); await pptx.writeFile({ fileName: path, compression: true }) }
function promptFor(config: Record<string, unknown>, input: unknown): string { return `${stringValue(config.prompt) ?? ''}\n${JSON.stringify(input)}`.trim().slice(0, 256_000) }
function outputText(value: unknown): string { if (typeof value === 'string') return value; const record = objectValue(value); if (typeof record.text === 'string') return record.text; return JSON.stringify(value, null, 2) }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function integer(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) ? value : fallback }
function stringRecord(value: unknown): Record<string, string> { return Object.fromEntries(Object.entries(objectValue(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) }
function extractJson(value: string): string { const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i); return fenced?.[1]?.trim() ?? value.trim() }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
function column(index: number): string { let value = index + 1; let result = ''; while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26) } return result }
