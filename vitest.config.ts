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
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
})
