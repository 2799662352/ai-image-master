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

/** 视频出片面用：按 Seedance 档位二选一。 */
export const PROMPT_BASE_DIRECTIVE =
  'PROMPT BASE — load exactly ONE, keyed by `model`: "2.5" (also the default when the model is unknown) ' +
  '→ skill `sd25-pe`; "2.0" / "2.0-fast" / "2.0-mini" → skill `sd2-pe`. Load it ONCE per task and reuse ' +
  'it across every card — re-reading it per shot is pure overhead. Never load both: they are ~70KB ' +
  'combined and you can only follow one template anyway. The base owns the material reference syntax ' +
  '(图片N / 视频N / 音频N), the shot-structure formula, and, on 2.5 only, the edit / extend / keyframe / ' +
  'grid-storyboard templates. Writing the prompt from memory instead is how you end up with one that ' +
  'argues with the attached materials.'

/**
 * 视频出片面用：素材逐份负责。
 *
 * 与图片侧同一条纪律，只是这边有三类素材。sd25-pe 的官方原文叫「素材逐份负责 +
 * 【未采用素材】」，sd2-pe 叫「素材职责优先级 + 收束权重（必须写出）」—— 两边都有，
 * 但**工具描述里一句没有**，而 agent 直接调工具时读的就是工具描述。
 *
 * 漏写职责的那份素材不会被忽略，模型会自己给它安排一个用途：最常见的是把氛围板
 * 里的人一起演进画面，或者拿风格参考的运镜去覆盖你写好的镜头。
 */
export const MATERIAL_ROLE_DIRECTIVE =
  'ORDER IS IDENTITY, AND EVERY MATERIAL NEEDS A ROLE: the Nth entry of each array is 图片N / 视频N / ' +
  '音频N in the prompt, and the app preserves that order exactly. Give EVERY material you pass one ' +
  'explicit role line — a person gets bound (`将 @图片1 中的[2-3 个稳定静态特征] 定义为 <主体1>`), ' +
  'a mood board / style clip / voice sample gets told what it contributes and what it must NOT ' +
  'contribute. An unaccounted material gets a role invented for it, typically the people from a mood ' +
  'board walking into the shot. If you are not using one this turn, drop it from the array rather than ' +
  'passing it silently. Never write a raw asset:// id in the prompt body — bridge it through 图片N / <主体N>.'

/**
 * 出图面用。图片这边**只有一个**底座，而且就是入口卡本身。
 *
 * 别照搬视频那套「按模型二选一」：sd2-pe / sd25-pe 写的是 Seedance 的素材职责与
 * 镜头运动，对静帧没有意义，载进来只是白烧一次文件读 + 把视频模板的措辞带进图片
 * 提示词。这里显式写一句「video-only」正是因为视频工具的描述刚把那两个名字变得
 * 很显眼，不挡一下会被顺手载错。
 *
 * 同样不点名 director-prompt-engineering：七字段骨架已经内联进 catimation-image，
 * 那个叶子给的就是同样七行加查库纪律。把它写进工具描述 = 每次出图多一个来回，
 * 而「出图慢」的头号成因恰恰是这类多余往返。够用就别读，是入口卡自己写明的纪律。
 */
export const IMAGE_PROMPT_BASE_DIRECTIVE =
  'PROMPT BASE (load before writing ANY image prompt): skill `catimation-image`. It is the single image ' +
  'entry and already carries the 7-field prompt skeleton inline (subject+action → character refs → scene ' +
  '→ camera → lighting → composition → style/mood; English, ≤120 words) together with the ' +
  'cinematography-KB lookup rule — one read, no second hop. Reach for `director-prompt-engineering` only ' +
  'when that inline skeleton is genuinely not enough; it costs an extra round trip and mostly restates ' +
  'the same seven fields. The Seedance bases (`sd2-pe` / `sd25-pe`) are VIDEO-ONLY — never load them for stills.'
