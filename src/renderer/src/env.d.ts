/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * tldraw SDK license key, inlined into the renderer bundle at build time.
   * Required for packaged builds since tldraw 5.3.2 — see
   * `features/agent-workspace/canvas/tldrawLicense.ts`.
   */
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/esm/vs/language/json/json.worker?worker' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}

declare module 'monaco-editor/esm/vs/platform/instantiation/common/extensions' {
  export function registerSingleton(
    id: unknown,
    ctorOrDescriptor: unknown,
    supportsDelayedInstantiation: number | boolean,
  ): void
}

declare module 'monaco-editor/esm/vs/platform/product/common/productService' {
  export const IProductService: unknown
}
