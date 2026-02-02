import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.{test,spec}.{js,ts}'],
    exclude: ['node_modules', 'dist', 'build', '**/*.bench.ts'],
    // 自动清理 mocks，确保测试隔离
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    // 测试超时设置
    testTimeout: 10000,
    hookTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary', 'lcov'],
      reportsDirectory: './coverage',
      include: [
        'src/renderer/src/**/*.ts',
        'src/main/**/*.ts',
        'src/preload/**/*.ts'
      ],
      exclude: [
        'node_modules/',
        'dist/',
        'build/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/types/**',
        '**/index.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/__mocks__/**'
      ],
      thresholds: {
        // 当前基线 (将自动提升)
        lines: 51,
        functions: 52,
        branches: 39,
        statements: 49,
        // 启用自动更新 - 当覆盖率提升时自动提高基线
        autoUpdate: (newThreshold: number) => Math.floor(newThreshold),
        perFile: false
      }
    },
    setupFiles: ['./tests/setup.ts']
  },
  resolve: {
    alias: [
      // More specific aliases must come first
      { find: '@/services', replacement: resolve(__dirname, './src/renderer/src/services') },
      { find: '@/features', replacement: resolve(__dirname, './src/renderer/src/features') },
      { find: '@/core', replacement: resolve(__dirname, './src/renderer/src/core') },
      { find: '@/utils', replacement: resolve(__dirname, './src/renderer/src/utils') },
      { find: '@/types', replacement: resolve(__dirname, './src/types') },
      { find: '@renderer', replacement: resolve(__dirname, './src/renderer/src') },
      { find: '@main', replacement: resolve(__dirname, './src/main') },
      { find: '@preload', replacement: resolve(__dirname, './src/preload') },
      // Most general alias last
      { find: '@', replacement: resolve(__dirname, './src') }
    ]
  }
})

// Vitest bench 配置 (V15) - 通过 CLI 参数指定
// 运行命令: npm run test:bench