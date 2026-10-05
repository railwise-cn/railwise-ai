import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@kun': resolve('src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false,
    // Survey delivery and adjustment tests generate XLSX/PDF artifacts and
    // exercise the SQLite-backed runtime.  On the shared CI runner these
    // legitimate integration tests can exceed Vitest's 5 s default while the
    // suite is loading modules in parallel.  Keep the timeout bounded, but
    // allow the complete workflow to finish before treating it as hung.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
