import type {
  CameraSlot,
  DirectorSceneData,
  DirectorStageHandle,
  RecordOptions,
  RecordResult,
} from './DirectorStageScene';
import type { CaptureResolution, RecordFps, RecordQualityKey } from './directorConstants';
import type { PoseKeyframe } from './directorPoseClip';

/**
 * directorBridge —— 导演台的 agent 控制桥(仿 canvasBridge)。
 *
 * DirectorEditor 挂载时把 DirectorStageHandle 注册进来,卸载时清除;
 * AgentToolExecutor 把 `director_*` 工具调用路由到 {@link DirectorBridge.handle}。
 * 产品拍板「最高权限,别担心越权」:含 `director_exec` 逃生舱(直接在
 * handle 上跑模型写的 JS,与 canvas_exec 同款 AsyncFunction + 超时,不设沙箱)。
 *
 * 打包纪律:本模块被 AgentToolExecutor 静态引入(主 chunk),因此这里
 * **只允许 type-only import** 导演台重模块;catalog/poses/launcher/three
 * 一律在 action 内动态 import(three 只有导演台已打开时才会用到,彼时其
 * chunk 早已加载,动态 import 命中缓存)。
 */

const EXEC_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 30_000;

type AttachmentsSaveApi = {
  save?: (a: {
    threadId: string;
    name: string;
    mime: string;
    base64: string;
  }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
};

/** `new AsyncFunction(...)` — CSP 允许 unsafe-eval,与 canvas_exec 同款. */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function vec3(v: unknown): [number, number, number] | undefined {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')
    ? (v as [number, number, number])
    : undefined;
}

function serializeResult(result: unknown): unknown {
  if (result === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}

/**
 * 归一化 agent 传来的姿势关键帧数组:每帧要求 {t, bones};rootPos 缺省补
 * [0,0,0],id 缺省补新 id(agent 不需要关心 id,只在 UI 时间轴里有意义)。
 */
async function normalizePoseKeys(value: unknown): Promise<PoseKeyframe[]> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      'keyframes 需要非空数组:[{ t:秒, bones:{骨骼名:[qx,qy,qz,qw]}, rootPos?:[x,y,z] }, …](可用 capture_pose_keyframe 逐帧采集)。',
    );
  }
  const { newKeyframeId } = await import('./directorPoseClip');
  return value.map((raw, i) => {
    const k = raw as Partial<PoseKeyframe> & { t?: unknown; bones?: unknown };
    const t = typeof k.t === 'number' && Number.isFinite(k.t) ? k.t : null;
    const bones = k.bones && typeof k.bones === 'object' ? (k.bones as PoseKeyframe['bones']) : null;
    if (t == null || !bones || Object.keys(bones).length === 0) {
      throw new Error(`keyframes[${i}] 缺少 t 或 bones。`);
    }
    return {
      id: typeof k.id === 'string' && k.id ? k.id : newKeyframeId(),
      t,
      bones,
      rootPos: vec3(k.rootPos) ?? [0, 0, 0],
    };
  });
}

/**
 * 3D 资产 URL 归一化:web/blob/data URL 原样返回;本地路径(D:\…、
 * local-file://、file://)经 attachments IPC 读字节转 blob: URL —— 沙箱
 * 渲染器里 three 的 GLTFLoader/FBXLoader 走 fetch,吃不了本地路径。
 * 这让 agent 能导入用户的本地模型/动画,也能把 export_pose_clip_glb
 * 刚落盘的 .glb 直接喂回 play_animation。
 */
