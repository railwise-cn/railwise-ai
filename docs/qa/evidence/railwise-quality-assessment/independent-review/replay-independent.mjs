import { cpSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Replays archived evidence against a supplied implementation without editing it.
const evidence = dirname(fileURLToPath(import.meta.url))
if (!process.argv[2]) throw new Error('Usage: node replay-independent.mjs /absolute/path/to/implementation-repository')
const repo = realpathSync(resolve(process.argv[2]))
const scratch = mkdtempSync('/private/tmp/railwise-assessment-replay-')
const copy = (from, to) => cpSync(from, to, { recursive: true })
const linkModules = (destination, roots) => {
  mkdirSync(destination, { recursive: true })
  for (const root of roots) for (const name of readdirSync(root)) {
    const target = join(destination, name)
    if (!existsSync(target)) symlinkSync(join(root, name), target)
  }
}
copy(join(repo, 'src'), join(scratch, 'src'))
copy(join(repo, 'kun/src'), join(scratch, 'kun/src'))
copy(join(repo, 'kun/assets'), join(scratch, 'kun/assets'))
for (const name of ['package.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json']) {
  if (existsSync(join(repo, name))) copyFileSync(join(repo, name), join(scratch, name))
}
for (const name of ['package.json', 'vitest.config.ts', 'tsconfig.json', 'tsconfig.build.json']) copyFileSync(join(repo, 'kun', name), join(scratch, 'kun', name))
linkModules(join(scratch, 'node_modules'), [join(repo, 'node_modules')])
linkModules(join(scratch, 'kun/node_modules'), [join(repo, 'kun/node_modules'), join(repo, 'node_modules')])
const locate = (flat, original) => existsSync(join(evidence, flat)) ? join(evidence, flat) : join(evidence, original)
copyFileSync(locate('assessment-independent.test.ts', 'src/engineering/assessment-independent.test.ts'), join(scratch, 'kun/src/engineering/assessment-independent.test.ts'))
copyFileSync(locate('assessment-independent-routes.test.ts', 'src/server/routes/assessment-independent.test.ts'), join(scratch, 'kun/src/server/routes/assessment-independent.test.ts'))
copyFileSync(locate('AssessmentIndependent.dom.test.ts', 'ui/src/renderer/src/components/engineering/AssessmentIndependent.dom.test.ts'), join(scratch, 'src/renderer/src/components/engineering/AssessmentIndependent.dom.test.ts'))
const run = (args, cwd) => {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Replay failed: npm ${args.join(' ')}; scratch retained at ${scratch}`)
}
console.log(`Independent replay directory: ${scratch}`)
run(['test', '--', '--run', 'src/engineering/assessment-independent.test.ts', 'src/server/routes/assessment-independent.test.ts', '--reporter=json', `--outputFile=${scratch}/independent-runtime.json`], join(scratch, 'kun'))
run(['test', '--', '--run', 'src/renderer/src/components/engineering/AssessmentIndependent.dom.test.ts', '--reporter=json', `--outputFile=${scratch}/independent-ui.json`], scratch)
run(['run', 'build'], join(scratch, 'kun'))
const smoke = readFileSync(join(evidence, 'compiled-smoke.mjs'), 'utf8').replaceAll('/private/tmp/railwise-assessment-independent-review/compiled-smoke.json', `${scratch}/compiled-smoke.json`)
writeFileSync(join(scratch, 'kun/compiled-smoke.mjs'), smoke)
const result = spawnSync(process.execPath, ['compiled-smoke.mjs'], { cwd: join(scratch, 'kun'), stdio: 'inherit' })
if (result.status !== 0) throw new Error(`Compiled replay failed; scratch retained at ${scratch}`)
console.log(`All independent checks passed. Evidence retained at ${scratch}`)
