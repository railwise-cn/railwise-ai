import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { BrowserCommandRunner } from '../src/services/browser-skill-cli.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'

// Structurally equivalent synthetic markup, based on the independently captured
// public query container (704B, SHA256 cb1d4a75a0ad0e3ee1957f1d1b2acc5264dacf2bad7edfabcd08ba332ba06d4b).
// Preserve the actual input depth/type/placeholder and both shared-class controls;
// omit vendor data-v/style attributes and all site/business content. This is a
// protocol/Runtime regression, never a claim of real website/model acceptance.
const markup = '<div class="searchInput-content-input"><div class="input-input"><div class="po-input po-input--medium po-input--prefix po-input--suffix"><input type="text" autocomplete="off" placeholder="请输入内容" class="po-input__inner"><span class="po-input__prefix"><i class="po-input__icon"></i></span></div></div><div class="input-button">搜标题</div><div class="input-button">搜全文</div></div>'
const pageUrl = 'https://public.example.test/query'
type Mode = 'safe' | 'get' | 'multiple-parents' | 'sensitive' | 'post' | 'non-query' | 'wrong-canonical' | 'wrong-frame' | 'absent-form-frame' | 'excess'
type Field = { key: string; read: string; selector?: string; attribute?: string }
type Audit = { selector: string; matches: number; maximum: number; ambiguousField?: string; truncated: boolean }
const cli = vi.hoisted(() => ({ run: undefined as BrowserCommandRunner | undefined }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({ ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn((config, args, signal) => cli.run!(config, args, signal)) }))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); cli.run = undefined; vi.unstubAllEnvs() })

function nativeDom(mode: Mode = 'safe') {
  const window = new Window({ url: pageUrl }), document = window.document
  document.body.innerHTML = (mode === 'post' || mode === 'get' ? '<form method="' + mode + '" action="/query">' + markup + '</form>' : markup) + '<output id="result"></output>'
  const parent = document.querySelector('.searchInput-content-input')!
  if (mode === 'multiple-parents') document.body.append(parent.cloneNode(true))
  if (mode === 'sensitive') parent.insertAdjacentHTML('beforeend', '<input type="password" name="account-password">')
  if (mode === 'excess') for (let i = 0; i < 16; i++) parent.insertAdjacentHTML('beforeend', '<div class="input-button">' + (i % 2 ? '搜全文' : '搜标题') + '</div>')
  const input = parent.querySelector('input')!, title = parent.querySelectorAll('.input-button')[0]!, full = parent.querySelectorAll('.input-button')[1]!
  if (mode === 'non-query') { title.textContent = '普通操作一'; full.textContent = '普通操作二' }
  const nodes = [...document.querySelectorAll('*')], refs = new Map(nodes.map((node, i) => [node, '@e' + (100 + i)]))
  refs.set(input, '@e54'); refs.set(title, '@e55'); refs.set(full, '@e56'); refs.set(parent, '@e57')
  const aliases = new Map([['@e7', title], ['@e8', full], ['@e9', input], ...[...refs].map(([node, ref]) => [ref, node] as const)])
  const audits: Audit[] = []
  const resolve = (ref: string) => aliases.get(ref.startsWith('@') ? ref : '@' + ref)
  const read = (args: readonly string[]) => {
    const fields = JSON.parse(args[args.indexOf('--fields-json') + 1]!) as Field[]
    const selector = args.includes('--selector') ? args[args.indexOf('--selector') + 1]! : ''
    const target = args.includes('--ref') ? resolve(args[args.indexOf('--ref') + 1]!) : undefined
    const matched = selector ? [...document.querySelectorAll(selector)] : target ? [target] : []
    const maximum = Number(args[args.indexOf('--max-nodes') + 1]), truncated = matched.length > maximum
    const audit: Audit = { selector, matches: matched.length, maximum, truncated }; audits.push(audit)
    const items = []
    for (const node of matched.slice(0, maximum)) {
      const values: Record<string, unknown> = {}
      for (const field of fields) {
        // The official scalar field contract rejects several descendants even
        // for exists; :scope explicitly denotes the current matched element.
        const selected = !field.selector || field.selector === ':scope' ? [node] : [...node.querySelectorAll(field.selector)]
        if (selected.length > 1) {
          audit.ambiguousField = field.key
          return { ok: false, code: 'invalid_params', exitCode: 1, outcomeUnknown: false,
            output: { code: 'invalid_params', data: { reason: 'read_field_ambiguous' } } }
        }
        const found = selected[0]
        values[field.key] = field.read === 'exists' ? selected.length === 1 : field.read === 'attribute' ? found?.getAttribute(field.attribute!) ?? null
          : field.read === 'value' ? found && 'value' in found ? String(found.value) : '' : field.read === 'text' ? found?.textContent ?? null : undefined
        if (values[field.key] === undefined) throw new Error('Unsupported official native field in protocol fixture')
      }
      const ref = !selector && mode === 'wrong-canonical' && fields.length === 1 ? '@e999' : refs.get(node)!
      items.push({ ref, values, redacted: [] })
    }
    return { ok: true, output: { tab_id: 1, page_url: pageUrl, frame_url: pageUrl,
      frame_id: selector && (mode === 'wrong-frame' || mode === 'absent-form-frame' && selector.startsWith('form:')) ? 'CHILD-FRAME' : 'MAIN-FRAME', scope: 'current_dom', truncated, items } }
  }
  return { window, document, input, title, full, parent, audits, read, resolve }
}