async function resolveAssetUrl(rawUrl: string): Promise<{ url: string; ext?: string }> {
  const extMatch = /\.(glb|gltf|fbx|json)(?:[?#]|$)/i.exec(rawUrl);
  const ext = extMatch ? extMatch[1].toLowerCase() : undefined;
  const { resolveMediaSrcOnce } = await import('../../media/useResolvedMediaSrc');
  const resolved = await resolveMediaSrcOnce(rawUrl, 'auto', { fullFidelity: true });
  if (!resolved) {
    throw new Error(
      `无法读取模型/动画文件:${rawUrl}(文件不存在,或扩展名不受支持 —— 仅支持 glb/gltf/fbx/json)。`,
    );
  }
  return { url: resolved, ext };
}

function dataUrlToBase64(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  return m ? { mime: m[1] || 'image/png', base64: m[2] } : null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'));
    reader.readAsDataURL(blob);
  });
}

async function saveAttachment(
  threadId: string,
  name: string,
  mime: string,
  base64: string,
): Promise<string | undefined> {
  const api = (window as Window & { electronAPI?: { attachments?: AttachmentsSaveApi } })
    .electronAPI?.attachments;
  if (!api?.save) return undefined;
  const res = await api.save({ threadId, name, mime, base64 });
  return res.ok ? res.path : undefined;
}

class DirectorBridge {
  private stage: DirectorStageHandle | null = null;
  private waiters: Array<(h: DirectorStageHandle) => void> = [];

  setHandle(handle: DirectorStageHandle | null): void {
    this.stage = handle;
    if (handle) {
      const pending = this.waiters;
      this.waiters = [];
      for (const resolve of pending) resolve(handle);
    }
  }

  clearHandle(): void {
    this.stage = null;
  }

  isOpen(): boolean {
    return this.stage != null;
  }

