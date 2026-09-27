// Run after npm --prefix kun run build. Uses real SQLite and the compiled service;
// this prepares the independent oracle and is not packaged UI acceptance.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const checkout = resolve(process.argv[2] || '.')
const evidence = dirname(fileURLToPath(import.meta.url))
const { SurveyAdvancedTrialsWorkspaceService } = await import(pathToFileURL(join(checkout, 'kun/dist/engineering/survey-advanced-trials-workspace.js')).href)
const root = await mkdtemp(join(tmpdir(), 'railwise-acceptance-smoke-'))
const project = { id: 'acceptance-smoke', revision: 1, workspace: root }
const service = new SurveyAdvancedTrialsWorkspaceService({ rootDir: root, getProject: id => id === project.id ? project : null })
try {
  for (const name of ['sample-declaration', 'stale-base-declaration', 'maximum-declaration']) {
    const declarationJson = await readFile(join(evidence, '../railwise-static-workspace', `${name}.json`), 'utf8')
    const request = { kind: 'static-incremental', acknowledged: true,
      expectedProjectRevision: 1, idempotencyKey: name, declarationJson,
      modelBasisStatement: '合成算例：验证独立验收脚本，不代表打包 GUI 或专业签认。' }
    const summary = service.createTrial(project.id, Buffer.from(JSON.stringify(request)))
    service.getTrial(project.id, summary.id)
  }
} finally { service.close() }
const oracle = JSON.parse(execFileSync(process.env.REVIEW_PYTHON || 'python3', [join(evidence, 'inspect-packaged-trials.py'),
  join(root, 'survey-advanced-trials.sqlite3'), '--project', project.id], { encoding: 'utf8' }))
console.log(JSON.stringify({ ...oracle, evidenceKind: 'development-service-smoke-not-packaged-gui', databaseDirectory: root }, null, 2))
