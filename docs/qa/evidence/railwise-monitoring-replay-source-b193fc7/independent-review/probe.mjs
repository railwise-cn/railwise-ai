import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = '/Users/wangjiawei/Documents/WorkWise';
process.chdir(root);
const require = createRequire(root + '/kun/package.json');
const { transpileModule, ModuleKind, ScriptTarget } = require('typescript');
const compile = text => transpileModule(text, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText;
const uri = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const timeUri = uri(compile(readFileSync('kun/src/engineering/engineering-trend-chart.ts', 'utf8')));
const { calculateMonitoringAnalysisV2: current } = await import(uri(compile(readFileSync('kun/src/engineering/monitoring-analysis.ts', 'utf8')).replace("'./engineering-trend-chart.js'", JSON.stringify(timeUri))));
const previous = execFileSync('git', ['show', 'HEAD:kun/src/engineering/engineering-service.ts'], { encoding: 'utf8' });
const start = previous.indexOf('    const instants = new Map(dataset.observations.map');
const end = previous.indexOf('\n    const analysis = MonitoringAnalysisV1.parse', start);
if (start < 0 || end < start) throw Error('old implementation extraction unavailable');
const source = `import {monitoringTrendInstant} from ${JSON.stringify(timeUri)}; export function old(project, dataset) {${previous.slice(start, end)}; return results;}`;
const { old } = await import(uri(compile(source)));
let seed = 7654321;
const rng = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let n = 0; n < 1000; n++) {
  const observations = Array.from({ length: 1 + Math.floor(rng() * 30) }, (_, i) => Object.freeze({
    id: `obs_0123456789ab_${i}`, point: `P${Math.floor(rng() * 3)}`, monitoringItem: `item${Math.floor(rng() * 2)}`,
    timestamp: ['2026-09-21', '2026-09-21T08:00:00+08:00', '2026-09-22T00:00:00Z', '2026-09-23T00:00:00Z'][Math.floor(rng() * 4)],
    value: [0, 8, 10, -10, 1e-9, 1e-9 - Number.EPSILON, Math.round(rng() * 100) / 10][Math.floor(rng() * 7)],
    ...(rng() > .5 ? { cumulative: rng() > .5 ? 0 : Math.round(rng() * 10) } : {})
  }));
  Object.freeze(observations);
  const project = { thresholds: n % 3 === 0 ? {} : { default: 10, item1: 8 } };
  if (JSON.stringify(old(project, { observations })) !== JSON.stringify(current(project, observations))) throw Error(`extraction regression at case ${n}`);
}
const boundary = (first, last) => current({ thresholds: { default: 10 } }, [
  { id: 'obs_0123456789ab_0', point: 'P', monitoringItem: 'item', timestamp: '2026-09-21', value: first },
  { id: 'obs_0123456789ab_1', point: 'P', monitoringItem: 'item', timestamp: '2026-09-22', value: last }
])[0];
if (boundary(0, 8).thresholdStatus !== 'warning' || boundary(0, 10).thresholdStatus !== 'alarm'
  || boundary(0, 10).anomaly !== false || boundary(0, 10.1).anomaly !== true
  || boundary(0, 1e-9).trend !== 'rising' || boundary(0, 1e-9 - Number.EPSILON).trend !== 'stable') throw Error('boundary changed');
const localeComparisons = ['en_US.UTF-8', 'sv_SE.UTF-8', 'en_US@numbers=latn', 'en_US@colNumeric=yes', 'en-US-u-kn-true', 'zh_CN.UTF-8'].map(locale => {
  const result = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify({resolved:new Intl.Collator().resolvedOptions(),cmp:'obs_0123456789ab_10'.localeCompare('obs_0123456789ab_2')}))"], { env: { ...process.env, LANG: locale, LC_ALL: locale }, encoding: 'utf8' });
  if (result.status !== 0) throw Error(result.stderr);
  return { environmentLocale: locale, ...JSON.parse(result.stdout) };
});
const report = {
  checkedAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  execution: { node: process.version, icu: process.versions.icu, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  exactPriorV2Comparisons: 1000, handCheckedBoundaries: 6, inputFrozen: true, extractionComparison: 'passed', localeComparisons,
  limits: ['Differential comparison against previous implementation, not an independent mathematical oracle.', 'The six direct assertions cover specific threshold/trend boundaries only.', 'No packaged application, real user data, end-to-end replay or production KPI was tested here.', 'Locale probe demonstrates imported ASCII ID grammar alone does not fix numeric collation.']
};
writeFileSync('/private/tmp/railwise-monitoring-replay-independent-review/output.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
