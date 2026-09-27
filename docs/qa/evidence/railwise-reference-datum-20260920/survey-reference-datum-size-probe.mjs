// Synthetic maximum-dimension/long-ID transport probe, not a production benchmark.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
if (!process.argv[2]) throw new Error('Pass the checkout root after compiling kun')
const { compareSurveyReferenceDatumV1 } = await import(pathToFileURL(join(resolve(process.argv[2]), 'kun/dist/engineering/survey-reference-datum.js')).href)
const n = 32
const id = label => label.padEnd(160, '测')
const epoch = number => ({
  id: id(`epoch-${number}`), sourceAnchor: id(`source-${number}`), sourceSha256: String(number).repeat(64),
  covarianceBasis: 'caller-declared-full-coordinate-covariance-not-cofactor',
  points: Array.from({ length: n }, (_, i) => ({ id: id(`epoch-${number}-point-${i}`), coordinate: 1e8 + i * 0.125 + number * (i % 7) * 0.015625 })),
  covariance: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1.2345678901234567e99 : 1.2345678901234567e98))
})
const request = {
  schemaVersion: 1, model: 'two-epoch-one-dimensional-declared-reference-datum', unit: 'mm', method: 'gls-reference-mean',
  referenceDeclaration: 'caller-selected-reference-set-not-verified-stable', testingStrategy: 'none-datum-comparison-only',
  firstEpoch: epoch(1), secondEpoch: epoch(2),
  mapping: Array.from({ length: n }, (_, i) => ({ id: id(`common-point-${i}`), firstPointId: id(`epoch-1-point-${i}`), secondPointId: id(`epoch-2-point-${i}`) })),
  referenceIds: Array.from({ length: n }, (_, i) => id(`common-point-${i}`)),
  dependence: { kind: 'caller-declared-cross-covariance', sourceAnchor: id('cross-source'), firstToSecondCovariance: Array.from({ length: n }, () => Array.from({ length: n }, () => 1.2345678901234567e97)) }
}
const before = performance.now()
const result = compareSurveyReferenceDatumV1(request)
const elapsedMs = performance.now() - before
if (result.outcome !== 'calculated') throw new Error(JSON.stringify(result))
const summary = { node: process.version, pointCount: n, referenceCount: n, maximumIdCodeUnits: 160, requestUtf8Bytes: Buffer.byteLength(JSON.stringify(request)), outputUtf8Bytes: Buffer.byteLength(JSON.stringify(result)), elapsedMs, outcome: result.outcome, covarianceClassification: result.covarianceCheck.classification, caveat: 'one local synthetic long-ID and maximum-dimension probe; not worst-case byte proof or production SLA' }
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'survey-reference-datum-size-probe.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
