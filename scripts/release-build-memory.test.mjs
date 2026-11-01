import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'

test('renderer packaging gets a working heap limit only in its build steps', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const expected = new Map([
    ['build-macos', ['Build signed macOS packages', 'Build unsigned macOS packages']],
    ['build-windows', ['Build Windows installer']]
  ])
  const nodeOptions = '--max-old-space-size=6144'
  assert.equal(workflow.env?.NODE_OPTIONS, undefined, 'build memory must not become a workflow-wide override')
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.env?.NODE_OPTIONS, undefined, `${jobName} must not export build memory to unrelated steps`)
    const buildSteps = expected.get(jobName) ?? []
    for (const name of buildSteps) assert.ok(job.steps.some(step => step.name === name), `missing build step: ${name}`)
    for (const step of job.steps ?? []) {
      assert.equal(step.env?.NODE_OPTIONS, buildSteps.includes(step.name) ? nodeOptions : undefined,
        `${jobName}/${step.name} must keep the memory limit scoped to renderer compilation`)
    }
  }
  // Exercise the exact YAML value with Node instead of accepting a misspelled
  // option that would leave Rollup at the default heap or stop the build.
  const actualLimit = Number(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import v8 from 'node:v8'; process.stdout.write(String(v8.getHeapStatistics().heap_size_limit))"], {
    encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodeOptions }
  }))
  assert.ok(actualLimit >= 6144 * 1024 * 1024 && actualLimit < 6250 * 1024 * 1024,
    `the packaging process received an unexpected heap limit: ${actualLimit}`)
})
