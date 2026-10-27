/**
 * 渠道清单已挪到 `shared/imageChannels` —— 主进程的 MCP 工具也要读它,而主进程
 * import 不了渲染层的模块。理由与那边的漂移事故见该文件顶部的注释。
 *
 * 这里保留一层再导出,是为了不动六个既有导入方(以及它们的相对路径)。新代码
 * 直接从 `shared/imageChannels` 引即可。
 */
export {
  DEFAULT_IMAGE_CHANNEL_ID,
  IMAGE_CHANNEL_IDS,
  IMAGE_CHANNELS,
  findImageChannel,
  isMiauOnlyChannel,
  isSelectableImageChannel,
  resolveImageChannel,
} from '../../../../shared/imageChannels'
export type { ImageChannel } from '../../../../shared/imageChannels'
