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
