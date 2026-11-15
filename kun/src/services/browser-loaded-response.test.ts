import { describe, expect, it } from 'vitest'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint } from './task-run-repository.js'
import { publicArticleId, primaryResponseRepresentation, readBrowserLoadedDocument, startBrowserResponseCapture, stopBrowserResponseCapture, validLoadedResponseEvidence,
  type BrowserResponseCapture, type BrowserDocumentCommand } from './browser-loaded-response.js'

const PARENT = 'https://source.example.test/detail?articleId=article-one'
const PROJECT = '轨道控制网测量公开测试项目'
const TITLE = `关于${PROJECT}的公开公告`
const HTML = `<section><h1>${PROJECT}</h1><p>预算金额（元）：400000；此处为完整的公开原文正文。</p></section>`
const JSON_BODY = JSON.stringify({ anyWrapper: { articleId: 'article-one', title: TITLE, projectName: PROJECT, content: HTML } })
const configuration = 'f'.repeat(64)
function fixture() {
  const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', turnId: 'turn', threadId: 'thread', workspaceRoot: '/tmp',
    workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', workspaceRevision: 0, agentRevision: 0,
    revision: 1, idempotencyKey: 'grant', issuedAt: new Date().toISOString(), allowedToolNames: ['browser_read_document'], allowedProviderIds: ['browser-skill'],
    connectorIdentityFingerprints: { 'browser-skill': configuration }, networkAllowlist: ['https://source.example.test'],
    browserScope: { browserInstanceId: 'browser', origins: ['https://source.example.test'], interaction: 'observe', verificationPolicy: 'public_query_target', revision: 1 } })
  const capture: BrowserResponseCapture = { taskId: 'task', turnId: 'turn', sessionId: 'session', tabId: 1, parentSourceUrl: PARENT,
    runId: 'native-run', name: 'owned-capture', grantFingerprint: operationFingerprint(grant), configurationFingerprint: configuration }
  const now = Date.now() - 100
  const run = { id: capture.runId, name: capture.name, session_id: capture.sessionId, tab_id: capture.tabId, state: 'capturing', requests: 2,
    dropped_requests: 0, active_rules: 0, coverage: ['from_start', 'task_tab'] }
  const parent = { id: 'native-run:n1', run_id: run.id, url: PARENT, method: 'GET', status: 200, state: 'complete', frame_id: 'frame', loader_id: 'loader', resource_type: 'Document', started_at: now }
  const response = { id: 'native-run:n2', run_id: run.id, url: 'https://source.example.test/observed-document?articleId=article-one&timestamp=1', method: 'GET', status: 200,
    state: 'complete', frame_id: 'frame', loader_id: 'loader', resource_type: 'XHR', mime_type: 'application/json', started_at: now + 1, finished_at: now + 2,
    integrity: { url: 'complete', metadata: 'complete' }, request_body: { state: 'empty' }, response_body: { state: 'available', redacted: false, replay_safe: false, chars: JSON_BODY.length } }
  const native = { tab_id: 1, page_url: PARENT, frame_url: PARENT, frame_id: 'frame', title: TITLE, captured_at: new Date().toISOString(), scope: 'current_dom',
    truncated: false, items: [{ ref: '@e1', values: { present: true }, redacted: [] }] }
  let body = JSON_BODY, nativeReads = 0
  const calls: string[][] = []
  let mutation: ((value: Record<string, unknown>, action: string) => void) | undefined
  const command: BrowserDocumentCommand = async args => {
    calls.push(args)
    let value: Record<string, unknown>
    if (args[0] === 'read') { nativeReads++; value = structuredClone(native) }
    else if (args[1] === 'start') value = { session_id: capture.sessionId, run: { ...run } }
    else if (args[1] === 'stop') value = { session_id: capture.sessionId, run: { ...run, state: 'stopped' } }
    else if (args[1] === 'requests') value = { session_id: capture.sessionId, run: { ...run }, requests: [parent, { ...response, response_body: { ...response.response_body, chars: body.length } }], truncated: false }
    else if (args[1] === 'request') {
      expect(args).not.toContain('headers')
      const offset = Number(args[args.indexOf('--offset') + 1]), text = body.slice(offset, offset + 16384), end = offset + text.length
      value = { session_id: capture.sessionId, run: { ...run }, request: { ...response, response_body: { ...response.response_body, chars: body.length, offset, text, ...(end < body.length ? { next_offset: end } : {}) } } }
    } else throw new Error(`Unexpected command ${args[0]}/${args[1]}`)
    mutation?.(value, args[0] === 'read' ? `native-${nativeReads}` : String(args[1]))
    return value
  }
  const read = () => readBrowserLoadedDocument({ capture, command, guard: async () => {}, currentTab: async () => ({ id: 1, url: PARENT }),
    allowResponseUrl: url => { expect(new URL(url).origin).toBe('https://source.example.test') } })
  return { grant, capture, response, parent, native, calls, command, read, change: (fn: typeof mutation) => { mutation = fn }, setBody: (text: string) => { body = text } }
}

