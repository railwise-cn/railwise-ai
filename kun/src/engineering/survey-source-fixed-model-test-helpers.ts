import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

export async function sourceFixedFixture(absolute = true, options: { mm?: boolean; missingHeight?: boolean; mixedSigma?: boolean; correlation?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'survey-source-model-'))
  const project = { id: 'source-project', revision: 1, workspace: join(root, 'workspace') }
  const service = new SurveyService({ rootDir: root, getProject: id => id === project.id ? project : null })
  const network = await importWorkwiseSurveyNetwork(service, {
    projectId: project.id, expectedRevision: 0, idempotencyKey: 'source-model-import', networkType: 'leveling',
    network: { networkType: 'leveling', knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, ...(options.missingHeight ? {} : { height: 10.1 }) }],
      observations: [.100, .101, .099].map((value, i) => ({ id: `dh${i}`, type: 'height-difference', from: 'BM', to: 'P', value: value * (options.mm ? 1000 : 1), unit: options.mm ? 'mm' : 'm',
        ...(absolute ? options.mixedSigma && i === 0 ? {} : { sigma: options.mm ? 2 : .002, sigmaUnit: options.mm ? 'mm' : 'm' } : { routeLength: 1 }),
        ...(options.correlation ? { covariance: [4e-6] } : {}) })), instrumentParameters: {} }
  })
  const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'source-model-check' })!
  const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'source-model-adjust' })
  return { service, project, network: checked, adjustment, root }
}
