// e2e/fixtures/index.ts
/**
 * E2E 测试 Fixtures 导出索引
 */

export {
  test,
  expect,
  waitForAppReady,
  waitForServiceBridge,
  switchToTab,
  getToastMessage,
  takeDebugScreenshot,
  evaluateInMain,
  launchApp
} from './electron'

export type { ElectronFixtures } from './electron'
