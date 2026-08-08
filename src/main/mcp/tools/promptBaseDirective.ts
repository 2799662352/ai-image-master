// 「写 prompt 之前，先按 model 载对应的提示词底座」—— 两条出片面共用的同一句话。
//
// 为什么要写死在**工具描述**里，而不是只靠入口卡去说：agent 完全可以直接调
// `video_workbench_add_tasks` / `generate_video`，不先加载 catimation-video。
// 一旦这样，「load the entry skill first」那一跳间接就断了，两个底座一个都不会载 ——
// 出来的 prompt 既没有素材引用语法，也没有 2.5 的编辑/延长/关键帧模板。这是实测
// 漏掉的路径，不是假想。
//
// 底座按模型二选一而不是二选零：2.0 的八大要素公式和 2.5 的模板结构不是一回事，
// 载错那个等于用另一代模型的写法去喂这一代。
//
// 单一真源：同一份素材上限口径今晚因为被复制成三份而漂移过三次（schema 放宽了、
// prose 没跟上；IR 素材放宽了、model 枚举没跟上）。这句话不再复制。

export const PROMPT_BASE_DIRECTIVE =
  'PROMPT BASE (load before writing ANY prompt, keyed by `model`): "2.5" → skill `sd25-pe`; ' +
  '"2.0" / "2.0-fast" / "2.0-mini" → skill `sd2-pe`. These are bases, not optional techniques — they own ' +
  'the material reference syntax (图片N / 视频N / 音频N), the shot-structure formula, and, on 2.5 only, ' +
  'the edit / extend / keyframe / grid-storyboard templates. Load the ONE that matches the model and ' +
  'follow its template; never blend both template sets into a single prompt. Calling this tool without ' +
  'the matching base is how you end up with a prompt that argues with the attached materials.'
