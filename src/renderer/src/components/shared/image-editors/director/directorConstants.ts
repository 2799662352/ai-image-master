/**
 * Director Stage — ground-truth constants reverse-engineered from RunningHub
 * 导演台 (overseas site, three.js r180). See docs/导演台模式-逆向研究报告.md §10.
 *
 * All values were read live from the real `<input type=range>` controls, not
 * inferred from minified source, so they can be used verbatim for replication.
 */

/**
 * 镜头预设 → 透视相机 fov(度). FOV 滑杆范围 10–150.
 * 数值为源码精确值(逆向自实站 chunk 的 `Ot` 数组:focal/fov),
 * 不再是滑杆实测近似。焦段对应全画幅等效 mm。
 */
export const LENS_PRESETS = {
  标准: 39.6, // standard — 50mm
  广角: 73.7, // wide — 24mm —— 全景导入入口默认
  超广角: 96.7, // ultraWide — 16mm
  人像: 23.9, // portrait — 85mm
  长焦: 15.2, // tele — 135mm
  超长焦: 10.3, // ultraTele — 200mm
  鱼眼: 150, // fisheye — 8mm (= FOV 上限)
} as const;

export type LensPresetKey = keyof typeof LENS_PRESETS;
export const LENS_PRESET_KEYS = Object.keys(LENS_PRESETS) as LensPresetKey[];

/** 每个镜头预设对应的等效焦距(mm),用于 UI 副标题展示. */
export const LENS_FOCAL: Record<LensPresetKey, number> = {
  标准: 50,
  广角: 24,
  超广角: 16,
  人像: 85,
  长焦: 135,
  超长焦: 200,
  鱼眼: 8,
};

export const FOV_RANGE: readonly [number, number] = [10, 150];
/** FOV 滑杆步进(实测 0.5). */
export const FOV_STEP = 0.5;
/** 镜头距离滑杆步进(实测 0.1). */
export const DISTANCE_STEP = 0.1;

/** 灯光默认值(底栏「灯光」面板). */
export const LIGHT_DEFAULTS = {
  /** 主光 = DirectionalLight,用方位角/仰角球面定位. */
  key: {
    intensity: 4.0,
    azimuthDeg: 61,
    elevationDeg: 13,
    color: '#ffffff',
    range: {
      intensity: [0, 10] as const,
      azimuth: [0, 360] as const,
      elevation: [-90, 90] as const,
    },
  },
  /** 环境光 = HemisphereLight(半球光). */
  ambient: {
    intensity: 0.6,
    color: '#ffffff',
    range: { intensity: [0, 3] as const },
  },
} as const;

/** 右栏「模型数据」变换滑杆范围. */
export const TRANSFORM_RANGE = {
  position: [-50, 50] as const,
  rotationDeg: [-180, 180] as const,
  scale: [0.01, 5] as const,
} as const;

/** 两个入口的默认相机/背景(见报告 §9.5 / §10.3). */
export const ENTRY_DEFAULTS = {
  /** 原生入口(左侧栏「导演台」):空网格地面. */
  native: { fov: 39.6, distance: 8.0, background: 'grid' as const },
  /** 全景导入入口(图片节点「导入导演台」):全景球背景 + 广角. */
  panorama: { fov: 73.7, distance: 4.0, background: 'equirect-sphere' as const },
} as const;

export type DirectorEntry = keyof typeof ENTRY_DEFAULTS;

/**
 * 场景级常量 — 逆向自实站 `DirectorEngine`(chunk `_Dmnzwia4.js`)。
 * 这些决定了「3D 空间比我们大许多」的观感:超远裁剪面 + 4000² 着色器
 * 地面 + 不限制的 dolly 半径。
 */
export const SCENE = {
  /** scene.background = new THREE.Color(2895930). */
  background: 0x2c303a,
  /** PerspectiveCamera(fov, aspect, near, far). 实站 near=0.01 far=2000. */
  cameraNear: 0.01,
  cameraFar: 2000,
  /** 默认 dolly 半径(镜头距离). */
  defaultDistance: 8,
  /** _setCameraOrbit 球面定位:方位角/仰角(度)+ 视点高度. */
  orbitAzimuthDeg: 72,
  orbitElevationDeg: 40,
  /** orbit.target / lookAt 视点 = (0, 0.5, 0). */
  targetY: 0.5,
  /** OrbitControls 阻尼. */
  orbitDamping: 0.08,
  /** dolly 半径范围:实站 min=0.01,max=∞. */
  orbitMinDistance: 0.01,
  orbitMaxDistance: Infinity,
} as const;

/**
 * 着色器无限网格地面 — 逆向自实站 `_installGrid()`。
 * PlaneGeometry(4000,4000) + ShaderMaterial(fwidth 抗锯齿,按距离淡出)。
 */
export const GRID = {
  size: 4000,
  /** 次级线颜色 new Color(3553860). */
  minorColor: 0x363a44,
  /** 主线颜色 new Color(4870234). */
  majorColor: 0x4a505a,
  minorStep: 1,
  majorStep: 10,
  /** 距视点 fadeStart 单位开始淡出,fadeEnd 单位完全消失. */
  fadeStart: 40,
  fadeEnd: 220,
} as const;

/** 镜头距离滑杆范围(OrbitControls dolly 半径). 实站不限上限,UI 给到 200. */
export const DISTANCE_RANGE: readonly [number, number] = [0.5, 200];

