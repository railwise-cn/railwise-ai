import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const ooxmlCoreDist = resolve('node_modules/pptx-vanilla-viewer/node_modules/ooxml-core/dist')
const ooxmlCoreResolver = {
  name: 'resolve-ooxml-core-esm',
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (!source.startsWith('ooxml-core/')) return null
    const subpath = source.slice('ooxml-core/'.length)
    // Upstream uses both extensionless subpaths and explicit ESM filenames.
    // Never append a second extension to e.g. automation/schemas.mjs.
    const modulePath = subpath.endsWith('.mjs') ? subpath.slice(0, -4) : subpath
    const direct = join(ooxmlCoreDist, `${modulePath}.mjs`)
    if (existsSync(direct)) return direct
    const index = join(ooxmlCoreDist, modulePath, 'index.mjs')
    return existsSync(index) ? index : null
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'claw-schedule-mcp-node-entry': resolve('src/main/claw-schedule-mcp-node-entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      // Shared contract sources also live under kun/, whose separately locked
      // runtime has its own Zod. A renderer schema tree must use one instance.
      dedupe: ['zod'],
      // The upstream UI package publishes ESM imports for ooxml-core's
      // editor modules, while npm can place a CJS-only copy under ooxml-ui.
      // Resolve the audited viewer copy explicitly for both package indexes
      // and deep editor modules so production Rollup builds stay deterministic.
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [ooxmlCoreResolver, react()]
  }
})
