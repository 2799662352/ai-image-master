import { defineConfig } from 'electron-vite'
import { resolve } from 'path'
import { builtinModules } from 'module'
import react from '@vitejs/plugin-react'
// import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Bundle 分析器 (仅在 analyze 模式下启用)
// 使用 npm run analyze 命令时，会生成 dist/stats.html 报告
const isAnalyze = process.env.npm_lifecycle_event === 'analyze' || process.argv.includes('--mode=analyze')
const isProd = process.env.NODE_ENV === 'production'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      target: 'node18',
      minify: isProd,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        },
        external: [
          'electron',
          /^electron\/.+/,
          ...builtinModules.flatMap(m => [m, `node:${m}`])
        ]
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      target: 'node18',
      minify: isProd,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        },
        external: [
          'electron',
          /^electron\/.+/,
          ...builtinModules.flatMap(m => [m, `node:${m}`])
        ]
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      // 目标为 Electron 的 Chromium 版本，启用现代 JS 特性
      target: 'chrome120',
      // CSS 代码分割
      cssCodeSplit: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index-react.html')
        },
        external: ['deepagents'],
        output: {
          // 代码分割配置
          manualChunks: (id: string) => {
            // 第三方库打包到 vendor chunk
            if (id.includes('node_modules')) {
              if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) {
                return 'vendor-react'
              }
              if (id.includes('zustand')) {
                return 'vendor-zustand'
              }
              if (id.includes('jszip')) {
                return 'vendor-jszip'
              }
              // 其他 node_modules
              return 'vendor'
            }
            
            // React Director app
            if (id.includes('src/renderer/src/react-app')) {
              return 'react-director'
            }
            
            // V18: 合并 core, services, feature-history, HistoryPage 到同一 chunk
            // Director 页面已迁移到 React (react-app/), 由 react-director chunk 处理
            if (id.includes('src/renderer/src/core') ||
                id.includes('src/renderer/src/services') ||
                id.includes('src/renderer/src/features/history') ||
                id.includes('src/renderer/src/pages/HistoryPage')) {
              return 'core-services'
            }
            if (id.includes('src/renderer/src/features/model-selector')) {
              return 'feature-model-selector'
            }
            if (id.includes('src/renderer/src/features/image-viewer')) {
              return 'feature-image-viewer'
            }
            if (id.includes('src/renderer/src/features/settings')) {
              return 'feature-settings'
            }
            if (id.includes('src/renderer/src/features/dialog')) {
              return 'feature-dialog'
            }
            if (id.includes('src/renderer/src/features/error-handler')) {
              return 'feature-error-handler'
            }
            if (id.includes('src/renderer/src/features/mobile-menu')) {
              return 'feature-mobile-menu'
            }
            if (id.includes('src/renderer/src/features/tab-manager')) {
              return 'feature-tab-manager'
            }
            if (id.includes('src/renderer/src/features/keyboard')) {
              return 'feature-keyboard'
            }
            if (id.includes('src/renderer/src/features/intelligent-resize')) {
              return 'feature-intelligent-resize'
            }
            if (id.includes('src/renderer/src/features/ui-state')) {
              return 'feature-ui-state'
            }
            if (id.includes('src/renderer/src/features/toast')) {
              return 'feature-toast'
            }
            if (id.includes('src/renderer/src/features/language')) {
              return 'feature-language'
            }
            // 页面模块 - 按页面拆分
            // 注意: HistoryPage 已合并到 core-services (见上方), Director 由 react-director chunk 处理
            if (id.includes('src/renderer/src/pages/GeneratePage')) {
              return 'page-generate'
            }
            if (id.includes('src/renderer/src/pages/BatchPage')) {
              return 'page-batch'
            }
            if (id.includes('src/renderer/src/pages/ComparePage')) {
              return 'page-compare'
            }
            if (id.includes('src/renderer/src/pages/PromptTemplates')) {
              return 'page-prompt-templates'
            }
            if (id.includes('src/renderer/src/pages/UnderstandPage')) {
              return 'page-understand'
            }
            if (id.includes('src/renderer/src/pages/BasePage')) {
              return 'page-base'
            }
            // V17: 移除 'pages' 通用 chunk，避免生成空 chunk
            // 所有页面已通过具体路径匹配处理
            
            // 工具模块
            if (id.includes('src/renderer/src/utils')) {
              return 'utils'
            }
            
            return undefined
          },
          // 优化 chunk 文件名
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      },
      // 优化构建 - Vite 7 默认使用 Oxc minifier (比 Terser 快 30-90x)
      minify: true,
      // 设置 chunk 大小警告阈值
      chunkSizeWarningLimit: 500,
      // 生成 sourcemap: 仅在分析模式下启用，生产构建不生成
      sourcemap: isAnalyze ? true : false,
      // 构建报告: 生产模式跳过压缩大小计算以加速构建
      reportCompressedSize: !isProd,
      // 生产环境移除 console.log 和 debugger (通过 esbuild transform)
      esbuild: {
        drop: isProd ? ['console', 'debugger'] : [],
        legalComments: 'none'
      }
    },
    // 开发服务器优化
    server: {
      // 预热关键模块以加速 HMR (路径相对于 renderer root: src/renderer)
      warmup: {
        clientFiles: [
          './src/main.tsx',
          './src/services/ServiceBridge.ts',
          './src/App.tsx',
          './src/stores/index.ts',
          './src/pages-react/index.ts'
        ]
      }
    },
    // 依赖优化
    optimizeDeps: {
      include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select'],
      exclude: [],
      esbuildOptions: {
        plugins: [{
          name: 'electron-node-builtins',
          setup(build: any) {
            const builtins = /^(fs|fs\/promises|path|os|child_process|crypto|stream|util|events|net|http|https|zlib|url|buffer|tls|assert|querystring)$/
            build.onResolve({ filter: builtins }, (args: any) => ({
              path: args.path, namespace: 'electron-require',
            }))
            build.onLoad({ filter: /.*/, namespace: 'electron-require' }, (args: any) => ({
              contents: `module.exports = require('${args.path}')`,
              loader: 'js',
            }))
          },
        }],
      },
    },
    // 解析别名
    resolve: {
      alias: {
        'node:async_hooks': resolve(__dirname, 'src/renderer/src/shims/async-hooks-shim.ts'),
        'langfuse-langchain': resolve(__dirname, 'src/renderer/src/shims/langfuse-noop.ts'),
        '@': resolve(__dirname, 'src/renderer/src'),
        '@core': resolve(__dirname, 'src/renderer/src/core'),
        '@services': resolve(__dirname, 'src/renderer/src/services'),
        '@features': resolve(__dirname, 'src/renderer/src/features'),
        '@pages': resolve(__dirname, 'src/renderer/src/pages'),
        '@utils': resolve(__dirname, 'src/renderer/src/utils'),
        '@types': resolve(__dirname, 'src/types'),
        '@react': resolve(__dirname, 'src/renderer/src/react-app'),
        '@skills': resolve(__dirname, 'skills'),
        '@config': resolve(__dirname, 'config')
      }
    },
    assetsInclude: ['**/*.md']
  }
})
