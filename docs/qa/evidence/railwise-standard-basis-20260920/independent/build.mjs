import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(process.argv[2] ?? '.')
const out = dirname(fileURLToPath(import.meta.url))
const { build } = createRequire(resolve(root, 'package.json'))('esbuild')
const entries = [
  'kun/src/engineering/survey-standard-basis.ts', 'kun/src/contracts/survey-standard-basis.ts',
  'kun/src/engineering/survey-quality-scoring.ts', 'kun/src/engineering/survey-quality-sampling.ts',
  'kun/src/server/routes/survey-standard-basis.ts', 'kun/src/server/router.ts',
  'src/main/ipc/app-ipc-schemas.ts', 'src/renderer/src/agent/survey-standard-basis-client.ts',
  'src/renderer/src/components/engineering/survey-quality-scoring-examples.ts', 'src/shared/survey-standard-basis.ts'
]
const source = files => files.map(file => `export * from ${JSON.stringify(resolve(root,file))}`).join('\n')
const options = {bundle:true,platform:'node',format:'esm',target:'node22',alias:{'@shared':resolve(root,'src/shared')},logLevel:'info'}
await build({...options,stdin:{contents:source(entries),resolveDir:root,loader:'ts'},outfile:resolve(out,'compiled.mjs')})
await build({...options,stdin:{contents:source(['src/renderer/src/components/engineering/SurveyStandardBasis.tsx']),resolveDir:root,loader:'ts'},
  outfile:resolve(out,'compiled-dom.mjs'),jsx:'automatic',external:['react','react-dom','react-i18next','lucide-react']})
