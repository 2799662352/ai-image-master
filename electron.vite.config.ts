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
      // Keep `dist/main/pgliteWorker.js` (built by scripts/build-pglite-worker.mjs)
      // intact across electron-vite (re)builds. electron-vite defaults to
      // emptying the output dir, which would wipe the worker bundle the
      // `dev` script pre-builds → utilityProcess.fork sees ENOENT → first
      // launch crashes with "PGlite worker exited (code 1)". The main entry
      // only ever produces `index.js` (no chunks/), so disabling auto-empty
      // doesn't leave stale artifacts.
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
          // NOTE: `pgliteWorker.ts` is intentionally NOT bundled here. As a
          // sibling entry it ends up linked to index.js via a shared chunk
          // (`require('./index.js')` at the top), which would re-execute the
          // entire main process inside the utilityProcess. Instead the
          // worker is built as a fully standalone CJS file by
          // `scripts/build-pglite-worker.mjs`, hooked into the `build`
          // script in package.json.
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        },
        external: [
          'electron',
          /^electron\/.+/,
          'cos-nodejs-sdk-v5',
          'tencentcloud-sdk-nodejs-mps',
          // PGlite ships native asset siblings to its bundled JS:
          //   - dist/pglite.data  (~5 MB Postgres data dir tarball)
          //   - dist/pglite.wasm  (Postgres compiled to wasm)
          //   - dist/initdb.wasm  (initdb bootstrap)
          //   - dist/{nodefs,opfs-ahp}.js  (filesystem backends)
          // The library locates these via `new URL('./pglite.data', import.meta.url)`
          // which resolves relative to the JS file at runtime. When rolldown
          // inlines PGlite into our `dist/main/chunks/chunk-…js`, the relative
          // lookup goes to `dist/main/pglite.data` — which we never copied
          // there, so PGlite.create() throws ENOENT and AgentRuntime.init()
          // never registers the `agent:send-message` IPC handler. Keeping
          // these packages as runtime `require()`s sidesteps the asset-copy
          // problem entirely: at runtime they resolve back into
          // `node_modules/@electric-sql/pglite/dist/`, where the binaries
          // already live.
          '@electric-sql/pglite',
          '@electric-sql/pglite-socket',
          // @parcel/watcher is a native C++ addon (prebuilt .node binaries
          // shipped per-platform via optionalDependencies — same engine
          // VSCode uses for its file watcher). Bundling it through rolldown
          // would strip the binary lookup; keep it as a runtime require so
          // resolution lands in node_modules/@parcel/watcher-<platform>-<arch>/
          // where electron-builder unpacks it from asar.
          '@parcel/watcher',
          /^@parcel\/watcher-/,
          // sharp is a native libvips addon used by the main-process media:thumb
          // hot path (src/main/file-explorer/mediaThumbIpc.ts). Its platform
          // binary lives in @img/sharp-<platform>-<arch>/lib/*.node and is loaded
          // via a runtime require() that rolldown cannot bundle. Keep sharp +
          // every @img/sharp-* subpackage external so resolution lands in
          // node_modules at runtime, where electron-builder unpacks the .node
          // from asar (asarUnpack rule). Bundling it caused the v4.3.20 startup
          // crash: "Could not load the sharp module using the win32-x64 runtime".
          'sharp',
          /^@img\/sharp-/,
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
          index: resolve(__dirname, 'src/renderer/index.html')
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
              if (id.includes('choices.js')) {
                return 'vendor-choices'
              }
              if (id.includes('jszip')) {
                return 'vendor-jszip'
              }
              if (id.includes('monaco-editor')) {
                return 'vendor-monaco'
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
            if (id.includes('src/renderer/src/pages/AudioPage') || id.includes('src/renderer/src/features/audio/')) {
              return 'page-audio'
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
      // 生产环境只删 debugger + 噪音日志(log/info/debug/trace)，
      // 但【保留 console.error / console.warn】——否则打包后 F12 完全看不到报错，
      // 用户无法诊断「图片报错但不显示细节」。pure 让 minifier 把无副作用的
      // 噪音日志 tree-shake 掉，error/warn 不在 pure 列表故得以保留。
      esbuild: {
        drop: isProd ? ['debugger'] : [],
        pure: isProd ? ['console.log', 'console.info', 'console.debug', 'console.trace'] : [],
        legalComments: 'none'
      }
    },
    // 开发服务器优化
    server: {
      // 预热关键模块以加速 HMR (路径相对于 renderer root: src/renderer)
      warmup: {
        clientFiles: [
          './src/main.ts',
          './src/services/ServiceBridge.ts',
          './src/core/AppBootstrap.ts'
        ]
      }
    },
    // 依赖优化
    optimizeDeps: {
      include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand', 'react-select', 'monaco-editor'],
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