  /** Resolve once the Director Stage has mounted (or reject on timeout). */
  waitForHandle(timeoutMs = OPEN_TIMEOUT_MS): Promise<DirectorStageHandle> {
    if (this.stage) return Promise.resolve(this.stage);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReady);
        reject(new Error('导演台未在超时内就绪。请先调用 director_open(或让用户点顶栏「导演台 3D」)。'));
      }, timeoutMs);
      const onReady = (h: DirectorStageHandle): void => {
        clearTimeout(timer);
        resolve(h);
      };
      this.waiters.push(onReady);
    });
  }

  private requireHandle(): DirectorStageHandle {
    if (!this.stage) {
      throw new Error('导演台未打开。先调用 director_open。');
    }
    return this.stage;
  }

  /** director_open:已开 → 直接就绪;未开 → 挂顶栏同款独立浮层再等 handle. */
  async open(): Promise<{ opened: true; alreadyOpen: boolean }> {
    if (this.stage) return { opened: true, alreadyOpen: true };
    const launcher = await import('../../../../features/director-launcher');
    launcher.openDirectorOverlay();
    await this.waitForHandle();
    return { opened: true, alreadyOpen: false };
  }

  /**
   * 统一入口:AgentToolExecutor 把 director_* 工具路由到这里。
   * 任何抛错都收敛为 { ok:false, error } —— 工具失败绝不允许炸掉 3D 场景。
   */
  async handle(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      switch (toolName) {
        case 'director_open':
          return await this.open();
        case 'director_scene':
          return await this.scene(String(params.action ?? ''), params);
        case 'director_snapshot':
          return this.snapshot(params.mode === 'full' ? 'full' : 'summary');
        case 'director_capture':
          return await this.capture(params, str(params.threadId));
        case 'director_record':
          return await this.record(String(params.action ?? ''), params, str(params.threadId));
        case 'director_exec':
          return await this.exec(String(params.code ?? ''));
        default:
          throw new Error(`Unknown director tool: ${toolName}`);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── director_exec:最高权限逃生舱 ─────────────────────────────
  /**
   * 在活的 DirectorStageHandle 上执行模型 JS。作用域:`director`(全部
   * 55+ 方法)+ `THREE`(three 命名空间)。AsyncFunction + 30s 超时,
   * 抛错回结构体,与 canvas_exec 完全同款(产品要求不设限)。
   */
  async exec(code: string): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const director = this.requireHandle();
    if (!code) return { success: false, error: 'director_exec 缺少 code。' };
    const THREE = await import('three');
    try {
      const fn = new AsyncFunction('director', 'THREE', code);
      const run = fn(director, THREE);
      const result = await Promise.race([
        run,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`director_exec timed out after ${EXEC_TIMEOUT_MS}ms`)),
            EXEC_TIMEOUT_MS,
          ),
        ),
      ]);
      return { success: true, result: serializeResult(result) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── director_snapshot:让 agent「读懂」场景 ───────────────────
  snapshot(mode: 'summary' | 'full'): unknown {
    const h = this.requireHandle();
    const scene = h.serializeScene();
    if (mode === 'full') {
      return { ok: true, mode, scene, objects: h.listObjects() };
    }
    // summary:剔除逐骨骼四元数(几百个数),保留 agent 决策需要的一切。
    const models = scene.models.map(({ bonePose, anim, ...rest }) => ({
      ...rest,
      hasPose: Boolean(bonePose && Object.keys(bonePose).length > 0),
      anim: anim ? { name: anim.name, url: anim.url, playing: anim.playing, time: anim.time } : undefined,
    }));
    return {
      ok: true,
      mode,
      objects: h.listObjects(),
      models,
      camera: { ...scene.camera, fov: h.getFov() },
      cameraSlots: scene.cameraSlots.map((s: CameraSlot) => ({
        id: s.id,
        name: s.name,
        fov: s.fov,
        position: s.position,
        target: s.target,
      })),
      light: scene.light,
      fx: h.getLightFx(),
      recordKeyframes: h.recordListKeyframes().map((k) => ({ id: k.id, t: k.t })),
      selectionHasSkeleton: h.hasSkeleton(),
    };
  }

  // ── director_capture:让 agent「看见」画面 ────────────────────
  async capture(params: Record<string, unknown>, threadId?: string): Promise<unknown> {
    const h = this.requireHandle();
    const slotId = str(params.slotId);
    if (slotId) h.applyCameraSlot(slotId);
    const mode = str(params.mode) ?? 'view';
    let dataUrls: string[];
    if (mode === 'multiview') {
      dataUrls = h.captureMultiView(num(params.count) === 12 ? 12 : 4, num(params.height) ?? 720);
    } else if (mode === 'aspect') {
      dataUrls = [h.captureAspect(num(params.ratio) ?? null, num(params.short) ?? 1080)];
    } else {
      dataUrls = [h.capture(num(params.height) ?? 1080)];
    }
    if (!threadId) {
      return { ok: false, error: '没有活跃聊天线程,截图无法落盘(需在 agent 会话内调用)。' };
    }
    const imagePaths: string[] = [];
    for (let i = 0; i < dataUrls.length; i++) {
      const decoded = dataUrlToBase64(dataUrls[i]);
      if (!decoded) continue;
      const p = await saveAttachment(
        threadId,
        `director-capture-${Date.now()}-${i}.png`,
        decoded.mime,
        decoded.base64,
      );
      if (p) imagePaths.push(p);
    }
    if (imagePaths.length === 0) return { ok: false, error: '截图导出失败(attachments API 不可用)。' };
    return { ok: true, mode, imagePaths };
  }

  // ── director_record:运镜关键帧 + 导出视频 ───────────────────
  async record(
    action: string,
    params: Record<string, unknown>,
    threadId?: string,
  ): Promise<unknown> {
    const h = this.requireHandle();
    switch (action) {
      case 'enter':
        h.recordEnter();
        return { ok: true };
      case 'exit':
        h.recordExit();
        return { ok: true };
      case 'add_keyframe': {
        const t = num(params.t);
        if (t == null) throw new Error('add_keyframe 需要 t(秒)。');
        const k = h.recordAddKeyframe(t);
        return { ok: true, keyframe: { id: k.id, t: k.t } };
      }
      case 'list':
        return { ok: true, keyframes: h.recordListKeyframes().map((k) => ({ id: k.id, t: k.t })) };
      case 'remove': {
        const id = str(params.id);
        if (!id) throw new Error('remove 需要 id。');
        h.recordRemoveKeyframe(id);
        return { ok: true };
      }
      case 'clear':
        h.recordClearKeyframes();
        return { ok: true };
      case 'seek': {
        const t = num(params.t);
        if (t == null) throw new Error('seek 需要 t(秒)。');
        h.recordSeek(t);
        return { ok: true };
      }
      case 'play': {
        // 预览播放一遍(不导出):插值机位只播关键帧首→末区间,不含空白段。
        const kfs = h.recordListKeyframes();
        if (kfs.length < 2) return { ok: false, error: '至少需要 2 个关键帧才能播放运镜(先 add_keyframe)。' };
        const tStart = kfs[0].t;
        const tEnd = Math.min(
          num(params.durationSec) != null ? tStart + (num(params.durationSec) as number) : kfs[kfs.length - 1].t,
          tStart + 120,
        );
        const spanSec = Math.max(0.1, tEnd - tStart);
        await new Promise<void>((resolve) => {
          // 安全护栏:onDone 丢失时按时长+2s 兜底停,避免工具调用挂死。
          let guard: ReturnType<typeof setTimeout> | undefined;
          const stop = h.recordPlay(tStart, tEnd, () => undefined, () => {
            if (guard != null) clearTimeout(guard);
            resolve();
          });
          guard = setTimeout(() => {
            stop();
            resolve();
          }, (spanSec + 2) * 1000);
        });
        return { ok: true, durationSec: spanSec };
      }
      case 'capture_video': {
        // 直录当前视口(不插值机位)—— 适合录一段正在播放的角色动画。
        const opts: RecordOptions = {
          durationSec: Math.min(num(params.durationSec) ?? 5, 60),
          resolution: (str(params.resolution) ?? '1080p') as CaptureResolution,
          fps: (num(params.fps) ?? 30) as RecordFps,
          quality: (str(params.quality) ?? 'high') as RecordQualityKey,
        };
        const result: RecordResult = await h.recordVideo(opts);
        if (!threadId) return { ok: false, error: '没有活跃聊天线程,视频无法落盘。' };
        const base64 = await blobToBase64(result.blob);
        const videoPath = await saveAttachment(
          threadId,
          `director-video-${Date.now()}.${result.ext}`,
          result.mime,
          base64,
        );
        if (!videoPath) return { ok: false, error: '视频落盘失败(attachments API 不可用)。' };
        return { ok: true, videoPath, width: result.width, height: result.height, durationMs: result.durationMs };
      }
      case 'export': {
        // 默认 0 = 按关键帧首→末跨度 1:1 实时导出;显式传值才拉伸时长。
        const durationSec = num(params.durationSec) ?? 0;
        const resolution = (str(params.resolution) ?? '1080p') as CaptureResolution;
        const fps = (num(params.fps) ?? 30) as RecordFps;
        const quality = (str(params.quality) ?? 'high') as RecordQualityKey;
        const result: RecordResult = await h.recordExport({ durationSec, resolution, fps, quality });
        if (!threadId) {
          return { ok: false, error: '没有活跃聊天线程,视频无法落盘。' };
        }
        const base64 = await blobToBase64(result.blob);
        const videoPath = await saveAttachment(
          threadId,
          `director-record-${Date.now()}.${result.ext}`,
          result.mime,
          base64,
        );
        if (!videoPath) return { ok: false, error: '视频导出落盘失败(attachments API 不可用)。' };
        return {
          ok: true,
          videoPath,
          width: result.width,
          height: result.height,
          durationMs: result.durationMs,
          mime: result.mime,
        };
      }
      default:
        throw new Error(`Unknown director_record action: ${action}`);
    }
  }

  // ── director_scene:对象/变换/灯光/机位/姿势/动画 全量操作 ────
  async scene(action: string, params: Record<string, unknown>): Promise<unknown> {
    const h = this.requireHandle();
    switch (action) {
      // 对象管理 -------------------------------------------------
      case 'list_objects':
        return { ok: true, objects: h.listObjects() };
      case 'list_model_catalog': {
        const { getCatalog } = await import('./directorCatalog');
        const kw = (str(params.keyword) ?? '').toLowerCase();
        const items = getCatalog().flatMap((c) =>
          c.models.map((m) => ({ category: c.label, id: m.id, name: m.name, url: m.url })),
        );
        const filtered = kw
          ? items.filter((m) => m.name.toLowerCase().includes(kw) || m.id.toLowerCase().includes(kw))
          : items;
        return { ok: true, count: filtered.length, models: filtered.slice(0, num(params.limit) ?? 100) };
      }
      case 'add_model': {
        const raw = str(params.url);
        if (!raw) throw new Error('add_model 需要 url(可先 list_model_catalog 查目录;也接受本地 glb/gltf/fbx 文件路径)。');
        const asset = await resolveAssetUrl(raw);
        await h.addModel(asset.url, {
          isFbx: params.isFbx === true || asset.ext === 'fbx',
          modelId: str(params.modelId),
        });
        return { ok: true, objects: h.listObjects() };
      }
      case 'add_mannequin': {
        const { rigUrl } = await import('./directorConstants');
        const color = params.color === 'red' ? 'red' : 'blue';
        await h.addModel(rigUrl(color), { isFbx: true, modelId: `mannequin-${color}` });
        return { ok: true, objects: h.listObjects() };
      }
      case 'add_crowd': {
        const layout = str(params.layout) ?? 'single';
        h.addCrowd({
          layout: (layout === 'array' || layout === 'random' ? layout : 'single') as never,
          count: num(params.count),
          columns: num(params.columns),
          spacingX: num(params.spacingX),
          spacingZ: num(params.spacingZ),
          radius: num(params.radius),
        });
        return { ok: true, objects: h.listObjects() };
      }
      case 'select': {
        const uuid = str(params.uuid);
        if (!uuid) throw new Error('select 需要 uuid(来自 list_objects)。');
        h.selectByUuid(uuid);
        return { ok: true };
      }
      case 'deselect':
        h.deselect();
        return { ok: true };
      case 'remove_selected':
        h.removeSelected();
        return { ok: true, objects: h.listObjects() };
      case 'duplicate_selected':
        h.duplicateSelected();
        return { ok: true, objects: h.listObjects() };
      case 'clear_models':
        h.clearModels();
        return { ok: true };
      case 'focus_selected':
        h.focusSelected();
        return { ok: true };
      case 'mirror':
        h.mirror();
        return { ok: true };
      case 'undo':
        h.undo();
        return { ok: true };
      case 'redo':
        h.redo();
        return { ok: true };
      case 'set_transform': {
        h.setSelectedTransform({
          position: vec3(params.position),
          rotationDeg: vec3(params.rotationDeg),
          scale: vec3(params.scale),
        });
        return { ok: true };
      }
      case 'toggle_grid':
        h.toggleGrid(params.visible !== false);
        return { ok: true };
      case 'set_panorama':
        h.setPanorama(str(params.url) ?? null);
        return { ok: true };
      // 相机 / 机位 ---------------------------------------------
      case 'set_fov': {
        const fov = num(params.fov);
        if (fov == null) throw new Error('set_fov 需要 fov。');
        h.setLensFov(fov);
        return { ok: true, fov: h.getFov() };
      }
      case 'get_fov':
        return { ok: true, fov: h.getFov() };
      case 'set_distance': {
        const d = num(params.distance);
        if (d == null) throw new Error('set_distance 需要 distance。');
        h.setDistance(d);
        return { ok: true };
      }
      case 'add_camera_slot': {
        const slot = h.addCameraSlot(str(params.name));
        return { ok: true, slot: { id: slot.id, name: slot.name, fov: slot.fov } };
      }
      case 'apply_camera_slot': {
        const id = str(params.id);
        if (!id) throw new Error('apply_camera_slot 需要 id。');
        h.applyCameraSlot(id);
        return { ok: true };
      }
      case 'remove_camera_slot': {
        const id = str(params.id);
        if (!id) throw new Error('remove_camera_slot 需要 id。');
        h.removeCameraSlot(id);
        return { ok: true };
      }
      case 'update_camera_slot': {
        const id = str(params.id);
        if (!id) throw new Error('update_camera_slot 需要 id。');
        h.updateCameraSlot(id, (params.patch ?? {}) as never);
        return { ok: true };
      }
      case 'list_camera_slots':
        return { ok: true, slots: h.listCameraSlots() };
      // 灯光 / 调色 ---------------------------------------------
      case 'set_key_light':
        h.setKeyLight({
          intensity: num(params.intensity),
          azimuthDeg: num(params.azimuthDeg),
          elevationDeg: num(params.elevationDeg),
          color: str(params.color),
        });
        return { ok: true };
      case 'set_ambient':
        h.setAmbient({ intensity: num(params.intensity), color: str(params.color) });
        return { ok: true };
      case 'set_light_fx':
        h.setLightFx((params.fx ?? params) as never);
        return { ok: true, fx: h.getLightFx() };
      case 'get_light_fx':
        return { ok: true, fx: h.getLightFx() };
      // 姿势(需先 select 一个高级假人) --------------------------
      case 'has_skeleton':
        return { ok: true, hasSkeleton: h.hasSkeleton(), isAdvancedMannequin: h.isAdvancedMannequin() };
      case 'get_bones':
        return { ok: true, bones: h.getBones() };
      case 'list_pose_presets': {
        const { POSE_KEYS } = await import('./directorPoses');
        return { ok: true, presets: POSE_KEYS };
      }
      case 'apply_pose': {
        const preset = str(params.preset);
        if (preset) {
          const { getPose } = await import('./directorPoses');
          h.applyPose(getPose(preset));
          return { ok: true, preset };
        }
        const map = params.map;
        if (map && typeof map === 'object') {
          h.applyPose(map as Record<string, [number, number, number, number]>);
          return { ok: true };
        }
        h.applyPose(null);
        return { ok: true, reset: true };
      }
      case 'set_bone_delta': {
        const bone = str(params.bone);
        const deg = vec3(params.deg);
        if (!bone || !deg) throw new Error('set_bone_delta 需要 bone + deg:[x,y,z](度)。');
        h.setBoneDelta(bone, deg);
        return { ok: true };
      }
      case 'reset_pose':
        h.resetPose();
        return { ok: true };
      // 动画(需先 select 一个高级假人) --------------------------
      case 'search_animations': {
        const { loadAnimCatalog, filterAnimations, animUrl } = await import('./directorAnimations');
        const catalog = await loadAnimCatalog();
        const matches = filterAnimations(catalog.animations, {
          keyword: str(params.keyword),
          category: str(params.category),
        });
        return {
          ok: true,
          categories: catalog.categories,
          count: matches.length,
          animations: matches
            .slice(0, num(params.limit) ?? 30)
            .map((a) => ({ id: a.id, name: a.name, nameEn: a.nameEn, cat: a.cat, url: animUrl(a) })),
        };
      }
      case 'play_animation': {
        const raw = str(params.url);
        if (!raw) throw new Error('play_animation 需要 url(可先 search_animations;也接受本地 fbx/glb/json 动画文件路径,含 export_pose_clip_glb 刚导出的 .glb)。');
        const asset = await resolveAssetUrl(raw);
        await h.playAnimation(asset.url, str(params.name), str(params.ext) ?? asset.ext);
        return { ok: true };
      }
      case 'pause_animation':
        h.pauseAnimation();
        return { ok: true };
      case 'resume_animation':
        h.resumeAnimation();
        return { ok: true };
      case 'stop_animation':
        h.stopAnimation();
        return { ok: true };
      case 'seek_animation': {
        const sec = num(params.sec);
        if (sec == null) throw new Error('seek_animation 需要 sec。');
        h.seekAnimation(sec);
        return { ok: true };
      }
      // K 动画:姿势关键帧 → 编译剪辑(需先 select 一个高级假人) ----
      case 'capture_pose_keyframe': {
        const k = h.capturePoseKeyframe();
        if (!k) {
          return { ok: false, error: '当前选中不是高级假人(先 add_mannequin + select 再摆姿势)。' };
        }
        return { ok: true, keyframe: k, boneCount: Object.keys(k.bones).length };
      }
      case 'apply_pose_keyframe': {
        const k = params.keyframe as Partial<PoseKeyframe> | undefined;
        if (!k || typeof k !== 'object' || !k.bones || typeof k.bones !== 'object') {
          throw new Error('apply_pose_keyframe 需要 keyframe:{ bones, rootPos? }(capture_pose_keyframe 的返回)。');
        }
        h.applyPoseKeyframe({ bones: k.bones, rootPos: vec3(k.rootPos) ?? [0, 0, 0] });
        return { ok: true };
      }
      case 'play_pose_clip': {
        const keys = await normalizePoseKeys(params.keyframes);
        const duration = num(params.duration) ?? Math.max(...keys.map((k) => k.t), 1);
        await h.playPoseClip(keys, duration, str(params.name));
        return { ok: true, keyframes: keys.length, duration };
      }
      case 'export_pose_clip_glb': {
        const keys = await normalizePoseKeys(params.keyframes);
        const duration = num(params.duration) ?? Math.max(...keys.map((k) => k.t), 1);
        const name = str(params.name) ?? 'director-anim';
        const blob = await h.exportPoseClipGlb(keys, duration, name);
        const threadId = str(params.threadId);
        if (!threadId) return { ok: false, error: '没有活跃聊天线程,.glb 无法落盘。' };
        const base64 = await blobToBase64(blob);
        const glbPath = await saveAttachment(
          threadId,
          `${name}-${Date.now()}.glb`,
          'model/gltf-binary',
          base64,
        );
        if (!glbPath) return { ok: false, error: '.glb 导出落盘失败(attachments API 不可用)。' };
        return { ok: true, glbPath, keyframes: keys.length, duration, bytes: blob.size };
      }
      // 场景管理 / 视图辅助 --------------------------------------
      case 'restore_scene': {
        const data = (params.scene ?? params.data) as DirectorSceneData | undefined;
        if (!data || typeof data !== 'object' || !Array.isArray((data as DirectorSceneData).models)) {
          throw new Error('restore_scene 需要 scene(director_snapshot mode=full 返回的 scene 字段,或保存工程的 JSON)。');
        }
        await h.restoreScene(data);
        return { ok: true, objects: h.listObjects() };
      }
      case 'reset':
        h.reset();
        return { ok: true };
      case 'set_transform_mode': {
        const mode = str(params.mode);
        if (mode !== 'translate' && mode !== 'rotate' && mode !== 'scale') {
          throw new Error("set_transform_mode 需要 mode:'translate'|'rotate'|'scale'。");
        }
        h.setTransformMode(mode);
        return { ok: true };
      }
      case 'show_skeleton':
        h.showSkeleton(params.visible !== false);
        return { ok: true };
      case 'duplicate_camera_slot': {
        const id = str(params.id);
        if (!id) throw new Error('duplicate_camera_slot 需要 id。');
        const slot = h.duplicateCameraSlot(id);
        return slot
          ? { ok: true, slot: { id: slot.id, name: slot.name, fov: slot.fov } }
          : { ok: false, error: `机位不存在:${id}` };
      }
      default:
        throw new Error(
          `Unknown director_scene action: ${action}。可用 action 见 director_scene 工具描述。`,
        );
    }
  }
}

export const directorBridge = new DirectorBridge();