/**
 * 录制 / 截图分辨率档 — 逆向自实站 `au` 数组。值 = 输出短边(px),
 * 长边按当前视口宽高比推算(见 computeOutputSize)。
 *   1080p → 1080, 2k(1440p) → 1440, 4k → 2160。
 */
export const CAPTURE_RESOLUTIONS = ['1080p', '2k', '4k'] as const;
export type CaptureResolution = (typeof CAPTURE_RESOLUTIONS)[number];
/** 短边像素(实站以高/短边为基准). */
export const CAPTURE_RES_SHORT: Record<CaptureResolution, number> = {
  '1080p': 1080,
  '2k': 1440,
  '4k': 2160,
};
/** 兼容旧引用:截图按高(px). */
export const CAPTURE_RES_HEIGHT = CAPTURE_RES_SHORT;

/** 录制质量档(bits-per-pixel). 逆向自实站 `ou`,默认 high. */
export const RECORD_QUALITY = [
  { key: 'low', label: '低', bpp: 0.06 },
  { key: 'medium', label: '中', bpp: 0.12 },
  { key: 'high', label: '高', bpp: 0.24, recommended: true },
  { key: 'max', label: '极高', bpp: 0.48 },
] as const;
export type RecordQualityKey = (typeof RECORD_QUALITY)[number]['key'];
export const RECORD_QUALITY_DEFAULT: RecordQualityKey = 'high';

/** 录制帧率档. 逆向自实站(24 / 30 推荐 / 60). */
export const RECORD_FPS = [24, 30, 60] as const;
export type RecordFps = (typeof RECORD_FPS)[number];
export const RECORD_FPS_DEFAULT: RecordFps = 30;

/**
 * 由短边 + 宽高比推算输出尺寸(强制偶数)。等价于实站 `lu(short, aspect)`:
 *   aspect ≥ 1(横): height = short, width = round(short*aspect)
 *   aspect < 1(竖): width = short, height = round(short/aspect)
 */
export function computeOutputSize(
  short: number,
  aspect: number,
): { width: number; height: number } {
  const a = typeof aspect === 'number' && aspect > 0 ? aspect : 16 / 9;
  let w: number, h: number;
  if (a >= 1) {
    h = short;
    w = Math.round(short * a);
  } else {
    w = short;
    h = Math.round(short / a);
  }
  return { width: w - (w % 2), height: h - (h % 2) };
}

/**
 * 视频码率(bps)= bpp × w × h × fps,限制在 [1.5Mbps, 80Mbps]。
 * 等价于实站 `su(qualityKey, w, h, fps)`。
 */
export function computeBitrate(
  qualityKey: RecordQualityKey,
  width: number,
  height: number,
  fps: number,
): number {
  const q =
    RECORD_QUALITY.find((x) => x.key === qualityKey) ?? RECORD_QUALITY[2];
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const f = Math.max(1, fps);
  return Math.max(1_500_000, Math.min(80_000_000, Math.round(q.bpp * w * h * f)));
}

/**
 * 选择浏览器支持的录制 MIME(优先 mp4/h264,回退 webm)。
 * 等价于实站 `Sf()`。
 */
export function pickRecorderMime(): { available: boolean; mime: string; ext: string } {
  const candidates = [
    'video/mp4;codecs=avc1.42E01F',
    'video/mp4;codecs=h264',
    'video/webm;codecs=h264',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  let mime = '';
  if (
    typeof MediaRecorder !== 'undefined' &&
    typeof MediaRecorder.isTypeSupported === 'function'
  ) {
    for (const c of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(c)) {
          mime = c;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  const ext = /^video\/mp4/.test(mime) ? 'mp4' : 'webm';
  return { available: !!mime, mime, ext };
}

/** 多视角批量截图的环绕方位角(度). 4视角 / 12视角. */
export const MULTI_VIEW_ANGLES = {
  4: [0, 90, 180, 270],
  12: Array.from({ length: 12 }, (_, i) => i * 30),
} as const;

/** 变换 gizmo 模式(对应 TransformControls.setMode). */
export type TransformMode = 'translate' | 'rotate' | 'scale';

/**
 * 高级假人(可骨骼摆姿) — 与实站一致的红/蓝两套 Mixamo 绑定:
 *   红色 = X Bot (x_bot.fbx)，蓝色 = Y Bot (y_bot.fbx)。
 * 资源由逆向自实站 `/dummy/{x,y}_bot.fbx` 下载，置于 ./rig 下,经
 * import.meta.url 解析为打包后 URL。
 */
export const ADVANCED_MANNEQUIN = {
  red: { key: 'x', label: '红色', botLabel: 'X Bot', file: 'x_bot.fbx' },
  blue: { key: 'y', label: '蓝色', botLabel: 'Y Bot', file: 'y_bot.fbx' },
} as const;
export type MannequinColor = keyof typeof ADVANCED_MANNEQUIN;

/** 资源解析:rig FBX 走 import.meta.url(Vite 会复制并指纹化). */
export function rigUrl(color: MannequinColor): string {
  const file = ADVANCED_MANNEQUIN[color].file;
  return new URL(`./rig/${file}`, import.meta.url).href;
}

/** 资源根:换成你自己的桶(COS/OSS/S3)时改这里;空串=用目录 JSON 里的原始 URL. */
export const DIRECTOR_ASSET_BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_DIRECTOR_ASSET_BASE ?? '';
