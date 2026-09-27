import { fileURLToPath } from 'node:url'

export default {
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: {
    environment: 'node', globals: false, fileParallelism: false, maxWorkers: 1,
    include: ['docs/qa/evidence/railwise-sampling-integration/create-service-fixture.test.ts']
  }
}
