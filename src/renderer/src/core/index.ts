// src/renderer/src/core/index.ts
/**
 * 核心模块导出索引
 */

// 应用启动引导
// V16.2 D - 合并 js/app.js 功能
export {
  AppBootstrap,
  getAppBootstrap,
  createAppBootstrap,
  resetAppBootstrap,
  initAppBootstrapGlobal
} from './AppBootstrap'
export type { BootstrapConfig, BootstrapState } from './AppBootstrap'

// 路由器
export { Router, getRouter, createRouter } from './Router'
export type { PageModule, RouterConfig, RouteChangeCallback } from './Router'

// 事件总线
export {
  EventBus,
  NamespacedEventBus,
  getEventBus,
  createEventBus,
  AppEvents
} from './EventBus'
export type { EventHandler, EventSubscription } from './EventBus'

// 页面懒加载器
// V16.2 D - 合并 js/app.js 的页面管理功能
export {
  PageLoader,
  getPageLoader,
  createPageLoader,
  resetPageLoader,
  initPageLoaderGlobal,
  defaultPageModules
} from './PageLoader'
export type { PageLoaderConfig, LoadingState } from './PageLoader'

// 事件管理器
// V16.4 - 事件委托模式，替代内联 onclick
export {
  EventManager,
  getEventManager,
  createEventManager,
  resetEventManager,
  initEventManagerGlobal
} from './EventManager'
export type { EventHandler as ActionEventHandler, ActionHandlers, EventManagerConfig } from './EventManager'
