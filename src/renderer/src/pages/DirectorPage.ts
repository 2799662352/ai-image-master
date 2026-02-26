// src/renderer/src/pages/DirectorPage.ts
/**
 * 导演模式页面模块 - TypeScript 版本
 * @description 支持漫画分镜布局和批量场景生成
 */

import { BasePage, AppInterface, PageState } from './BasePage'

// ==================== 类型定义 ====================

/**
 * 布局类型
 */
export type LayoutType = '6grid' | '4grid' | '2closeup' | '9grid'

/**
 * 生成模式
 */
export type GenerationMode = 'single' | 'multi'

/**
 * 风格模板类型
 */
export type StyleTemplateKey = 'anime' | 'manga' | 'movie' | 'webtoon' | 'comic' | 'illustration' | 'cinematic' | 'theatrical'

const BUILTIN_TEMPLATE_KEYS: ReadonlySet<string> = new Set<StyleTemplateKey>([
  'anime', 'manga', 'movie', 'webtoon', 'comic', 'illustration', 'cinematic', 'theatrical'
])

/**
 * 风格模板
 */
export interface StyleTemplate {
  name: string
  prefix: string
  suffix: string
  negative: string
}

/**
 * 内置风格模板集合 — 所有 StyleTemplateKey 必须有对应定义
 */
export type BuiltinStyleTemplates = Record<StyleTemplateKey, StyleTemplate>

/**
 * 风格模板集合（含自定义模板，key 为任意 string）
 */
export interface StyleTemplates {
  [key: string]: StyleTemplate
}

/**
 * 布局配置
 */
export interface LayoutConfig {
  rows: number
  cols: number
  name: string
  description: string
  ratio: string
}

/**
 * JSON 格式图片提示词 — Panel 结构
 */
export interface JsonPromptPanel {
  id: number
  shot?: string
  lens?: string
  spatial?: { fg?: string; mg?: string; bg?: string }
  action?: string
  light?: string
  mood?: string
  desc?: string
}

/**
 * JSON 格式图片提示词 — 顶层结构
 */
export interface JsonPrompt {
  composition: string
  subject: string
  style: string
  story: string
  panels: JsonPromptPanel[]
  constraints: string
  negative?: string
}

/**
 * 布局配置集合
 */
export interface LayoutConfigs {
  [key: string]: LayoutConfig
}

/**
 * 参考图片
 */
export interface DirectorReferenceImage {
  id?: number
  base64: string
  fileName: string
  fileSize: number
  mimeType: string
  originalFile?: File
}

/**
 * 生成结果
 */
export interface DirectorResult {
  success: boolean
  imageData?: string
  error?: string
  prompt: string
  index: number
}

/**
 * 自定义图库图片
 */
export interface CustomGalleryImage {
  id: string
  name: string
  base64?: string
  url?: string
  filename?: string
  createdAt: string
}

/**
 * 导演页面状态
 */
export interface DirectorPageState extends PageState {
  mode: GenerationMode
  layout: LayoutType
  ratio: string
  resolution: string
  template: StyleTemplateKey | string | null
  imageCount: string
  sceneDescription: string
  multiScenePrompts: string
  referenceImages: Array<{
    base64: string
    fileName: string
    fileSize: number
    mimeType: string
  }>
}

/**
 * 导演模式页面类
 */
export class DirectorPage extends BasePage {
  // 参考图片
  private referenceImages: DirectorReferenceImage[] = []
  private maxReferenceImages: number = 8

  // 生成状态
  private isGenerating: boolean = false
  private isProcessingFiles: boolean = false

  // 布局和模式
  private currentLayout: LayoutType = '6grid'
  private imageCount: number = 1
  private currentRatio: string = '3:2'
  private currentResolution: string = '2K'
  private currentTemplate: StyleTemplateKey | null = null
  private currentCustomTemplateKey: string | null = null
  private currentMode: GenerationMode = 'single'

  // 生成结果
  private generatedResult: string | null = null
  private generatedResults: DirectorResult[] = []
  private currentResultIndex: number = 0

  // 分析资产
  private lastAnalysisResult: string | null = null
  private lastComicPrompt: string | null = null
  private currentModalType: 'analysis' | 'prompt' | null = null
  private modalEscHandler: ((e: KeyboardEvent) => void) | null = null

  // 图库
  private gallerySelectedImages: string[] = []
  private customGalleryImages: CustomGalleryImage[] = []
  private galleryEditMode: boolean = false
  private galleryDeleteSelection: string[] = []
  private exampleGalleryCount: number = 38
  private exampleGalleryPath: string = 'assets/templates/'

  // 模板管理
  private customTemplates: StyleTemplates = {}
  private templateOverrides: StyleTemplates = {}
  private editingTemplateKey: string | null = null
  private editingTemplateIsBuiltin: boolean = false

  // 图像理解模型
  private visionModel: string = 'gpt-5.2'
  private visionModelConfig: { models: Array<{ id: string; name: string; shortName?: string; icon?: string; recommended?: boolean; description?: string; features?: string[]; price?: string }>; defaultModel: string } | null = null

  // 完整 Gem 系统提示词（北风诉苦原版 v1.1）- 用于生成 JSON 格式分镜提示词
  private gemSystemPrompt: string = `(NanoBananaPro视角裂变专家

:核心角色 "多维视角一致性生成助手 (3x3精简版)"

:目的 "基于用户提供的单张参考图描述，保持视觉锚点绝对不变，通过特定视角的强化组合，生成9个（3x3宫格）极具沉浸感的JSON格式英文提示词。"

:作者 "北风诉苦（bailing200215），漫剧自用版 v1.1"

:适配模型 "NanoBananaPro"

;;──────────────────────────────────────────────────────────────────────
;; 核心能力设定
;;──────────────────────────────────────────────────────────────────────

:能力 (

(视觉锁定 "能够精准提取并锁定参考图中的核心元素（人物ID、衣着细节、环境布局、特定光影），确保在9张分镜中这些描述一字不差或高度一致。")

(特定镜头强化 "侧重于沉浸式和关系视角的构建，重点生成背后、过肩及主观镜头。")

(随机排列 "能够生成9种高张力的镜头组合，避免平庸的平视镜头。")

(格式输出 "严格遵守NanoBananaPro的JSON格式要求，输出3x3布局配置。")
)

;;──────────────────────────────────────────────────────────────────────
;; 变量库 (已根据要求调整)
;;──────────────────────────────────────────────────────────────────────

:镜头变量库 (

;; 剔除了常规的 Long, Medium, Close，保留极端的或更有张力的景别

(景别 '( "Extreme Close-up (ECU - Focus on eyes/details)" "Full Body Shot" "Cowboy Shot (Thigh-up)" "Upper Body Shot (Chest-up)" "Wide Angle Full Shot" ))

;; 强调了需要的视角，但保留部分其他视角以供填充剩余空位

(视角 '( "Back View (Walking away/Looking at scenery)" "Over-the-Shoulder (OTS)" "Point of View (POV)" "Low Angle (Heroic)" "High Angle (Vulnerable)" "Dutch Angle (Tilted)" "Top-Down / God's Eye View" ))

(构图 '( "Rule of Thirds" "Center Composition" "Depth of Field (Bokeh)" "Framing within a frame" "Dynamic Diagonal" ))
)

;;──────────────────────────────────────────────────────────────────────
;; 输入与处理
;;──────────────────────────────────────────────────────────────────────

:输入 (

(格式 "用户提供的参考图详细描述 (包含人物、环境、光影)")

(处理流程 (

  "1. 【提取锚点】：将用户的描述定义为 [Base_Prompt]，这部分在生成时不可修改。"

  "2. 【权重分配】：在9个分镜中，强制分配：2个背后视角，3个过肩视角(OTS)，2个主观视角(POV)，剩余2个随机分配(如荷兰角或俯视)。"

  "3. 【合成Prompt】：Prompt结构 = [Camera_Setup] + [Base_Prompt] + [Quality_Tags] + [Marking_Instructions]。"

  "4. 【JSON封装】：填入shots数组，确保shot_number从'分镜1'到'分镜9'。"

))
)

;;──────────────────────────────────────────────────────────────────────
;; 输出结构定义 (JSON)
;;──────────────────────────────────────────────────────────────────────

:输出 (

(格式 "JSON String wrapped in code block")

(结构模板
  \`\`\`json
  {
    "image_generation_model": "NanoBananaPro",
    "grid_layout": "3x3",
    "grid_aspect_ratio": "16:9",
    "global_watermark": {
      "position": "bottom_center",
      "size": "small"
    },
    "shots": [
      // 循环9次，i 从 1 到 9
      {
        "shot_number": "分镜{i}",
        "prompt_text": "[特定的镜头语言], [用户提供的固定参考图描述], [画质与细节词]. '分镜{i}' in the top-left corner. No timecode, no subtitles."
      }
    ]
  }
  \`\`\`
)
)

;;──────────────────────────────────────────────────────────────────────
;; 约束模块 (硬性规定)
;;──────────────────────────────────────────────────────────────────────

:约束 (

(C1 "一致性绝对优先：无论视角如何变化，人物特征（发型、衣着、面孔）和环境必须保持一致。")

(C2 "视角强制分布：9个分镜中必须包含：
     - 至少 2个 背后视角 (Back View)；
     - 至少 3个 过肩视角 (Over-the-Shoulder)；
     - 至少 2个 主观视角 (Point of View/POV)；
     - 剩余 2个 自由选择高张力视角（如上帝视角或大特写）。")

(C3 "景别限制：严禁使用 'Medium Shot', 'Long Shot', 'Close-up' 这种平庸的描述。请使用 'Cowboy Shot', 'Extreme Close-up', 'Full Body' 等替代。")

(C4 "格式规范：JSON必须纯净，shots数组必须精确包含9个对象。")

(C5 "文字指令：每个prompt必须包含 \"'分镜X' in the top-left corner\" 和 \"no timecode, no subtitles\"。")

(C6 "语言：Prompt内容必须为英文。")
)

;;──────────────────────────────────────────────────────────────────────
;; 运行指令
;;──────────────────────────────────────────────────────────────────────

(运行方法 "请用户输入参考图的详细描述（中文或英文），助手将自动生成包含9个（3x3）特定强化视角的JSON代码块。")

)`

  // 风格模板库 - 名称将在 getTemplateDisplayName() 中国际化
  private styleTemplates: BuiltinStyleTemplates = {
    anime: {
      name: 'anime', // i18n key: director.templates.styles.anime
      prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ',
      suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring',
      negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks'
    },
    manga: {
      name: 'manga', // i18n key: director.templates.styles.manga
      prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ',
      suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout',
      negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render'
    },
    movie: {
      name: 'movie', // i18n key: director.templates.styles.movie
      prefix: 'cinematic storyboard, film still, movie scene, cinematography, ',
      suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading',
      negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality'
    },
    webtoon: {
      name: 'webtoon', // i18n key: director.templates.styles.webtoon
      prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ',
      suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere',
      negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome'
    },
    comic: {
      name: 'comic', // i18n key: director.templates.styles.comic
      prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ',
      suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene',
      negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading'
    },
    illustration: {
      name: 'illustration', // i18n key: director.templates.styles.illustration
      prefix: 'illustration, detailed artwork, artistic composition, ',
      suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration',
      negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background'
    },
    cinematic: {
      name: 'cinematic', // i18n key: director.templates.styles.cinematic  电影级九宫格（导演级分镜）
      prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. Symmetrical grid, hard borders, clean white dividing lines. Each panel labeled with KF number + shot type + suggested duration. ',
      suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh',
      negative: 'text, speech bubbles, dialogue, watermark, signature, blurry, low quality, inconsistent characters, different outfits, style change, irregular panels, asymmetric grid, new characters not in reference, guessed identities, brand logos'
    },
    theatrical: {
      name: 'theatrical', // i18n key: director.templates.styles.theatrical  剧场版动画
      prefix: '((現代的な撮影技術を駆使した日本のアニメ映画スタイル:1.5)), ((劇場版クオリティのスクリーンショット:1.5)), ((TVアニメの没入感:1.4)), 以下のプロンプトに従って画像の絵コンテを調整します。日本のアニメ映画版で、監督に見せるための絵コンテです。ストーリー感を表現します。複数のカットで構成されたものは必ず映画版のスクリーンショットで構成された絵コンテで、テキスト内のすべてのストーリー情報を漏らさず、最も重要な演技のカットを示してください。((参考画像の画風に完全に従って構築します:1.6)), ((画風の完全再現:1.6)), ((オリジナル画風を維持:1.5)), ',
      suffix: ', 高品質, 8k, masterpiece, best quality, absurdres, veryaesthetic, full color, anime cel shading, TV anime coloring, modern anime style, cinematic lighting, highly detailed, depth of field, anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, key animation frames, emotional acting focus',
      negative: '低品質, 作画崩壊, 実写, 3D, 異なる画風, 画風の変更, 文字, ぼやけ, (worst quality, low quality:1.4), illustration, static illustration, poster, artbook, sketch, monochrome, grayscale'
    }
  }

  private defaultStyleTemplates: BuiltinStyleTemplates

  // 布局配置 - 名称和描述将在 getLayoutDisplayName/Description() 中国际化
  private layouts: LayoutConfigs = {
    '6grid': {
      rows: 2,
      cols: 3,
      name: '6grid', // i18n key: director.layouts.6grid.name
      description: '6grid', // i18n key: director.layouts.6grid.description
      ratio: '3:2'
    },
    '4grid': {
      rows: 2,
      cols: 2,
      name: '4grid', // i18n key: director.layouts.4grid.name
      description: '4grid', // i18n key: director.layouts.4grid.description
      ratio: '1:1'
    },
    '2closeup': {
      rows: 1,
      cols: 2,
      name: '2closeup', // i18n key: director.layouts.2closeup.name
      description: '2closeup', // i18n key: director.layouts.2closeup.description
      ratio: '16:9'
    },
    '9grid': {
      rows: 3,
      cols: 3,
      name: '9grid', // i18n key: director.layouts.9grid.name
      description: '9grid', // i18n key: director.layouts.9grid.description
      ratio: '16:9'  // 默认横屏，分形几何原则：总图和单格比例一致
    }
  }

  // 电影导演级分镜 Gem 系统提示词（cinematic 模板专用 - trailer director + cinematographer + storyboard artist）
  private cinematicGemSystemPrompt: string = `<role>
You are an award-winning trailer director + cinematographer + storyboard artist. Your job: turn ONE reference image into a cohesive cinematic short sequence, then output AI-video-ready keyframes.
</role>

<input>
User provides: one reference image (image) and optional scene description.
</input>

<non-negotiable rules - continuity & truthfulness>
1) First, analyze the full composition: identify ALL key subjects (person/group/vehicle/object/animal/props/environment elements) and describe spatial relationships and interactions.
2) Do NOT guess real identities, exact real-world locations, or brand ownership. Stick to visible facts.
3) Strict continuity across ALL shots: same subjects, same wardrobe/appearance, same environment, same time-of-day and lighting style.
4) Depth of field must be realistic: deeper in wides, shallower in close-ups with natural bokeh.
5) Do NOT introduce new characters/objects not present in the reference image.
</non-negotiable rules>

<goal>
Expand the image into a 10–20 second cinematic clip with a clear theme and emotional progression (setup → build → turn → payoff).
</goal>

<workflow>
Step 1 - Analyze: Identify all key subjects, spatial relationships, lighting conditions, and mood from the reference image.
Step 2 - Plan: Design emotional arc (setup → build → turn → payoff) with shot progression.
Step 3 - Shot Design: For each keyframe, specify camera angle, lens, movement, DoF, and duration.
Step 4 - Continuity Check: Verify all subjects maintain identical appearance across all shots.
Step 5 - Contact Sheet Output: Output ONE single master image as a Cinematic Contact Sheet / Storyboard Grid containing ALL keyframes.
  - Default grid: 3x3. If more than 9 keyframes, use 4x3 or 5x3 so every keyframe fits into ONE image.
  - Each panel must be clearly labeled: KF number + shot type + suggested duration.
  - Strict continuity across ALL panels.
</workflow>

<output_format>
Output as JSON code block. Define "character_anchor" as a top-level field (single source of truth for character appearance).

Each shot's prompt_text MUST be a valid JSON object STRING (not natural language). Format:
{"kf":"KF1 - CU - 2s","lens":"85mm static","spatial":{"fg":"rain-streaked glass soft focus","mg":"woman sitting at table sharp","bg":"blurred city lights"},"action":"gazes down, bites lower lip","light":"upper-left window, soft diffused, warm 4500K, ratio 2:1","label":"分镜1"}

Fields in each prompt_text JSON:
- kf: KF number + shot type + duration
- lens: focal length + camera movement
- spatial: {fg, mg, bg} three depth layers
- action: one anchor verb + manner words (no stacking)
- light: source + direction + quality + color temperature
- label: "分镜N" for panel marking

Do NOT use natural language sentences. Do NOT repeat character_anchor in shots. Keep each field concise.
</output_format>

<shot_design_vocabulary>
Camera Angles: Eye-level, Low angle (heroic), High angle (vulnerable), Dutch angle (tension), Bird's eye, Worm's eye, Over-the-shoulder (OTS), POV
Lens Types: Wide 24mm (establishing), Standard 50mm (natural), Telephoto 85mm (portrait compression), Macro (detail), Anamorphic (cinematic)
Camera Movement: Static/locked, Slow push-in, Pull-back reveal, Tracking/dolly, Crane up/down, Handheld (urgency), Steadicam orbit
Shot Types: Extreme Wide Shot (EWS), Wide Shot (WS), Full Shot (FS), Cowboy Shot, Medium Close-up (MCU), Close-up (CU), Extreme Close-up (ECU), Insert/Detail
</shot_design_vocabulary>

<camera_physics>
MANDATORY — every shot MUST obey these optical physics rules. Violations produce "fake AI look":

Shot-Lens-DoF Consistency:
- EWS/WS + 24mm wide → Deep DoF (everything sharp). Emotion: epic, lonely, establishing
- FS/Cowboy + 35-50mm → Medium DoF. Emotion: narrative, daily life
- MCU/CU + 85mm portrait → Shallow DoF (bokeh background). Emotion: intimacy, emotion amplifier
- ECU + 105mm+ → Very shallow DoF. Emotion: micro-expression, pressure

FORBIDDEN combinations (physically impossible):
- Wide angle (24mm) + shallow DoF → NEVER
- Long shot + shallow DoF → NEVER (unless tilt-shift)
- Telephoto (135mm+) + deep DoF → NEVER
</camera_physics>

<spatial_depth>
Every shot MUST define three spatial layers to avoid flat "cardboard cutout" look:
- Foreground: framing element, partial occlusion, or textured surface (out of focus if shallow DoF)
- Midground: primary subject and action zone (sharp focus)
- Background: environment context, atmosphere, depth cues (bokeh or haze)

Example: "Foreground: rain-streaked window glass (soft focus). Midground: woman sitting at table, sharp. Background: blurred city lights through window."
If a shot has NO foreground element, compensate with strong atmospheric depth (fog, dust motes, light rays).
</spatial_depth>

<lighting_rules>
NEVER write vague lighting words like "cinematic lighting" or "atmospheric". Instead specify:
1. Light SOURCE: where does light physically come from? (window, lamp, neon sign, sunset, screen glow)
2. Light DIRECTION: which side of the subject does it hit? (upper-left key, rim from behind, under-light)
3. Light QUALITY: hard (sharp shadows) or soft (diffused, wrapping)?
4. Light RATIO: key-to-fill ratio (e.g., 4:1 dramatic, 2:1 natural, 1:1 flat/clinical)

Color hierarchy: designate ONE dominant color temperature (warm OR cool) covering 80%+ of the frame. Complementary color appears ONLY in small accent areas.
</lighting_rules>

<expression_rules>
For CU/MCU shots, NEVER use emotion adjectives (sad, happy, angry). Describe PHYSIOLOGICAL MICRO-ACTIONS:
- Sadness: eyes glisten, lower lip trembles, gaze drops to floor
- Joy: crow's feet crinkle, teeth visible, eyes squint
- Fear: pupils dilate, nostrils flare, jaw clenches
- Tension: swallows hard, jaw tightens, brow furrows
- Shyness: averts gaze, chin tucks, bites lower lip

For wider shots, express emotion through BODY POSTURE:
- Defeat: shoulders slumped, head bowed, arms hanging
- Confidence: chest open, chin slightly raised, steady gaze
- Anxiety: fidgeting hands, weight shifting, hunched shoulders
</expression_rules>

<action_rules>
Each panel: ONE primary verb (anchor action) + manner words for HOW.
FORBIDDEN: stacking multiple verbs ("runs, jumps, rolls, draws sword").
CORRECT: "sprinting with 15-degree forward lean, coat flaring behind, head turning over shoulder"

For emotional moments, use Start-Transition-End micro-arc within a single panel:
"Maintains composure → deep visible breath → faint relieved smile slowly forms"
</action_rules>`

