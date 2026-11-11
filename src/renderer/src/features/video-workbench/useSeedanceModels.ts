// 「工作台能选哪些视频模型」——工作台卡片的模型下拉数据源。
//
// 视频生成只剩 Miau 网关这一条上游(vvdance 直连与「海外 / 国内」站点已删除),
// 所以可选档位不再随站点变化,也不再向主进程查询:就是能力表里开放了工作台模式的那些别名
// (`WORKBENCH_VIDEO_MODEL_ALIASES`)。深度捕捉(`depth`)没有工作台模式,只能经
// `generate_video` 提交,因此不会出现在这里。
//
// 仍保留成 hook 而不是让调用方直接 import 常量:以后下拉要按账号 / 灰度收窄时只改这一处,
// 卡片不用动。

import type { SeedanceModelAlias } from '../../../../types/seedance'
import { WORKBENCH_VIDEO_MODEL_ALIASES } from '../../../../types/seedance'

export function useSeedanceModels(): readonly SeedanceModelAlias[] {
  return WORKBENCH_VIDEO_MODEL_ALIASES
}
