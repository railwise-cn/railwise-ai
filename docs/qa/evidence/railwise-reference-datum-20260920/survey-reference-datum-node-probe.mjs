// Runs compiled product code with Node ESM; high-precision auditing is separate.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const evidence = dirname(fileURLToPath(import.meta.url))
if (!process.argv[2]) throw new Error('Pass the checkout root after compiling kun')
const checkout = resolve(process.argv[2])
const { compareSurveyReferenceDatumV1 } = await import(pathToFileURL(join(checkout, 'kun/dist/engineering/survey-reference-datum.js')).href)
const reference = JSON.parse(readFileSync(join(evidence, 'survey-reference-datum-oracle.json'), 'utf8'))
const outputs = reference.cases.map(item => ({ name: item.name, result: compareSurveyReferenceDatumV1(item.request) }))
if (outputs.some(item => item.result.outcome !== 'calculated')) throw new Error('Compiled reference datum oracle smoke failed')
writeFileSync(join(evidence, 'survey-reference-datum-node-output.json'), JSON.stringify({ node: process.version, outputs }, null, 2) + '\n')
console.log(JSON.stringify({ node: process.version, cases: outputs.length, allCalculated: true }))