  // Sora2 视频提示词模板
  private sora2VideoPromptTemplate = `{CHARACTER_CARD} The video plays out in a continuous 9-part sequence:
{VIDEO_SEQUENCES}`

  constructor(app: AppInterface) {
    super(app)
    this.defaultStyleTemplates = JSON.parse(JSON.stringify(this.styleTemplates))
    this.init()
  }

  /**
   * 初始化页面
   */
  init(): void {
    console.log('初始化导演模式页面 (TypeScript)')
    this.bindEvents()
    this.bindStateAutoSave()
    this.loadUserTemplates()
    this.loadCustomGalleryImages()
    this.loadVisionModelConfig()
    
    // 初始化 UI 状态
    this.updateLayoutSelection()
    this.updateGenerateButtonState()
    this.syncDefaultTemplateUI()  // 同步默认模板 UI
    
    this.isInitialized = true
  }

  /**
   * 同步默认模板的 UI 显示
   */
  private syncDefaultTemplateUI(): void {
    const activeKey = this.currentTemplate || this.currentCustomTemplateKey
    if (!activeKey) return

    const template = this.getCurrentTemplateData()
    if (!template) return

    const displayName = this.getTemplateDisplayName(activeKey, template)
    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = displayName
      nameSpan.classList.add('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.remove('hidden')
    }

    console.log('[DirectorPage] 默认模板已设置:', activeKey, displayName)
  }

  /**
   * 加载图像理解模型配置
   */
  private async loadVisionModelConfig(): Promise<void> {
    try {
      const response = await fetch('data/vision-models.json?v=' + Date.now())
      this.visionModelConfig = await response.json()
      this.visionModel = this.visionModelConfig!.defaultModel
      this.updateVisionModelDisplay()
      console.log('✅ 导演模式加载视觉模型配置:', this.visionModelConfig)
    } catch (error) {
      console.warn('⚠️ 加载视觉模型配置失败，使用默认值:', error)
      this.visionModelConfig = {
        models: [
          { id: 'gpt-5.2', name: 'GPT-5.2', shortName: 'GPT-5.2', icon: '🚀', recommended: true }
        ],
        defaultModel: 'gpt-5.2'
      }
    }
  }

  /**
   * 更新图像理解模型显示
   */
  private updateVisionModelDisplay(): void {
    const iconEl = this.getElement<HTMLElement>('directorVisionModelIcon')
    const nameEl = this.getElement<HTMLElement>('directorVisionModelName')
    
    if (!this.visionModelConfig || !iconEl || !nameEl) return
    
    const model = this.visionModelConfig.models.find(m => m.id === this.visionModel)
    if (model) {
      iconEl.textContent = model.icon || '🤖'
      nameEl.textContent = model.shortName || model.name || model.id
    }
  }

  /**
   * 绑定事件
   */
  bindEvents(): void {
    // 上传区域
    this.setupUploadArea()

    // 清除参考图按钮（动态元素，静默模式）
    this.addEventListenerSafe('directorClearImage', 'click', () => this.clearReferenceImage(), true)

    // 图像理解模型选择
    this.addEventListenerSafe('directorVisionModelBtn', 'click', () => this.openVisionModelModal())

    // 模式切换
    this.setupModeSwitch()

    // 多提示词输入计数
    this.addEventListenerSafe('directorMultiSceneInput', 'input', () => this.updatePromptCount())

    // 布局选择
    this.setupLayoutSelection()

    // 生成按钮
    this.addEventListenerSafe('directorGenerateBtn', 'click', () => this.startGeneration())

    // 下载按钮（动态元素，静默模式）
    this.addEventListenerSafe('directorDownloadBtn', 'click', () => this.downloadResult(), true)
    this.addEventListenerSafe('directorDownloadAllBtn', 'click', () => this.downloadAllResults(), true)

    // 重新生成按钮（动态元素，静默模式）
    this.addEventListenerSafe('directorRegenerateBtn', 'click', () => this.startGeneration(), true)

    // 出图数量滑块
    this.addEventListenerSafe('directorImageCount', 'input', () => this.updateImageCountDisplay())

    // 风格模板
    this.setupTemplateEvents()

    // 图片尺寸选择
    const ratioSelect = this.getElement<HTMLSelectElement>('directorRatio')
    if (ratioSelect) {
      ratioSelect.addEventListener('change', (e: Event) => {
        this.currentRatio = (e.target as HTMLSelectElement).value
      })
    }

    // 分辨率选择
    const resolutionSelect = this.getElement<HTMLSelectElement>('directorResolution')
    if (resolutionSelect) {
      resolutionSelect.addEventListener('change', (e: Event) => {
        this.currentResolution = (e.target as HTMLSelectElement).value
      })
    }

    // 示例图库
    this.setupGalleryEvents()
  }

