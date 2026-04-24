export interface TemplateData {
  key: string
  displayName: string
  desc: string
  icon: string
  prefix: string
  suffix: string
  negative: string
  negativeEnabled: boolean
}

type EditableTemplateFields = Pick<TemplateData, 'prefix' | 'suffix' | 'negative' | 'negativeEnabled'>

const TEMPLATE_OVERRIDES_STORAGE_KEY = 'director.template-overrides.v1'

export const BUILTIN_TEMPLATES: TemplateData[] = [
  { key: 'anime', displayName: '日式动画', desc: 'TV anime 赛璐璐着色', icon: '🎌', prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring', negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality', negativeEnabled: false },
  { key: 'manga', displayName: '黑白漫画', desc: '网点纸 + 动态线条', icon: '📖', prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ', suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout', negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render', negativeEnabled: false },
  { key: 'movie', displayName: '电影分镜', desc: '电影级光影景深', icon: '🎬', prefix: 'cinematic storyboard, film still, movie scene, cinematography, ', suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading', negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality', negativeEnabled: false },
  { key: 'webtoon', displayName: '韩式条漫', desc: '全彩柔和竖版', icon: '📱', prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ', suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere', negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome', negativeEnabled: false },
  { key: 'comic', displayName: '美漫风格', desc: '粗线条网点动作感', icon: '💥', prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ', suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene', negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading', negativeEnabled: false },
  { key: 'anime-screencap', displayName: '日式动画截图风', desc: 'TV anime 截图 + 赛璐璐着色', icon: '🎨', prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring', negative: '(worst quality, low quality:1.4), illustration, static illustration, poster, artbook, sketch, monochrome, grayscale, rating:general', negativeEnabled: true },
  { key: 'cinematic', displayName: '影院级写实', desc: '8K 写实自然景深', icon: '🎥', prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. Symmetrical grid, hard borders, clean white dividing lines. Each panel labeled with KF number + shot type + suggested duration. ', suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh', negative: 'text, speech bubbles, dialogue, watermark, signature, blurry, low quality, inconsistent characters, different outfits, style change, irregular panels, asymmetric grid, new characters not in reference, guessed identities, brand logos', negativeEnabled: false },
  { key: 'theatrical', displayName: '剧场版动画', desc: '剧场版品质电影级', icon: '🎭', prefix: '((現代的な撮影技術を駆使した日本のアニメ映画スタイル:1.5)), ((劇場版クオリティのスクリーンショット:1.5)), ((TVアニメの没入感:1.4)), 以下のプロンプトに従って画像の絵コンテを調整します。日本のアニメ映画版で、監督に見せるための絵コンテです。ストーリー感を表現します。複数のカットで構成されたものは必ず映画版のスクリーンショットで構成された絵コンテで、テキスト内のすべてのストーリー情報を漏らさず、最も重要な演技のカットを示してください。((参考画像の画風に完全に従って構築します:1.6)), ((画風の完全再現:1.6)), ((オリジナル画風を維持:1.5)), ', suffix: ', 高品質, 8k, masterpiece, best quality, absurdres, veryaesthetic, full color, anime cel shading, TV anime coloring, modern anime style, cinematic lighting, highly detailed, depth of field, anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, key animation frames, emotional acting focus', negative: '低品質, 作画崩壊, 実写, 3D, 異なる画風, 画風の変更, 文字, ぼやけ, (worst quality, low quality:1.4), illustration, static illustration, poster, artbook, sketch, monochrome, grayscale', negativeEnabled: false },
  { key: 'cinematic-art-design', displayName: '电影美术设定图', desc: '原版 · 场景平面图+分镜+材质灯光+角色设定', icon: '📐', prefix: `{"templateMeta":{"templateName":"电影/剧情演出 美术设定富文本图（通用模板）","version":"v1.0","referenceFormat":"MV/影视美术设定图（参考示例：洋館サロン ピアノ演奏シーン設定図）","corePurpose":"整合场景美术、镜头分镜、角色设定、材质灯光的可视化概念参考，用于剧情演出/影视项目前期展示与AI生成"},"overallLayoutStructure":{"layoutDescription":"参考示例布局：顶部标题栏 + 左上核心俯视图（带机位标注） + 右上镜头分镜对应表 + 中部立面/剖面图 + 底部材质/灯光参考区 + 扩展人设/剧情解析区","aspectRatio":"16:9（横版，适配影视设定图通用尺寸）","modulePositions":{"titleBar":"顶部通栏","topDownPlanView":"左上主视觉区","shotCorrespondenceBoard":"右上网格区","elevationAndSectionViews":"中部横排区","materialAndLighting":"底部横排区","characterAndPlotNotes":"右侧/底部扩展区（可选）"}},"projectBaseInfo":{"projectName":"【必填】项目/剧集名称","sceneTitle":"【必填】场景/场次标题（如：场16-2 城邦广场宣告戏）","sceneNumber":"【可选】场次编号（如：16-2）","genre":"【必填】题材类型（如：史诗神话/复古文艺/古风权谋）","styleTone":"【必填】整体调性（如：史诗庄重/复古暗黑/明亮庄重）","coreSceneTag":"【可选】场景核心标签（如：权力更迭/情感爆发/仪式宣告）"},"coreSceneArtDesign":{"sectionTitle":"场景美术设定","topDownPlanView":{"planTitle":"场景平面图（俯视）","dimensions":{"width":"内寸约X m（如：约13.5m）","depth":"内寸约X m（如：约9.5m）","height":"内寸约X m（如：约5.0m）"},"cameraMarkers":[{"markerId":"①","markerStyle":"黄色三角+编号标注（参考示例样式）","positionInPlan":"平面图内坐标位置","cameraDirection":"镜头朝向标注（带方向箭头）","correspondingShotId":"对应分镜编号（如：SH01）"}],"sceneElementLabels":[{"labelText":"关键场景元素标注（如：中央钢琴/城邦高台/民众聚集区）","labelPosition":"平面图内对应位置","description":"元素说明（如：仪式核心道具/场景功能区）"}]},"elevationViews":[{"viewTitle":"北侧/东侧立面图（视角可自定义）","viewPurpose":"展示墙面、窗户、装饰、道具的正面效果","description":"立面核心内容说明（如：彩色玻璃窗/木质雕花护墙板/王座高台）"}],"sectionView":{"viewTitle":"A-A剖面图","viewPurpose":"展示层高、空间纵深、关键道具/人物的高度关系","keyElements":["层高标注","关键道具高度","人物站位高度参考"]},"spaceDataSpec":{"roomSize":"室内尺寸（如：W13.5m × D9.5m × H5.0m）","floorMaterial":"地面材质（如：深色实木拼花/大理石/复古地毯）","wallMaterial":"墙面材质（如：木质护墙板/石材/石膏雕花墙）","keyProps":["核心道具1","核心道具2"],"ambianceStyle":"整体氛围风格（如：クラシカル・重厚/史诗庄重/复古文艺）"}},"shotCorrespondenceBoard":{"sectionTitle":"カット対応表（镜头对应参考）","layoutType":"3×3/网格缩略图表格（参考示例样式）","shots":[{"shotId":"SH01","correspondingCameraMarker":"对应平面图机位编号（如：①）","shotThumbnailDesc":"镜头画面缩略图描述（如：角色全景亮相/关键道具特写/民众全景）","shotType":"景别（如：全景/中景/近景/特写/大特写）","cameraMovement":"运镜方式（如：固定/推/拉/摇/环绕/希区柯克变焦）","contentDescription":"镜头核心内容（如：角色与道具互动/关键台词场景/情绪特写）","emotionTone":"镜头情绪（如：庄重/紧张/温情/震撼）"}]},"characterDesignSection":{"sectionTitle":"角色设定参考","layoutPosition":"右侧扩展区/底部扩展区","characters":[{"characterId":"C01","characterName":"角色名称","roleInScene":"本场身份/定位（如：主导者/核心配角/反派）","visualReferenceDesc":"人设参考图描述（如：黑金神话战衣/复古洋装/政务制服）","costumeDetails":"服装风格与细节（如：材质/配色/标志性配饰）","coreExpression":"本场情绪状态（如：威严/隐忍/激动/怯懦）","positionInScene":"场景内站位（如：高台中央/画面左侧/民众前方）"}]},"materialAndLightingReference":{"materialReferences":{"sectionTitle":"主な装飾・マテリアル（主要装饰/材质参考）","layoutType":"横排缩略图参考（参考示例样式）","materials":[{"materialId":"M01","materialName":"材质/装饰名称（如：水晶吊灯/彩色玻璃窗/木质雕花护墙板）","referenceDesc":"参考效果描述","usagePosition":"应用场景位置（如：天花板照明/墙面装饰/地面）"}]},"lightingPlan":{"sectionTitle":"照明計画（照明参考）","planStyle":"示意图标注（参考示例样式，含光源类型、方向标注）","lightSources":[{"lightId":"L01","lightType":"光源类型（如：自然光/吊灯/壁灯/台灯/舞台顶光）","lightDirection":"光线方向（如：顶光/侧逆光/漫射光/暖光包围）","colorTemperature":"色温/色调（如：暖黄色/冷白色/自然日光/庄重白光）","atmosphereEffect":"氛围效果（如：庄重明亮/复古暖调/史诗氛围感）"}]}},"plotAndAtmosphereNotes":{"sectionTitle":"剧情与氛围解析","plotSummary":"本场剧情核心内容简述（如：宙斯拥立塞勒涅为女王，宣布权力更迭）","coreThemes":["核心主题1","核心主题2"],"emotionalArc":"本场情绪递进（如：庄重宣告→爽感逆袭→温情收尾）","keyAtmosphereKeywords":["史诗感","仪式感","爽感","温情"]},"richTextAnnotationSpec":{"planAnnotationStyle":"平面图标注方式：黄色三角标记+编号+文字说明（参考示例样式）","shotTableStyle":"分镜表样式：网格缩略图+编号+简短文字说明，保持简洁清晰","textStyle":{"titleFont":"无衬线粗体/电影感衬线字体（参考示例日式无衬线风格）","bodyFont":"简洁无衬线体，保证可读性","textColor":"深色背景用白色/浅灰，浅色背景用黑色/深灰，标注文字可搭配主题色（如：金色/黄色）","textBackground":"关键说明可加半透黑底/磨砂半透，避免遮挡主视觉"},"colorPalette":"整体配色参考：深色木质/暖金色/复古棕/庄重白，适配场景调性"},"outputSpec":{"imageSize":"【必填】成品尺寸（如：3840×2160 横版/ 2160×3840 竖版，参考示例为横版）","resolution":"300DPI","format":"PNG/JPG 高清无水印","usage":"剧情演出展示/影视前期概念/项目汇报/AI生成参考/美术对接用图"}}\n`, suffix: '', negative: 'blurry, lowres, bad anatomy, worst quality, text overlap, illegible labels', negativeEnabled: false },
  { key: 'cinematic-art-design-verbatim', displayName: '电影美术设定图 原始', desc: '保留原始 JSON 缩进/换行/空行，一字不改', icon: '📋', prefix: `{
  "templateMeta": {
    "templateName": "电影/剧情演出 美术设定富文本图（通用模板）",
    "version": "v1.0",
    "referenceFormat": "MV/影视美术设定图（参考示例：洋館サロン ピアノ演奏シーン設定図）",
    "corePurpose": "整合场景美术、镜头分镜、角色设定、材质灯光的可视化概念参考，用于剧情演出/影视项目前期展示与AI生成"
  },

  "overallLayoutStructure": {
    "layoutDescription": "参考示例布局：顶部标题栏 + 左上核心俯视图（带机位标注） + 右上镜头分镜对应表 + 中部立面/剖面图 + 底部材质/灯光参考区 + 扩展人设/剧情解析区",
    "aspectRatio": "16:9（横版，适配影视设定图通用尺寸）",
    "modulePositions": {
      "titleBar": "顶部通栏",
      "topDownPlanView": "左上主视觉区",
      "shotCorrespondenceBoard": "右上网格区",
      "elevationAndSectionViews": "中部横排区",
      "materialAndLighting": "底部横排区",
      "characterAndPlotNotes": "右侧/底部扩展区（可选）"
    }
  },

  "projectBaseInfo": {
    "projectName": "【必填】项目/剧集名称",
    "sceneTitle": "【必填】场景/场次标题（如：场16-2 城邦广场宣告戏）",
    "sceneNumber": "【可选】场次编号（如：16-2）",
    "genre": "【必填】题材类型（如：史诗神话/复古文艺/古风权谋）",
    "styleTone": "【必填】整体调性（如：史诗庄重/复古暗黑/明亮庄重）",
    "coreSceneTag": "【可选】场景核心标签（如：权力更迭/情感爆发/仪式宣告）"
  },

  "coreSceneArtDesign": {
    "sectionTitle": "场景美术设定",
    "topDownPlanView": {
      "planTitle": "场景平面图（俯视）",
      "dimensions": {
        "width": "内寸约X m（如：约13.5m）",
        "depth": "内寸约X m（如：约9.5m）",
        "height": "内寸约X m（如：约5.0m）"
      },
      "cameraMarkers": [
        {
          "markerId": "①",
          "markerStyle": "黄色三角+编号标注（参考示例样式）",
          "positionInPlan": "平面图内坐标位置",
          "cameraDirection": "镜头朝向标注（带方向箭头）",
          "correspondingShotId": "对应分镜编号（如：SH01）"
        }
      ],
      "sceneElementLabels": [
        {
          "labelText": "关键场景元素标注（如：中央钢琴/城邦高台/民众聚集区）",
          "labelPosition": "平面图内对应位置",
          "description": "元素说明（如：仪式核心道具/场景功能区）"
        }
      ]
    },
    "elevationViews": [
      {
        "viewTitle": "北侧/东侧立面图（视角可自定义）",
        "viewPurpose": "展示墙面、窗户、装饰、道具的正面效果",
        "description": "立面核心内容说明（如：彩色玻璃窗/木质雕花护墙板/王座高台）"
      }
    ],
    "sectionView": {
      "viewTitle": "A-A剖面图",
      "viewPurpose": "展示层高、空间纵深、关键道具/人物的高度关系",
      "keyElements": ["层高标注", "关键道具高度", "人物站位高度参考"]
    },
    "spaceDataSpec": {
      "roomSize": "室内尺寸（如：W13.5m × D9.5m × H5.0m）",
      "floorMaterial": "地面材质（如：深色实木拼花/大理石/复古地毯）",
      "wallMaterial": "墙面材质（如：木质护墙板/石材/石膏雕花墙）",
      "keyProps": ["核心道具1", "核心道具2"],
      "ambianceStyle": "整体氛围风格（如：クラシカル・重厚/史诗庄重/复古文艺）"
    }
  },

  "shotCorrespondenceBoard": {
    "sectionTitle": "カット対応表（镜头对应参考）",
    "layoutType": "3×3/网格缩略图表格（参考示例样式）",
    "shots": [
      {
        "shotId": "SH01",
        "correspondingCameraMarker": "对应平面图机位编号（如：①）",
        "shotThumbnailDesc": "镜头画面缩略图描述（如：角色全景亮相/关键道具特写/民众全景）",
        "shotType": "景别（如：全景/中景/近景/特写/大特写）",
        "cameraMovement": "运镜方式（如：固定/推/拉/摇/环绕/希区柯克变焦）",
        "contentDescription": "镜头核心内容（如：角色与道具互动/关键台词场景/情绪特写）",
        "emotionTone": "镜头情绪（如：庄重/紧张/温情/震撼）"
      }
    ]
  },

  "characterDesignSection": {
    "sectionTitle": "角色设定参考",
    "layoutPosition": "右侧扩展区/底部扩展区",
    "characters": [
      {
        "characterId": "C01",
        "characterName": "角色名称",
        "roleInScene": "本场身份/定位（如：主导者/核心配角/反派）",
        "visualReferenceDesc": "人设参考图描述（如：黑金神话战衣/复古洋装/政务制服）",
        "costumeDetails": "服装风格与细节（如：材质/配色/标志性配饰）",
        "coreExpression": "本场情绪状态（如：威严/隐忍/激动/怯懦）",
        "positionInScene": "场景内站位（如：高台中央/画面左侧/民众前方）"
      }
    ]
  },

  "materialAndLightingReference": {
    "materialReferences": {
      "sectionTitle": "主な装飾・マテリアル（主要装饰/材质参考）",
      "layoutType": "横排缩略图参考（参考示例样式）",
      "materials": [
        {
          "materialId": "M01",
          "materialName": "材质/装饰名称（如：水晶吊灯/彩色玻璃窗/木质雕花护墙板）",
          "referenceDesc": "参考效果描述",
          "usagePosition": "应用场景位置（如：天花板照明/墙面装饰/地面）"
        }
      ]
    },
    "lightingPlan": {
      "sectionTitle": "照明計画（照明参考）",
      "planStyle": "示意图标注（参考示例样式，含光源类型、方向标注）",
      "lightSources": [
        {
          "lightId": "L01",
          "lightType": "光源类型（如：自然光/吊灯/壁灯/台灯/舞台顶光）",
          "lightDirection": "光线方向（如：顶光/侧逆光/漫射光/暖光包围）",
          "colorTemperature": "色温/色调（如：暖黄色/冷白色/自然日光/庄重白光）",
          "atmosphereEffect": "氛围效果（如：庄重明亮/复古暖调/史诗氛围感）"
        }
      ]
    }
  },

  "plotAndAtmosphereNotes": {
    "sectionTitle": "剧情与氛围解析",
    "plotSummary": "本场剧情核心内容简述（如：宙斯拥立塞勒涅为女王，宣布权力更迭）",
    "coreThemes": ["核心主题1", "核心主题2"],
    "emotionalArc": "本场情绪递进（如：庄重宣告→爽感逆袭→温情收尾）",
    "keyAtmosphereKeywords": ["史诗感", "仪式感", "爽感", "温情"]
  },

  "richTextAnnotationSpec": {
    "planAnnotationStyle": "平面图标注方式：黄色三角标记+编号+文字说明（参考示例样式）",
    "shotTableStyle": "分镜表样式：网格缩略图+编号+简短文字说明，保持简洁清晰",
    "textStyle": {
      "titleFont": "无衬线粗体/电影感衬线字体（参考示例日式无衬线风格）",
      "bodyFont": "简洁无衬线体，保证可读性",
      "textColor": "深色背景用白色/浅灰，浅色背景用黑色/深灰，标注文字可搭配主题色（如：金色/黄色）",
      "textBackground": "关键说明可加半透黑底/磨砂半透，避免遮挡主视觉"
    },
    "colorPalette": "整体配色参考：深色木质/暖金色/复古棕/庄重白，适配场景调性"
  },

  "outputSpec": {
    "imageSize": "【必填】成品尺寸（如：3840×2160 横版/ 2160×3840 竖版，参考示例为横版）",
    "resolution": "300DPI",
    "format": "PNG/JPG 高清无水印",
    "usage": "剧情演出展示/影视前期概念/项目汇报/AI生成参考/美术对接用图"
  }
}
`, suffix: '', negative: '', negativeEnabled: false },
  { key: 'cinematic-art-design-pro', displayName: '电影美术设定图 Pro', desc: '增强版 · 带指令头+剧本分隔+输出要求', icon: '🎬', prefix: `请按照下方 JSON 模板的结构与模块划分，生成一张「电影/剧情演出 美术设定富文本图」：严格遵循模板里的模块位置、信息层级、标注样式与版式要求，最终输出的是一张富信息量的设定图（而不是代码/文字堆叠）。模板规范 JSON:\n{"templateMeta":{"templateName":"电影/剧情演出 美术设定富文本图（通用模板）","version":"v1.0","referenceFormat":"MV/影视美术设定图（参考示例：洋館サロン ピアノ演奏シーン設定図）","corePurpose":"整合场景美术、镜头分镜、角色设定、材质灯光的可视化概念参考，用于剧情演出/影视项目前期展示与AI生成"},"overallLayoutStructure":{"layoutDescription":"参考示例布局：顶部标题栏 + 左上核心俯视图（带机位标注） + 右上镜头分镜对应表 + 中部立面/剖面图 + 底部材质/灯光参考区 + 扩展人设/剧情解析区","aspectRatio":"16:9（横版，适配影视设定图通用尺寸）","modulePositions":{"titleBar":"顶部通栏","topDownPlanView":"左上主视觉区","shotCorrespondenceBoard":"右上网格区","elevationAndSectionViews":"中部横排区","materialAndLighting":"底部横排区","characterAndPlotNotes":"右侧/底部扩展区（可选）"}},"projectBaseInfo":{"projectName":"【必填】项目/剧集名称","sceneTitle":"【必填】场景/场次标题（如：场16-2 城邦广场宣告戏）","sceneNumber":"【可选】场次编号（如：16-2）","genre":"【必填】题材类型（如：史诗神话/复古文艺/古风权谋）","styleTone":"【必填】整体调性（如：史诗庄重/复古暗黑/明亮庄重）","coreSceneTag":"【可选】场景核心标签（如：权力更迭/情感爆发/仪式宣告）"},"coreSceneArtDesign":{"sectionTitle":"场景美术设定","topDownPlanView":{"planTitle":"场景平面图（俯视）","dimensions":{"width":"内寸约X m（如：约13.5m）","depth":"内寸约X m（如：约9.5m）","height":"内寸约X m（如：约5.0m）"},"cameraMarkers":[{"markerId":"①","markerStyle":"黄色三角+编号标注（参考示例样式）","positionInPlan":"平面图内坐标位置","cameraDirection":"镜头朝向标注（带方向箭头）","correspondingShotId":"对应分镜编号（如：SH01）"}],"sceneElementLabels":[{"labelText":"关键场景元素标注（如：中央钢琴/城邦高台/民众聚集区）","labelPosition":"平面图内对应位置","description":"元素说明（如：仪式核心道具/场景功能区）"}]},"elevationViews":[{"viewTitle":"北侧/东侧立面图（视角可自定义）","viewPurpose":"展示墙面、窗户、装饰、道具的正面效果","description":"立面核心内容说明（如：彩色玻璃窗/木质雕花护墙板/王座高台）"}],"sectionView":{"viewTitle":"A-A剖面图","viewPurpose":"展示层高、空间纵深、关键道具/人物的高度关系","keyElements":["层高标注","关键道具高度","人物站位高度参考"]},"spaceDataSpec":{"roomSize":"室内尺寸（如：W13.5m × D9.5m × H5.0m）","floorMaterial":"地面材质（如：深色实木拼花/大理石/复古地毯）","wallMaterial":"墙面材质（如：木质护墙板/石材/石膏雕花墙）","keyProps":["核心道具1","核心道具2"],"ambianceStyle":"整体氛围风格（如：クラシカル・重厚/史诗庄重/复古文艺）"}},"shotCorrespondenceBoard":{"sectionTitle":"カット対応表（镜头对应参考）","layoutType":"3×3/网格缩略图表格（参考示例样式）","shots":[{"shotId":"SH01","correspondingCameraMarker":"对应平面图机位编号（如：①）","shotThumbnailDesc":"镜头画面缩略图描述（如：角色全景亮相/关键道具特写/民众全景）","shotType":"景别（如：全景/中景/近景/特写/大特写）","cameraMovement":"运镜方式（如：固定/推/拉/摇/环绕/希区柯克变焦）","contentDescription":"镜头核心内容（如：角色与道具互动/关键台词场景/情绪特写）","emotionTone":"镜头情绪（如：庄重/紧张/温情/震撼）"}]},"characterDesignSection":{"sectionTitle":"角色设定参考","layoutPosition":"右侧扩展区/底部扩展区","characters":[{"characterId":"C01","characterName":"角色名称","roleInScene":"本场身份/定位（如：主导者/核心配角/反派）","visualReferenceDesc":"人设参考图描述（如：黑金神话战衣/复古洋装/政务制服）","costumeDetails":"服装风格与细节（如：材质/配色/标志性配饰）","coreExpression":"本场情绪状态（如：威严/隐忍/激动/怯懦）","positionInScene":"场景内站位（如：高台中央/画面左侧/民众前方）"}]},"materialAndLightingReference":{"materialReferences":{"sectionTitle":"主な装飾・マテリアル（主要装饰/材质参考）","layoutType":"横排缩略图参考（参考示例样式）","materials":[{"materialId":"M01","materialName":"材质/装饰名称（如：水晶吊灯/彩色玻璃窗/木质雕花护墙板）","referenceDesc":"参考效果描述","usagePosition":"应用场景位置（如：天花板照明/墙面装饰/地面）"}]},"lightingPlan":{"sectionTitle":"照明計画（照明参考）","planStyle":"示意图标注（参考示例样式，含光源类型、方向标注）","lightSources":[{"lightId":"L01","lightType":"光源类型（如：自然光/吊灯/壁灯/台灯/舞台顶光）","lightDirection":"光线方向（如：顶光/侧逆光/漫射光/暖光包围）","colorTemperature":"色温/色调（如：暖黄色/冷白色/自然日光/庄重白光）","atmosphereEffect":"氛围效果（如：庄重明亮/复古暖调/史诗氛围感）"}]}},"plotAndAtmosphereNotes":{"sectionTitle":"剧情与氛围解析","plotSummary":"本场剧情核心内容简述（如：宙斯拥立塞勒涅为女王，宣布权力更迭）","coreThemes":["核心主题1","核心主题2"],"emotionalArc":"本场情绪递进（如：庄重宣告→爽感逆袭→温情收尾）","keyAtmosphereKeywords":["史诗感","仪式感","爽感","温情"]},"richTextAnnotationSpec":{"planAnnotationStyle":"平面图标注方式：黄色三角标记+编号+文字说明（参考示例样式）","shotTableStyle":"分镜表样式：网格缩略图+编号+简短文字说明，保持简洁清晰","textStyle":{"titleFont":"无衬线粗体/电影感衬线字体（参考示例日式无衬线风格）","bodyFont":"简洁无衬线体，保证可读性","textColor":"深色背景用白色/浅灰，浅色背景用黑色/深灰，标注文字可搭配主题色（如：金色/黄色）","textBackground":"关键说明可加半透黑底/磨砂半透，避免遮挡主视觉"},"colorPalette":"整体配色参考：深色木质/暖金色/复古棕/庄重白，适配场景调性"},"outputSpec":{"imageSize":"【必填】成品尺寸（如：3840×2160 横版/ 2160×3840 竖版，参考示例为横版）","resolution":"300DPI","format":"PNG/JPG 高清无水印","usage":"剧情演出展示/影视前期概念/项目汇报/AI生成参考/美术对接用图"}}\n\n【本场剧本 / 场景描述】:\n`, suffix: `\n\n【输出要求】：\n1. 版式严格遵循 overallLayoutStructure（顶部标题栏 + 左上俯视图 + 右上分镜表 + 中部立面/剖面 + 底部材质/灯光 + 扩展人设/剧情区）。\n2. 所有模块内带富文本标注：机位用黄色三角+编号、场景元素用引线标签、分镜格带编号与景别说明、材质/灯光区带缩略图+文字。\n3. 信息层级清晰、留白合理；字体为电影感无衬线/日式无衬线；中文/英文/日文标注混排但对齐工整。\n4. 整体风格：影视美术设定图质感、专业制作文档气质、概念美术板 + 技术蓝图混合。\n5. 输出 3840×2160 横版高清（16:9），300DPI 等效画质，构图稳定、无 JSON 代码字符泄漏、无 watermark。`, negative: 'raw JSON code, literal curly braces, code snippets, syntax characters, broken typography, blurry, lowres, bad anatomy, worst quality, text overlap, illegible labels, misaligned grid, asymmetric layout, random watermark, signature', negativeEnabled: false },
]

const DEFAULT_TEMPLATE_MAP = Object.fromEntries(
  BUILTIN_TEMPLATES.map((t) => [t.key, { ...t }])
) as Record<string, TemplateData>

export const TEMPLATE_MAP = Object.fromEntries(
  BUILTIN_TEMPLATES.map((t) => [t.key, { ...t }])
) as Record<string, TemplateData>

function readTemplateOverrides(): Record<string, EditableTemplateFields> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(TEMPLATE_OVERRIDES_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, EditableTemplateFields>
  } catch {
    return {}
  }
}

function writeTemplateOverrides(overrides: Record<string, EditableTemplateFields>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TEMPLATE_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Best-effort persistence; ignore quota/storage errors.
  }
}

function applyOverrides(): void {
  const overrides = readTemplateOverrides()
  for (const [key, value] of Object.entries(overrides)) {
    const target = TEMPLATE_MAP[key]
    if (!target) continue
    target.prefix = value.prefix
    target.suffix = value.suffix
    target.negative = value.negative
    target.negativeEnabled = Boolean(value.negativeEnabled)
  }
}

applyOverrides()

export function persistTemplateOverride(key: string, value: EditableTemplateFields): void {
  const target = TEMPLATE_MAP[key]
  if (!target) return

  target.prefix = value.prefix
  target.suffix = value.suffix
  target.negative = value.negative
  target.negativeEnabled = value.negativeEnabled

  const overrides = readTemplateOverrides()
  overrides[key] = value
  writeTemplateOverrides(overrides)
}

export function resetTemplateOverride(key: string): void {
  const target = TEMPLATE_MAP[key]
  const fallback = DEFAULT_TEMPLATE_MAP[key]
  if (!target || !fallback) return

  target.prefix = fallback.prefix
  target.suffix = fallback.suffix
  target.negative = fallback.negative
  target.negativeEnabled = fallback.negativeEnabled

  const overrides = readTemplateOverrides()
  delete overrides[key]
  writeTemplateOverrides(overrides)
}

export function getStyleInstructions(templateKey: string | null): string {
  if (!templateKey) return ''
  const t = TEMPLATE_MAP[templateKey]
  if (!t) return ''
  return `${t.prefix}[SUBJECT]${t.suffix}`
}

export function composePromptWithTemplate(templateKey: string | null, userPrompt: string): string {
  if (!templateKey) return userPrompt
  const t = TEMPLATE_MAP[templateKey]
  if (!t) return userPrompt
  return `${t.prefix}${userPrompt}${t.suffix}`
}

const CUSTOM_TEMPLATES_STORAGE_KEY = 'director.custom-templates.v1'

function readCustomTemplates(): TemplateData[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TemplateData[]
  } catch {
    return []
  }
}

function writeCustomTemplates(templates: TemplateData[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(CUSTOM_TEMPLATES_STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // Best-effort persistence
  }
}

export function getCustomTemplates(): TemplateData[] {
  return readCustomTemplates()
}

export function addCustomTemplate(data: Omit<TemplateData, 'key'>): string {
  const key = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const template: TemplateData = { ...data, key }

  const customs = readCustomTemplates()
  customs.push(template)
  writeCustomTemplates(customs)

  TEMPLATE_MAP[key] = { ...template }
  return key
}

export function deleteCustomTemplate(key: string): void {
  if (!key.startsWith('custom-')) return
  const customs = readCustomTemplates().filter(t => t.key !== key)
  writeCustomTemplates(customs)
  delete TEMPLATE_MAP[key]
}

export function updateCustomTemplate(key: string, data: Omit<TemplateData, 'key'>): void {
  if (!key.startsWith('custom-')) return
  const customs = readCustomTemplates().map(t =>
    t.key === key ? { ...data, key } : t
  )
  writeCustomTemplates(customs)
  TEMPLATE_MAP[key] = { ...data, key }
}

export function getAllTemplates(): TemplateData[] {
  return [...BUILTIN_TEMPLATES, ...readCustomTemplates()]
}

for (const t of readCustomTemplates()) {
  TEMPLATE_MAP[t.key] = { ...t }
}
