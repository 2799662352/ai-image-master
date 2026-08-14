/**
 * 视频生成模式的联合类型 —— 单独一个叶子模块。
 *
 * 为什么不留在 `videoWorkbench.ts`：模型能力表（`seedance.ts` 的
 * `VIDEO_MODEL_CAPABILITIES`）要按模型声明「这个模型开放哪几种模式」，而
 * `videoWorkbench.ts` 反过来 import `seedance.ts`。两个文件都有**运行时导出**
 * （前者 8 个常量、后者能力表与校验函数），互相 import 就是真的循环依赖，不是
 * 类型层那种会被擦除的假环。
 *
 * 把类型抽到这里，两边各自单向依赖它；`videoWorkbench.ts` 原样 re-export，
 * 现有的十几处 `from './videoWorkbench'` 一行都不用改。
 *
 * 模式移植自 soraui 旧工作台 VolcengineArkVideoMode：
 * 文生视频 / 首帧 / 首尾帧 / 参考图 / 全能参考(多模态) / 编辑视频 / 延长视频。
 * 模式决定素材上限与提交时的 role 语义（首帧/尾帧 vs reference_*）。
 */
export type VideoWorkbenchMode =
  | 'text2video'
  | 'first_frame'
  | 'first_last_frame'
  | 'reference_images'
  | 'multimodal_ref'
  | 'edit_video'
  | 'extend_video'

/** 全部模式，按 UI 里的展示顺序。能力表的 `modes` 从中取子集。 */
export const ALL_VIDEO_WORKBENCH_MODES: readonly VideoWorkbenchMode[] = [
  'text2video',
  'first_frame',
  'first_last_frame',
  'reference_images',
  'multimodal_ref',
  'edit_video',
  'extend_video',
] as const