  /**
   * 设置上传区域
   */
  private setupUploadArea(): void {
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (!uploadArea) return

    uploadArea.addEventListener('click', () => this.triggerFileSelection())
    uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e))
    uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e))
    uploadArea.addEventListener('drop', (e) => this.handleDrop(e))
  }

  /**
   * 设置模式切换
   */
  private setupModeSwitch(): void {
    const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="directorMode"]')
    modeRadios.forEach(radio => {
      radio.addEventListener('change', (e: Event) => {
        this.switchMode((e.target as HTMLInputElement).value as GenerationMode)
      })
    })
  }

  /**
   * 设置布局选择
   */
  private setupLayoutSelection(): void {
    const layoutContainer = this.getElement<HTMLElement>('directorLayoutOptions')
    console.log('[DirectorPage] 设置布局选择, 容器存在:', !!layoutContainer)
    
    if (layoutContainer) {
      layoutContainer.addEventListener('click', (e: MouseEvent) => {
        const card = (e.target as HTMLElement).closest('.layout-card') as HTMLElement | null
        console.log('[DirectorPage] 布局点击, 卡片:', card?.dataset.layout)
        if (card?.dataset.layout) {
          this.selectLayout(card.dataset.layout as LayoutType)
        }
      })
    }
    
    // 备用方案：直接绑定到每个布局卡片
    const cards = document.querySelectorAll<HTMLElement>('.layout-card[data-layout]')
    console.log('[DirectorPage] 找到布局卡片数量:', cards.length)
    cards.forEach(card => {
      card.addEventListener('click', () => {
        const layout = card.dataset.layout as LayoutType
        console.log('[DirectorPage] 直接点击布局:', layout)
        if (layout) {
          this.selectLayout(layout)
        }
      })
    })
  }

  /**
   * 设置模板事件
   */
  private setupTemplateEvents(): void {
    this.addEventListenerSafe('directorTemplateBtn', 'click', () => this.showTemplateModal())
    this.addEventListenerSafe('closeTemplateModalX', 'click', () => this.hideTemplateModal())
    this.addEventListenerSafe('closeTemplateModal', 'click', () => this.hideTemplateModal())
    this.addEventListenerSafe('directorClearTemplate', 'click', () => this.clearTemplate())

    const templateList = this.getElement<HTMLElement>('directorTemplateList')
    if (templateList) {
      templateList.addEventListener('click', (e: MouseEvent) => {
        const card = (e.target as HTMLElement).closest('.template-card') as HTMLElement | null
        if (card?.dataset.template) {
          this.selectTemplate(card.dataset.template)
        }
      })
    }
  }

  /**
   * 设置图库事件
   */
  private setupGalleryEvents(): void {
    this.addEventListenerSafe('directorExampleGalleryBtn', 'click', () => this.showGalleryModal())
    this.addEventListenerSafe('closeGalleryModalX', 'click', () => this.hideGalleryModal())
    this.addEventListenerSafe('closeGalleryModal', 'click', () => this.hideGalleryModal())
    this.addEventListenerSafe('confirmGallerySelection', 'click', () => this.confirmGallerySelection())
  }

  /**
   * 绑定状态自动保存
   */
  private bindStateAutoSave(): void {
    const elements = [
      { id: 'directorSceneInput', event: 'input' },
      { id: 'directorMultiSceneInput', event: 'input' },
      { id: 'directorImageCount', event: 'input' },
      { id: 'directorRatio', event: 'change' },
      { id: 'directorResolution', event: 'change' }
    ]

    elements.forEach(({ id, event }) => {
      const element = this.getElement<HTMLElement>(id)
      if (element) {
        element.addEventListener(event, () => this.saveCurrentState())
      }
    })
  }

  // ==================== 图库管理 ====================

  /**
   * 显示图库模态框
   */
  showGalleryModal(): void {
    const modal = this.getElement<HTMLElement>('directorGalleryModal')
    if (modal) {
      modal.classList.remove('hidden')
      this.galleryEditMode = false
      this.galleryDeleteSelection = []
      this.updateGalleryEditModeUI()
      this.loadGalleryImages()
      ;(window as any).i18n?.updateDOM()
    }
  }

  /**
   * 隐藏图库模态框
   */
  hideGalleryModal(): void {
    const modal = this.getElement<HTMLElement>('directorGalleryModal')
    if (modal) {
      modal.classList.add('hidden')
    }
    this.gallerySelectedImages = []
    this.galleryDeleteSelection = []
    this.galleryEditMode = false
    this.updateGallerySelectedCount()
  }

  /**
   * 加载自定义图库
   */
  async loadCustomGalleryImages(): Promise<void> {
    try {
      let images: CustomGalleryImage[] = []
      const electronAPI = (window as any).electronAPI

      if (electronAPI?.isElectron) {
        images = await electronAPI.loadCustomGallery() || []
      } else {
        const data = localStorage.getItem('director_custom_gallery')
        images = data ? JSON.parse(data) : []
      }

      this.customGalleryImages = images
      console.log('[DirectorPage] 已加载自定义图库:', this.customGalleryImages.length, '张')
    } catch (error) {
      console.error('[DirectorPage] 加载自定义图库失败:', error)
      this.customGalleryImages = []
    }
  }

  /**
   * 加载图库图片
   */
  loadGalleryImages(): void {
    this.loadCustomGalleryGrid()
    this.loadBuiltinGalleryGrid()
    if (!this.galleryEditMode) {
      this.gallerySelectedImages = []
    }
    this.updateGallerySelectedCount()
  }

  /**
   * 加载自定义图库网格
   */
  private loadCustomGalleryGrid(): void {
    const grid = this.getElement<HTMLElement>('customGalleryGrid')
    const countSpan = this.getElement<HTMLElement>('customImageCount')

    if (!grid) return

    if (countSpan) {
      countSpan.textContent = `(${this.customGalleryImages.length})`
    }

    grid.innerHTML = ''

    if (this.customGalleryImages.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full text-center py-10 relative overflow-hidden"
             style="border: 2px dashed #3F3F46; background: linear-gradient(135deg, #18181B 0%, #09090B 100%);">
          <div class="relative z-10">
            <i class="fas fa-folder-open text-4xl mb-3" style="color: #06B6D4;"></i>
            <p class="text-[#FAFAFA] text-sm uppercase tracking-widest font-bold mb-1">NO_DATA_FOUND</p>
            <p class="text-[#71717A] text-xs uppercase tracking-wide">${this.t('director.gallery.clickToAddImages') || '点击上方按钮添加您的图片'}</p>
          </div>
        </div>
      `
      return
    }

    this.customGalleryImages.forEach(img => {
      const card = this.createGalleryCard(img, true)
      grid.appendChild(card)
    })
  }

  /**
   * 加载内置图库网格
   */
  private loadBuiltinGalleryGrid(): void {
    // HTML 中使用 directorGalleryGrid 而不是 builtinGalleryGrid
    const grid = this.getElement<HTMLElement>('directorGalleryGrid')
    if (!grid) return

    grid.innerHTML = ''

    for (let i = 1; i <= this.exampleGalleryCount; i++) {
      const imagePath = `${this.exampleGalleryPath}anime-example-${String(i).padStart(2, '0')}.png`
      const card = this.createBuiltinGalleryCard(imagePath, i)
      grid.appendChild(card)
    }
  }

  /**
   * 创建图库卡片
   */
  private createGalleryCard(img: CustomGalleryImage, isCustom: boolean): HTMLElement {
    const card = document.createElement('div')
    const imageUrl = img.url || img.base64 || ''
    const isSelected = this.galleryEditMode
      ? this.galleryDeleteSelection.includes(img.id)
      : this.gallerySelectedImages.includes(imageUrl)

    card.className = 'gallery-card group relative cursor-pointer overflow-hidden transition-all duration-300'
    card.dataset.imgId = img.id
    card.dataset.isCustom = String(isCustom)

    card.innerHTML = `
      <img src="${imageUrl}" alt="${img.name}" 
           class="w-full h-32 object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">
      <div class="gallery-check ${isSelected ? '' : 'hidden'} absolute top-2 right-2 w-6 h-6 z-30 flex items-center justify-center"
           style="background: ${this.galleryEditMode ? '#EF4444' : '#EC4899'};">
        <i class="fas ${this.galleryEditMode ? 'fa-trash' : 'fa-check'} text-white text-xs"></i>
      </div>
      <div class="absolute bottom-0 left-0 right-0 z-20" 
           style="background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%);">
        <div class="p-2">
          <p class="text-[#FAFAFA] text-xs truncate uppercase tracking-wider font-medium">${img.name}</p>
        </div>
      </div>
    `

    card.addEventListener('click', () => this.handleGalleryCardClick(img, imageUrl))

    return card
  }

  /**
   * 创建内置图库卡片
   */
  private createBuiltinGalleryCard(imagePath: string, index: number): HTMLElement {
    const card = document.createElement('div')
    const isSelected = this.gallerySelectedImages.includes(imagePath)

    card.className = 'gallery-card group relative cursor-pointer overflow-hidden transition-all duration-300'
    card.dataset.imagePath = imagePath

    card.innerHTML = `
      <img src="${imagePath}" alt="${this.t('director.gallery.exampleImage', { index }) || `示例图片 ${index}`}" 
           class="w-full h-32 object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy">
      <div class="gallery-check ${isSelected ? '' : 'hidden'} absolute top-2 right-2 w-6 h-6 z-30 flex items-center justify-center bg-pink-500">
        <i class="fas fa-check text-white text-xs"></i>
      </div>
    `

    card.addEventListener('click', () => this.toggleGallerySelection(imagePath, card))

    return card
  }

  /**
   * 处理图库卡片点击
   */
  private handleGalleryCardClick(img: CustomGalleryImage, imageUrl: string): void {
    if (this.galleryEditMode) {
      const idx = this.galleryDeleteSelection.indexOf(img.id)
      if (idx > -1) {
        this.galleryDeleteSelection.splice(idx, 1)
      } else {
        this.galleryDeleteSelection.push(img.id)
      }
      this.loadGalleryImages()
    } else {
      this.toggleGallerySelection(imageUrl)
    }
  }

  /**
   * 切换图库选择
   */
  private toggleGallerySelection(imagePath: string, card?: HTMLElement): void {
    const idx = this.gallerySelectedImages.indexOf(imagePath)
    if (idx > -1) {
      this.gallerySelectedImages.splice(idx, 1)
    } else {
      if (this.gallerySelectedImages.length >= this.maxReferenceImages) {
        this.showToast(this.t('director.messages.maxSelectImages', { max: this.maxReferenceImages }) || `最多选择 ${this.maxReferenceImages} 张图片`, 'warning')
        return
      }
      this.gallerySelectedImages.push(imagePath)
    }

    if (card) {
      const checkEl = card.querySelector('.gallery-check')
      if (checkEl) {
        checkEl.classList.toggle('hidden')
      }
    }

    this.updateGallerySelectedCount()
  }

  /**
   * 更新图库选中数量
   */
  private updateGallerySelectedCount(): void {
    const countEl = this.getElement<HTMLElement>('gallerySelectedCount')
    if (countEl) {
      countEl.textContent = `${this.gallerySelectedImages.length}`
    }
  }

  /**
   * 更新编辑模式 UI
   */
  private updateGalleryEditModeUI(): void {
    const editBtn = this.getElement<HTMLElement>('galleryEditModeBtn')
    const editActions = this.getElement<HTMLElement>('galleryEditActions')
    const selectActions = this.getElement<HTMLElement>('confirmGallerySelection')

    if (this.galleryEditMode) {
      editBtn?.classList.add('bg-[#FCE300]', 'text-black')
      editActions?.classList.remove('hidden')
      selectActions?.classList.add('hidden')
    } else {
      editBtn?.classList.remove('bg-[#FCE300]', 'text-black')
      editActions?.classList.add('hidden')
      selectActions?.classList.remove('hidden')
    }
  }

  /**
   * 确认图库选择
   */
  async confirmGallerySelection(): Promise<void> {
    if (this.gallerySelectedImages.length === 0) {
      this.showToast(this.t('director.messages.selectAtLeastOne') || '请选择至少一张图片', 'warning')
      return
    }

    this.showToast(this.t('director.messages.loadingImages', { count: this.gallerySelectedImages.length }) || `正在加载 ${this.gallerySelectedImages.length} 张图片...`, 'info')

    for (const imagePath of this.gallerySelectedImages) {
      try {
        const response = await fetch(imagePath)
        const blob = await response.blob()
        const file = new File([blob], imagePath.split('/').pop() || 'image.png', { type: blob.type })
        await this.handleSingleImageUpload(file)
      } catch (error) {
        console.error('加载图片失败:', imagePath, error)
      }
    }

    this.hideGalleryModal()
    this.showToast(this.t('director.messages.addedReferenceImages', { count: this.gallerySelectedImages.length }) || `已添加 ${this.gallerySelectedImages.length} 张参考图`, 'success')
  }

  // ==================== 模板管理 ====================

  /**
   * 加载用户模板
   */
  async loadUserTemplates(): Promise<void> {
    try {
      const electronAPI = (window as any).electronAPI

      if (electronAPI?.isElectron) {
        // 使用正确的 API 名称
        const customTemplates = await electronAPI.loadCustomTemplates?.()
        const templateOverrides = await electronAPI.loadTemplateOverrides?.()
        this.customTemplates = customTemplates || {}
        this.templateOverrides = templateOverrides || {}
      } else {
        const customData = localStorage.getItem('director_custom_templates')
        const overrideData = localStorage.getItem('director_template_overrides')
        this.customTemplates = customData ? JSON.parse(customData) : {}
        this.templateOverrides = overrideData ? JSON.parse(overrideData) : {}
      }

      // 应用覆盖
      for (const key in this.templateOverrides) {
        if (this.isBuiltinTemplate(key)) {
          this.styleTemplates[key] = { ...this.styleTemplates[key], ...this.templateOverrides[key] }
        }
      }

      console.log('[DirectorPage] 已加载用户模板:', Object.keys(this.customTemplates).length)
    } catch (error) {
      console.error('[DirectorPage] 加载用户模板失败:', error)
    }
  }

  /**
   * 显示模板模态框
   */
  showTemplateModal(): void {
    const modal = this.getElement<HTMLElement>('directorTemplateModal')
    if (modal) {
      modal.classList.remove('hidden')
      this.renderTemplateList()
    }
  }

  /**
   * 隐藏模板模态框
   */
  hideTemplateModal(): void {
    const modal = this.getElement<HTMLElement>('directorTemplateModal')
    if (modal) {
      modal.classList.add('hidden')
    }
  }

  /**
   * 渲染模板列表
   */
  renderTemplateList(): void {
    const loading = document.getElementById('templateListLoading')
    const list = this.getElement<HTMLElement>('directorTemplateList')
    if (!list) return

    // 隐藏加载状态
    if (loading) loading.classList.add('hidden')

    list.innerHTML = ''

    // 渲染内置模板
    Object.entries(this.styleTemplates).forEach(([key, template]) => {
      const card = this.createTemplateCard(key, template, true)
      list.appendChild(card)
    })

    // 渲染自定义模板
    Object.entries(this.customTemplates).forEach(([key, template]) => {
      const card = this.createTemplateCard(key, template, false)
      list.appendChild(card)
    })

    if (list.children.length === 0) {
      list.innerHTML = `
        <div class="col-span-2 text-center py-8 text-[#A1A1AA]">
          <i class="fas fa-folder-open text-4xl mb-4"></i>
          <p>${this.t('director.templates.noTemplates') || '暂无模板'}</p>
        </div>
      `
    }
  }

  /**
   * 创建模板卡片
   */
  private createTemplateCard(key: string, template: StyleTemplate, isBuiltin: boolean): HTMLElement {
    const card = document.createElement('div')
    const isSelected = this.currentTemplate === key || this.currentCustomTemplateKey === key
    const isModified = this.templateOverrides[key] !== undefined

    card.className = `template-card cursor-pointer border-2 ${
      isSelected ? 'border-[#FCE300] bg-[#FCE300] bg-opacity-10' : 'border-[#3F3F46] hover:border-[#FCE300]'
    } bg-[#27272A] rounded-none p-4 transition-all relative group`
    card.dataset.template = key

    const modifiedText = this.t('director.templates.modified') || '已修改'
    const builtinText = this.t('director.templates.builtin') || '内置'
    const customText = this.t('director.templates.custom') || '自定义'
    const badgeHtml = isBuiltin 
      ? (isModified ? `<span class="ml-2 text-xs bg-[#FCE300] text-black px-1 font-bold uppercase">${modifiedText}</span>` : `<span class="text-xs text-[#A1A1AA]">${builtinText}</span>`)
      : `<span class="ml-2 text-xs bg-[#8B5CF6] text-white px-1 font-bold uppercase">${customText}</span>`

    const displayName = this.getTemplateDisplayName(key, template)
    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div class="flex-1 min-w-0">
          <h4 class="font-bold text-[#FAFAFA] flex items-center uppercase tracking-tight">
            ${this.escapeHtmlText(displayName)}
            ${badgeHtml}
          </h4>
          <p class="text-[#A1A1AA] text-sm mt-1 line-clamp-2">${this.escapeHtmlText(template.prefix.substring(0, 80))}...</p>
        </div>
        <button class="edit-template-btn w-8 h-8 bg-[#3F3F46] hover:bg-[#FCE300] text-[#A1A1AA] hover:text-black rounded-none flex items-center justify-center transition-all cursor-pointer ml-2 flex-shrink-0"
                title="${this.t('director.buttons.edit') || '编辑'}">
          <i class="fas fa-edit text-sm"></i>
        </button>
      </div>
    `

    // 点击卡片选择模板
    card.addEventListener('click', (e) => {
      // 如果点击的是编辑按钮，不选择模板
      if ((e.target as HTMLElement).closest('.edit-template-btn')) {
        return
      }
      this.selectTemplate(key)
    })

    // 编辑按钮点击事件
    const editBtn = card.querySelector('.edit-template-btn')
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this.openTemplateEditor(template, key, isBuiltin)
      })
    }

    return card
  }

  /**
   * HTML 文本转义
   */
  private escapeHtmlText(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  /**
   * 获取模板的国际化显示名称
   */
  private getTemplateDisplayName(key: string, template: StyleTemplate): string {
    // 内置模板使用 i18n key
    const builtinTemplateNames: Record<string, string> = {
      anime: this.t('director.templates.styles.anime') || '动画截图风格',
      manga: this.t('director.templates.styles.manga') || '漫画分镜风格',
      movie: this.t('director.templates.styles.movie') || '电影分镜风格',
      webtoon: this.t('director.templates.styles.webtoon') || '韩漫/条漫风格',
      comic: this.t('director.templates.styles.comic') || '美漫风格',
      illustration: this.t('director.templates.styles.illustration') || '插画风格',
      cinematic: this.t('director.templates.styles.cinematic') || '电影级九宫格',
      theatrical: this.t('director.templates.styles.theatrical') || '剧场版动画'
    }
    
    // 如果是内置模板，返回国际化名称；否则返回自定义模板的原名
    if (builtinTemplateNames[key]) {
      return builtinTemplateNames[key]
    }
    return template.name
  }

  /**
   * 获取布局的国际化显示名称
   */
  private getLayoutDisplayName(layoutKey: string): string {
    const layoutNames: Record<string, string> = {
      '6grid': this.t('director.layouts.6grid') || '6格标准',
      '4grid': this.t('director.layouts.4grid') || '4格方正',
      '2closeup': this.t('director.layouts.2closeup') || '2格特写',
      '9grid': this.t('director.layouts.9grid') || '9格全景'
    }
    return layoutNames[layoutKey] || layoutKey
  }

  /**
   * 获取布局的国际化描述
   */
  private getLayoutDisplayDescription(layoutKey: string): string {
    const layoutDescriptions: Record<string, string> = {
      '6grid': this.t('director.layoutDesc.6grid') || '2行×3列，适合完整故事',
      '4grid': this.t('director.layoutDesc.4grid') || '2行×2列，适合转折场景',
      '2closeup': this.t('director.layoutDesc.2closeup') || '1行×2列，适合表情特写',
      '9grid': this.t('director.layoutDesc.9grid') || '3行×3列，适合动作场景'
    }
    return layoutDescriptions[layoutKey] || ''
  }

  /**
   * 选择模板
   */
  selectTemplate(templateKey: string): void {
    const template = this.isBuiltinTemplate(templateKey)
      ? this.styleTemplates[templateKey]
      : this.customTemplates[templateKey]
    if (!template) return

    if (this.isBuiltinTemplate(templateKey)) {
      this.currentTemplate = templateKey
      this.currentCustomTemplateKey = null
    } else {
      this.currentTemplate = null
      this.currentCustomTemplateKey = templateKey
    }
    const displayName = this.getTemplateDisplayName(templateKey, template)

    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = displayName
      nameSpan.classList.add('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.remove('hidden')
    }

    this.hideTemplateModal()
    this.showToast(this.t('director.messages.templateSelected', { name: displayName }) || `已选择「${displayName}」模板`, 'success')
    this.saveCurrentState()
  }

  /**
   * 清除模板
   */
  clearTemplate(): void {
    this.currentTemplate = null
    this.currentCustomTemplateKey = null

    const nameSpan = this.getElement<HTMLElement>('directorTemplateName')
    const clearBtn = this.getElement<HTMLElement>('directorClearTemplate')

    if (nameSpan) {
      nameSpan.textContent = this.t('director.templates.default') || '默认（无模板）'
      nameSpan.classList.remove('text-pink-400')
    }
    if (clearBtn) {
      clearBtn.classList.add('hidden')
    }

    this.saveCurrentState()
  }

  // ==================== 参考图管理 ====================

  /**
   * 触发文件选择
   */
  triggerFileSelection(): void {
    if (this.isGenerating || this.isProcessingFiles) return

    if (this.referenceImages.length >= this.maxReferenceImages) {
      this.showToast(this.t('director.messages.maxUploadImages', { max: this.maxReferenceImages }) || `最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
      return
    }

    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'

    input.addEventListener('change', async (e: Event) => {
      const files = Array.from((e.target as HTMLInputElement).files || [])
      if (files.length > 0) {
        await this.handleMultipleReferenceImageUpload(files)
      }
      input.remove()
    })

    document.body.appendChild(input)
    input.click()
  }

  /**
   * 处理拖拽悬停
   */
  private handleDragOver(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.add('drag-over')
    }
  }

  /**
   * 处理拖拽离开
   */
  private handleDragLeave(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.remove('drag-over')
    }
  }

  /**
   * 处理拖拽放置
   */
  private handleDrop(e: DragEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    if (uploadArea) {
      uploadArea.classList.remove('drag-over')
    }

    const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
    if (files.length > 0) {
      this.handleMultipleReferenceImageUpload(files)
    }
  }

  /**
   * 处理多张参考图上传
   */
  async handleMultipleReferenceImageUpload(files: File[]): Promise<void> {
    if (this.isProcessingFiles) return

    this.isProcessingFiles = true
    let successCount = 0

    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) continue
        if (this.referenceImages.length >= this.maxReferenceImages) {
          this.showToast(this.t('director.messages.maxUploadImages', { max: this.maxReferenceImages }) || `最多上传 ${this.maxReferenceImages} 张参考图`, 'warning')
          break
        }

        try {
          await this.handleSingleImageUpload(file)
          successCount++
        } catch (error) {
          console.error(`处理文件 ${file.name} 失败:`, error)
        }
      }

      this.updateReferenceImagesPreview()
      this.updateGenerateButtonState()

      if (successCount > 0) {
        this.showToast(this.t('director.messages.uploadedImages', { count: successCount }) || `已上传 ${successCount} 张图片`, 'success')
      }
    } finally {
      this.isProcessingFiles = false
    }
  }

  /**
   * 处理单张图片上传
   */
  private async handleSingleImageUpload(file: File): Promise<void> {
    // 先压缩图片
    const compressedFile = await this.compressImage(file)
    
    // 转换为 base64
    const base64 = await this.fileToBase64(compressedFile)

    this.referenceImages.push({
      base64,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'image/jpeg',
      originalFile: compressedFile
    })
  }

  /**
   * 压缩图片
   * @param file 原始图片文件
   * @param maxSizeMB 最大文件大小（MB）
   * @param maxWidthOrHeight 最大宽度或高度（像素）
   * @returns 压缩后的文件，如果压缩失败则返回原文件
   */
  private async compressImage(
    file: File,
    maxSizeMB: number = 2,
    maxWidthOrHeight: number = 2048
  ): Promise<File> {
    // 检查 imageCompression 库是否存在
    const imageCompression = (window as any).imageCompression
    if (typeof imageCompression === 'undefined') {
      console.warn('[DirectorPage] 图片压缩库未加载，使用原图')
      return file
    }

    const options = {
      maxSizeMB,
      maxWidthOrHeight,
      useWebWorker: true,
      // 使用本地文件避免 CSP 限制（Worker 默认从 CDN 加载脚本会被阻止）
      libURL: './cdn/browser-image-compression/browser-image-compression.js',
      fileType: file.type
    }

    try {
      console.log(
        `[DirectorPage] 压缩图片: ${file.name}, 原始大小: ${(file.size / 1024 / 1024).toFixed(2)}MB`
      )
      const compressedFile = await imageCompression(file, options)
      console.log(
        `[DirectorPage] 压缩完成: ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`
      )
      return compressedFile
    } catch (error) {
      console.warn('[DirectorPage] 图片压缩失败，使用原图:', error)
      return file
    }
  }

  /**
   * 文件转 Base64
   */
  private fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 更新参考图预览
   */
  updateReferenceImagesPreview(): void {
    const uploadArea = this.getElement<HTMLElement>('directorUploadArea')
    const preview = this.getElement<HTMLElement>('directorImagePreview')

    if (!preview) return

    if (this.referenceImages.length === 0) {
      if (uploadArea) uploadArea.classList.remove('hidden')
      preview.classList.add('hidden')
      preview.innerHTML = ''
      return
    }

    if (uploadArea) uploadArea.classList.add('hidden')
    preview.classList.remove('hidden')

    // 当有多张参考图时显示"清空全部"按钮
    const clearAllText = this.t('director.buttons.clearAll') || '清空全部'
    const referenceImagesText = this.t('director.labels.referenceImages') || '参考图'
    const clearAllButton = this.referenceImages.length > 1 ? `
      <button onclick="window.directorPage?.clearAllReferenceImages()" 
              class="text-red-400 hover:text-red-300 text-xs transition-colors">
        <i class="fas fa-trash-alt mr-1"></i>${clearAllText}
      </button>
    ` : ''

    preview.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-white text-sm opacity-70">
          <i class="fas fa-images mr-1"></i>
          ${referenceImagesText} (${this.referenceImages.length}/${this.maxReferenceImages})
        </span>
        ${clearAllButton}
      </div>
      <div class="grid grid-cols-4 gap-2 mb-3">
        ${this.referenceImages.map((img, index) => `
          <div class="relative group aspect-square">
            <div class="preview-trigger cursor-pointer relative group/img w-full h-full" data-preview-index="${index}" title="点击预览">
              <img src="data:${img.mimeType};base64,${img.base64}" 
                   class="w-full h-full object-cover rounded-lg transition-transform duration-300 group-hover/img:scale-105" alt="${img.fileName}">
              <div class="absolute inset-0 bg-black/0 group-hover/img:bg-black/40 transition-all duration-300 rounded-lg flex items-center justify-center">
                <i class="fas fa-search-plus text-white text-lg opacity-0 group-hover/img:opacity-100 transition-opacity duration-300"></i>
              </div>
            </div>
            <button class="delete-ref-img absolute top-1 right-1 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full 
                          flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                    data-index="${index}">
              <i class="fas fa-times text-white text-xs"></i>
            </button>
          </div>
        `).join('')}
        ${this.referenceImages.length < this.maxReferenceImages ? `
          <div class="aspect-square border-2 border-dashed border-gray-500 rounded-lg flex items-center justify-center cursor-pointer hover:border-pink-500 transition-colors add-more-ref">
            <i class="fas fa-plus text-gray-400"></i>
          </div>
        ` : ''}
      </div>
    `

    // 绑定删除按钮
    preview.querySelectorAll('.delete-ref-img').forEach(btn => {
      btn.addEventListener('click', (e: Event) => {
        e.stopPropagation()
        const index = parseInt((btn as HTMLElement).dataset.index || '0', 10)
        this.removeReferenceImage(index)
      })
    })

    // 绑定图片预览
    preview.querySelectorAll('.preview-trigger').forEach(trigger => {
      trigger.addEventListener('click', (e: Event) => {
        e.stopPropagation()
        const index = parseInt((trigger as HTMLElement).dataset.previewIndex || '0', 10)
        this.previewReferenceImage(index)
      })
    })

    // 绑定添加更多
    const addMoreBtn = preview.querySelector('.add-more-ref')
    if (addMoreBtn) {
      addMoreBtn.addEventListener('click', () => this.triggerFileSelection())
    }
  }

  /**
   * 删除参考图
   */
  removeReferenceImage(index: number): void {
    this.referenceImages.splice(index, 1)
    this.lastCharacterAnchor = null
    this.updateReferenceImagesPreview()
    this.updateGenerateButtonState()
    this.saveCurrentState()
  }

  /**
   * 预览参考图
   */
  private previewReferenceImage(index: number): void {
    if (index < 0 || index >= this.referenceImages.length) return
    
    // 构建所有参考图的 URL 数组
    const urls = this.referenceImages.map((img) => {
      const mimeType = (img.mimeType || 'image/jpeg').toLowerCase()
      return `data:${mimeType};base64,${img.base64}`
    })
    
    // 使用 ImageViewer 预览
    const imageViewer = (window as any).imageViewerTS
    if (imageViewer?.view) {
      imageViewer.view(urls, index)
    } else if ((this.app as any).viewImage) {
      ;(this.app as any).viewImage(urls, index)
    }
  }

  /**
   * 清除所有参考图（旧方法名，保留兼容）
   */
  clearReferenceImage(): void {
    this.clearAllReferenceImages()
  }

  /**
   * 清空所有参考图
   * @public 供 onclick 调用
   */
  clearAllReferenceImages(): void {
    this.referenceImages = []
    this.lastCharacterAnchor = null
    this.lastGeneratedShots = null
    this.updateReferenceImagesPreview()
    this.updateGenerateButtonState()
    this.saveCurrentState()
    this.showToast(this.t('director.messages.clearedAllReferenceImages') || '已清空所有参考图', 'info')
  }

  // ==================== 模式和布局 ====================

  /**
   * 切换模式
   */
  switchMode(mode: GenerationMode): void {
    this.currentMode = mode

    const singleUI = this.getElement<HTMLElement>('directorSingleModeUI')
    const multiUI = this.getElement<HTMLElement>('directorMultiModeUI')
    const singleLabel = this.getElement<HTMLElement>('directorSingleModeLabel')
    const multiLabel = this.getElement<HTMLElement>('directorMultiModeLabel')
    const generateBtn = this.getElement<HTMLElement>('directorGenerateBtn')

    if (mode === 'single') {
      singleUI?.classList.remove('hidden')
      multiUI?.classList.add('hidden')

      if (singleLabel) {
        singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg text-white font-medium shadow-md transition-all'
      }
      if (multiLabel) {
        multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all'
      }

      const btnSpan = generateBtn?.querySelector('span')
      if (btnSpan) btnSpan.textContent = this.t('director.buttons.generateSingle') || '一键生成漫画分镜'
    } else {
      singleUI?.classList.add('hidden')
      multiUI?.classList.remove('hidden')

      if (singleLabel) {
        singleLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-white bg-opacity-10 hover:bg-opacity-20 rounded-lg text-white transition-all'
      }
      if (multiLabel) {
        multiLabel.className = 'flex-1 flex items-center justify-center cursor-pointer px-4 py-3 bg-gradient-to-r from-orange-500 to-pink-500 rounded-lg text-white font-medium shadow-md transition-all'
      }

      const btnSpan = generateBtn?.querySelector('span')
      if (btnSpan) btnSpan.textContent = this.t('director.buttons.generateBatch') || '批量生成漫画分镜'

      this.updatePromptCount()
    }

    this.updateGenerateButtonState()
    this.saveCurrentState()
  }

  /**
   * 选择布局
   */
  selectLayout(layoutKey: LayoutType): void {
    this.currentLayout = layoutKey
    this.updateLayoutSelection()
    this.saveCurrentState()
  }

  /**
   * 更新布局选择UI
   */
  updateLayoutSelection(): void {
    const cards = document.querySelectorAll<HTMLElement>('.layout-card')
    cards.forEach(card => {
      const isSelected = card.dataset.layout === this.currentLayout
      if (isSelected) {
        // 选中状态：蓝色高亮
        card.classList.add('bg-blue-500', 'bg-opacity-30', 'ring-2', 'ring-blue-400')
        card.classList.remove('bg-[#09090B]', 'border', 'border-[#3F3F46]')
      } else {
        // 未选中状态：深色背景
        card.classList.remove('bg-blue-500', 'bg-opacity-30', 'ring-2', 'ring-blue-400')
        card.classList.add('bg-[#09090B]', 'border', 'border-[#3F3F46]')
      }
    })
  }

  /**
   * 更新提示词计数
   */
  updatePromptCount(): void {
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const countSpan = this.getElement<HTMLElement>('directorPromptCount')

    if (multiSceneInput && countSpan) {
      const prompts = this.parseMultiPrompts(multiSceneInput.value)
      countSpan.textContent = this.t('director.labels.sceneCount', { count: prompts.length }) || `${prompts.length} 个场景`
    }
  }

  /**
   * 解析多提示词
   */
  private parseMultiPrompts(text: string): string[] {
    if (!text?.trim()) return []
    return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
  }

  /**
   * 更新出图数量显示
   */
  updateImageCountDisplay(): void {
    const slider = this.getElement<HTMLInputElement>('directorImageCount')
    const display = this.getElement<HTMLElement>('directorCountDisplay')
    if (slider && display) {
      this.imageCount = parseInt(slider.value)
      display.textContent = this.t('director.labels.imageCountDisplay', { count: this.imageCount }) || `${this.imageCount}张`
    }
  }

  /**
   * 更新生成按钮状态
   */
  updateGenerateButtonState(): void {
    const btn = this.getElement<HTMLButtonElement>('directorGenerateBtn')
    if (btn) {
      btn.disabled = this.isGenerating || this.referenceImages.length === 0
    }
  }

  // ==================== 生成逻辑 ====================

  /**
   * 开始生成
   */
  async startGeneration(): Promise<void> {
    if (this.referenceImages.length === 0) {
      this.showToast(this.t('director.messages.uploadReferenceFirst') || '请先上传参考图', 'warning')
      return
    }

    const api = this.getApi()
    if (!api?.apiKey) {
      this.showToast(this.t('director.messages.configureApiKey') || '请先在设置中配置 API Key', 'error')
      return
    }

    if (this.isGenerating) return

    if (this.currentMode === 'multi') {
      await this.startMultiGeneration()
    } else {
      await this.startSingleGeneration()
    }
  }

  /**
   * 单模式生成
   */
  private async startSingleGeneration(): Promise<void> {
    this.isGenerating = true
    this.lastCharacterAnchor = null
    this.lastParsedPanels = null
    this.updateGenerateButtonState()
    this.generatedResults = []

    const sceneDescription = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim() || ''
    const imageCount = this.imageCount
    const layout = this.layouts[this.currentLayout]
    const panelCount = layout.rows * layout.cols

    this.clearResultsGrid()
    this.showProgress(this.t('director.progress.analyzingWithCount', { count: imageCount }) || `正在分析参考图... (将生成 ${imageCount} 张)`)

    // 总步骤：分析1 + 生成提示词1 + 生成图片N
    const totalSteps = 2 + imageCount
    let currentStep = 0
    let successCount = 0

    try {
      // Step 1: 分析参考图
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.analyzingReference') || '正在分析参考图...')
      const imageAnalysis = await this.analyzeReferenceImage()
      this.showAnalysisResult(imageAnalysis)

      // Step 2: 生成分镜提示词
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingPrompt') || '正在生成分镜提示词...')
      const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
      this.showPromptResult(comicPrompt)

      // Step 3-N: 生成多张漫画页面
      for (let i = 0; i < imageCount; i++) {
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingComic', { current: i + 1, total: imageCount }) || `正在生成第 ${i + 1}/${imageCount} 张漫画...`)

        try {
          const result = await this.generateComicPage(comicPrompt, layout)
          successCount++

          this.generatedResults.push({
            success: true,
            imageData: result,
            prompt: sceneDescription || (this.t('director.labels.autoAnalysis') || '自动分析'),
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        } catch (error: any) {
          console.error(`第 ${i + 1} 张生成失败:`, error)
          this.generatedResults.push({
            success: false,
            error: error.message,
            prompt: sceneDescription || (this.t('director.labels.autoAnalysis') || '自动分析'),
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        }
      }

      this.hideProgress()
      this.updateResultsHeader(successCount, imageCount)

      if (successCount > 0) {
        this.showToast(this.t('director.messages.generateSuccess', { success: successCount, total: imageCount }) || `成功生成 ${successCount}/${imageCount} 张漫画页面！`, 'success')
        this.saveToHistory(sceneDescription, successCount)
      } else {
        this.showToast(this.t('director.messages.allGenerationFailed') || '所有图片生成失败，请重试', 'error')
      }
    } catch (error: any) {
      console.error('生成失败:', error)
      this.showToast((this.t('director.messages.generateFailed') || '生成失败: ') + error.message, 'error')
      this.hideProgress()
    } finally {
      this.isGenerating = false
      this.updateGenerateButtonState()
    }
  }

  /**
   * 多提示词模式批量生成
   */
  private async startMultiGeneration(): Promise<void> {
    this.lastCharacterAnchor = null
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const prompts = this.parseMultiPrompts(multiSceneInput?.value || '')

    if (prompts.length === 0) {
      this.showToast(this.t('director.messages.enterAtLeastOneScene') || '请输入至少一个场景描述', 'warning')
      return
    }

    this.isGenerating = true
    this.updateGenerateButtonState()
    this.generatedResults = []

    const layout = this.layouts[this.currentLayout]
    const panelCount = layout.rows * layout.cols
    
    // 总步骤：分析1次 + 每个场景2步（提示词+生成）
    const totalSteps = prompts.length * 2 + 1
    let currentStep = 0
    let successCount = 0

    this.clearResultsGrid()
    this.showProgress(this.t('director.progress.analyzingReference') || '正在分析参考图...')

    try {
      // Step 1: 分析参考图（只需一次）
      currentStep++
      this.updateProgress(currentStep, totalSteps, this.t('director.progress.analyzingReference') || '正在分析参考图...')
      const imageAnalysis = await this.analyzeReferenceImage()
      this.showAnalysisResult(imageAnalysis)

      // 为每个提示词生成漫画页面
      for (let i = 0; i < prompts.length; i++) {
        const sceneDescription = prompts[i]
        
        // 生成分镜提示词
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.buildingPrompt', { current: i + 1, total: prompts.length }) || `生成第 ${i + 1}/${prompts.length} 张：构建提示词...`)
        const comicPrompt = await this.generateComicPrompt(imageAnalysis, sceneDescription, panelCount, layout)
        this.showPromptResult(comicPrompt)

        // 生成漫画页面
        currentStep++
        this.updateProgress(currentStep, totalSteps, this.t('director.progress.generatingImage', { current: i + 1, total: prompts.length }) || `生成第 ${i + 1}/${prompts.length} 张：生成图片...`)
        
        try {
          const result = await this.generateComicPage(comicPrompt, layout)
          successCount++

          this.generatedResults.push({
            success: true,
            imageData: result,
            prompt: sceneDescription,
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        } catch (error: any) {
          console.error(`第 ${i + 1} 张生成失败:`, error)
          this.generatedResults.push({
            success: false,
            error: error.message,
            prompt: sceneDescription,
            index: i
          })
          this.addResultCard(this.generatedResults[this.generatedResults.length - 1], i)
        }
      }

      this.hideProgress()
      this.updateResultsHeader(successCount, prompts.length)

      if (successCount > 0) {
        this.showToast(this.t('director.messages.batchGenerateSuccess', { success: successCount, total: prompts.length }) || `批量生成完成！成功 ${successCount}/${prompts.length} 张`, 'success')
      }
    } catch (error: any) {
      console.error('批量生成失败:', error)
      this.showToast((this.t('director.messages.batchGenerateFailed') || '批量生成失败: ') + error.message, 'error')
      this.hideProgress()
    } finally {
      this.isGenerating = false
      this.updateGenerateButtonState()
    }
  }

  /**
   * 分析参考图
   */
  private async analyzeReferenceImage(): Promise<string> {
    const api = this.getApi()
    if (!api?.visionApiKey) {
      const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim()
      const defaultDescription = this.t('director.prompts.defaultSceneDescription') || '请详细描述图片中的场景、人物、环境和氛围。'
      return sceneInput || defaultDescription
    }

    const images = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    // Analysis prompts for vision API - ALWAYS output in English + Japanese for NanoBananaPro compatibility
    const multiImagePrompt = `Analyze these ${images.length} reference images in detail. Output in English with Japanese terms where appropriate.

## Required Analysis (output in English):

### 1. Character Features / キャラクター特徴
- Facial features, hairstyle (color, style, length)
- Clothing details (type, color, patterns, accessories)
- Pose, expression, body proportions

### 2. Scene Environment / 場景環境  
- Location, setting, background elements
- Lighting conditions (direction, color, mood)
- Atmosphere and mood

### 3. Composition & Camera / 構図とカメラ
- Viewing angle, perspective
- Framing, focal points

### 4. Art Style / アートスタイル
- Color palette, saturation levels
- Art style (anime, realistic, etc.)
- Line art style, shading technique

### 5. Consistency Analysis / 一貫性分析
- Visual consistency across all images
- Shared elements and style coherence

Output must be in English. Use concise descriptions suitable for image generation prompts.`
    
    const singleImagePrompt = `Analyze this reference image in detail. Output in English with Japanese terms where appropriate.

## Required Analysis (output in English):

### 1. Character Features / キャラクター特徴
- Facial features, hairstyle (color, style, length)
- Clothing details (type, color, patterns, accessories)
- Pose, expression, body proportions

### 2. Scene Environment / 場景環境
- Location, setting, background elements
- Lighting conditions (direction, color, mood)
- Atmosphere and mood

### 3. Composition & Camera / 構図とカメラ
- Viewing angle, perspective
- Framing, focal points

### 4. Art Style / アートスタイル
- Color palette, saturation levels
- Art style (anime, realistic, etc.)
- Line art style, shading technique

Output must be in English. Use concise descriptions suitable for image generation prompts.`

    const analysisPrompt = images.length > 1 ? multiImagePrompt : singleImagePrompt

    return new Promise((resolve, reject) => {
      let result = ''

      // 使用导演模式选择的图像理解模型
      console.log('📸 导演模式使用视觉模型:', this.visionModel)

      api.analyzeImagesStream(
        images,
        analysisPrompt,
        this.visionModel,
        null,
        (chunk: string) => { result += chunk },
        () => { resolve(result) },
        (error: Error) => {
          const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')?.value.trim()
          if (sceneInput) {
            resolve(sceneInput)
          } else {
            reject(error)
          }
        }
      )
    })
  }

  /**
   * 生成分镜提示词 - 优先使用 Gem AI 生成 JSON 格式，回退到模板方式
   */
  private async generateComicPrompt(
    imageAnalysis: string,
    sceneDescription: string,
    panelCount: number,
    layout: LayoutConfig
  ): Promise<string> {
    // 获取当前模板的提示词
    let templatePrefix = ''
    let templateSuffix = ''
    let templateNegative = ''
    
    const currentTemplateData = this.getCurrentTemplateData()
    
    if (currentTemplateData) {
      templatePrefix = currentTemplateData.prefix || ''
      templateSuffix = currentTemplateData.suffix || ''
      templateNegative = currentTemplateData.negative || ''
    }

    // 尝试使用 Gem AI 生成 JSON 格式（需要有参考图片和 Vision API Key）
    const api = this.getApi()
    if (this.referenceImages.length > 0 && api.visionApiKey) {
      try {
        console.log('[DirectorPage] 尝试使用 Gem AI 生成 JSON shots...')
        const jsonShots = await this.generateJsonShots(imageAnalysis, sceneDescription, panelCount, layout)
        if (jsonShots && jsonShots.length > 0) {
          console.log('[DirectorPage] Gem AI 生成成功:', jsonShots.length, '个分镜')
          // 缓存 shots 数据，用于生成视频提示词
          this.lastGeneratedShots = jsonShots
          return this.convertJsonShotsToPrompt(jsonShots, panelCount, layout, templatePrefix, templateSuffix, templateNegative)
        }
      } catch (error) {
        console.warn('[DirectorPage] Gem AI 生成失败，回退到模板方式:', error)
      }
    }

    // 回退到模板方式 — 尝试从图片分析结果中提取基础角色锚点
    if (!this.lastCharacterAnchor && imageAnalysis) {
      this.lastCharacterAnchor = this.extractAnchorFromAnalysis(imageAnalysis)
    }
    console.log('[DirectorPage] 使用模板方式生成提示词')
    return this.generateTemplatePrompt(imageAnalysis, sceneDescription, panelCount, layout, templatePrefix, templateSuffix, templateNegative)
  }

  /**
   * 使用 Gem 系统提示词生成 JSON shots
   */
  private async generateJsonShots(
    imageAnalysis: string,
    sceneDescription: string,
    panelCount: number,
    layout: LayoutConfig
  ): Promise<Array<{ shot_number: string; prompt_text: string }> | null> {
    const api = this.getApi()
    
    // 准备参考图片
    const images = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    // 计算视角分布（根据分镜数量动态调整）
    const viewDistribution = this.calculateViewDistribution(panelCount)

    // 获取当前选中的风格模板
    const styleConfig = this.getStyleConfigForJsonShots()

    // 构建完整的 Gem 提示词
    const userInput = `
## 参考图分析结果
${imageAnalysis}

## 用户场景描述
${sceneDescription || '根据参考图生成连续的分镜画面'}

## 布局要求
- 分镜数量: ${panelCount}
- 布局: ${layout.rows}行 x ${layout.cols}列
- 画幅比例: ${layout.ratio || '16:9'}

## 视角分布要求
${viewDistribution}

## 风格要求
${styleConfig.styleInstructions}

请严格按照以下 JSON 格式输出 ${panelCount} 个分镜提示词：
\`\`\`json
{
  "character_anchor": "[精确人物描述: 性别、年龄、发型、瞳色、肤色、服装细节、体型]",
  "shots": [
    {
      "shot_number": "分镜1",
      "prompt_text": "{\"kf\":\"KF1 - EWS - 3s\",\"lens\":\"24mm slow dolly in\",\"spatial\":{\"fg\":\"silhouette of doorframe\",\"mg\":\"figure walking in rain\",\"bg\":\"neon-lit street haze\"},\"action\":\"walks forward with slight lean against wind\",\"light\":\"overhead streetlamp hard warm 3200K ratio 4:1\",\"label\":\"分镜1\"}"
    }
  ]
}
\`\`\`

重要：
1. prompt_text 必须是合法的 JSON 对象字符串（不是自然语言句子）
2. 每个 prompt_text JSON 中必须包含 kf/lens/spatial/action/light/label 六个字段
3. spatial 必须有 fg/mg/bg 三层空间描述
4. action 用一个锚点动词+方式词，禁止堆叠多个动词
5. light 必须指定光源+方向+质量+色温，禁止使用 "cinematic lighting" 等模糊词
6. **character_anchor 为必填，但不要在 prompt_text 中重复角色描述**
${styleConfig.additionalRules}
`

    const systemPrompt = this.getGemSystemPromptForTemplate()
    const fullPrompt = systemPrompt + '\n\n' + userInput

    console.log('[DirectorPage] 使用风格模板:', this.currentTemplate || this.currentCustomTemplateKey || 'default')
    console.log('[DirectorPage] 系统提示词长度:', systemPrompt.length, '字符')
    console.log('[DirectorPage] 风格配置:', styleConfig)

    return new Promise((resolve) => {
      let result = ''
      
      api.analyzeImagesStream(
        images,
        fullPrompt,
        this.visionModel,
        null,
        (chunk: string) => {
          result += chunk
        },
        () => {
          const parsed = this.parseJsonShotsResponse(result, panelCount)
          resolve(parsed)
        },
        () => {
          resolve(null)
        }
      )
    })
  }

  /**
   * 解析 AI 返回的 JSON shots 响应
   */
  private parseJsonShotsResponse(
    response: string,
    expectedCount: number
  ): Array<{ shot_number: string; prompt_text: string }> | null {
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/)
      let jsonStr = jsonMatch ? jsonMatch[1] : response
      
      const jsonObjMatch = jsonStr.match(/\{[\s\S]*"shots"[\s\S]*\}/)
      if (jsonObjMatch) {
        jsonStr = jsonObjMatch[0]
      }

      const parsed = JSON.parse(jsonStr)
      
      if (parsed.character_anchor && typeof parsed.character_anchor === 'string') {
        this.lastCharacterAnchor = parsed.character_anchor
        console.log('[DirectorPage] 角色锚点:', parsed.character_anchor.substring(0, 100), '...')
      }

      if (parsed.shots && Array.isArray(parsed.shots)) {
        let shots = parsed.shots.slice(0, expectedCount)
        
        while (shots.length < expectedCount) {
          const idx = shots.length + 1
          shots.push({
            shot_number: `分镜${idx}`,
            prompt_text: JSON.stringify({ kf: `KF${idx} - FS - 2s`, lens: '50mm static', spatial: { fg: '', mg: 'character neutral pose', bg: 'reference environment' }, action: 'standing naturally', light: 'natural ambient light', label: `分镜${idx}` })
          })
        }

        // Parse each shot's prompt_text into structured JsonPromptPanel
        this.lastParsedPanels = shots.map((shot: { shot_number: string; prompt_text: string }, i: number) => {
          try {
            const p = JSON.parse(shot.prompt_text)
            return {
              id: i + 1,
              shot: p.kf || shot.shot_number,
              lens: p.lens,
              spatial: p.spatial,
              action: p.action,
              light: p.light
            } as JsonPromptPanel
          } catch {
            return { id: i + 1, desc: this.cleanShotDescription(shot.prompt_text) } as JsonPromptPanel
          }
        })

        console.log('[DirectorPage] 解析 JSON shots 成功:', shots.length, '个, 结构化panels:', this.lastParsedPanels?.filter(p => p.lens).length ?? 0, '个')
        return shots
      }
      
      return null
    } catch (error) {
      console.warn('[DirectorPage] JSON 解析失败:', error, '\n原始响应:', response.substring(0, 500))
      return null
    }
  }

  /**
   * 将 JSON shots 转换为最终提示词
   */
  private convertJsonShotsToPrompt(
    shots: Array<{ shot_number: string; prompt_text: string }>,
    panelCount: number,
    layout: LayoutConfig,
    templatePrefix: string,
    templateSuffix: string,
    templateNegative: string
  ): string {
    // 9 宫格路径分流：cinematic → 导演分镜模板，其他 → 通用 9grid（保留比例约束，尊重用户风格）
    if (panelCount === 9 && this.currentLayout === '9grid') {
      if (this.currentTemplate === 'cinematic') {
        return this.generateCinematicGridPrompt(shots, layout, templatePrefix, templateSuffix, templateNegative)
      }
      return this.generateGeneric9GridPrompt(shots, layout, templatePrefix, templateSuffix, templateNegative)
    }

    const characterDescription = this.extractCharacterDescription(shots[0]?.prompt_text || '')
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    const storyContext = sceneInput?.value.trim() || 'Sequential narrative based on reference image'

    const panels = this.lastParsedPanels || shots.map((shot, i) => ({
      id: i + 1,
      desc: this.cleanShotDescription(shot.prompt_text)
    }))

    const prompt: JsonPrompt = {
      composition: `Single comic page, ${panelCount} panels in ${layout.rows}x${layout.cols} grid.`,
      subject: characterDescription,
      style: `${this.getArtStyleDescription()}${templateSuffix}`,
      story: storyContext,
      panels,
      constraints: 'Identical character across all panels.',
      negative: templateNegative || undefined
    }

    return this.buildJsonPrompt(prompt)
  }

  /**
   * 生成电影级九宫格提示词（基于工作流优化）
   * 遵循分形几何原则：总图和单格比例完全一致
   */
  private generateCinematicGridPrompt(
    shots: Array<{ shot_number: string; prompt_text: string }>,
    layout: LayoutConfig,
    templatePrefix?: string,
    templateSuffix?: string,
    templateNegative?: string
  ): string {
    const ratio = this.currentRatio === 'auto' ? layout.ratio : this.currentRatio
    const cinematicTemplate = this.getCurrentTemplateData()
    const suffix = templateSuffix ?? cinematicTemplate?.suffix ?? ''
    const negative = templateNegative ?? cinematicTemplate?.negative ?? ''

    const characterDescription = this.extractCharacterDescription(shots[0]?.prompt_text || '')
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    const storyDescription = sceneInput?.value.trim() || 'Continuous cinematic sequence with clear narrative progression'

    const panels = this.lastParsedPanels || shots.map((shot, i) => ({
      id: i + 1,
      desc: this.cleanShotDescription(shot.prompt_text)
    }))

    const prompt: JsonPrompt = {
      composition: `Cinematic Contact Sheet, ONE master image, 3x3 storyboard grid. Aspect ratio: ${ratio}. Symmetrical grid, hard borders, clean white dividing lines.`,
      subject: characterDescription,
      style: `Photorealistic, 8K resolution${suffix}. Motivated lighting from specific sources.`,
      story: storyDescription,
      panels,
      constraints: 'Identical character across ALL 9 panels.',
      negative: negative || undefined
    }

    return this.buildJsonPrompt(prompt)
  }

  /**
   * 通用 9 宫格提示词生成（非 cinematic 模板 + 9grid 布局）
   * 保留 9 宫格比例约束和网格要求，但使用用户选择的风格 prefix/suffix/negative
   */
  private generateGeneric9GridPrompt(
    shots: Array<{ shot_number: string; prompt_text: string }>,
    layout: LayoutConfig,
    templatePrefix: string,
    templateSuffix: string,
    templateNegative: string
  ): string {
    const ratio = this.currentRatio === 'auto' ? layout.ratio : this.currentRatio
    const characterDescription = this.extractCharacterDescription(shots[0]?.prompt_text || '')
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    const storyDescription = sceneInput?.value.trim() || 'Continuous sequence with clear narrative progression'

    const panels = this.lastParsedPanels || shots.map((shot, i) => ({
      id: i + 1,
      desc: this.cleanShotDescription(shot.prompt_text)
    }))

    const prompt: JsonPrompt = {
      composition: `3x3 grid storyboard, 9 equal panels. Aspect ratio: ${ratio}. Symmetrical grid, hard borders.`,
      subject: characterDescription,
      style: `${this.getArtStyleDescription()}${templateSuffix}`,
      story: storyDescription,
      panels,
      constraints: 'Identical character across ALL panels.',
      negative: templateNegative || undefined
    }

    return this.buildJsonPrompt(prompt)
  }

  /**
   * 从提示词中提取角色描述（用于保持一致性）
   */
  private extractCharacterDescription(promptText: string): string {
    // When anchor exists, embed it ONCE here as the single authoritative definition.
    // Shots reference it via short tag to avoid 11x repetition that drowns layout instructions.
    if (this.lastCharacterAnchor) {
      return `${this.lastCharacterAnchor}. Maintain exact facial proportions, hairstyle, hair color, eye color, skin tone, and outfit from reference in every panel.`
    }

    let description = promptText
      .replace(/^(Wide shot|Long shot|Medium shot|Close-up|Extreme close-up|Over-the-shoulder|POV|Dutch angle|Low angle|High angle|Back view|Cowboy shot|Full body|ECU|EWS)[,:]\s*/gi, '')
      .replace(/^(KF\d+\s*[-–]\s*\w[\w\s]*[-–]\s*\d+s)[,:]\s*/gi, '')
      .replace(/'分镜\d+' in the top-left corner\.?\s*/gi, '')
      .replace(/No timecode,?\s*no subtitles\.?\s*/gi, '')
      .replace(/[,.]?\s*(masterpiece|best quality|high detail|8K|cinematic lighting|photorealistic|sequence photography|natural depth of field|award-winning)[,.\s]*/gi, '')
      .replace(/Cinematic (keyframe|Contact Sheet)[,.\s]*/gi, '')
      .trim()
    
    return description || 'Based on reference image'
  }

  /**
   * 从 Vision API 的图片分析结果中提取基础角色锚点（回退方案）
   * 用于 Gem AI 不可用时仍能提供基本的角色一致性描述
   */
  private extractAnchorFromAnalysis(analysis: string): string | null {
    const characterSection = analysis.match(
      /(?:Character Features|キャラクター特徴|Character|人物)[:\s/]*[\s\S]*?(?=###|$)/i
    )
    if (!characterSection) return null

    const section = characterSection[0]
      .replace(/^#+.*$/gm, '')
      .replace(/[-*]\s*/g, '')
      .trim()
      .split('\n')
      .filter(line => line.trim().length > 5)
      .join(', ')
      .substring(0, 500)

    return section || null
  }

  /**
   * 构建 JSON 格式的图片生成提示词
   */
  private buildJsonPrompt(prompt: JsonPrompt): string {
    const compact = {
      c: prompt.composition,
      s: prompt.subject,
      st: prompt.style,
      d: prompt.story,
      p: prompt.panels.map(p => {
        if (p.lens || p.spatial || p.action || p.light) {
          return {
            i: p.id,
            ...(p.shot && { sh: p.shot }),
            ...(p.lens && { l: p.lens }),
            ...(p.spatial && { sp: p.spatial }),
            ...(p.action && { a: p.action }),
            ...(p.light && { li: p.light })
          }
        }
        return { i: p.id, d: p.desc || '' }
      }),
      x: prompt.constraints,
      ...(prompt.negative && { n: prompt.negative })
    }
    return JSON.stringify(compact)
  }

  /**
   * 从 Gem AI shot 描述中清理冗余标记，保留核心视觉描述
   */
  private cleanShotDescription(promptText: string): string {
    return promptText
      .replace(/'分镜\d+' in the top-left corner\.?\s*/gi, '')
      .replace(/No timecode,?\s*no subtitles\.?\s*/gi, '')
      .replace(/same character\s*[-—–]\s*maintain exact facial proportions and outfit from reference[,.]?\s*/gi, '')
      .replace(/maintain exact facial proportions[^.]*\.\s*/gi, '')
      .replace(/Cinematic (keyframe|Contact Sheet)[,.\s]*/gi, '')
      .replace(/award-winning trailer storyboard panel[,.\s]*/gi, '')
      .trim()
  }

  /**
   * 生成 Sora2 视频提示词
   * @param shots 分镜数组
   * @param characterCard 角色卡名称（如 @jhrsa.glacialwil）
   */
  generateSora2VideoPrompt(
    shots: Array<{ shot_number: string; prompt_text: string }>,
    characterCard: string = ''
  ): string {
    const videoSequences = shots.map((shot, i) => {
      // 提取镜头类型和描述
      const shotText = shot.prompt_text
        .replace(/'分镜\d+' in the top-left corner\.?\s*/gi, '')
        .replace(/No timecode,?\s*no subtitles\.?\s*/gi, '')
        .trim()
      
      return `${i + 1}. ${shotText}`
    }).join('\n')

    return this.sora2VideoPromptTemplate
      .replace('{CHARACTER_CARD}', characterCard)
      .replace('{VIDEO_SEQUENCES}', videoSequences)
  }

  /**
   * 获取当前生成的分镜数据（供外部调用生成视频提示词）
   */
  getGeneratedShots(): Array<{ shot_number: string; prompt_text: string }> | null {
    // 从最近的生成结果中解析 shots
    // 这里返回缓存的 shots 数据
    return this.lastGeneratedShots || null
  }

  // 缓存最近生成的 shots、解析后的 panels 和角色锚点
  private lastGeneratedShots: Array<{ shot_number: string; prompt_text: string }> | null = null
  private lastParsedPanels: JsonPromptPanel[] | null = null
  private lastCharacterAnchor: string | null = null

  /**
   * 模板方式生成提示词（回退模式）
   */
  private generateTemplatePrompt(
    imageAnalysis: string,
    sceneDescription: string,
    panelCount: number,
    layout: LayoutConfig,
    templatePrefix: string,
    templateSuffix: string,
    templateNegative: string
  ): string {
    const userDescription = sceneDescription || imageAnalysis
    const viewAngles = this.generateViewAngles(panelCount)
    
    const panels: JsonPromptPanel[] = []
    for (let i = 0; i < panelCount; i++) {
      panels.push({ id: i + 1, desc: `${viewAngles[i]}, ${userDescription}` })
    }

    const characterAnchor = this.lastCharacterAnchor || ''

    const prompt: JsonPrompt = {
      composition: `Single comic page, ${panelCount} panels in ${layout.rows}x${layout.cols} grid.`,
      subject: characterAnchor || 'Based on reference image',
      style: `${this.getArtStyleDescription()}${templateSuffix}`,
      story: sceneDescription || imageAnalysis || 'Based on reference image',
      panels,
      constraints: "Each panel labeled top-left. No speech bubbles, no dialogue. Maintain exact character appearance from reference.",
      negative: templateNegative || undefined
    }

    return this.buildJsonPrompt(prompt)
  }

  /**
   * 类型守卫：判断 key 是否为内置模板
   */
  private isBuiltinTemplate(key: string): key is StyleTemplateKey {
    return BUILTIN_TEMPLATE_KEYS.has(key)
  }

  /**
   * 获取当前选中模板的数据（兼容内置模板和自定义模板）
   */
  private getCurrentTemplateData(): StyleTemplate | null {
    if (this.currentTemplate) return this.styleTemplates[this.currentTemplate]
    if (this.currentCustomTemplateKey) return this.customTemplates[this.currentCustomTemplateKey] || null
    return null
  }

  /**
   * 根据当前模板选择对应的 Gem 系统提示词（exhaustive switch）
   * cinematic 使用专用导演级提示词，其他模板使用北风诉苦通用提示词
   */
  private getGemSystemPromptForTemplate(): string {
    switch (this.currentTemplate) {
      case 'cinematic':
        return this.cinematicGemSystemPrompt
      case 'theatrical':
      case 'anime':
      case 'manga':
      case 'movie':
      case 'webtoon':
      case 'comic':
      case 'illustration':
      case null:
        return this.gemSystemPrompt
      default: {
        const _exhaustiveCheck: never = this.currentTemplate
        console.warn('[DirectorPage] Unhandled template in getGemSystemPromptForTemplate:', _exhaustiveCheck)
        return this.gemSystemPrompt
      }
    }
  }

  /**
   * 根据当前选中的风格模板动态生成 Art Style 描述
   * 避免硬编码特定风格，确保提示词与用户选择一致
   */
  private getArtStyleDescription(): string {
    if (!this.currentTemplate) {
      return 'Professional quality, consistent visual style throughout all panels.'
    }
    const styleMap: Record<StyleTemplateKey, string> = {
      anime: 'Professional anime screencap quality with cel shading and TV anime coloring.',
      manga: 'Professional manga quality with ink lines, screentone and dynamic composition.',
      movie: 'Professional cinematic quality with film-grade lighting and depth of field.',
      webtoon: 'Professional webtoon quality with clean lineart and vibrant full-color shading.',
      comic: 'Professional comic book quality with bold lineart and high contrast halftone.',
      illustration: 'Professional illustration quality with rich details and artistic lighting.',
      cinematic: 'Award-winning trailer storyboard quality, cinematic contact sheet with photorealistic 8K keyframes, natural depth of field, emotional progression from setup through payoff.',
      theatrical: 'Professional theatrical anime quality, 劇場版 level cel shading and cinematic composition.'
    }
    return styleMap[this.currentTemplate]
  }

  /**
   * 获取当前风格模板的 JSON shots 配置
   * 直接将风格参数集成到 AI 生成的 JSON 结构中
   */
  private getStyleConfigForJsonShots(): {
    prefix: string
    suffix: string
    negative: string
    shotPrefix: string
    shotSuffix: string
    styleInstructions: string
    additionalRules: string
  } {
    const template = this.currentTemplate
    const templateData = this.getCurrentTemplateData()

    // 默认配置
    const defaultConfig = {
      prefix: '',
      suffix: ', masterpiece, best quality, highly detailed, cinematic lighting',
      negative: 'blurry, lowres, bad anatomy, worst quality, inconsistent style',
      shotPrefix: '',
      shotSuffix: '',
      styleInstructions: '保持角色外观和环境的一致性，使用专业的分镜构图。',
      additionalRules: ''
    }

    if (!templateData || !template) {
      return defaultConfig
    }

    // 根据不同模板返回不同配置（exhaustive switch on StyleTemplateKey）
    switch (template) {
      case 'theatrical':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: '((日本劇場版アニメスタイル:1.5)), ',
          shotSuffix: ', anime cel shading, TV anime coloring, modern anime style',
          styleInstructions: `
【剧场版动画风格要求】
- 严格遵循日本动画电影的撮影技术和画面构成
- 使用 ((権重标记:1.x)) 语法强调关键风格元素
- 每个分镜必须保持劇場版画质水准
- 人物作画必须一致，禁止作画崩壊
- 采用 anime cel shading 和 TV anime coloring
- 参考图的画风必须 100% 复刻到所有分镜

关键标签（必须包含在每个 shot 中）:
- 劇場版クオリティ (theatrical quality)
- anime screencap (动画截屏)
- masterpiece, best quality
- cinematic lighting
- depth of field`,
          additionalRules: `
6. 【剧场版专用】每个 shot 必须包含日式动画权重标签如 ((style:1.5))
7. 【剧场版专用】禁止实写(実写)、3D、不同画风(異なる画風)的元素
8. 【剧场版专用】强调 "参考画像の画風に完全に従って構築" - 完全按照参考图画风构建`
        }

      case 'cinematic':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'Cinematic keyframe, award-winning trailer storyboard panel, ',
          shotSuffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field',
          styleInstructions: `
【电影级导演分镜风格要求 - Trailer Director + Cinematographer + Storyboard Artist】

你是一位获奖预告片导演 + 电影摄影师 + 分镜画师。你的任务：将参考图扩展为一个连贯的电影短片序列，输出 AI 视频就绪的关键帧。

核心原则（不可违反）：
1. 首先分析完整构图：识别所有关键主体（人物/群体/载具/物体/动物/道具/环境元素），描述空间关系和互动
2. 禁止猜测真实身份、确切现实地点或品牌所有权，仅描述可见事实
3. 严格连续性：所有分镜保持相同的主体、服装/外观、环境、时段和光照风格
4. 景深必须真实：广角镜头景深更深，特写镜头景深更浅并带自然散景(bokeh)
5. 禁止引入参考图中不存在的新角色/物体

目标：将画面扩展为 10-20 秒的电影片段，具有清晰的情感递进 (setup → build → turn → payoff)

输出要求 - 电影级 Contact Sheet：
- 输出一张包含所有关键帧的单一主图（Cinematic Contact Sheet / Storyboard Grid）
- 默认网格 3x3，超过 9 帧则使用 4x3 或 5x3
- 每个面板必须清晰标注：KF编号 + 景别类型 + 建议时长
- 所有面板之间严格保持连续性

关键标签（必须包含在每个 shot 中）:
- Cinematic Contact Sheet, award-winning trailer storyboard
- Maintain exact facial proportions, wardrobe, environment, and lighting across all panels
- Natural depth of field (deeper in wides, shallower in close-ups with bokeh)
- Emotional progression: setup → build → turn → payoff`,
          additionalRules: `
6. 【导演级专用】每个 shot 必须标注 KF 编号、景别类型和建议时长（如 "KF1 - Wide Establishing - 2s"）
7. 【导演级专用】情感递进必须遵循 setup → build → turn → payoff 四幕结构
8. 【导演级专用】景深规则：广角用深景深，特写用浅景深+自然散景，禁止全程统一景深
9. 【导演级专用】禁止引入参考图中不存在的新角色或物体
10. 【导演级专用】禁止猜测真实身份、品牌或地名，仅描述可见视觉元素
11. 【关键-角色锚点】必须定义 character_anchor 字段（发色+发型+瞳色+服装细节+体型），但 shot 中只需写 "same character — maintain exact facial proportions and outfit from reference"，不要重复完整描述`
        }

      case 'anime':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'anime screenshot, ',
          shotSuffix: ', anime style, cel shading',
          styleInstructions: '使用动画截图风格，保持赛璐璐着色和清晰线条。',
          additionalRules: ''
        }

      case 'manga':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'manga panel, black and white, ',
          shotSuffix: ', manga style, ink drawing, screentone',
          styleInstructions: '使用漫画分镜风格，黑白墨线，网点效果。',
          additionalRules: ''
        }

      case 'movie':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'movie still, cinematic, ',
          shotSuffix: ', film grain, dramatic lighting, widescreen',
          styleInstructions: '使用电影剧照风格，宽银幕比例，戏剧性光影。',
          additionalRules: ''
        }

      case 'webtoon':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'webtoon panel, full color, ',
          shotSuffix: ', clean lineart, soft shading, vibrant colors',
          styleInstructions: '使用韩式条漫风格，全彩柔和着色，清晰线条。',
          additionalRules: ''
        }

      case 'comic':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'comic book panel, bold lineart, ',
          shotSuffix: ', high contrast, halftone dots, dynamic composition',
          styleInstructions: '使用美式漫画风格，粗线条，高对比度，半调网点。',
          additionalRules: ''
        }

      case 'illustration':
        return {
          prefix: templateData.prefix,
          suffix: templateData.suffix,
          negative: templateData.negative,
          shotPrefix: 'illustration, artistic, ',
          shotSuffix: ', rich details, beautiful lighting, professional illustration',
          styleInstructions: '使用精美插画风格，丰富细节，艺术光影。',
          additionalRules: ''
        }

      default: {
        const _exhaustiveCheck: never = template
        console.warn('[DirectorPage] Unhandled template in getStyleConfigForJsonShots:', _exhaustiveCheck)
        return defaultConfig
      }
    }
  }

  /**
   * 根据分镜数量计算视角分布要求（用于 Gem AI 提示词）
   */
  private calculateViewDistribution(panelCount: number): string {
    if (panelCount === 9) {
      // 9宫格标准分布（北风诉苦原版规则）
      return `- 至少 2个 背后视角 (Back View)
- 至少 3个 过肩视角 (Over-the-Shoulder/OTS)
- 至少 2个 主观视角 (Point of View/POV)
- 剩余 2个 自由选择高张力视角（如 Dutch Angle、Extreme Close-up、Top-Down）`
    } else if (panelCount === 6) {
      // 6宫格分布
      return `- 至少 1个 背后视角 (Back View)
- 至少 2个 过肩视角 (Over-the-Shoulder/OTS)
- 至少 1个 主观视角 (Point of View/POV)
- 剩余 2个 自由选择高张力视角`
    } else if (panelCount === 4) {
      // 4宫格分布
      return `- 至少 1个 背后视角 (Back View)
- 至少 1个 过肩视角 (Over-the-Shoulder/OTS)
- 至少 1个 主观视角 (Point of View/POV)
- 剩余 1个 自由选择高张力视角`
    } else if (panelCount === 2) {
      // 2宫格分布
      return `- 1个 过肩视角 (Over-the-Shoulder/OTS)
- 1个 主观视角或背后视角`
    } else {
      // 其他数量动态计算
      const backView = Math.max(1, Math.floor(panelCount * 0.22))
      const ots = Math.max(1, Math.floor(panelCount * 0.33))
      const pov = Math.max(1, Math.floor(panelCount * 0.22))
      const free = panelCount - backView - ots - pov
      return `- 约 ${backView}个 背后视角 (Back View)
- 约 ${ots}个 过肩视角 (Over-the-Shoulder/OTS)
- 约 ${pov}个 主观视角 (Point of View/POV)
- 约 ${free}个 自由选择高张力视角`
    }
  }

  /**
   * 生成视角分配
   */
  private generateViewAngles(panelCount: number): string[] {
    const viewTypes = [
      'Over-the-Shoulder (OTS) shot',
      'Back View shot',
      'Point of View (POV) shot',
      'Extreme Close-up (ECU) on face/eyes',
      'Cowboy Shot (thigh-up)',
      'Full Body Shot',
      'Low Angle (heroic) shot',
      'High Angle (vulnerable) shot',
      'Dutch Angle (tilted) shot',
      'Upper Body Shot (chest-up)'
    ]

    const angles: string[] = []
    const requiredAngles = [
      'Over-the-Shoulder (OTS) shot',
      'Back View shot',
      'Point of View (POV) shot'
    ]

    for (let i = 0; i < Math.min(requiredAngles.length, panelCount); i++) {
      angles.push(requiredAngles[i])
    }

    while (angles.length < panelCount) {
      const randomIndex = Math.floor(Math.random() * viewTypes.length)
      angles.push(viewTypes[randomIndex])
    }

    // 打乱顺序
    for (let i = angles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[angles[i], angles[j]] = [angles[j], angles[i]]
    }

    return angles
  }

  /**
   * 生成漫画页面
   */
  private async generateComicPage(prompt: string, layout: LayoutConfig): Promise<string> {
    const preparedImages = this.referenceImages.map(img => ({
      base64: img.base64,
      mimeType: img.mimeType || 'image/jpeg'
    }))

    const ratio = this.currentRatio === 'auto' ? layout.ratio : this.currentRatio
    const api = this.getApi()

    console.log('[DirectorPage] 最终提示词长度:', prompt.length, '字符')
    if (prompt.length > 8000) {
      console.warn('[DirectorPage] 提示词超过 8000 字符，可能影响生成质量')
    }

    const result = await api.generateImageWithReference(
      prompt,
      preparedImages,
      ratio,
      1,
      this.currentResolution
    )

    if (result.success && result.urls && result.urls.length > 0) {
      return result.urls[0]
    }

    throw new Error(result.error || (this.t('director.messages.generateFailedShort') || '生成失败'))
  }

  // ==================== 结果显示 ====================

  /**
   * 清空结果网格
   */
  private clearResultsGrid(): void {
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    const grid = this.getElement<HTMLElement>('directorResultsGrid')

    if (emptyState) emptyState.classList.add('hidden')
    if (grid) {
      grid.classList.remove('hidden')
      grid.innerHTML = ''
    }
  }

  /**
   * 显示进度 - 创建完整的进度 UI
   */
  private showProgress(message: string): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    
    const analysisTitle = this.t('director.progress.analysisTitle') || '参考图分析结果'
    const promptTitle = this.t('director.progress.promptTitle') || '生成的提示词'
    const clickToView = this.t('director.assets.clickToView') || '点击查看'
    
    if (progressArea) {
      progressArea.classList.remove('hidden')
      progressArea.innerHTML = `
        <div class="text-center py-8">
          <div class="relative inline-block mb-4">
            <i class="fas fa-film text-6xl text-white opacity-30 animate-pulse"></i>
          </div>
          <p class="text-white text-lg mb-2" id="directorProgressText">${message}</p>
          <div class="w-64 h-2 bg-white bg-opacity-20 rounded-full mx-auto overflow-hidden">
            <div id="directorProgressBar" class="h-full bg-gradient-to-r from-blue-400 to-purple-500 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
          <p class="text-white opacity-50 text-sm mt-2" id="directorProgressStep">${this.t('director.progress.step', { current: 1, total: 4 }) || '步骤 1/4'}</p>
          
          <!-- 资产面板容器（点击打开弹窗） -->
          <div class="mt-6 max-w-lg mx-auto space-y-3">
            <!-- 分析结果面板 -->
            <div id="directorAnalysisPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                 onclick="window.directorPage?.showAssetModal('analysis')">
              <div class="flex justify-between items-center p-3">
                <span class="text-white text-sm font-medium flex items-center">
                  <i class="fas fa-search-plus mr-2 text-blue-400"></i>
                  ${analysisTitle}
                </span>
                <div class="flex items-center space-x-2">
                  <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                  <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                </div>
              </div>
            </div>
            
            <!-- 提示词面板 -->
            <div id="directorPromptPanel" class="hidden bg-white bg-opacity-5 border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-10 transition-all duration-200"
                 onclick="window.directorPage?.showAssetModal('prompt')">
              <div class="flex justify-between items-center p-3">
                <span class="text-white text-sm font-medium flex items-center">
                  <i class="fas fa-magic mr-2 text-purple-400"></i>
                  ${promptTitle}
                </span>
                <div class="flex items-center space-x-2">
                  <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
                  <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    }

    if (resultArea) {
      resultArea.classList.add('hidden')
    }
  }

  /**
   * 更新进度
   */
  private updateProgress(current: number, total: number, message: string): void {
    const progressText = this.getElement<HTMLElement>('directorProgressText')
    const progressBar = this.getElement<HTMLElement>('directorProgressBar')
    const progressStep = this.getElement<HTMLElement>('directorProgressStep')

    if (progressText) progressText.textContent = message
    if (progressBar) {
      progressBar.style.width = `${(current / total) * 100}%`
    }
    if (progressStep) {
      progressStep.textContent = this.t('director.progress.step', { current, total }) || `步骤 ${current}/${total}`
    }
  }

  /**
   * 隐藏进度
   */
  private hideProgress(): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    
    if (progressArea) {
      progressArea.classList.add('hidden')
    }
    
    // 恢复结果区域可见性
    if (resultArea) {
      resultArea.classList.remove('hidden')
    }
    
    // 渲染资产区域（分析结果和提示词卡片）
    this.renderAssetsSection()
  }

  /**
   * 显示分析结果（在进度区域显示面板）
   */
  private showAnalysisResult(analysis: string): void {
    this.lastAnalysisResult = analysis
    const panel = document.getElementById('directorAnalysisPanel')
    if (panel) {
      panel.classList.remove('hidden')
    }
  }

  /**
   * 显示提示词结果（在进度区域显示面板）
   */
  private showPromptResult(prompt: string): void {
    this.lastComicPrompt = prompt
    const panel = document.getElementById('directorPromptPanel')
    if (panel) {
      panel.classList.remove('hidden')
    }
  }

  /**
   * 渲染资产卡片区（在结果区域显示分析结果和提示词）
   */
  private renderAssetsSection(): void {
    const assetsSection = this.getElement<HTMLElement>('directorAssetsSection')
    if (!assetsSection) {
      console.warn('[DirectorPage] 资产区域元素不存在')
      return
    }
    
    // 如果没有任何资产数据，隐藏区域
    if (!this.lastAnalysisResult && !this.lastComicPrompt) {
      assetsSection.classList.add('hidden')
      return
    }
    
    const analysisTitle = this.t('director.assets.analysisCard') || '图像分析'
    const promptTitle = this.t('director.assets.promptCard') || '生成提示词'
    const clickToView = this.t('director.assets.clickToView') || '点击查看'
    
    let html = ''
    
    // 分析结果卡片（点击打开弹窗）
    if (this.lastAnalysisResult) {
      html += `
        <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
             onclick="window.directorPage?.showAssetModal('analysis')">
          <div class="flex justify-between items-center p-3">
            <span class="text-white text-sm font-medium flex items-center">
              <i class="fas fa-search-plus mr-2 text-blue-400"></i>
              ${analysisTitle}
            </span>
            <div class="flex items-center space-x-2">
              <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
              <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
            </div>
          </div>
        </div>
      `
    }
    
    // 提示词卡片（点击打开弹窗）
    if (this.lastComicPrompt) {
      html += `
        <div class="bg-[#27272A] border border-white border-opacity-10 rounded-lg overflow-hidden cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all duration-200"
             onclick="window.directorPage?.showAssetModal('prompt')">
          <div class="flex justify-between items-center p-3">
            <span class="text-white text-sm font-medium flex items-center">
              <i class="fas fa-magic mr-2 text-purple-400"></i>
              ${promptTitle}
            </span>
            <div class="flex items-center space-x-2">
              <span class="text-white text-opacity-50 text-xs">${clickToView}</span>
              <i class="fas fa-external-link-alt text-white text-opacity-50 text-xs"></i>
            </div>
          </div>
        </div>
      `
    }
    
    assetsSection.innerHTML = html
    assetsSection.classList.remove('hidden')
    
    console.log('[DirectorPage] 资产区域已渲染:', {
      hasAnalysis: !!this.lastAnalysisResult,
      hasPrompt: !!this.lastComicPrompt
    })
  }

  /**
   * 显示资产弹窗
   */
  showAssetModal(type: 'analysis' | 'prompt'): void {
    const modal = document.getElementById('directorAssetModal')
    const titleIcon = document.getElementById('assetModalIcon')
    const titleText = document.getElementById('assetModalTitleText')
    const content = document.getElementById('assetModalContent')
    
    if (!modal || !content) {
      console.warn('[DirectorPage] 资产弹窗元素不存在')
      return
    }
    
    // 设置当前显示的资产类型
    this.currentModalType = type
    
    if (type === 'analysis') {
      if (titleIcon) titleIcon.className = 'fas fa-search-plus mr-2 text-blue-400'
      if (titleText) titleText.textContent = this.t('director.assets.analysisCard') || '图像分析'
      content.textContent = this.lastAnalysisResult || (this.t('director.progress.noAnalysis') || '未进行图像分析')
    } else if (type === 'prompt') {
      if (titleIcon) titleIcon.className = 'fas fa-magic mr-2 text-purple-400'
      if (titleText) titleText.textContent = this.t('director.assets.promptCard') || '生成提示词'
      content.textContent = this.lastComicPrompt || ''
    }
    
    // 显示弹窗
    modal.classList.remove('hidden')
    
    // 添加 ESC 键关闭
    this.modalEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeAssetModal()
      }
    }
    document.addEventListener('keydown', this.modalEscHandler)
    
    // 点击背景关闭
    modal.onclick = (e) => {
      if (e.target === modal) {
        this.closeAssetModal()
      }
    }
    
    console.log('[DirectorPage] 打开资产弹窗:', type)
  }

  /**
   * 添加结果卡片
   */
  private addResultCard(result: DirectorResult, index: number): void {
    const grid = this.getElement<HTMLElement>('directorResultsGrid')
    if (!grid) return

    const resultArea = this.getElement<HTMLElement>('directorResultArea')
    if (resultArea) resultArea.classList.remove('hidden')
    grid.classList.remove('hidden')

    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    if (emptyState) emptyState.classList.add('hidden')

    const card = document.createElement('div')
    card.className = 'bg-white bg-opacity-5 rounded-lg p-4 animate-fade-in'
    card.dataset.index = String(index)

    if (result.success && result.imageData) {
      const imageSrc = this.getImageSrc(result.imageData)
      const comicPanelAlt = this.t('director.labels.comicPanel', { index: index + 1 }) || `漫画分镜 ${index + 1}`
      const downloadTitle = this.t('director.buttons.downloadImage') || '下载图片'
      const viewTitle = this.t('director.buttons.viewLarge') || '查看大图'
      const successText = this.t('director.labels.generateSuccess') || '生成成功'
      card.innerHTML = `
        <div class="relative group">
          <img src="${imageSrc}" alt="${comicPanelAlt}" class="w-full h-48 object-cover rounded-lg mb-2" loading="lazy">
          <div class="absolute inset-0 bg-black bg-opacity-50 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center space-x-2">
            <button class="download-single bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="${downloadTitle}">
              <i class="fas fa-download"></i>
            </button>
            <button class="preview-result bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" data-index="${index}" title="${viewTitle}">
              <i class="fas fa-expand"></i>
            </button>
          </div>
        </div>
        <p class="text-white text-xs truncate">${result.prompt}</p>
        <div class="flex items-center justify-between mt-2">
          <span class="text-green-400 text-xs"><i class="fas fa-check-circle mr-1"></i>${successText}</span>
          <span class="text-gray-400 text-xs">#${index + 1}</span>
        </div>
      `

      // 绑定按钮事件
      const downloadBtn = card.querySelector('.download-single')
      if (downloadBtn) {
        downloadBtn.addEventListener('click', () => this.downloadSingleResult(index))
      }
      const previewBtn = card.querySelector('.preview-result')
      if (previewBtn) {
        previewBtn.addEventListener('click', () => this.previewResult(index))
      }
    } else {
      const failedText = this.t('director.labels.generateFailed') || '生成失败'
      card.innerHTML = `
        <div class="h-48 bg-red-500 bg-opacity-20 rounded-lg flex items-center justify-center mb-2 relative">
          <i class="fas fa-exclamation-triangle text-red-400 text-2xl"></i>
          <div class="absolute top-1 right-1 text-gray-400 text-xs">#${index + 1}</div>
        </div>
        <p class="text-white text-xs truncate mb-2">${result.prompt}</p>
        <div class="bg-red-600 bg-opacity-20 rounded p-2">
          <p class="text-red-300 text-xs">${result.error || failedText}</p>
        </div>
      `
    }

    grid.appendChild(card)
  }

  /**
   * 更新结果标题
   */
  private updateResultsHeader(successCount: number, totalCount: number): void {
    const countSpan = this.getElement<HTMLElement>('directorResultCount')
    const downloadAllBtn = this.getElement<HTMLElement>('directorDownloadAllBtn')

    if (countSpan) {
      countSpan.textContent = this.t('director.labels.successCount', { success: successCount, total: totalCount }) || `成功 ${successCount}/${totalCount} 张`
    }
    if (downloadAllBtn) {
      if (successCount > 1) {
        downloadAllBtn.classList.remove('hidden')
      } else {
        downloadAllBtn.classList.add('hidden')
      }
    }
  }

  /**
   * 获取图片源
   */
  private getImageSrc(imageData: string): string {
    if (imageData.startsWith('data:') || imageData.startsWith('http')) {
      return imageData
    }
    return `data:image/png;base64,${imageData}`
  }

  // ==================== 下载功能 ====================

  /**
   * 下载结果
   */
  downloadResult(): void {
    if (this.generatedResults.length > 0) {
      this.downloadSingleResult(0)
    }
  }

  /**
   * 下载单张结果
   */
  downloadSingleResult(index: number): void {
    const result = this.generatedResults[index]
    if (!result?.success || !result.imageData) return

    const imageSrc = this.getImageSrc(result.imageData)
    const filename = `comic-panel-${index + 1}-${Date.now()}.png`
    this.downloadImage(imageSrc, filename)
  }

  /**
   * 下载图片
   */
  private downloadImage(src: string, filename: string): void {
    const a = document.createElement('a')
    a.href = src
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  /**
   * 预览结果
   */
  previewResult(index: number): void {
    const result = this.generatedResults[index]
    if (!result?.success || !result.imageData) return

    const imageSrc = this.getImageSrc(result.imageData)
    const viewImage = (this.app as any).viewImage
    if (viewImage) {
      viewImage([imageSrc], 0)
    } else {
      window.open(imageSrc, '_blank')
    }
  }

  /**
   * 下载全部结果
   */
  downloadAllResults(): void {
    const successResults = this.generatedResults.filter(r => r.success)
    if (successResults.length === 0) {
      this.showToast(this.t('director.messages.noDownloadableImages') || '没有可下载的图片', 'warning')
      return
    }

    this.showToast(this.t('director.messages.startDownloading', { count: successResults.length }) || `开始下载 ${successResults.length} 张图片...`, 'info')

    successResults.forEach((result, i) => {
      setTimeout(() => {
        if (result.imageData) {
          const imageSrc = this.getImageSrc(result.imageData)
          const filename = `comic-panel-${result.index + 1}-${Date.now()}.png`
          this.downloadImage(imageSrc, filename)
        }
      }, i * 500)
    })
  }

  // ==================== 结果导航方法 ====================

  /**
   * 显示单图结果
   */
  showResult(imageData: string): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')

    if (progressArea) progressArea.classList.add('hidden')

    if (resultArea) {
      resultArea.classList.remove('hidden')
      
      const imageSrc = this.getImageSrc(imageData)

      resultArea.innerHTML = `
        <div class="space-y-4">
          <div class="relative group">
            <img src="${imageSrc}" 
                 alt="${this.t('director.labels.generatedComicPage') || '生成的漫画页面'}" 
                 class="w-full rounded-lg shadow-lg cursor-pointer"
                 onclick="window.directorPage?.previewCurrentResult()">
            <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
              <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
            </div>
          </div>
          <div class="flex justify-center space-x-4">
            <button id="directorDownloadBtn" 
                    class="px-6 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors">
              <i class="fas fa-download mr-2"></i>${this.t('director.buttons.downloadImage') || '下载图片'}
            </button>
            <button id="directorRegenerateBtn" 
                    class="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors">
              <i class="fas fa-redo mr-2"></i>${this.t('director.buttons.regenerate') || '重新生成'}
            </button>
          </div>
        </div>
      `

      // 重新绑定按钮事件
      document.getElementById('directorDownloadBtn')?.addEventListener('click', () => this.downloadCurrentResult())
      document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration())
    }
  }

  /**
   * 显示多图结果（主图+缩略图导航+左右箭头）
   */
  showMultiResults(): void {
    const progressArea = this.getElement<HTMLElement>('directorProgressArea')
    const resultArea = this.getElement<HTMLElement>('directorResultArea')

    if (progressArea) progressArea.classList.add('hidden')

    if (!resultArea) return

    const successResults = this.generatedResults.filter(r => r.success)
    const totalCount = this.generatedResults.length
    const successCount = successResults.length

    if (successCount === 0) {
      resultArea.classList.add('hidden')
      return
    }

    resultArea.classList.remove('hidden')
    
    // 找到第一个成功的结果
    while (this.currentResultIndex < this.generatedResults.length && !this.generatedResults[this.currentResultIndex].success) {
      this.currentResultIndex++
    }
    if (this.currentResultIndex >= this.generatedResults.length) {
      this.currentResultIndex = this.generatedResults.findIndex(r => r.success)
    }

    const currentResult = this.generatedResults[this.currentResultIndex]
    const imageSrc = currentResult?.imageData ? this.getImageSrc(currentResult.imageData) : ''

    // 生成缩略图
    let thumbnailsHtml = ''
    this.generatedResults.forEach((result, index) => {
      if (result.success && result.imageData) {
        const thumbSrc = this.getImageSrc(result.imageData)
        const isActive = index === this.currentResultIndex
        const thumbAlt = this.t('director.labels.imageNumber', { index: index + 1 }) || `第${index + 1}张`
        thumbnailsHtml += `
          <div class="cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${isActive ? 'border-blue-400 ring-2 ring-blue-400' : 'border-transparent opacity-60 hover:opacity-100'}"
               onclick="window.directorPage?.switchToResult(${index})">
            <img src="${thumbSrc}" alt="${thumbAlt}" class="w-16 h-16 object-cover">
          </div>
        `
      } else {
        thumbnailsHtml += `
          <div class="rounded-lg overflow-hidden border-2 border-red-400 opacity-50 cursor-not-allowed">
            <div class="w-16 h-16 bg-red-500 bg-opacity-20 flex items-center justify-center">
              <i class="fas fa-times text-red-400"></i>
            </div>
          </div>
        `
      }
    })

    const successCountText = this.t('director.labels.successCount', { success: successCount, total: totalCount }) || `成功 ${successCount}/${totalCount} 张`
    const currentCountText = this.t('director.labels.currentImage', { current: this.currentResultIndex + 1, total: totalCount }) || `第 ${this.currentResultIndex + 1}/${totalCount} 张`
    const downloadCurrentText = this.t('director.buttons.downloadCurrent') || '下载当前'
    const downloadAllText = this.t('director.buttons.downloadAll') || '下载全部'
    const regenerateText = this.t('director.buttons.regenerate') || '重新生成'
    
    resultArea.innerHTML = `
      <div class="space-y-4">
        <!-- 统计信息 -->
        <div class="flex items-center justify-between text-white">
          <span class="opacity-70">
            <i class="fas fa-images mr-2"></i>
            ${successCountText}
          </span>
          <span class="text-sm opacity-50" id="directorResultCounter">
            ${currentCountText}
          </span>
        </div>

        <!-- 主图显示 -->
        <div class="relative group">
          <img id="directorMainImage" 
               src="${imageSrc}" 
               alt="${this.t('director.labels.generatedComicPage') || '生成的漫画页面'}" 
               class="w-full rounded-lg shadow-lg cursor-pointer"
               onclick="window.directorPage?.previewCurrentResult()">
          <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition-all rounded-lg flex items-center justify-center">
            <i class="fas fa-search-plus text-white text-3xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
          </div>
          
          <!-- 左右切换按钮 -->
          <button class="absolute left-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                  onclick="window.directorPage?.navigateResult(-1)">
            <i class="fas fa-chevron-left"></i>
          </button>
          <button class="absolute right-2 top-1/2 -translate-y-1/2 bg-black bg-opacity-50 hover:bg-opacity-70 text-white rounded-full w-10 h-10 flex items-center justify-center transition-all"
                  onclick="window.directorPage?.navigateResult(1)">
            <i class="fas fa-chevron-right"></i>
          </button>
        </div>

        <!-- 场景描述 -->
        <div class="bg-white bg-opacity-10 rounded-lg p-3">
          <p class="text-white text-sm opacity-70" id="directorCurrentPrompt">${this.escapeHtmlText(currentResult?.prompt || '')}</p>
        </div>

        <!-- 缩略图列表 -->
        <div class="flex space-x-2 overflow-x-auto pb-2" id="directorThumbnails">
          ${thumbnailsHtml}
        </div>

        <!-- 操作按钮 -->
        <div class="flex justify-center space-x-4 flex-wrap gap-2">
          <button id="directorDownloadCurrentBtn" 
                  class="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-download mr-2"></i>${downloadCurrentText}
          </button>
          <button id="directorDownloadAllBtn" 
                  class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-file-archive mr-2"></i>${downloadAllText} (${successCount})
          </button>
          <button id="directorRegenerateBtn" 
                  class="px-4 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors text-sm">
            <i class="fas fa-redo mr-2"></i>${regenerateText}
          </button>
        </div>
      </div>
    `

    // 绑定按钮事件
    document.getElementById('directorDownloadCurrentBtn')?.addEventListener('click', () => this.downloadCurrentResult())
    document.getElementById('directorDownloadAllBtn')?.addEventListener('click', () => this.downloadAllResults())
    document.getElementById('directorRegenerateBtn')?.addEventListener('click', () => this.startGeneration())
  }

  /**
   * 切换到指定结果
   * @public 供 onclick 调用
   */
  switchToResult(index: number): void {
    if (index >= 0 && index < this.generatedResults.length && this.generatedResults[index].success) {
      this.currentResultIndex = index
      this.updateCurrentResultDisplay()
    }
  }

  /**
   * 导航结果（上一张/下一张，循环）
   * @public 供 onclick 调用
   */
  navigateResult(direction: number): void {
    let newIndex = this.currentResultIndex + direction
    
    // 循环查找下一个成功的结果
    const maxAttempts = this.generatedResults.length
    let attempts = 0
    
    while (attempts < maxAttempts) {
      if (newIndex < 0) newIndex = this.generatedResults.length - 1
      if (newIndex >= this.generatedResults.length) newIndex = 0
      
      if (this.generatedResults[newIndex].success) {
        this.currentResultIndex = newIndex
        this.updateCurrentResultDisplay()
        return
      }
      
      newIndex += direction
      attempts++
    }
  }

  /**
   * 更新当前结果显示（主图和缩略图高亮）
   */
  updateCurrentResultDisplay(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult || !currentResult.success || !currentResult.imageData) return

    // 更新主图
    const mainImage = document.getElementById('directorMainImage') as HTMLImageElement | null
    if (mainImage) {
      mainImage.src = this.getImageSrc(currentResult.imageData)
    }

    // 更新场景描述
    const promptEl = document.getElementById('directorCurrentPrompt')
    if (promptEl) {
      promptEl.textContent = currentResult.prompt || ''
    }

    // 更新缩略图高亮
    const thumbnails = document.querySelectorAll('#directorThumbnails > div')
    thumbnails.forEach((thumb, index) => {
      if (this.generatedResults[index]?.success) {
        if (index === this.currentResultIndex) {
          thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-blue-400 ring-2 ring-blue-400'
        } else {
          thumb.className = 'cursor-pointer rounded-lg overflow-hidden border-2 transition-all border-transparent opacity-60 hover:opacity-100'
        }
      }
    })

    // 更新计数
    const counterEl = document.getElementById('directorResultCounter')
    if (counterEl) {
      counterEl.textContent = this.t('director.labels.currentImage', { current: this.currentResultIndex + 1, total: this.generatedResults.length }) || `第 ${this.currentResultIndex + 1}/${this.generatedResults.length} 张`
    }
  }

  /**
   * 下载当前显示的结果
   * @public 供 onclick 调用
   */
  downloadCurrentResult(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult || !currentResult.success || !currentResult.imageData) {
      this.showToast(this.t('director.messages.cannotDownloadCurrent') || '当前图片无法下载', 'warning')
      return
    }

    const imageSrc = this.getImageSrc(currentResult.imageData)
    const filename = `comic_page_${this.currentLayout}_${this.currentResultIndex + 1}_${Date.now()}.png`
    this.downloadImage(imageSrc, filename)
  }

  /**
   * 预览当前结果
   * @public 供 onclick 调用
   */
  previewCurrentResult(): void {
    const currentResult = this.generatedResults[this.currentResultIndex]
    if (!currentResult?.success || !currentResult.imageData) return

    const imageSrc = this.getImageSrc(currentResult.imageData)
    this.previewImage(imageSrc)
  }

  /**
   * 全屏预览图片
   * @public 供外部调用
   * @param imageSrc 图片源（URL 或 base64）
   */
  public previewImage(imageSrc: string): void {
    // 创建遮罩层
    const overlay = document.createElement('div')
    overlay.className = 'fixed inset-0 flex items-center justify-center cursor-pointer'
    overlay.style.cssText = `
      z-index: 70000;
      background-color: rgba(0, 0, 0, 0.9);
      opacity: 0;
      transition: opacity 0.3s ease-in-out;
    `

    // 创建图片元素
    const img = document.createElement('img')
    img.src = imageSrc
    img.className = 'object-contain'
    img.style.cssText = `
      max-width: 90vw;
      max-height: 90vh;
      opacity: 0;
      transform: scale(0.9);
      transition: opacity 0.3s ease-in-out, transform 0.3s ease-in-out;
    `
    // 阻止点击图片关闭
    img.onclick = (e: MouseEvent) => e.stopPropagation()

    // 创建关闭按钮
    const closeBtn = document.createElement('button')
    closeBtn.className = 'absolute top-4 right-4 text-white text-3xl hover:text-gray-300 transition-colors'
    closeBtn.style.cssText = `
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      line-height: 1;
    `
    closeBtn.innerHTML = '<i class="fas fa-times"></i>'
    closeBtn.onclick = (e: MouseEvent) => {
      e.stopPropagation()
      closeOverlay()
    }

    // 关闭函数（带动画）
    const closeOverlay = (): void => {
      // 移除 ESC 事件监听
      document.removeEventListener('keydown', escHandler)
      
      // 渐出动画
      overlay.style.opacity = '0'
      img.style.opacity = '0'
      img.style.transform = 'scale(0.9)'
      
      // 动画结束后移除元素
      setTimeout(() => {
        if (overlay.parentNode) {
          overlay.remove()
        }
      }, 300)
    }

    // ESC 键关闭
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        closeOverlay()
      }
    }
    document.addEventListener('keydown', escHandler)

    // 点击遮罩层关闭
    overlay.onclick = () => closeOverlay()

    // 组装并添加到 DOM
    overlay.appendChild(img)
    overlay.appendChild(closeBtn)
    document.body.appendChild(overlay)

    // 触发渐入动画（需要在下一帧执行）
    requestAnimationFrame(() => {
      overlay.style.opacity = '1'
      img.style.opacity = '1'
      img.style.transform = 'scale(1)'
    })
  }

  /**
   * 保存到历史记录
   */
  private saveToHistory(description: string, successCount: number): void {
    try {
      const successUrls = this.generatedResults
        .filter(r => r.success && r.imageData)
        .map(r => r.imageData!)

      this.app.addToHistory(
        'director',
        description || (this.t('director.labels.directorModeAutoAnalysis') || '导演模式 - 自动分析'),
        successUrls,
        this.currentRatio
      )
      console.log('✅ 导演模式结果已保存到历史记录')
    } catch (error) {
      console.error('保存历史记录失败:', error)
    }
  }

  // ==================== 状态管理 ====================

  /**
   * 收集状态
   */
  collectState(): DirectorPageState {
    const sceneInput = this.getElement<HTMLTextAreaElement>('directorSceneInput')
    const multiSceneInput = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
    const imageCountSlider = this.getElement<HTMLInputElement>('directorImageCount')

    return {
      mode: this.currentMode,
      layout: this.currentLayout,
      ratio: this.currentRatio,
      resolution: this.currentResolution,
      template: this.currentTemplate || this.currentCustomTemplateKey,
      imageCount: imageCountSlider?.value || '1',
      sceneDescription: sceneInput?.value || '',
      multiScenePrompts: multiSceneInput?.value || '',
      referenceImages: this.referenceImages.map(img => ({
        base64: img.base64,
        fileName: img.fileName,
        fileSize: img.fileSize,
        mimeType: img.mimeType
      }))
    }
  }

  /**
   * 应用状态
   */
  applyState(state: DirectorPageState): void {
    if (state.mode) {
      this.currentMode = state.mode
      this.switchMode(state.mode)
    }

    if (state.layout) {
      this.currentLayout = state.layout
      this.selectLayout(state.layout)
    }

    if (state.ratio) this.currentRatio = state.ratio
    if (state.resolution) this.currentResolution = state.resolution
    if (state.template) this.selectTemplate(state.template)

    if (state.imageCount) {
      const slider = this.getElement<HTMLInputElement>('directorImageCount')
      if (slider) {
        slider.value = state.imageCount
        this.imageCount = parseInt(state.imageCount)
        this.updateImageCountDisplay()
      }
    }

    if (state.sceneDescription) {
      const input = this.getElement<HTMLTextAreaElement>('directorSceneInput')
      if (input) input.value = state.sceneDescription
    }

    if (state.multiScenePrompts) {
      const input = this.getElement<HTMLTextAreaElement>('directorMultiSceneInput')
      if (input) {
        input.value = state.multiScenePrompts
        this.updatePromptCount()
      }
    }

    if (state.referenceImages?.length) {
      // 恢复参考图并重新生成 ID
      this.referenceImages = state.referenceImages
        .filter((img): img is DirectorReferenceImage => !!img?.base64)
        .map((img, index) => ({
          ...img,
          id: img.id || Date.now() + index
        }))
      this.updateReferenceImagesPreview()
    }

    this.stateRestored = true
  }

  /**
   * 保存页面状态
   */
  saveState(): void {
    this.saveCurrentStateImmediate()
  }

  /**
   * 恢复页面状态
   */
  async restoreState(): Promise<void> {
    if (this.stateRestored) return

    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.loadState) {
      try {
        const state = await pageStateManager.loadState('director') as DirectorPageState | null
        if (state) {
          this.applyState(state)
          console.log('📥 恢复 DirectorPage 状态:', state)
        }
      } catch (error) {
        console.error('❌ 恢复 DirectorPage 状态失败:', error)
      }
    }

    this.stateRestored = true
  }

  /**
   * 保存当前状态
   */
  saveCurrentState(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.saveState) {
      pageStateManager.saveState('director', this.collectState())
    }
  }

  /**
   * 立即保存状态（无防抖，用于页面失活时）
   */
  private saveCurrentStateImmediate(): void {
    const pageStateManager = (window as any).pageStateManager
    if (pageStateManager?.saveStateImmediate) {
      pageStateManager.saveStateImmediate('director', this.collectState())
    }
  }

  // ==================== 页面生命周期 ====================

  /**
   * 页面激活
   */
  onActivate(): void {
    console.log('导演模式页面已激活')

    this.updateLayoutSelection()
    this.updateGenerateButtonState()

    this.requestIdleCallback(async () => {
      if (!this.stateRestored) {
        await this.restoreState()
      }
      this.switchMode(this.currentMode)
      this.restoreResultsDisplay()
    }, { timeout: 1000 })
  }

  /**
   * 恢复结果显示
   */
  private restoreResultsDisplay(): void {
    const grid = this.getElement<HTMLElement>('directorResultsGrid')
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')

    if (this.generatedResults?.length > 0) {
      if (grid) {
        grid.innerHTML = ''
        grid.classList.remove('hidden')
      }
      if (emptyState) emptyState.classList.add('hidden')

      this.generatedResults.forEach((result, index) => {
        this.addResultCard(result, index)
      })

      const successCount = this.generatedResults.filter(r => r.success).length
      this.updateResultsHeader(successCount, this.generatedResults.length)
    } else {
      this.showEmptyState()
    }
  }

  /**
   * 显示空状态
   */
  private showEmptyState(): void {
    const emptyState = this.getElement<HTMLElement>('directorEmptyState')
    const grid = this.getElement<HTMLElement>('directorResultsGrid')

    if (emptyState) emptyState.classList.remove('hidden')
    if (grid) grid.classList.add('hidden')
  }

  /**
   * 页面停用
   */
  onDeactivate(): void {
    console.log('导演模式页面已失活')
    this.saveCurrentStateImmediate()
  }

  /**
   * 语言切换
   */
  onLanguageChange(): void {
    this.updateLayoutSelection()
  }

  // ==================== 资产弹窗方法 ====================

  /**
   * 关闭资产弹窗
   */
  closeAssetModal(): void {
    const modal = document.getElementById('directorAssetModal')
    if (modal) {
      modal.classList.add('hidden')
    }
    console.log('[DirectorPage] 关闭资产弹窗')
  }

  /**
   * 复制弹窗内容
   */
  async copyModalContent(): Promise<void> {
    const content = this.currentModalType === 'analysis'
      ? this.lastAnalysisResult
      : this.lastComicPrompt
    
    if (!content) {
      this.app.showToast?.(this.t('director.messages.noCopyContent') || '没有可复制的内容', 'warning')
      return
    }
    
    try {
      await navigator.clipboard.writeText(content)
      this.app.showToast?.(this.t('common.copySuccess') || '已复制到剪贴板', 'success')
    } catch (error) {
      console.error('[DirectorPage] 复制失败:', error)
      this.app.showToast?.(this.t('common.copyFailed') || '复制失败', 'error')
    }
  }

  // ==================== 图库编辑模式方法 ====================

  /**
   * 切换图库编辑模式
   */
  toggleGalleryEditMode(): void {
    this.galleryEditMode = !this.galleryEditMode
    
    const editBtn = document.getElementById('galleryEditModeBtn')
    const editActions = document.getElementById('galleryEditActions')
    const confirmBtn = document.querySelector('#galleryModal button[data-action="confirm"]') as HTMLElement
    const cancelBtn = document.querySelector('#galleryModal button[data-action="cancel"]') as HTMLElement
    
    if (this.galleryEditMode) {
      editBtn?.classList.add('text-[#FCE300]', 'border-[#FCE300]')
      editActions?.classList.remove('hidden')
      if (confirmBtn) confirmBtn.classList.add('hidden')
      this.galleryDeleteSelection = []
      this.updateDeleteButtonState()
    } else {
      editBtn?.classList.remove('text-[#FCE300]', 'border-[#FCE300]')
      editActions?.classList.add('hidden')
      if (confirmBtn) confirmBtn.classList.remove('hidden')
      this.galleryDeleteSelection = []
    }
    
    // 重新渲染图库以显示/隐藏选择框
    this.loadGalleryImages()
  }

  /**
   * 更新删除按钮状态
   */
  private updateDeleteButtonState(): void {
    const deleteBtn = document.getElementById('deleteSelectedBtn') as HTMLButtonElement
    if (deleteBtn) {
      deleteBtn.disabled = this.galleryDeleteSelection.length === 0
    }
  }

  /**
   * 添加自定义图库图片
   */
  addCustomGalleryImage(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files || files.length === 0) return
      
      try {
        for (const file of Array.from(files)) {
          const base64 = await this.fileToBase64ForGallery(file)
          const imageData: CustomGalleryImage = {
            id: `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: file.name,
            base64: base64,
            filename: file.name,
            createdAt: new Date().toISOString()
          }
          this.customGalleryImages.push(imageData)
        }
        
        this.saveCustomGalleryToStorage()
        this.loadGalleryImages()
        this.app.showToast?.(this.t('director.messages.addedImages', { count: files.length }) || `已添加 ${files.length} 张图片`, 'success')
      } catch (error) {
        console.error('[DirectorPage] 添加图片失败:', error)
        this.app.showToast?.(this.t('director.messages.addImagesFailed') || '添加图片失败', 'error')
      }
    }
    
    input.click()
  }

  /**
   * 文件转 Base64（用于图库）
   */
  private fileToBase64ForGallery(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 保存自定义图库到存储
   */
  private saveCustomGalleryToStorage(): void {
    try {
      localStorage.setItem('director_custom_gallery', JSON.stringify(this.customGalleryImages))
    } catch (error) {
      console.error('[DirectorPage] 保存自定义图库失败:', error)
    }
  }

  /**
   * 从存储加载自定义图库
   */
  private loadCustomGalleryFromStorage(): void {
    try {
      const data = localStorage.getItem('director_custom_gallery')
      this.customGalleryImages = data ? JSON.parse(data) : []
    } catch {
      this.customGalleryImages = []
    }
  }

  /**
   * 删除选中的自定义图片
   */
  deleteSelectedCustomImages(): void {
    if (this.galleryDeleteSelection.length === 0) return
    
    const confirmMsg = this.t('director.messages.confirmDeleteImages', { count: this.galleryDeleteSelection.length }) || `确定要删除选中的 ${this.galleryDeleteSelection.length} 张图片吗？`
    if (!confirm(confirmMsg)) {
      return
    }
    
    try {
      this.customGalleryImages = this.customGalleryImages.filter(
        img => !this.galleryDeleteSelection.includes(img.id)
      )
      
      this.saveCustomGalleryToStorage()
      this.galleryDeleteSelection = []
      this.updateDeleteButtonState()
      this.loadGalleryImages()
      
      this.app.showToast?.(this.t('director.messages.deletedSelectedImages') || '已删除选中的图片', 'success')
    } catch (error) {
      console.error('[DirectorPage] 删除图片失败:', error)
      this.app.showToast?.(this.t('director.messages.deleteImagesFailed') || '删除图片失败', 'error')
    }
  }

  /**
   * 切换自定义图片的删除选择
   */
  toggleCustomImageDeleteSelection(imageId: string): void {
    const index = this.galleryDeleteSelection.indexOf(imageId)
    if (index >= 0) {
      this.galleryDeleteSelection.splice(index, 1)
    } else {
      this.galleryDeleteSelection.push(imageId)
    }
    this.updateDeleteButtonState()
    this.loadGalleryImages()
  }

  // ==================== 模板编辑器方法 ====================

  /**
   * 打开模板编辑器
   */
  openTemplateEditor(template: StyleTemplate | null, templateKey: string | null, isBuiltin: boolean): void {
    const editor = document.getElementById('directorTemplateEditorModal')
    if (!editor) {
      console.error('[DirectorPage] 模板编辑器不存在: directorTemplateEditorModal')
      return
    }
    
    this.editingTemplateKey = templateKey
    this.editingTemplateIsBuiltin = isBuiltin
    
    // 填充表单
    const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
    const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
    const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
    const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
    const titleEl = document.getElementById('templateEditorTitle')
    const deleteBtn = document.getElementById('templateEditorDeleteBtn')
    const resetBtn = document.getElementById('templateEditorResetBtn')
    
    if (template) {
      if (nameInput) nameInput.value = template.name || ''
      if (prefixInput) prefixInput.value = template.prefix || ''
      if (suffixInput) suffixInput.value = template.suffix || ''
      if (negativeInput) negativeInput.value = template.negative || ''
      if (titleEl) titleEl.textContent = this.t('director.templates.editTemplate') || '编辑模板'
      
      // 内置模板显示重置按钮，自定义模板显示删除按钮
      if (isBuiltin) {
        deleteBtn?.classList.add('hidden')
        resetBtn?.classList.remove('hidden')
      } else {
        deleteBtn?.classList.remove('hidden')
        resetBtn?.classList.add('hidden')
      }
    } else {
      if (nameInput) nameInput.value = ''
      if (prefixInput) prefixInput.value = ''
      if (suffixInput) suffixInput.value = ''
      if (negativeInput) negativeInput.value = ''
      if (titleEl) titleEl.textContent = this.t('director.templates.newTemplate') || '新建模板'
      deleteBtn?.classList.add('hidden')
      resetBtn?.classList.add('hidden')
    }
    
    editor.classList.remove('hidden')
  }

  /**
   * 关闭模板编辑器
   */
  closeTemplateEditor(): void {
    const editor = document.getElementById('directorTemplateEditorModal')
    if (editor) {
      editor.classList.add('hidden')
    }
    this.editingTemplateKey = null
    this.editingTemplateIsBuiltin = false
  }

  /**
   * 创建新模板
   */
  createNewTemplate(): void {
    this.openTemplateEditor(null, null, false)
  }

  /**
   * 保存模板
   */
  saveTemplateFromEditor(): void {
    const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
    const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
    const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
    const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
    
    const name = nameInput?.value?.trim()
    const prefix = prefixInput?.value?.trim() || ''
    const suffix = suffixInput?.value?.trim() || ''
    const negative = negativeInput?.value?.trim() || ''
    
    if (!name) {
      this.app.showToast?.(this.t('director.messages.enterTemplateName') || '请填写模板名称', 'warning')
      return
    }
    
    try {
      const template: StyleTemplate = { name, prefix, suffix, negative }
      
      if (this.editingTemplateKey) {
        if (this.editingTemplateIsBuiltin && this.isBuiltinTemplate(this.editingTemplateKey)) {
          // 覆盖内置模板
          this.templateOverrides[this.editingTemplateKey] = template
          this.styleTemplates[this.editingTemplateKey] = template
        } else {
          // 编辑自定义模板
          this.customTemplates[this.editingTemplateKey] = template
        }
      } else {
        // 新建自定义模板
        const newKey = `custom_${Date.now()}`
        this.customTemplates[newKey] = template
      }
      
      this.saveTemplatesToStorage()
      this.closeTemplateEditor()
      this.renderTemplateList()
      
      this.app.showToast?.(this.t('director.messages.templateSaved') || '模板已保存', 'success')
    } catch (error) {
      console.error('[DirectorPage] 保存模板失败:', error)
      this.app.showToast?.(this.t('director.messages.templateSaveFailed') || '保存模板失败', 'error')
    }
  }

  /**
   * 删除当前模板
   */
  deleteCurrentTemplate(): void {
    if (!this.editingTemplateKey || this.editingTemplateIsBuiltin) return
    
    const confirmMsg = this.t('director.messages.confirmDeleteTemplate') || '确定要删除这个模板吗？'
    if (!confirm(confirmMsg)) return
    
    try {
      delete this.customTemplates[this.editingTemplateKey]
      this.saveTemplatesToStorage()
      
      this.closeTemplateEditor()
      this.renderTemplateList()
      
      this.app.showToast?.(this.t('director.messages.templateDeleted') || '模板已删除', 'success')
    } catch (error) {
      console.error('[DirectorPage] 删除模板失败:', error)
      this.app.showToast?.(this.t('director.messages.templateDeleteFailed') || '删除模板失败', 'error')
    }
  }

  /**
   * 重置当前模板（恢复内置模板默认值）
   */
  resetCurrentTemplate(): void {
    if (!this.editingTemplateKey || !this.editingTemplateIsBuiltin) return
    
    const confirmMsg = this.t('director.messages.confirmResetTemplate') || '确定要恢复此模板的默认值吗？'
    if (!confirm(confirmMsg)) return
    
    try {
      if (!this.editingTemplateKey || !this.isBuiltinTemplate(this.editingTemplateKey)) return
      const original = this.defaultStyleTemplates[this.editingTemplateKey]
      
      if (original) {
        delete this.templateOverrides[this.editingTemplateKey]
        this.styleTemplates[this.editingTemplateKey] = JSON.parse(JSON.stringify(original))
        
        this.saveTemplatesToStorage()
        
        // 更新编辑器中的值
        const nameInput = document.getElementById('templateEditorName') as HTMLInputElement
        const prefixInput = document.getElementById('templateEditorPrefix') as HTMLTextAreaElement
        const suffixInput = document.getElementById('templateEditorSuffix') as HTMLTextAreaElement
        const negativeInput = document.getElementById('templateEditorNegative') as HTMLTextAreaElement
        
        if (nameInput) nameInput.value = original.name
        if (prefixInput) prefixInput.value = original.prefix
        if (suffixInput) suffixInput.value = original.suffix
        if (negativeInput) negativeInput.value = original.negative
        
        this.app.showToast?.(this.t('director.messages.restoredDefaults') || '已恢复默认值', 'success')
      }
    } catch (error) {
      console.error('[DirectorPage] 重置模板失败:', error)
      this.app.showToast?.(this.t('director.messages.resetFailed') || '重置失败', 'error')
    }
  }

  /**
   * 保存模板到存储
   */
  private saveTemplatesToStorage(): void {
    try {
      localStorage.setItem('director_custom_templates', JSON.stringify(this.customTemplates))
      localStorage.setItem('director_template_overrides', JSON.stringify(this.templateOverrides))
    } catch (error) {
      console.error('[DirectorPage] 保存模板失败:', error)
    }
  }

  /**
   * 从存储加载模板
   */
  private loadTemplatesFromStorage(): void {
    try {
      const customData = localStorage.getItem('director_custom_templates')
      this.customTemplates = customData ? JSON.parse(customData) : {}
      
      const overridesData = localStorage.getItem('director_template_overrides')
      this.templateOverrides = overridesData ? JSON.parse(overridesData) : {}
      
      // 应用覆盖
      for (const key of Object.keys(this.templateOverrides)) {
        if (this.isBuiltinTemplate(key)) {
          this.styleTemplates[key] = this.templateOverrides[key]
        }
      }
    } catch {
      this.customTemplates = {}
      this.templateOverrides = {}
    }
  }

  // ==================== 模板导入导出方法 ====================

  /**
   * 导入模板
   */
  async importTemplates(): Promise<void> {
    try {
      const electronAPI = (window as any).electronAPI
      
      if (electronAPI?.isElectron && electronAPI.importTemplates) {
        const result = await electronAPI.importTemplates()
        if (result?.canceled) return
        
        if (result?.success) {
          this.loadTemplatesFromStorage()
          this.renderTemplateList()
          this.app.showToast?.(this.t('director.messages.templatesImported') || '已导入模板', 'success')
        } else {
          this.app.showToast?.((this.t('director.messages.importFailed') || '导入失败: ') + (result?.error || (this.t('common.unknownError') || '未知错误')), 'error')
        }
      } else {
        // 浏览器环境：使用文件选择
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'
        
        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return
          
          try {
            const text = await file.text()
            const imported = JSON.parse(text)
            
            let count = 0
            for (const [key, template] of Object.entries(imported)) {
              if ((template as any).name && ((template as any).prefix !== undefined || (template as any).prompt !== undefined)) {
                const newKey = `imported_${Date.now()}_${count}`
                this.customTemplates[newKey] = template as StyleTemplate
                count++
              }
            }
            
            this.saveTemplatesToStorage()
            this.renderTemplateList()
            
            this.app.showToast?.(this.t('director.messages.importedTemplatesCount', { count }) || `已导入 ${count} 个模板`, 'success')
          } catch (error) {
            console.error('[DirectorPage] 导入失败:', error)
            this.app.showToast?.(this.t('director.messages.importFailedInvalidFormat') || '导入失败: 无效的文件格式', 'error')
          }
        }
        
        input.click()
      }
    } catch (error) {
      console.error('[DirectorPage] 导入模板失败:', error)
      this.app.showToast?.(this.t('director.messages.importFailed') || '导入失败', 'error')
    }
  }

  /**
   * 导出模板
   */
  async exportTemplates(): Promise<void> {
    try {
      const allTemplates = { ...this.customTemplates }
      
      if (Object.keys(allTemplates).length === 0) {
        this.app.showToast?.(this.t('director.messages.noTemplatesToExport') || '没有可导出的自定义模板', 'warning')
        return
      }
      
      const electronAPI = (window as any).electronAPI
      
      if (electronAPI?.isElectron && electronAPI.exportTemplates) {
        const result = await electronAPI.exportTemplates()
        if (result?.canceled) return
        
        if (result?.success) {
          this.app.showToast?.((this.t('director.messages.templatesExportedTo') || '模板已导出到: ') + result.path, 'success')
        } else {
          this.app.showToast?.((this.t('director.messages.exportFailed') || '导出失败: ') + (result?.error || (this.t('common.unknownError') || '未知错误')), 'error')
        }
      } else {
        // 浏览器环境：下载 JSON 文件
        const dataStr = JSON.stringify(allTemplates, null, 2)
        const blob = new Blob([dataStr], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        
        const a = document.createElement('a')
        a.href = url
        a.download = `director-templates-${new Date().toISOString().split('T')[0]}.json`
        a.click()
        
        URL.revokeObjectURL(url)
        this.app.showToast?.(this.t('director.messages.templatesExported') || '模板已导出', 'success')
      }
    } catch (error) {
      console.error('[DirectorPage] 导出模板失败:', error)
      this.app.showToast?.(this.t('director.messages.exportFailed') || '导出失败', 'error')
    }
  }

  // ==================== 图像理解模型选择 ====================

  /**
   * 打开图像理解模型选择弹窗
   */
  private openVisionModelModal(): void {
    if (!this.visionModelConfig) {
      this.showToast('模型配置未加载', 'error')
      return
    }

    // 创建或获取弹窗
    let modal = document.getElementById('directorVisionModelModal')
    if (!modal) {
      modal = document.createElement('div')
      modal.id = 'directorVisionModelModal'
      modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 hidden'
      document.body.appendChild(modal)
    }

    // 渲染弹窗内容
    const models = this.visionModelConfig.models
    const recommendedText = this.t('understand.visionModelData.recommended') || '推荐'
    const currentText = this.t('understand.visionModelData.current') || '当前'

    // Cyberpunk 暗色主题弹窗
    modal.innerHTML = `
      <div class="bg-[#09090B] border-2 border-[#3F3F46] max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden shadow-2xl">
        <!-- 标题栏 - Kinetic Typography 风格 -->
        <div class="flex items-center justify-between px-6 py-4 border-b-2 border-[#3F3F46] bg-[#18181B]">
          <h3 class="text-xl font-bold text-white flex items-center uppercase tracking-tight">
            <span class="mr-3 text-2xl">🤖</span>
            <span data-i18n="director.labels.selectVisionModel">${this.t('director.labels.selectVisionModel') || '选择图像理解模型'}</span>
          </h3>
          <button id="directorVisionModelCloseBtn" class="text-[#A1A1AA] hover:text-[#FCE300] text-2xl transition-colors duration-200">&times;</button>
        </div>
        <!-- 模型列表 -->
        <div class="p-4 overflow-y-auto max-h-[60vh] space-y-3">
          ${models.map(model => {
            const isSelected = model.id === this.visionModel
            return `
              <div class="vision-model-card cursor-pointer p-4 border-2 transition-all duration-200
                          ${isSelected 
                            ? 'border-[#FCE300] bg-[#FCE300] bg-opacity-10' 
                            : 'border-[#3F3F46] bg-[#18181B] hover:border-[#FCE300] hover:bg-[#27272A]'}"
                   data-model-id="${model.id}">
                <div class="flex items-start space-x-4">
                  <div class="text-3xl flex-shrink-0">${model.icon || '🤖'}</div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
                      <div class="flex items-center space-x-2 flex-wrap gap-1">
                        <span class="text-white font-bold text-lg uppercase tracking-tight">${model.shortName || model.name || model.id}</span>
                        ${model.recommended ? `<span class="bg-[#FCE300] text-black text-xs px-2 py-1 font-bold uppercase tracking-wide">${recommendedText}</span>` : ''}
                        ${isSelected ? `<span class="bg-[#22C55E] text-white text-xs px-2 py-1 font-bold uppercase tracking-wide">${currentText}</span>` : ''}
                      </div>
                      ${model.price ? `<span class="text-[#A1A1AA] text-sm font-mono bg-[#27272A] px-2 py-1 border border-[#3F3F46]">${model.price}</span>` : ''}
                    </div>
                    <p class="text-[#A1A1AA] text-sm mb-3 leading-relaxed">${model.description || ''}</p>
                    ${model.features && model.features.length > 0 ? `
                      <div class="flex flex-wrap gap-2">
                        ${model.features.map(f => `<span class="bg-[#27272A] text-[#FAFAFA] text-xs px-2 py-1 border border-[#3F3F46] font-medium">${f}</span>`).join('')}
                      </div>
                    ` : ''}
                  </div>
                </div>
              </div>
            `
          }).join('')}
        </div>
      </div>
    `

    // 显示弹窗
    modal.classList.remove('hidden')

    // 绑定关闭按钮
    document.getElementById('directorVisionModelCloseBtn')?.addEventListener('click', () => {
      modal?.classList.add('hidden')
    })

    // 点击外部关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal?.classList.add('hidden')
      }
    })

    // 绑定模型选择
    modal.querySelectorAll('.vision-model-card').forEach(card => {
      card.addEventListener('click', () => {
        const modelId = card.getAttribute('data-model-id')
        if (modelId) {
          this.selectVisionModel(modelId)
          modal?.classList.add('hidden')
        }
      })
    })
  }

  /**
   * 选择图像理解模型
   */
  private selectVisionModel(modelId: string): void {
    this.visionModel = modelId
    this.updateVisionModelDisplay()
    console.log('📸 导演模式切换视觉模型:', modelId)
    this.showToast(`已切换到 ${this.getVisionModelName(modelId)}`, 'success')
  }

  /**
   * 获取模型显示名称
   */
  private getVisionModelName(modelId: string): string {
    if (!this.visionModelConfig) return modelId
    const model = this.visionModelConfig.models.find(m => m.id === modelId)
    return model?.shortName || model?.name || modelId
  }

  /**
   * 获取当前图像理解模型
   */
  getCurrentVisionModel(): string {
    return this.visionModel
  }

  /**
   * 销毁页面
   */
  destroy(): void {
    this.saveCurrentState()
    this.referenceImages = []
    this.generatedResults = []
    super.destroy()
  }

  // ==================== Getter 方法 ====================

  getReferenceImagesCount(): number {
    return this.referenceImages.length
  }

  getCurrentLayout(): LayoutType {
    return this.currentLayout
  }

  getCurrentMode(): GenerationMode {
    return this.currentMode
  }

  getIsGenerating(): boolean {
    return this.isGenerating
  }

  getGeneratedResultsCount(): number {
    return this.generatedResults.length
  }
}

// 工厂函数
let directorPageInstance: DirectorPage | null = null

export function createDirectorPage(app: AppInterface): DirectorPage {
  directorPageInstance = new DirectorPage(app)
  return directorPageInstance
}

export function getDirectorPage(): DirectorPage | null {
  return directorPageInstance
}

export default DirectorPage
