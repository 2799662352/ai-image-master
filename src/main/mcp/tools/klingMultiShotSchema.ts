// 可灵分镜(multiShot)的 MCP 入参 schema —— generate_video 与视频工作台两组工具共用同一份。
//
// 刻意写成**朴素对象**:`type` 一个枚举 + `shots` 一个数组。不用 discriminatedUnion / anyOf ——
// 转成 JSON Schema 会生出 anyOf,客户端校验器对它的支持参差不齐(duration 那段注释里有血泪史)。
// 「智能分镜不能带 shots、自定义分镜必须带」这类联动由 validateKlingMultiShot 说清楚,schema 管不全。
//
// 用工厂函数而不是导出常量:zod schema 对象不能跨字段复用,同一个实例被多处引用会报 `_zod` 未定义。

import { z } from 'zod'
import {
  KLING_MAX_SHOTS,
  KLING_MAX_SHOT_PROMPT_LENGTH,
} from '../../../types/klingMultiShot'

const zShot = () =>
  z.object({
    prompt: z.string().describe(`This shot's description (1-${KLING_MAX_SHOT_PROMPT_LENGTH} chars).`),
    duration: z.number().int().min(1).max(30).describe('Whole seconds, ≥1.'),
  })

export const zMultiShot = () =>
  z
    .object({
      type: z.enum(['intelligence', 'customize', 'off']).describe(
        '"intelligence" = the model cuts the shots itself from the top-level prompt (prompt REQUIRED, no shots). '
        + '"customize" = YOU script the shots in `shots`. "off" = clear it (single shot).',
      ),
      shots: z.array(zShot()).max(KLING_MAX_SHOTS).optional().describe(
        `customize only: 1-${KLING_MAX_SHOTS} shots in play order. Durations MUST add up to the card's total `
        + `duration exactly. The top-level prompt may be left empty (the shots take over).`,
      ),
    })
    .optional()
    .describe(
      'kling4 / kling4-omni ONLY: split ONE video into several shots (multi-shot). Omit = a single shot. '
      + 'Same price either way (billed by total seconds). Rejected by other models. '
      + 'Changing the card duration later re-scales customize shots proportionally.',
    )