describe('fixed native loaded-response representation', () => {
  it('accepts the proved short project-name representation without hard-coding a wrapper or endpoint', () => {
    expect(primaryResponseRepresentation(JSON_BODY, 'article-one', TITLE)).toMatchObject({ html: HTML, association: 'projectName', pointer: '/anyWrapper/content' })
  })
  it.each(['title-only', 'body-only', 'similar-value', 'short-project', 'duplicate', 'script-only'] as const)('rejects %s as a primary representation', mode => {
    const doc = JSON.parse(JSON_BODY) as { anyWrapper: { articleId: string; title: string; projectName: string; content: string } }
    if (mode === 'title-only') doc.anyWrapper.content = '<p>这里只包含不相符的正文，不能借标题证明。</p>'
    if (mode === 'body-only') doc.anyWrapper.title = '不包含项目名称的其他页面标题'
    if (mode === 'similar-value') doc.anyWrapper.projectName += '变更'
    if (mode === 'short-project') { doc.anyWrapper.projectName = '项目'; doc.anyWrapper.content = '<p>项目正文。</p>' }
    if (mode === 'script-only') doc.anyWrapper.content = `<script>const text=${JSON.stringify(PROJECT)}</script><p>无匹配正文</p>`
    const value = mode === 'duplicate' ? { one: doc.anyWrapper, two: doc.anyWrapper } : doc
    expect(primaryResponseRepresentation(JSON.stringify(value), 'article-one', mode === 'body-only' ? doc.anyWrapper.title : TITLE)).toBeUndefined()
  })
  it('keeps URL, loader, native title, source bytes and chunks bound without treating replay_safe as read authorization', async () => {
    const f = fixture(), output = await f.read()
    expect(output).toMatchObject({ sourceKind: 'actual_loaded_response', html: HTML, responseText: JSON_BODY, readScope: 'response_document', truncated: false })
    expect(validLoadedResponseEvidence(output, f.grant)).toBe(true)
    expect(f.calls.some(args => ['evaluate', 'navigate', 'replay'].includes(args[0]!) || args.includes('headers'))).toBe(false)
    for (const mutate of [(v: Record<string, unknown>) => { v.html += 'changed' }, (v: Record<string, unknown>) => { (v.nativeProof as Record<string, unknown>).responseSha256 = '0'.repeat(64) }]) {
      const changed = structuredClone(output); mutate(changed); expect(validLoadedResponseEvidence(changed, f.grant)).toBe(false)
    }
    expect(validLoadedResponseEvidence(output, { ...f.grant, revision: 2 })).toBe(false)
  })
  it.each(['frame', 'loader', 'origin', 'article', 'redacted', 'truncated', 'gap', 'title-after', 'reload', 'scope'] as const)('refuses %s drift without returning partial primary content', async mode => {
    const f = fixture(); let metadataReads = 0
    f.change((value, action) => {
      if (action === 'requests') {
        metadataReads++
        const rows = value.requests as Array<Record<string, unknown>>, row = rows[1]!
        if (mode === 'frame') row.frame_id = 'foreign-frame'
        if (mode === 'loader') row.loader_id = 'old-loader'
        if (mode === 'origin') row.url = 'https://foreign.example.test/observed-document?articleId=article-one'
        if (mode === 'article') row.url = 'https://source.example.test/observed-document?articleId=other'
        if (mode === 'redacted') (row.response_body as Record<string, unknown>).redacted = true
        if (mode === 'truncated') (row.response_body as Record<string, unknown>).state = 'truncated'
        if (mode === 'scope') value.truncated = true
        if (mode === 'reload' && metadataReads === 2) rows[0] = { ...rows[0], id: 'different-parent-document', loader_id: 'new-loader' }
      }
      if (mode === 'gap' && action === 'request') ((value.request as Record<string, unknown>).response_body as Record<string, unknown>).offset = 1
      if (mode === 'title-after' && action === 'native-2') value.title = '已变化的页面标题'
    })
    await expect(f.read()).rejects.toHaveProperty('code')
  })
  it('stops only a positively identified owned capture and rejects foreign ownership', async () => {
    const f = fixture(), { runId: _runId, ...input } = f.capture
    expect(await startBrowserResponseCapture(f.command, input)).toMatchObject(f.capture)
    await stopBrowserResponseCapture(f.command, f.capture)
    expect(f.calls.filter(args => args[1] === 'stop')[0]).toContain(f.capture.runId)
    f.change(value => { if (value.run) (value.run as Record<string, unknown>).name = 'someone-else' })
    await expect(startBrowserResponseCapture(f.command, input)).rejects.toHaveProperty('code', 'browser_document_capture_not_owned')
  })
  it('reassembles a complete multi-chunk native response without clipping Unicode or accepting an incomplete body', async () => {
    const f = fixture(), content = HTML.replace('</section>', `<p>${'测量正文😀'.repeat(4500)}</p></section>`)
    f.setBody(JSON.stringify({ document: { articleId: 'article-one', title: TITLE, projectName: PROJECT, content } }))
    const output = await f.read()
    expect(output.html).toBe(content)
    expect((output.nativeProof as { chunks: unknown[] }).chunks.length).toBeGreaterThan(1)
    expect(validLoadedResponseEvidence(output, f.grant)).toBe(true)
  })
  it('does not retain a parent URL carrying credential query keys or dispatch a capture for it', async () => {
    const f = fixture(), { runId: _runId, ...input } = f.capture
    input.parentSourceUrl += '&access_token=synthetic-private'
    expect(publicArticleId(input.parentSourceUrl)).toBeUndefined()
    await expect(startBrowserResponseCapture(f.command, input)).rejects.toHaveProperty('code', 'browser_document_representation_unsupported')
    expect(f.calls).toHaveLength(0)
  })
  it('rejects a source after a fenced guard changes during the native body read', async () => {
    const f = fixture(); let stale = false
    f.change((_value, action) => { if (action === 'request') stale = true })
    await expect(readBrowserLoadedDocument({ capture: f.capture, command: f.command,
      guard: async () => { if (stale) throw new Error('Synthetic execution lease expired during I/O') },
      currentTab: async () => ({ id: 1, url: PARENT }), allowResponseUrl: () => {} })).rejects.toThrow('Synthetic execution lease expired')
  })
})
