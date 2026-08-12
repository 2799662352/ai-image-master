// vitest.setup.ts

// jsdom does not implement the legacy editing APIs. Some clipboard/paste helpers
// in the renderer call `document.queryCommandSupported(...)` at module-load time
// to feature-detect `execCommand('paste')`, which throws "is not a function"
// under jsdom and breaks any suite that imports those modules (e.g. the agent
// workspace page). Stub both so feature detection cleanly reports "unsupported".
if (typeof document !== 'undefined') {
  if (typeof document.queryCommandSupported !== 'function') {
    document.queryCommandSupported = () => false
  }
  if (typeof document.execCommand !== 'function') {
    document.execCommand = () => false
  }
}

// jsdom 没有 ResizeObserver。任何「按容器尺寸算布局」的组件(视频标注覆盖层要用它
// 把 canvas 对齐到 object-fit: contain 后的真实画面区)一挂载就会 ReferenceError,
// 而那与被测行为无关。给一个不回调的空实现:jsdom 里本来也没有真实布局可观察。
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
}
