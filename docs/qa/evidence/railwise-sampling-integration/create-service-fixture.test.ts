import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { EngineeringService } from '../../../../kun/src/engineering/engineering-service.js'
import { SurveySamplingWorkspaceService } from '../../../../kun/src/engineering/survey-sampling-workspace.js'

/** Opt-in fixture generator, run only with fixture.vitest.config.mts.
 * Every invocation creates a new directory; existing paths are never opened.
 * Generated files intentionally remain available for the independent auditor. */
it('creates closed real-service synthetic databases for an independent read-only audit', async () => {
  const requested = process.env.RAILWISE_SAMPLING_FIXTURE_DIR
  let root: string
  if (requested !== undefined) {
    if (!isAbsolute(requested)) throw new Error('RAILWISE_SAMPLING_FIXTURE_DIR must be an absolute new path')
    await mkdir(requested, { recursive: false, mode: 0o700 })
    root = requested
  } else root = await mkdtemp(join(tmpdir(), 'railwise-sampling-service-rebuild-'))
  const runtime = join(root, 'runtime')
  const workspace = join(root, 'workspace')
  const engineering = new EngineeringService({ rootDir: runtime })
  let sampling: SurveySamplingWorkspaceService | undefined
  try {
    sampling = new SurveySamplingWorkspaceService({ rootDir: runtime, getProject: id => engineering.getProject(id) })
    const project = engineering.createProject({ name: 'Independent synthetic audit fixture', workspace, expectedRevision: 0, idempotencyKey: 'independent-project' })
    const population = sampling.createPopulation(project.id, {
      idempotencyKey: 'independent-population', expectedProjectRevision: project.revision,
      productType: '工程测量', unitProductType: '单位成果',
      definitionStatement: '真实服务生成的独立审计测试材料，非实际项目验收。\n',
      orderedUnitProductIds: Array.from({ length: 1001 }, (_, index) => `Unit-${index + 1}`)
    })
    const census = sampling.createRun(project.id, { populationId: population.id, idempotencyKey: 'independent-census-run', stage: 'process', inspectionMode: 'census' })
    const random = sampling.createRun(project.id, { populationId: population.id, idempotencyKey: 'independent-random-run', stage: 'final-field', inspectionMode: 'table-1-simple-random' })
    expect(census.sampleSize).toBe(1001)
    expect(random.sampleSize).toBe(80)
    expect(random.batches.map(batch => batch.batchSize)).toEqual([501, 500])
    await engineering.flush()
    const repo = fileURLToPath(new URL('../../../../', import.meta.url))
    const manifest = {
      schemaVersion: 1, provenance: 'real-source-services-with-synthetic-inputs-not-packaged-gui',
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      createdAt: new Date().toISOString(), nodeVersion: process.version,
      root, runtimeDirectory: runtime, workspaceDirectory: workspace,
      projectId: project.id, populationId: population.id, unitCount: population.unitCount,
      runs: [census, random].map(run => ({ id: run.id, stage: run.stage, inspectionMode: run.inspectionMode, sampleSize: run.sampleSize, planHash: run.planHash })),
      trust: 'Synthetic service fixture only; no independent seed witness, field measurements, professional review or packaged UI acceptance.'
    }
    await writeFile(join(root, 'fixture.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    process.stdout.write(`Sampling fixture manifest: ${join(root, 'fixture.json')}\nSampling audit --root: ${runtime}\n`)
  } finally {
    sampling?.close()
    engineering.close()
  }
})
