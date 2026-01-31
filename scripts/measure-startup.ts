#!/usr/bin/env npx tsx
/**
 * 启动时间基准测试脚本
 * 
 * 功能:
 * - 测量 Electron 应用的启动时间
 * - 输出关键性能指标
 * - 可用于 CI/CD 性能回归检测
 * 
 * 使用方法:
 * npx tsx scripts/measure-startup.ts
 * 
 * 目标指标:
 * - app.whenReady() -> window.show(): < 1.5s
 */

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

interface StartupMetrics {
  appReadyTime: number | null
  pathsInitTime: number | null
  windowCreatedTime: number | null
  readyToShowTime: number | null
  pageLoadedTime: number | null
  totalStartupTime: number | null
}

async function measureStartup(): Promise<StartupMetrics> {
  return new Promise((resolve) => {
    const metrics: StartupMetrics = {
      appReadyTime: null,
      pathsInitTime: null,
      windowCreatedTime: null,
      readyToShowTime: null,
      pageLoadedTime: null,
      totalStartupTime: null
    }

    const projectRoot = path.resolve(__dirname, '..')
    const mainScript = path.join(projectRoot, 'dist', 'main', 'index.js')

    // Check if built
    if (!fs.existsSync(mainScript)) {
      console.error('❌ 请先运行 npm run build:vite 构建应用')
      process.exit(1)
    }

    // Spawn Electron process
    const electronPath = require('electron') as string
    const child = spawn(electronPath, [mainScript], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['inherit', 'pipe', 'pipe']
    })

    let startTime = Date.now()
    let output = ''

    const parseMetric = (line: string, pattern: RegExp): number | null => {
      const match = line.match(pattern)
      return match ? parseInt(match[1], 10) : null
    }

    const processLine = (line: string) => {
      // Parse performance markers from main process
      if (line.includes('[Performance] App ready:')) {
        metrics.appReadyTime = parseMetric(line, /App ready: (\d+)ms/)
      }
      if (line.includes('[Performance] Paths initialized:')) {
        metrics.pathsInitTime = parseMetric(line, /Paths initialized: (\d+)ms/)
      }
      if (line.includes('[Performance] Window created:')) {
        metrics.windowCreatedTime = parseMetric(line, /Window created: (\d+)ms/)
      }
      if (line.includes('[Performance] Ready to show:')) {
        metrics.readyToShowTime = parseMetric(line, /Ready to show: (\d+)ms/)
      }
      if (line.includes('[Performance] Page loaded:')) {
        metrics.pageLoadedTime = parseMetric(line, /Page loaded: (\d+)ms/)
        metrics.totalStartupTime = Date.now() - startTime

        // Kill the process after getting all metrics
        setTimeout(() => {
          child.kill('SIGTERM')
        }, 500)
      }
    }

    child.stdout?.on('data', (data) => {
      const text = data.toString()
      output += text
      text.split('\n').forEach(processLine)
    })

    child.stderr?.on('data', (data) => {
      const text = data.toString()
      output += text
      text.split('\n').forEach(processLine)
    })

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      console.error('❌ 启动超时 (30秒)')
      child.kill('SIGTERM')
      resolve(metrics)
    }, 30000)

    child.on('close', () => {
      clearTimeout(timeout)
      resolve(metrics)
    })
  })
}

function formatMetrics(metrics: StartupMetrics): void {
  console.log('\n📊 启动时间基准测试结果\n')
  console.log('=' .repeat(50))
  
  const formatTime = (ms: number | null, target?: number): string => {
    if (ms === null) return '❓ 未测量'
    const status = target && ms <= target ? '✅' : target && ms > target ? '⚠️' : '📌'
    return `${status} ${ms}ms${target ? ` (目标: <${target}ms)` : ''}`
  }

  console.log(`App Ready:        ${formatTime(metrics.appReadyTime, 500)}`)
  console.log(`Paths Init:       ${formatTime(metrics.pathsInitTime)}`)
  console.log(`Window Created:   ${formatTime(metrics.windowCreatedTime)}`)
  console.log(`Ready to Show:    ${formatTime(metrics.readyToShowTime, 1500)}`)
  console.log(`Page Loaded:      ${formatTime(metrics.pageLoadedTime, 2000)}`)
  console.log('=' .repeat(50))
  console.log(`总启动时间:       ${formatTime(metrics.totalStartupTime, 3000)}`)
  console.log('')

  // Summary
  const readyToShow = metrics.readyToShowTime
  if (readyToShow !== null) {
    if (readyToShow <= 1500) {
      console.log('🎉 启动性能优秀! 达到目标 (<1.5s)')
    } else if (readyToShow <= 2500) {
      console.log('👍 启动性能良好，可进一步优化')
    } else {
      console.log('⚠️ 启动性能需要优化')
    }
  }
}

async function main() {
  console.log('🚀 开始测量 Electron 应用启动时间...\n')
  
  const metrics = await measureStartup()
  formatMetrics(metrics)

  // Return non-zero exit code if startup is too slow
  if (metrics.readyToShowTime && metrics.readyToShowTime > 3000) {
    process.exit(1)
  }
}

main().catch(console.error)
