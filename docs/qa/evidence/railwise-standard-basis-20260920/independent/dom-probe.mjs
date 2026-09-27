import assert from 'node:assert/strict'
import { Window } from 'happy-dom'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SurveyStandardBasis } from './compiled-dom.mjs'
import * as p from './compiled.mjs'
const browser = new Window()
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(globalThis, 'navigator', {value: browser.navigator, configurable: true})
const i18n = createInstance()
await i18n.init({lng:'en',resources:{en:{standardBasis:JSON.parse(readFileSync(resolve(process.argv[2] ?? '.', 'src/renderer/src/locales/en/standard-basis.json')))}},interpolation:{escapeValue:false}})
const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
const router = new p.Router(); p.registerSurveyStandardBasisRoutes(router,{authorize:()=>true})
const requests=[], opened=[]
let intercept = null
const runtimeRequest = async (path,method='GET') => {
  requests.push(path)
  if (intercept) { const value = await intercept(path); if(value) return value }
  assert(p.runtimeRequestPayloadSchema.safeParse({path,method}).success)
  const url = new URL(path,'http://localhost'), route=router.match(method,url.pathname)
  const response=await route.handler(new Request(url),{params:route.params})
  return {...response,ok:response.status<400}
}
window.workwise={runtimeRequest,openExternal:async url=>opened.push(url)}
const result=p.scoreSurveyQualityV1(p.qualityScoringExample('unit','planar-control-point'))
const context=p.scoringStandardBasisContext(result)
const render=async (ctx=context,ready=true)=>act(async()=>root.render(createElement(I18nextProvider,{i18n},createElement(SurveyStandardBasis,{context:ctx,runtimeReady:ready}))))
const toggle=async value=>act(async()=>{host.querySelector('details').open=value;host.querySelector('details').dispatchEvent(new browser.Event('toggle'))})
const settle=async()=>{for(let i=0;i<10;i++)await act(async()=>new Promise(r=>setTimeout(r,5)))}
await render();assert.equal(requests.length,0)
await toggle(true);await settle()
assert(host.textContent.includes('Declared hierarchical unit score'))
assert(host.querySelector('a').href.endsWith('#page=9'))
await act(async()=>host.querySelector('a').click());assert.equal(opened.length,1)
await render(context,false);await settle();assert.equal(host.querySelectorAll('a').length,0)
await render();await settle();assert(host.querySelector('a'))
let release
const deferred=new Promise(r=>release=r)
intercept=async path=>path===p.RUNTIME_STANDARD_BASIS_PATH?deferred:null
await toggle(false);await toggle(true)
await render({...context,algorithmVersion:'unsupported'});await toggle(false)
await act(async()=>release({ok:true,status:200,body:JSON.stringify(p.getSurveyStandardBasisCatalog())}));await settle()
assert.equal(host.querySelectorAll('a').length,0)
assert(!host.textContent.includes('Declared hierarchical unit score'))
intercept=null
await toggle(true);await settle();assert(host.querySelector('[role=alert]'));assert.equal(host.querySelectorAll('a').length,0)
await render(null);await settle();assert.equal(host.querySelectorAll('a').length,0)
await act(async()=>root.unmount())
console.log(JSON.stringify({domChecks:['lazy-open','actual-runtime-catalog-and-detail','official-pdf-page','offline-clears-basis','close-and-changed-context-discard-late-response','unsupported-version-no-links','missing-identity-no-links'],totalRequests:requests.length,errors:[]},null,2))
