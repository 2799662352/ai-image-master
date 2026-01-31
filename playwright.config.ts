import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  retries: 2,
  workers: 1, // Electron 测试需要串行执行
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],
  
  // 全局快照配置
  snapshotDir: './e2e/screenshots',
  snapshotPathTemplate: '{snapshotDir}/{testFilePath}/{arg}{ext}',
  
  // 预期截图目录
  expect: {
    toHaveScreenshot: {
      // 允许 0.5% 的像素差异（用于跨平台兼容）
      maxDiffPixelRatio: 0.005,
      // 允许最多 100 个不同像素
      maxDiffPixels: 100,
      // 截图阈值
      threshold: 0.2,
      // 动画稳定后截图
      animations: 'disabled',
      // 使用 CSS 缩放截图
      scale: 'css'
    },
    toMatchSnapshot: {
      // 快照比较阈值
      maxDiffPixelRatio: 0.005
    }
  },
  
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    // 视觉测试时禁用动画
    launchOptions: {
      slowMo: 0
    }
  },
  
  projects: [
    {
      name: 'electron',
      testMatch: '**/*.e2e.ts',
      testIgnore: '**/*.visual.e2e.ts'
    },
    {
      name: 'visual',
      testMatch: '**/*.visual.e2e.ts',
      // 视觉测试特殊配置
      use: {
        screenshot: 'on',
        video: 'off',
        trace: 'off'
      },
      // 视觉测试不重试
      retries: 0
    }
  ]
})
