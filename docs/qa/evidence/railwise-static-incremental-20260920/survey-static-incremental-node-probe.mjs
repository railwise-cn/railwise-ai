import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const evidence = dirname(fileURLToPath(import.meta.url))
if (!process.argv[2]) throw new Error('Pass checkout root after compiling kun')
const checkout = resolve(process.argv[2])
const { appendSurveyStaticLinearObservationsV1 } = await import(pathToFileURL(join(checkout, 'kun/dist/engineering/survey-static-incremental.js')).href)
const oracle = JSON.parse(readFileSync(join(evidence, 'survey-static-incremental-oracle.json'), 'utf8'))
const outputs = oracle.cases.flatMap(c => c.prefixes.map(prefix => {
  const request = structuredClone(c.request)
  if (prefix.appended) request.append.observations = request.append.observations.slice(0, prefix.appended)
  const result = appendSurveyStaticLinearObservationsV1(request)
  if (result.outcome !== 'calculated') throw new Error(JSON.stringify({ name: c.name, prefix, result }))
  return { name: c.name, appended: prefix.appended, result }
}))
writeFileSync(join(evidence, 'survey-static-incremental-node-output.json'), JSON.stringify({ node: process.version, outputs }, null, 2) + '\n')
console.log(JSON.stringify({ node: process.version, cases: oracle.cases.length, prefixFits: outputs.length, allCalculated: true }))
