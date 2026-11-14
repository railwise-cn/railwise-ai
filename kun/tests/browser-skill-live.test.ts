import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { BrowserCapabilityConfig } from '../src/contracts/browser-skill.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { TaskRunSchema } from '../src/contracts/tasks.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { browserEnvironment, parseBrowserStatus, runBrowserCommand } from '../src/services/browser-skill-cli.js'
import { buildBrowserSkillToolProvider } from '../src/adapters/tool/browser-skill-tool-provider.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { listApprovedBrowserScheduleActions } from '../src/services/browser-schedule-action-authority.js'
import type { BrowserScheduleResolution } from '../src/contracts/browser-schedule-actions.js'
import { ManagedBrowserSkillRuntime } from '../src/services/managed-browser-skill-runtime.js'
const executeFile = promisify(execFile)
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe.runIf(process.env.RAILWISE_BROWSER_CONNECTED_ACCEPTANCE === '1')('actual BrowserSkill extension and typed provider', () => {
  it('reads two fixture pages through the official extension and preserves source evidence', async () => {
    const root = process.env.RAILWISE_BROWSER_CONNECTED_ROOT!
    const executable = process.env.RAILWISE_BROWSER_CLI!
    const extensionZip = process.env.RAILWISE_BROWSER_EXTENSION_ZIP!
    const chromePath = process.env.RAILWISE_BROWSER_TEST_CHROME!
    const scheduleAcceptance = process.env.RAILWISE_BROWSER_SCHEDULE_ACCEPTANCE === '1'
    const interactionAcceptance = scheduleAcceptance || process.env.RAILWISE_BROWSER_INTERACTION_ACCEPTANCE === '1'
    const publicUrl = process.env.RAILWISE_BROWSER_PUBLIC_URL
    if (interactionAcceptance) expect(publicUrl).toBeUndefined()
    const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined
    expect([root, executable, extensionZip, chromePath].every(value => value?.startsWith('/'))).toBe(true)
    expect(await lstat(join(root, 'chrome-profile')).catch(() => undefined), 'Acceptance requires a fresh isolated browser profile').toBeUndefined()
    await mkdir(join(root, 'extension'), { recursive: true })
    const archive = await readFile(extensionZip)
    expect(hash(archive)).toBe('4de785b340e401de855448410be3b7bad5e685a9e5128c0bd4ec4edeba5c9fc9')
    await executeFile('tar', ['-xf', extensionZip, '-C', join(root, 'extension')])
    const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'))
    expect(manifest.version).toBe('0.5.0')
    const versionOutput = String((await executeFile(executable, ['--version'])).stdout)
    const cliVersion = /\b(\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1]
    expect(cliVersion).toBe('0.5.0')
    const config = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', version: cliVersion, executablePath: executable,
      executableHash: hash(await readFile(executable)), homeDirectory: join(root, 'bsk-home'), revision: 1, interaction: 'observe' })
    const daemon = spawn(executable, ['daemon', 'start', '--foreground'], { env: browserEnvironment(config.homeDirectory), shell: false, stdio: 'pipe' })
    let daemonLog = ''
    daemon.stderr.on('data', bytes => { daemonLog = (daemonLog + String(bytes)).slice(-6000) })
    const chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--password-store=basic', '--use-mock-keychain',
      `--user-data-dir=${join(root, 'chrome-profile')}`, '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', '--disable-gpu', '--no-proxy-server', `--log-net-log=${join(root, 'chrome-netlog.json')}`, 'about:blank'], { stdio: 'pipe', shell: false })
    let chromeLog = ''
    chrome.stderr.on('data', bytes => { chromeLog = (chromeLog + String(bytes)).slice(-6000) })
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(request.url === '/two' ? '<!doctype html><html><head><title>RailWise controlled source two</title></head><body><h1>PAGE TWO RAILWISE</h1><p>Second controlled source.</p></body></html>' : '<!doctype html><html><head><title>RailWise controlled source one</title></head><body><h1>PAGE ONE RAILWISE</h1><a href="/two">Next page</a><input type="search" aria-label="采购检索" oninput="document.getElementById(&quot;result&quot;).textContent=this.value"><p id="result"></p></body></html>')
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
    const now = new Date().toISOString()
    repository.create(TaskRunSchema.parse({ id: 'synthetic-browser', threadId: 'thread', activeTurnId: 'turn', childTaskIds: [], workspaceRoot: root,
      goal: `浏览器读取 ${origin} 两页`, status: 'running', agentId: 'default', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false, ...(scheduleAcceptance ? { schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } } : {}) },
      budget: { maxAttempts: 1, maxDurationMs: 180000 }, attempts: 0, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0, createdAt: now, updatedAt: now }))
    const workerEvents: unknown[] = []
    let lastStatus: unknown
    let socket: WebSocket | undefined
    try {
      await expect.poll(() => /DevTools listening on (ws:\/\/\S+)/.exec(chromeLog)?.[1], { timeout: 20000 }).toBeTruthy()
      socket = new WebSocket(/DevTools listening on (ws:\/\/\S+)/.exec(chromeLog)![1])
      await new Promise<void>((done, reject) => { socket!.once('open', done); socket!.once('error', reject) })
      socket.on('message', bytes => {
        const event = JSON.parse(String(bytes))
        if (event.method === 'Target.attachedToTarget') {
          const sessionId = event.params.sessionId
          socket!.send(JSON.stringify({ id: 99, method: 'Runtime.enable', sessionId }))
          if (event.params.targetInfo.type === 'service_worker') {
            socket!.send(JSON.stringify({ id: 100, method: 'Network.enable', sessionId }))
          }
        }
        if (event.method === 'Target.attachedToTarget') workerEvents.push({ method: event.method, type: event.params.targetInfo.type })
        if (event.method === 'Runtime.exceptionThrown') workerEvents.push({ method: event.method, message: event.params.exceptionDetails.text })
        if (event.method === 'Network.webSocketFrameError') workerEvents.push({ method: event.method, message: event.params.errorMessage })
        if (event.method === 'Network.webSocketHandshakeResponseReceived') workerEvents.push({ method: event.method, status: event.params.response.status })
      })
      socket.send(JSON.stringify({ id: 98, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } }))
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(() => reject(new Error('Official test extension load timed out')), 10000)
        socket!.on('message', bytes => {
          const response = JSON.parse(String(bytes))
          if (response.id !== 1) return
          clearTimeout(timeout)
          if (response.error) reject(new Error(JSON.stringify(response.error)))
          else done()
        })
        socket!.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: join(root, 'extension') } }))
      })
      await expect.poll(async () => {
        const status = await runBrowserCommand(config, ['status'])
        lastStatus = status
        return status.ok ? parseBrowserStatus(status.output).browsers.length : 0
      }, { timeout: 30000, interval: 500 }).toBe(1)
      const status = parseBrowserStatus((lastStatus as { output: unknown }).output)
      config.browserInstanceId = status.browsers[0].id
      config.origins = publicOrigin ? [origin, publicOrigin] : [origin]
      let scheduleResolution: BrowserScheduleResolution | undefined
      const provider = buildBrowserSkillToolProvider({ config: () => config, repository, dataDir: root, resolveSchedule: async () => scheduleResolution })
      const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'read-only', abortSignal: new AbortController().signal,
        awaitApproval: async () => { throw new Error('Read-only navigation must reuse the reviewed site scope') },
        executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: 'synthetic-browser', threadId: 'thread', turnId: 'turn', workspaceRoot: root,
          workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAllowlist: config.origins,
          browserScope: { browserInstanceId: config.browserInstanceId, origins: config.origins, interaction: 'observe', revision: 1 },
          workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant', issuedAt: now }) }
      const call = async (name: string, args: Record<string, unknown>, activeContext = context) => {
        const result = await provider.tools.find(tool => tool.name === name)!.execute(args, activeContext)
        if (result.isError) throw Object.assign(new Error(JSON.stringify(result.output)), { toolOutput: result.output })
        return result.output as Record<string, any>
      }
      const session = await call('browser_session_start', {})
      const first = await call('browser_navigate', { sessionId: session.sessionId, url: origin + '/one' })
      expect(first.evidence.contentRead).toBe(true)
      const realTabs = await runBrowserCommand(config, ['tab', 'list', '--session', session.sessionId, '--scope', 'agent'])
      expect(realTabs.ok).toBe(true)
      const realTab = (realTabs.output as { tabs: Array<Record<string, unknown>> }).tabs[0]
      expect(realTab.title).toBe('RailWise controlled source one')
      const html = await call('browser_get_html', { sessionId: session.sessionId })
      expect(html.html).toContain('href="/two"')
      let interactionEvidence: unknown
      let scheduledInteractionEvidence: unknown
      let nextContextId = first.observation.context_id
      if (interactionAcceptance) {
        const host = new LocalToolHost({ registry: new CapabilityRegistry([provider]) })
        expect((await host.listTools(context)).some(tool => tool.name === 'browser_fill')).toBe(false)
        expect(await host.execute({ callId: 'request-interaction', toolName: 'browser_request_interaction', arguments: { reason: '填写本地合成搜索框' } }, context))
          .toMatchObject({ item: { isError: true, output: { code: 'browser_interaction_scope_required' } } })
        repository.update('synthetic-browser', 0, task => ({ ...task, status: 'waiting_user', activeTurnId: undefined,
          authority: { source: 'user', workspaceRoot: root, externalTargets: [], grantedAt: now, browserScope: context.executionGrant!.browserScope! } }))
        config.interaction = 'interact'
        config.revision = 2
        config.browsers = status.browsers
        const runtime = new ManagedBrowserSkillRuntime({ config, repository, dataDir: root, configPath: join(root, 'unused-config'), apply: () => undefined })
        const binding = runtime.bindingSnapshot('synthetic-browser')
        expect(binding).toMatchObject({ interaction: 'interact', previousInteraction: 'observe' })
        runtime.confirmBinding('synthetic-browser', { confirmed: true, expectedTaskRevision: binding.taskRevision,
          expectedBrowserRevision: binding.browserRevision, browserInstanceId: binding.browserInstanceId,
          origins: binding.origins, interaction: 'interact', idempotencyKey: 'explicit-synthetic-interaction' })
        const confirmed = repository.get('synthetic-browser')!
        repository.update(confirmed.id, confirmed.revision, task => ({ ...task, status: 'running', activeTurnId: 'turn' }))
        context.executionGrant = { ...context.executionGrant!, revision: 1, browserScope: confirmed.authority!.browserScope! }
        const fresh = await call('browser_observe', { sessionId: session.sessionId })
        await writeFile(join(root, 'synthetic-input-observation.json'), JSON.stringify({ first: first.observation, fresh: fresh.observation }, null, 2))
        const targetLine = JSON.stringify(first.observation).split(/\\n|\n/).find(line => line.includes('采购检索')) ?? ''
        const target = /@?e\d+/.exec(targetLine)?.[0]
        expect(target, 'Actual extension observation must expose the labelled input reference').toBeTruthy()
        let approvals = 0
        let summary = ''
        context.awaitApproval = async approval => { approvals += 1; summary = approval.summary; return 'allow' }
        if (scheduleAcceptance) {
          await call('browser_authorize_action', { sessionId: session.sessionId, contextId: fresh.observation.context_id,
            target, action: 'fill', value: '轨道交通监测验收', scope: 'schedule', scheduleAccess: 'public_query' })
        }
        const filled = await host.execute({ callId: 'synthetic-fill', toolName: 'browser_fill', arguments: {
          sessionId: session.sessionId, contextId: fresh.observation.context_id, target, value: '轨道交通监测验收'
        } }, context)
        expect(filled.item).toMatchObject({ isError: false, output: { status: 'succeeded' } })
        expect(summary).toContain('采购检索')
        expect(summary).toContain('轨道交通监测验收')
        expect(summary).not.toContain('browser_fill')
        const readback = await call('browser_get_html', { sessionId: session.sessionId })
        expect(readback.html).toContain('id="result">轨道交通监测验收')
        const after = await call('browser_observe', { sessionId: session.sessionId })
        nextContextId = after.observation.context_id
        interactionEvidence = { scopeConfirmed: true, sameTask: true, approvals, action: 'fill', count: 1, readbackVerified: true,
          summaryHash: hash(Buffer.from(summary)), readbackHash: readback.resultHash, externalWrites: 0 }
        if (scheduleAcceptance) {
          expect(approvals).toBe(1)
          const source = repository.get('synthetic-browser')!
          const actions = listApprovedBrowserScheduleActions(repository, source)
          expect(actions).toHaveLength(1)
          const binding = { scheduleId: 'schedule_synthetic-browser', versionId: 'synthetic-published-version', sourceTaskId: source.id,
            scopeHash: 'a'.repeat(64), actionsHash: hash(Buffer.from(JSON.stringify(actions))) }
          scheduleResolution = { binding, actions }
          repository.create({ ...source, id: 'synthetic-occurrence', threadId: 'due-thread', activeTurnId: 'due-turn',
            scheduledBy: { scheduleId: binding.scheduleId, dueAt: new Date().toISOString() } })
          const dueContext: ToolHostContext = { ...context, threadId: 'due-thread', turnId: 'due-turn',
            executionGrant: { ...context.executionGrant!, id: 'due-grant', taskId: 'synthetic-occurrence', threadId: 'due-thread', turnId: 'due-turn',
              scheduleScopeHash: binding.scopeHash, browserScheduleBinding: binding, expiresAt: new Date(Date.now() + 60000).toISOString() },
            awaitApproval: async () => { throw new Error('The finite schedule action must derive its own short authorization') } }
          const dueSession = await call('browser_session_start', {}, dueContext)
          expect(dueSession.sessionId).not.toBe(session.sessionId)
          const duePage = await call('browser_navigate', { sessionId: dueSession.sessionId, url: origin + '/one' }, dueContext)
          const dueLine = JSON.stringify(duePage.observation).split(/\\n|\n/).find(line => line.includes('采购检索')) ?? ''
          const dueTarget = /@?e\d+/.exec(dueLine)?.[0]
          expect(dueTarget).toBeTruthy()
          expect(await host.execute({ callId: 'due-fill', toolName: 'browser_fill', arguments: { sessionId: dueSession.sessionId,
            contextId: duePage.observation.context_id, target: dueTarget, value: '轨道交通监测验收' } }, dueContext))
            .toMatchObject({ item: { isError: false, output: { status: 'succeeded' } } })
          const dueRead = await call('browser_get_html', { sessionId: dueSession.sessionId }, dueContext)
          expect(dueRead.html).toContain('id="result">轨道交通监测验收')
          expect(repository.operations('synthetic-occurrence', 'browser_derived_action_authorization')).toHaveLength(1)
          await call('browser_session_stop', { sessionId: dueSession.sessionId }, dueContext)
          scheduledInteractionEvidence = { independentTask: true, independentSession: true, actualCliWrites: 1, addedApprovals: 0,
            readbackVerified: true, readbackHash: dueRead.resultHash, scopeResolution: 'synthetic-published-plan-fixture', actualFlowDispatch: false }
        }

      }
      const second = await call('browser_navigate', { sessionId: session.sessionId, url: origin + '/two', contextId: nextContextId })
      expect(JSON.stringify(second.observation)).toContain('PAGE TWO RAILWISE')
      const shot = await call('browser_screenshot', { sessionId: session.sessionId })
      expect(hash(await readFile(shot.imagePath))).toBe(shot.sha256)
      let publicPage: unknown
      if (publicUrl) {
        try {
          await call('browser_navigate', { sessionId: session.sessionId, url: publicUrl, contextId: second.observation.context_id })
          await new Promise(done => setTimeout(done, 2500))
          const publicRead = await call('browser_observe', { sessionId: session.sessionId })
          const publicHtml = await call('browser_get_html', { sessionId: session.sessionId })
          await writeFile(join(root, 'public-observation.json'), JSON.stringify(publicRead.observation))
          publicPage = { status: 'readable', sourceUrl: publicRead.sourceUrl, evidence: publicRead.evidence, htmlHash: publicHtml.resultHash,
            title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(publicHtml.html)?.[1]?.trim(),
            observationExcerpt: String(publicRead.observation.observation?.text ?? '').slice(0, 1800),
            publicLinkLabels: String(publicRead.observation.observation?.text ?? '').split('\n').filter(line => /link.*(?:项目|公告|采购|中标|监测)/.test(line)).slice(0, 16), truncated: publicHtml.truncated }
          expect(process.env.RAILWISE_BROWSER_EXPECT_BLOCKED).not.toBe('1')
        } catch (error) {
          const blocked = (error as { toolOutput?: Record<string, unknown> }).toolOutput
          if (process.env.RAILWISE_BROWSER_EXPECT_BLOCKED !== '1' || blocked?.code !== 'web_access_blocked') throw error
          expect(blocked.evidence).toMatchObject({ contentRead: false, verified: false })
          publicPage = { ...blocked, status: 'blocked' }
        }
      }
      await call('browser_session_stop', { sessionId: session.sessionId })
      await writeFile(join(root, 'evidence.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), cliVersion, extensionVersion: manifest.version,
        credentialStore: 'isolated-test-mock-keychain', protocol: status.protocolVersion, browserVersion: (await executeFile(chromePath, ['--version'])).stdout.trim(), pagesRead: 2, htmlRead: true,
        tabListShape: { keys: Object.keys(realTab), title: realTab.title }, publicPage, pageEvidenceHashes: [first.resultHash, second.resultHash], screenshotHash: shot.sha256, approvals: interactionAcceptance ? 1 : 0, interactionEvidence, scheduledInteractionEvidence,
        sessionStopped: repository.operations('synthetic-browser', 'browser_session').every(item => (item.result as { stopped?: boolean }).stopped) }, null, 2))
    } catch (error) {
      await writeFile(join(root, 'failure.json'), JSON.stringify({ error: String(error), lastStatus, daemonLog, chromeLog, workerEvents }, null, 2))
      throw error
    } finally {
      socket?.close(); chrome.kill('SIGTERM'); daemon.kill('SIGTERM'); repository.close()
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections() })
    }
  }, 120000)
})
