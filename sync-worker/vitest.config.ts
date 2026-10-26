import { defineConfig } from 'vitest/config'

export default defineConfig({
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '../src/**/*.test.ts'],
    server: {
      deps: {
        external: ['node:sqlite', '@tauri-apps/plugin-sql'],
      },
    },
  },
})