async function fixture(mode: Mode = 'safe', flow: 'clicks' | 'fill-and-click' = 'clicks') {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const dom = nativeDom(mode); cleanup.push(() => dom.window.happyDOM.close())
  const root = await realpath(await mkdtemp(join(tmpdir(), 'public-query-real-dom-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let live = false, url = 'about:blank', context = 0, calls = 0, sawFinalToolResult = false
  const clicks: string[] = [], fills: string[] = [], query = '工程测量 完整输入&标点<42>'
  const nativeExpectations: Array<{action:string;conditions:Array<{target:string;field:string;attribute?:string;equals:unknown}>}> = []
  cli.run = async (_config, args) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'dom-browser', browser_name: 'Chrome', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: live ? [{ session_id: 'dom-session', browser_instance_id: 'dom-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { live = true; return { ok: true, output: { session_id: 'dom-session', browser_instance_id: 'dom-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { live = false; return { ok: true, output: { stopped: ['dom-session'], failed: [] } } }
    if (!live) return { ok: false, code: 'not_found', output: { code: 'not_found' } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url, title: 'Synthetic public query' }] } }
    if (args[0] === 'navigate') { url = args[1]!; return { ok: true, output: {} } }
    if (args[0] === 'cooperate') return { ok: true, output: { context_id: 'dom-context-' + (++context), observation_id: 'dom-observation-' + context, control_policy: 'target',
      observation: { text: '@e7 button ' + dom.title.textContent + '\n@e8 button ' + dom.full.textContent + '\n@e9 textbox 请输入内容 value="' + dom.input.value + '"\n公开查询结果 ' + clicks.length } } }
    if (args[0] === 'read') return dom.read(args)
    if (args[0] === 'get-html') {
      const node = args.includes('--ref') ? dom.resolve(args[args.indexOf('--ref') + 1]!) : dom.document.documentElement
      return { ok: true, output: { tab_id: 1, html: node?.outerHTML ?? '', truncated: false } }
    }
    if (args[0] === 'click' || args[0] === 'fill') {
      expect(args).toContain('--expect')
      const expectations = JSON.parse(args[args.indexOf('--expect') + 1]!) as Array<{target:string;field:string;attribute?:string;equals:unknown}>
      nativeExpectations.push({action:args[0],conditions:expectations})
      for (const condition of expectations) {
        const node = dom.resolve(condition.target)!
        expect(condition.field === 'exists' ? Boolean(node) : condition.field === 'text' ? node.textContent : condition.field === 'value' && 'value' in node ? String(node.value) : node.getAttribute(condition.attribute!)).toEqual(condition.equals)
      }
      const ref = args.find(arg=>/^@?e\d+$/.test(arg))!, node = dom.resolve(ref)!
      if (args[0] === 'fill') {
        expect(node).toBe(dom.input)
        const value = args[args.indexOf('--value') + 1]!
        dom.input.value = value; fills.push(value)
        return { ok: true, output: { filled: true } }
      }
      clicks.push(node.textContent!.trim()); dom.document.querySelector('#result')!.textContent = '已核对公开查询 ' + node.textContent!.trim()
      return { ok: true, output: { clicked: true } }
    }
    throw new Error('Unexpected synthetic CLI command: ' + args[0])
  }
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls++; const body = JSON.parse(Buffer.concat(chunks).toString())
    const called = new Set((body.messages ?? []).flatMap((m:{tool_calls?:Array<{id:string}>})=>m.tool_calls?.map(t=>t.id) ?? []))
    const steps = [['start','browser_session_start'],['navigate','browser_navigate'],...(flow === 'fill-and-click' ? [['fill','browser_fill']] : []),['title','browser_click'],...(flow === 'clicks' ? [['full','browser_click']] : [])]
    const next = steps.find(([id])=>!called.has('dom-' + id))
    response.writeHead(200,{'content-type':'text/event-stream'})
    if (!next) { sawFinalToolResult = true; response.write(': synthetic model hold until test shutdown\n\n'); return }
    const args = next[0] === 'navigate' ? {sessionId:'dom-session',url:pageUrl} : next[0] === 'fill' ? {sessionId:'dom-session',contextId:'dom-context-' + context,target:'@e9',value:query} : ['title','full'].includes(next[0]!) ? {sessionId:'dom-session',contextId:'dom-context-' + context,target:next[0] === 'title' ? '@e7' : '@e8'} : {}
    response.end('data: ' + JSON.stringify({id:'dom-model',choices:[{index:0,delta:{tool_calls:[{index:0,id:'dom-' + next[0],type:'function',function:{name:next[1],arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]}) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve))
  cleanup.push(()=>new Promise<void>(resolve=>{model.close(()=>resolve());model.closeAllConnections()}))
  const runtime = await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'runtime'),runtimeToken:'synthetic-dom',apiKey:'synthetic-local-only',
    baseUrl:'http://127.0.0.1:' + (model.address() as {port:number}).port + '/v1',endpointFormat:'chat_completions',model:'dom-model',approvalPolicy:'on-request',sandboxMode:'read-only',tokenEconomyMode:false,insecure:false,storage:{backend:'file'},
    capabilities:KunCapabilitiesConfig.parse({browserSkill:{enabled:true,state:'ready',executablePath:join(root,'synthetic-cli'),executableHash:'a'.repeat(64),version:'0.5.0',daemonProtocolVersion:'1.9',browserInstanceId:'dom-browser',origins:['https://public.example.test'],interaction:'interact',revision:1,
      browsers:[{id:'dom-browser',name:'Chrome',label:'Synthetic',connected:true,versionSkew:false,extensionVersion:'0.5.0',protocolVersion:'1.9'}]}})})
  cleanup.push(async()=>runtime.shutdown?.())
  const router = buildRouter(runtime)
  const api = (path:string,method='POST',body?:unknown)=>dispatchRequest(router,new Request('http://localhost' + path,{method,headers:{authorization:'Bearer synthetic-dom','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}))
  const thread = await runtime.threadService.create({workspace,mode:'agent',model:'dom-model',approvalPolicy:'on-request'})
  const initial = await runtime.taskCoordinator!.command({threadId:thread.id,intent:'new',idempotencyKey:'create',request:{prompt:'使用BrowserSkill在 https://public.example.test/query 查询工程测量的公开资料，无需账号。'}})
  expect(initial.kind).toBe('capability_required');expect(calls).toBe(0)
  const id = initial.task!.id, task = ()=>runtime.taskRepository!.get(id)!
  const snapshot = await (await api('/v1/tasks/' + id + '/browser-binding','GET')).json() as BrowserTaskBindingSnapshot
  const bound = await api('/v1/tasks/' + id + '/browser-binding','POST',{confirmed:true,expectedTaskRevision:snapshot.taskRevision,expectedBrowserRevision:snapshot.browserRevision,browserInstanceId:snapshot.browserInstanceId,origins:snapshot.origins,interaction:'interact',verificationPolicy:'public_query_target',publicQueryAuthorization:'task',idempotencyKey:'bind-query-scope'})
  expect(bound.status,await bound.clone().text()).toBe(200);expect(calls).toBe(0)
  expect((await api('/v1/tasks/' + id + '/resume','POST',{expectedRevision:task().revision,idempotencyKey:'continue-separately'})).status).toBe(202)
  await expect.poll(()=>sawFinalToolResult || runtime.approvalGate.pending().length > 0 || ['stalled','waiting_user','failed'].includes(task().status),{timeout:10000}).toBe(true)
  return {runtime,task,dom,clicks,fills,query,nativeExpectations}
}

it('models native scalar exists ambiguity and unique :scope without hardcoded search-form fields',async()=>{
  const dom = nativeDom();cleanup.push(()=>dom.window.happyDOM.close())
  const read = (selector:string,fields:Field[])=>dom.read(['read','--selector',selector,'--fields-json',JSON.stringify(fields),'--max-nodes','8','--max-bytes','8192'])
  expect(read('.searchInput-content-input',[{key:'target',read:'exists',selector:'.input-button'}])).toMatchObject({ok:false,code:'invalid_params',output:{data:{reason:'read_field_ambiguous'}}})
  expect(read('.input-button',[{key:'present',read:'exists',selector:':scope'}])).toMatchObject({ok:true,output:{truncated:false,items:[{ref:'@e55',values:{present:true}},{ref:'@e56',values:{present:true}}]}})
  expect(read('.searchInput-content-input',[{key:'searchInput',read:'exists',selector:'input[type="search"],input[name="q"],input[name="keyword"],input[id="title"]'}])).toMatchObject({ok:true,output:{items:[{values:{searchInput:false}}]}})
})

it.each(['safe','get'] as const)('derives both shared-class query actions from actual nested DOM and persisted scope without human approval (%s)',async mode=>{
  const f = await fixture(mode), id = f.task().id, repository = f.runtime.taskRepository!
  expect(f.dom.parent.querySelector('.input-input > .po-input > input[placeholder="请输入内容"]')).toBeTruthy()
  expect(f.dom.document.querySelectorAll('div.input-button')).toHaveLength(2)
  expect(repository.operations(id,'browser_scope_action_authorization')).toHaveLength(2)
  expect(repository.operations(id,'browser_derived_action_authorization')).toHaveLength(2)
  expect(repository.humanRequests('approval',false)).toHaveLength(0);expect(f.runtime.approvalGate.pending()).toHaveLength(0)
  expect(f.clicks).toEqual(['搜标题','搜全文'])
  expect(repository.operations(id,'browser_action_dispatch')).toMatchObject([{status:'succeeded',result:{actionAcknowledged:true,readbackPending:false}},{status:'succeeded',result:{actionAcknowledged:true,readbackPending:false}}])
  expect(repository.operations(id,'browser_scope_action_authorization').every(r=>r.request?.rule==='search_trigger')).toBe(true)
},20000)

it.each(['sensitive','post','non-query'] as const)('does not fill a generic nested input through an unsafe or unproved ancestor (%s)',async mode=>{
  const f = await fixture(mode,'fill-and-click'), id = f.task().id
  expect(f.fills).toHaveLength(0);expect(f.dom.input.value).toBe('');expect(f.clicks).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_scope_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_derived_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_action_dispatch')).toHaveLength(0)
},20000)

it.each(['safe','get'] as const)('fills the unlabelled nested text input and reads its whole value before query with no human approval (%s)',async mode=>{
  const f = await fixture(mode,'fill-and-click'), id = f.task().id, repository = f.runtime.taskRepository!
  expect(f.dom.input.getAttribute('placeholder')).toBe('请输入内容')
  expect(f.dom.input.hasAttribute('name') || f.dom.input.hasAttribute('id') || f.dom.input.hasAttribute('aria-label')).toBe(false)
  expect(f.fills).toEqual([f.query]);expect(f.dom.input.value).toBe(f.query);expect(f.clicks).toEqual(['搜标题'])
  expect(f.nativeExpectations.find(item=>item.action==='fill')?.conditions).toContainEqual({target:'@e9',field:'value',equals:''})
  expect(f.nativeExpectations.find(item=>item.action==='click')?.conditions).toContainEqual({target:'@e9',field:'value',equals:f.query})
  expect(repository.humanRequests('approval',false)).toHaveLength(0);expect(f.runtime.approvalGate.pending()).toHaveLength(0)
  expect(repository.operations(id,'browser_scope_action_authorization')).toHaveLength(2)
  expect(repository.operations(id,'browser_derived_action_authorization')).toHaveLength(2)
  const dispatches = repository.operations(id,'browser_action_dispatch')
  expect(dispatches).toHaveLength(2)
  expect(dispatches.find(r=>r.request?.action==='fill')).toMatchObject({status:'succeeded',request:{valueHash:createHash('sha256').update(f.query).digest('hex')},result:{actionAcknowledged:true,readbackPending:false,publicQueryInput:{value:f.query}}})
  expect(dispatches.find(r=>r.request?.action==='click')).toMatchObject({status:'succeeded',result:{actionAcknowledged:true,readbackPending:false}})
},20000)

it.each(['multiple-parents','sensitive','post','wrong-canonical','wrong-frame','absent-form-frame','excess'] as const)('does not derive or dispatch scope actions for %s DOM/protocol proof',async mode=>{
  const f = await fixture(mode), id = f.task().id
  expect(f.clicks).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_scope_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_derived_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id,'browser_action_dispatch')).toHaveLength(0)
  if(mode==='excess')expect(f.dom.audits.some(a=>a.truncated)).toBe(true)
  // No approval is auto-decided in this fixture. Unknown structure may use the
  // existing human-review path; it never becomes task-backed permission.
},20000)
