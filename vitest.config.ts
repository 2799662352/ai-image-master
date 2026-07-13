import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@/': resolve(__dirname, 'src/renderer/src') + '/',
      '@': resolve(__dirname, 'src/renderer/src'),
      '@core': resolve(__dirname, 'src/renderer/src/core'),
      '@services': resolve(__dirname, 'src/renderer/src/services'),
      '@features': resolve(__dirname, 'src/renderer/src/features'),
      '@pages': resolve(__dirname, 'src/renderer/src/pages'),
      '@utils': resolve(__dirname, 'src/renderer/src/utils'),
      '@types': resolve(__dirname, 'src/types'),
      '@react': resolve(__dirname, 'src/renderer/src/react-app'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    // Keep CI deterministic on 4-core hosted runners. Unbounded file workers
    // make PGlite, websocket, and dynamic-import suites starve each other.
    maxWorkers: 4,
    testTimeout: 30000,
    hookTimeout: 30000,
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      // Linux V8 instrumentation includes more platform-conditional branches
      // than Windows. These floors match the lower cross-platform baseline
      // while still blocking future coverage regressions in required CI.
      thresholds: {
        lines: 42,
        functions: 42,
        branches: 39,
        statements: 41,
      },
    },
    setupFiles: ['./vitest.setup.ts'],
  },
})
