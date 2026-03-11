/**
 * Bridge for loading `deepagents` in Electron renderer via native require().
 *
 * `deepagents` depends on Node.js built-ins (fs, path, os, fast-glob) that
 * cannot be polyfilled in a browser context. Since Electron's renderer has
 * nodeIntegration: true, we load it through require() instead of ESM import.
 */

let _createDeepAgent: any = null
let _MemorySaver: any = null
let _loadError: Error | null = null

try {
  const nodeRequire = (globalThis as any).require || (window as any).require
  if (nodeRequire) {
    const mod = nodeRequire('deepagents')
    _createDeepAgent = mod.createDeepAgent
    try {
      const lgMod = nodeRequire('@langchain/langgraph')
      _MemorySaver = lgMod.MemorySaver
    } catch {
      // fallback: deepagents may bundle it
    }
  } else {
    _loadError = new Error('Electron require() not available — deepagents needs Node.js runtime')
  }
} catch (e: any) {
  _loadError = e
}

export function getCreateDeepAgent(): typeof import('deepagents').createDeepAgent {
  if (_loadError) throw _loadError
  if (!_createDeepAgent) throw new Error('deepagents not loaded')
  return _createDeepAgent
}

export function getMemorySaver(): any {
  if (_MemorySaver) return _MemorySaver
  return null
}
