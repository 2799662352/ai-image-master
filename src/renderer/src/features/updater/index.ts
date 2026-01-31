/**
 * Updater Feature - 更新通知模块
 * V17: 提供用户友好的更新通知界面
 */

export {
  UpdateNotification,
  getUpdateNotification,
  createUpdateNotification,
  resetUpdateNotification,
  initUpdateNotificationGlobal
} from './UpdateNotification'

export type {
  UpdateNotificationConfig,
  UpdateInfo,
  DownloadProgress
} from './UpdateNotification'
