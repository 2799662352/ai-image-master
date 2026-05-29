/// <reference types="vite/client" />

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
