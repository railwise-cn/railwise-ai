import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Resvg } from '/Users/wangjiawei/Documents/WorkWise/node_modules/@resvg/resvg-js/index.js'
import { DeepseekCompatModelClient } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/adapters/model/deepseek-compat-model-client.js'

const settings = JSON.parse(await readFile('/Users/wangjiawei/Library/Application Support/WorkWise/workwise-settings.json', 'utf8'))
const apiKey = settings.provider?.apiKey?.trim()
const base = new URL(settings.provider?.baseUrl)
if (!apiKey || base.origin !== 'https://api.deepseek.com' || base.username || base.password) throw new Error('Official provider not configured')
const requests = []
const client = new DeepseekCompatModelClient({ model: 'deepseek-flash', baseUrl: base.origin, apiKey,
  fetchImpl: async (url, options) => {
    if (new URL(url).origin !== base.origin) throw new Error('Unexpected origin')
    const response = await fetch(url, { ...options, redirect: 'error' })
    requests.push({ path: new URL(url).pathname, status: response.status })
    return response
  }
})
async function run(label, prompt, extras, evaluate) {
  const started = Date.now()
  const timestamp = new Date().toISOString()
  let text = '', stopReason, failureCode
  const calls = []
  try {
    for await (const chunk of client.stream({
      threadId: 'v41-synthetic-capabilities', turnId: label, model: 'deepseek-flash', prefix: [],
      history: [{ id: label, threadId: 'v41-synthetic-capabilities', turnId: label, role: 'user', status: 'completed',
        createdAt: timestamp, kind: 'user_message', text: prompt }],
      tools: [], maxTokens: 256, reasoningEffort: 'off', abortSignal: AbortSignal.timeout(45000), ...extras
    })) {
      if (chunk.kind === 'assistant_text_delta') text += chunk.text
      if (chunk.kind === 'completed') stopReason = chunk.stopReason
      if (chunk.kind === 'tool_call_complete') calls.push({ name: chunk.toolName, arguments: chunk.arguments })
      if (chunk.kind === 'error') failureCode = /^[a-z0-9_]+$/i.test(chunk.code ?? '') ? chunk.code : 'adapter-error'
    }
    return { label, timestamp, elapsedMs: Date.now() - started, stopReason, failureCode,
      matched: !failureCode && evaluate({ text, calls, stopReason }), text, calls }
  } catch {
    return { label, timestamp, elapsedMs: Date.now() - started, matched: false, error: 'transport-or-adapter-error' }
  }
}
const report = { model: 'deepseek-flash', scope: 'live compiled adapter, synthetic inputs, no tool executed and no packaged UI acceptance',
  credentialCopied: false, settingsChanged: false, requests, results: [] }
report.results.push(await run('json', 'Return exactly one JSON object: {"probe":"railwise","value":7}',
  { responseFormat: 'json_object' }, ({ text, stopReason }) => {
    try { const v = JSON.parse(text); return stopReason === 'stop' && v.probe === 'railwise' && v.value === 7 } catch { return false }
  }))
report.results.push(await run('function', 'Call only the record_echo tool with token "RAILWISE_TOOL_OK". It is a synthetic echo contract and does not modify anything.',
  { requiredToolName: 'record_echo', tools: [{ name: 'record_echo', description: 'Return a synthetic echo token without side effects.',
    inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } }] },
  ({ calls, stopReason }) => stopReason === 'tool_calls' && calls.length === 1 && calls[0].name === 'record_echo' && calls[0].arguments.token === 'RAILWISE_TOOL_OK'))
const image = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="white"/><circle cx="60" cy="90" r="30" fill="blue"/><circle cx="150" cy="90" r="30" fill="blue"/><rect x="220" y="60" width="60" height="60" fill="red"/></svg>').render().asPng()
report.imageSha256 = createHash('sha256').update(image).digest('hex')
report.results.push(await run('vision', 'Count the colored shapes in the attached image. Return JSON only with integer fields blue_circles and red_squares.',
  { responseFormat: 'json_object', attachments: [{ id: 'synthetic-shapes', name: 'synthetic-shapes.png', mimeType: 'image/png',
    width: 300, height: 180, dataBase64: image.toString('base64') }] }, ({ text, stopReason }) => {
    try { const v = JSON.parse(text); return stopReason === 'stop' && v.blue_circles === 2 && v.red_squares === 1 } catch { return false }
  }))
console.log(JSON.stringify(report, null, 2))
if (!report.results.every(r => r.matched)) process.exitCode = 1
