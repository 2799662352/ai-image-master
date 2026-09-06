// 工作台把素材 chip 存成 `【@图片1】/【@视频2】/【@音频1】`(renderer promptTokens.ts),
// 这层方括号是 UI 的 chip 外壳,不是提示词语法。
const WORKBENCH_CHIP_RE = /【(@(?:图片|视频|音频)\d+)】/g

/**
 * 提示词在工具边界上**原样发送**。`@图片1 / @视频1 / @音频1` 就是火山方舟 Seedance
 * OpenAPI 里的提示词写法(§2.3「如果你在提示词中使用 @参考N / @视频N / @音频N 这类
 * 标签,请确保它们与 content[] 里的素材顺序一一对应」),`@` 保留、不删。
 *
 * 唯一动的是工作台 chip 的 `【@图片N】` 外壳:解成 `@图片N`。方括号在官方符号表里是
 * 字幕(`【第一章：启程】`),chip 外壳原样发出去会被当字幕;而 chip 形态是 UI 内部编码,
 * 用户看到的是 chip 不是文字,解包不算改用户的提示词。
 *
 * 曾经在这里做过更多事(2026-09 之前:把 `@图片1` 归一成 `图片1`、翻译 Fal 风格的
 * `@Image1`、清 `<图片1>` 旧别名;2026-09 短暂加过删空行 / 删中文字间空格的排版收束)。
 * 用户明确否掉:提示词是什么,发过去就是什么;`@` 不要去掉。排版和别名写法都按模型侧
 * 约束解决(sd2-pe / sd25-pe / 入口卡),运行时不替模型改稿。别再加回来。
 */
export function normalizeSeedancePromptReferences(prompt: string): string {
  return prompt.replace(WORKBENCH_CHIP_RE, '$1')
}
