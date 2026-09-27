import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as p from './compiled.mjs'
const root = resolve(process.argv[2] ?? '.') + '/'
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
let calls = 0
const router = new p.Router()
p.registerSurveyStandardBasisRoutes(router, { authorize: req => req.headers.get('authorization') === 'Bearer independent-test' })
async function request(path, method = 'GET', authorized = true) {
  const url = new URL(path, 'http://localhost')
  const route = router.match(method, url.pathname)
  if (!route) return { status: 404, ok: false, body: '{}' }
  const response = await route.handler(new Request(url, { method, headers: authorized ? { authorization: 'Bearer independent-test' } : {} }), { params: route.params })
  assert.equal(response.headers['cache-control'], 'no-store')
  return { ...response, ok: response.status < 400 }
}
globalThis.window = { workwise: { runtimeRequest: async (path, method) => {
  calls++
  assert.equal(p.runtimeRequestPayloadSchema.safeParse({ path, method }).success, true)
  return request(path, method)
} } }
const hash = data => createHash('sha256').update(data).digest('hex')
const catalog = p.getSurveyStandardBasisCatalog()
assert.equal(catalog.rules.length, 9)
assert.equal(hash(JSON.stringify(catalog.rules.map(e => e.ruleDigest))), catalog.catalogDigest)
const sources = JSON.parse(readFileSync(root + 'docs/qa/evidence/railwise-standards-20260920/sources.json'))
const reviews = sources.clauseReviews
for (const entry of catalog.rules) {
  assert.equal(hash(JSON.stringify(p.SurveyStandardBasisRuleV1.parse(entry.rule))), entry.ruleDigest)
  for (const evidence of entry.rule.source.evidenceDocuments) assert.equal(hash(readFileSync(root + evidence.path)), evidence.sha256)
  for (const locator of [...entry.rule.locators, ...entry.rule.profiles.flatMap(p => p.locators)]) {
    for (const clause of locator.clauses) {
      const reviewed = reviews.filter(r => r.clauses.some(c => c === clause || c.startsWith(clause + '.') || clause.startsWith(c + '.')))
      assert(reviewed.length, 'no retained review for ' + clause)
      assert(locator.pdfPages.some(page => reviewed.some(r => r.pdfPages.includes(page))), 'page not in retained review for ' + clause)
    }
  }
}
const results = []
for (const operation of ['accuracy','deduction','unit','overview','sample','final-batch','acceptance-batch']) {
  for (const profile of ['planar-control-point','height-control-section']) {
    const result = p.scoreSurveyQualityV1(p.qualityScoringExample(operation, profile))
    const before = JSON.stringify(result)
    const context = p.scoringStandardBasisContext(result)
    const resolved = await p.readResultStandardBasis(context)
    assert.equal(resolved.entry.rule.executor.operation, operation)
    assert.equal(resolved.profile.profileId, profile)
    assert.equal(JSON.stringify(result), before)
    assert.equal(resolved.entry.rule.standardConformity, 'not-evaluated')
    results.push([operation, profile])
  }
}
for (const inspectionMode of ['census','table-1-simple-random']) {
  const ids=['sample-a','sample-b','sample-c','sample-d']
  const plan=p.createQualitySamplingPlan({schemaVersion:1,projectId:'synthetic-project',populationId:'synthetic-population',productType:'control',unitProductType:'point',definitionEvidenceSha256:'a'.repeat(64),orderedUnitProductIds:ids,populationHash:p.qualitySamplingPopulationHash(ids),stage:'acceptance',inspectionMode,round:1,
    ...(inspectionMode==='census'?{}:{randomSource:{seedHex:'a'.repeat(64),sourceDescription:'independent synthetic test',receiptSha256:'b'.repeat(64),trust:'caller-declared-not-authenticated'}})})
  const before=JSON.stringify(plan)
  const context=p.samplingStandardBasisContext({...plan,inspectionMode})
  const detail=await p.readResultStandardBasis(context)
  assert.equal(detail.entry.rule.executor.operation,inspectionMode)
  assert.equal(JSON.stringify(plan),before)
  results.push(['sampling',inspectionMode])
}
const r = catalog.rules[0].rule, profile = r.profiles[0]
const ref = {standardCode:r.standardCode,standardVersion:r.standardVersion,ruleId:r.ruleId,ruleVersion:r.ruleVersion,sourceSha256:r.source.sha256,algorithmVersion:r.executor.algorithmVersion,profileId:profile.profileId,profileVersion:profile.profileVersion}
const exactPath = p.runtimeStandardBasisPath(ref)
const negative = []
for (const field of Object.keys(ref)) {
  const bad = { ...ref, [field]: field==='sourceSha256' ? 'b'.repeat(64) : 'wrong' }
  const response = await request(p.runtimeStandardBasisPath(bad))
  assert(response.status >= 400)
  negative.push([field,response.status])
}
for (const path of [exactPath+'&extra=1', exactPath+'&profileId='+profile.profileId, exactPath.replace(/&profileVersion=[^&]+/,''),p.RUNTIME_STANDARD_BASIS_PATH+'?bad=1']) {
  assert.equal(p.runtimeRequestPayloadSchema.safeParse({path}).success,false)
  assert.equal((await request(path)).status,400)
  assert.equal((await request(path,'GET',false)).status,401)
}
for (const method of ['POST','PUT','DELETE','PATCH']) {
  assert.equal(p.runtimeRequestPayloadSchema.safeParse({path:exactPath,method}).success,false)
  assert.equal((await request(exactPath,method)).status,404)
}
const unit = catalog.rules.find(e => e.rule.executor.operation === 'unit').rule
const unitClauses = unit.locators.flatMap(l=>l.clauses)
const formulaSixMissing = !unitClauses.includes('6.2.4.5')
const probe = { actualRuntimeIpcDesktopRoundTrips:results.length, actualReadonlyCalls:calls, rejectedIdentityFields:negative, retainedSourcesAndPagesChecked:true, historicalScoreBytesUnchanged:true, finding:{code:'unit-formula-6-clause-missing',present:formulaSixMissing,clauses:unitClauses,sourceEvidence:'Retained official PDF pages 10/11, printed 7/8: 6.2.4.5 contains formula (6); 6.2.5 contains grade table 3.'} }
console.log(JSON.stringify(probe,null,2))
