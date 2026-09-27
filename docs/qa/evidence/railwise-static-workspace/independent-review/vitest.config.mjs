import { fileURLToPath } from 'node:url'
const evidence = fileURLToPath(new URL('.', import.meta.url))
const repo = process.env.REVIEW_REPO
if (!repo) throw new Error('Set REVIEW_REPO to an absolute checkout path')
export default { root: evidence, resolve:{alias:{'#repo':repo,'@shared':`${repo}/src/shared`,'@renderer':`${repo}/src/renderer/src`}}, esbuild:{jsx:'automatic'},test:{environment:'node',globals:false,include:['*.test.ts'],fileParallelism:false,maxWorkers:1,testTimeout:120000}}
