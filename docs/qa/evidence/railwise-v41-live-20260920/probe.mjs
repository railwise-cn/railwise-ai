import { readFile } from 'node:fs/promises'
import { DeepseekCompatModelClient } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/adapters/model/deepseek-compat-model-client.js'
import { DeepSeekResponsesWebProvider } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/adapters/tool/deepseek-responses-web-provider.js'

const settings = JSON.parse(await readFile('/Users/wangjiawei/Library/Application Support/WorkWise/workwise-settings.json', 'utf8'))
const apiKey = settings.provider?.apiKey?.trim()
const origin = new URL(settings.provider?.baseUrl)
if (!apiKey || origin.origin !== 'https://api.deepseek.com' || origin.username || origin.password) {
  throw new Error('Existing official provider is not configured; no request sent')
}
const model = 'deepseek-flash'
const requests = []
const searchShapes = []
const fetchImpl = async (url, options) => {
  const parsed = new URL(url)
  if (parsed.origin !== origin.origin) throw new Error('Unexpected provider origin')
  const started = Date.now()
  const response = await fetch(url, { ...options, redirect: 'error' })
  requests.push({ path: parsed.pathname, status: response.status, elapsedMs: Date.now() - started })
  if (parsed.pathname.endsWith('/responses')) {
    const body = await response.clone().json().catch(() => null)
    searchShapes.push({ type: body?.type, status: body?.status,
      errorCode: typeof body?.error?.code === 'string' && /^[a-z0-9_-]+$/i.test(body.error.code) ? body.error.code : undefined,
      output: Array.isArray(body?.output) ? body.output.map(item => ({ type: item.type, status: item.status,
        actionType: item.action?.type,
        content: Array.isArray(item.content) ? item.content.map(part => ({ type: part.type,
          annotations: Array.isArray(part.annotations) ? part.annotations.map(a => ({ type: a.type, url: a.url })) : [] })) : [] })) : [] })
  }
  return response
}
const report = {
  timestamp: new Date().toISOString(), model, origin: origin.origin,
  credentialSource: 'existing production provider, read in memory only',
  settingsChanged: false, candidateCredentialCopied: false,
  scope: 'compiled production adapters; not packaged GUI acceptance',
  requests, searchShapes, chat: {}, search: { status: 'not-attempted' }
}
const started = Date.now()
const client = new DeepseekCompatModelClient({ baseUrl: origin.origin, apiKey, model, fetchImpl })
let answer = ''
let stopReason
let failureCode
try {
  for await (const chunk of client.stream({
    threadId: 'live-v41-synthetic', turnId: 'live-v41-probe', model,
    prefix: [], history: [{ id: 'input', threadId: 'live-v41-synthetic', turnId: 'live-v41-probe',
      kind: 'user_message', role: 'user', status: 'completed', createdAt: report.timestamp,
      text: 'Reply with exactly: RAILWISE_V41_OK. Do not call tools.' }],
    tools: [], maxTokens: 64, reasoningEffort: 'off', abortSignal: AbortSignal.timeout(45000)
  })) {
    if (chunk.kind === 'assistant_text_delta') answer += chunk.text
    if (chunk.kind === 'completed') stopReason = chunk.stopReason
    if (chunk.kind === 'error') failureCode = /^[a-z_0-9]+$/.test(chunk.code ?? '') ? chunk.code : 'adapter-error'
  }
  report.chat = { status: !failureCode && stopReason === 'stop' && answer.trim() ? 'completed' : 'failed',
    expectedResponseMatched: answer.trim() === 'RAILWISE_V41_OK', answerCharacters: answer.length,
    stopReason, failureCode, elapsedMs: Date.now() - started }
} catch {
  report.chat = { status: 'transport-or-adapter-error', elapsedMs: Date.now() - started }
}
if (report.chat.status === 'completed') {
  const startedSearch = Date.now()
  try {
    const provider = new DeepSeekResponsesWebProvider({ baseUrl: origin.origin, apiKey, model, fetchImpl })
    const results = await provider.search({ query: 'Find the official DeepSeek API documentation page for deepseek-flash.',
      limit: 3, timeoutMs: 45000, signal: AbortSignal.timeout(45000) })
    report.search = { status: 'completed-with-citations', elapsedMs: Date.now() - startedSearch,
      sources: results.map(result => ({ url: result.url, provider: result.provider })) }
  } catch (error) {
    const reason = error.message?.startsWith('DeepSeek Responses web search') ? error.message : 'transport-or-adapter-error'
    report.search = { status: 'failed', reason, elapsedMs: Date.now() - startedSearch }
  }
}
console.log(JSON.stringify(report, null, 2))
if (report.chat.status !== 'completed') process.exitCode = 1
