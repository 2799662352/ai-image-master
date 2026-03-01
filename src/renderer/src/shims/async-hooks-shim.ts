/**
 * Shim for node:async_hooks in Electron renderer.
 * Tries Electron's require() first, falls back to no-op polyfill.
 */

let _AsyncLocalStorage: any

try {
  const nodeRequire = (globalThis as any).require || (window as any).require
  if (nodeRequire) {
    const mod = nodeRequire('async_hooks')
    _AsyncLocalStorage = mod.AsyncLocalStorage
  }
} catch {
  // Electron require not available or async_hooks not accessible
}

if (!_AsyncLocalStorage) {
  _AsyncLocalStorage = class AsyncLocalStorage {
    private _store: any = undefined
    getStore() { return this._store }
    run(store: any, callback: (...args: any[]) => any, ...args: any[]) {
      const prev = this._store
      this._store = store
      try { return callback(...args) }
      finally { this._store = prev }
    }
    enterWith(store: any) { this._store = store }
    disable() { this._store = undefined }
  }
}

export const AsyncLocalStorage = _AsyncLocalStorage
