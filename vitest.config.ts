import { resolve } from 'path'
import { realpathSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Isolated worktrees may share the locked dependency tree through a symlink.
  server: { fs: { allow: [resolve('.'), realpathSync(resolve('node_modules'))] } },
  resolve: {
    dedupe: ['zod'],
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/renderer/src/components/write/WriteWorkspaceStart.test.tsx']
  }
})
