import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../', import.meta.url))
export default {
  root,
  resolve: { alias: { '@shared': `${root}src/shared`, '@renderer': `${root}src/renderer/src` } },
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', globals: false, include: ['docs/qa/evidence/railwise-advanced-workspace-review/*.test.ts'], fileParallelism: false, maxWorkers: 1 }
}
