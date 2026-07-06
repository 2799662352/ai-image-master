import { beforeEach, describe, expect, it, vi } from 'vitest';
import { directorBridge } from '../directorBridge';
import type { DirectorStageHandle } from '../DirectorStageScene';

/**
 * directorBridge 单测:验证 agent → handle 的 action 映射与健壮性
 * (工具失败必须收敛为 { ok:false, error },绝不抛出去炸 3D 场景)。
 * 用最小 fake handle,不加载 three/场景。
 */

function makeFakeHandle(): DirectorStageHandle {
  const fake = {
    addModel: vi.fn(async () => {}),
    addCrowd: vi.fn(),
    removeSelected: vi.fn(),
    clearModels: vi.fn(),
    setTransformMode: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    duplicateSelected: vi.fn(),
    focusSelected: vi.fn(),
    deselect: vi.fn(),
    setBoxSelect: vi.fn(),
    setLensFov: vi.fn(),
    setDistance: vi.fn(),
    setKeyLight: vi.fn(),
    setAmbient: vi.fn(),
    setLightFx: vi.fn(),
    getLightFx: vi.fn(() => ({ exposure: 1 })),
    setSelectedTransform: vi.fn(),
    toggleGrid: vi.fn(),
    setPanorama: vi.fn(),
    mirror: vi.fn(),
    reset: vi.fn(),
    hasSkeleton: vi.fn(() => true),
    getBones: vi.fn(() => [{ uuid: 'b1', name: 'mixamorigHips', depth: 0 }]),
    showSkeleton: vi.fn(),
    poseBone: vi.fn(),
    setBonePick: vi.fn(),
    resetPose: vi.fn(),
    applyPose: vi.fn(),
    setBoneDelta: vi.fn(),
    isAdvancedMannequin: vi.fn(() => true),
    playAnimation: vi.fn(async () => {}),
    pauseAnimation: vi.fn(),
    resumeAnimation: vi.fn(),
    stopAnimation: vi.fn(),
    seekAnimation: vi.fn(),
    capturePoseKeyframe: vi.fn(() => null),
    applyPoseKeyframe: vi.fn(),
    playPoseClip: vi.fn(async () => {}),
    exportPoseClipGlb: vi.fn(async () => new Blob()),
    capture: vi.fn(() => 'data:image/png;base64,QUJD'),
    captureAspect: vi.fn(() => 'data:image/png;base64,QUJD'),
    captureMultiView: vi.fn(() => ['data:image/png;base64,QUJD', 'data:image/png;base64,REVG']),
    listObjects: vi.fn(() => [{ uuid: 'u1', name: 'Bot', isCrowd: false }]),
    selectByUuid: vi.fn(),
    addCameraSlot: vi.fn(() => ({
      id: 'slot1',
      name: '机位 1',
      position: [0, 1, 5] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      target: [0, 1, 0] as [number, number, number],
      fov: 40,
      showRay: false,
    })),
    applyCameraSlot: vi.fn(),
    removeCameraSlot: vi.fn(),
    duplicateCameraSlot: vi.fn(() => null),
    updateCameraSlot: vi.fn(),
    listCameraSlots: vi.fn(() => []),
    getFov: vi.fn(() => 40),
    renderSlotPreview: vi.fn(),
    recordEnter: vi.fn(),
    recordExit: vi.fn(),
    recordAddKeyframe: vi.fn((t: number) => ({
      id: 'k1',
      t,
      position: [0, 1, 5] as [number, number, number],
      quaternion: [0, 0, 0, 1] as [number, number, number, number],
      target: [0, 1, 0] as [number, number, number],
      fov: 40,
    })),
    recordListKeyframes: vi.fn(() => []),
    recordRemoveKeyframe: vi.fn(),
    recordClearKeyframes: vi.fn(),
    recordSeek: vi.fn(),
    recordPlay: vi.fn(() => () => {}),
    recordExport: vi.fn(async () => ({
      blob: new Blob(['x']),
      mime: 'video/webm',
      ext: 'webm',
      width: 1920,
      height: 1080,
      durationMs: 8000,
    })),
    recordVideo: vi.fn(async () => ({
      blob: new Blob(['x']),
      mime: 'video/webm',
      ext: 'webm',
      width: 1920,
      height: 1080,
      durationMs: 8000,
    })),
    isRecording: vi.fn(() => false),
    serializeScene: vi.fn(() => ({
      version: 1 as const,
      models: [
        {
          name: 'Bot',
          position: [0, 0, 0] as [number, number, number],
          rotationDeg: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
          bonePose: { mixamorigHips: [0, 0, 0, 1] as [number, number, number, number] },
          anim: { name: 'Walk', url: 'https://cdn/walk.fbx', time: 1.5, playing: true },
        },
      ],
      cameraSlots: [],
      camera: {
        position: [0, 1, 5] as [number, number, number],
        quaternion: [0, 0, 0, 1] as [number, number, number, number],
        target: [0, 1, 0] as [number, number, number],
        fov: 40,
      },
      light: {
        keyIntensity: 1,
        keyColor: '#fff',
        keyAzimuthDeg: 0,
        keyElevationDeg: 45,
        ambientIntensity: 0.5,
        ambientColor: '#fff',
      },
    })),
    restoreScene: vi.fn(async () => {}),
  };
  return fake as unknown as DirectorStageHandle;
}

describe('directorBridge', () => {
  let handle: DirectorStageHandle;

  beforeEach(() => {
    handle = makeFakeHandle();
    directorBridge.setHandle(handle);
  });

  it('未打开时工具返回结构化错误而不是抛异常', async () => {
    directorBridge.clearHandle();
    const res = (await directorBridge.handle('director_scene', { action: 'list_objects' })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('director_open');
  });

  it('director_open 已打开时直接就绪', async () => {
    const res = await directorBridge.handle('director_open', {});
    expect(res).toEqual({ opened: true, alreadyOpen: true });
  });

  it('scene: list_objects / select / set_transform 正确分发', async () => {
    const list = (await directorBridge.handle('director_scene', { action: 'list_objects' })) as {
      ok: boolean;
      objects: unknown[];
    };
    expect(list.ok).toBe(true);
    expect(list.objects).toHaveLength(1);

    await directorBridge.handle('director_scene', { action: 'select', uuid: 'u1' });
    expect(handle.selectByUuid).toHaveBeenCalledWith('u1');

    await directorBridge.handle('director_scene', {
      action: 'set_transform',
      position: [1, 2, 3],
      rotationDeg: [0, 90, 0],
    });
    expect(handle.setSelectedTransform).toHaveBeenCalledWith({
      position: [1, 2, 3],
      rotationDeg: [0, 90, 0],
      scale: undefined,
    });
  });

  it('scene: 缺参/未知 action 收敛为 ok:false', async () => {
    const noUuid = (await directorBridge.handle('director_scene', { action: 'select' })) as {
      ok: boolean;
      error?: string;
    };
    expect(noUuid.ok).toBe(false);
    expect(noUuid.error).toContain('uuid');

    const unknown = (await directorBridge.handle('director_scene', { action: 'blow_up' })) as {
      ok: boolean;
      error?: string;
    };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain('blow_up');
  });

  it('scene: 灯光/机位/姿势/动画 分发到对应 handle 方法', async () => {
    await directorBridge.handle('director_scene', {
      action: 'set_key_light',
      intensity: 2,
      azimuthDeg: 30,
    });
    expect(handle.setKeyLight).toHaveBeenCalledWith({
      intensity: 2,
      azimuthDeg: 30,
      elevationDeg: undefined,
      color: undefined,
    });

    const slot = (await directorBridge.handle('director_scene', {
      action: 'add_camera_slot',
      name: '正面',
    })) as { ok: boolean; slot: { id: string } };
    expect(slot.ok).toBe(true);
    expect(handle.addCameraSlot).toHaveBeenCalledWith('正面');

    await directorBridge.handle('director_scene', {
      action: 'set_bone_delta',
      bone: 'mixamorigRightArm',
      deg: [0, 0, 60],
    });
    expect(handle.setBoneDelta).toHaveBeenCalledWith('mixamorigRightArm', [0, 0, 60]);

    await directorBridge.handle('director_scene', {
      action: 'play_animation',
      url: 'https://cdn/walk.fbx',
      name: 'Walk',
    });
    expect(handle.playAnimation).toHaveBeenCalledWith('https://cdn/walk.fbx', 'Walk', undefined);
  });

  it('snapshot summary 剔除 bonePose 但保留动画状态', async () => {
    const res = (await directorBridge.handle('director_snapshot', {})) as {
      ok: boolean;
      models: Array<{ bonePose?: unknown; hasPose: boolean; anim?: { name: string; playing: boolean } }>;
    };
    expect(res.ok).toBe(true);
    expect(res.models[0].bonePose).toBeUndefined();
    expect(res.models[0].hasPose).toBe(true);
    expect(res.models[0].anim?.name).toBe('Walk');
    expect(res.models[0].anim?.playing).toBe(true);
  });

  it('snapshot full 返回完整 serializeScene(含 bonePose)', async () => {
    const res = (await directorBridge.handle('director_snapshot', { mode: 'full' })) as {
      ok: boolean;
      scene: { models: Array<{ bonePose?: unknown }> };
    };
    expect(res.ok).toBe(true);
    expect(res.scene.models[0].bonePose).toBeDefined();
  });

  it('capture 没有 threadId 时返回结构化错误(不落盘)', async () => {
    const res = (await directorBridge.handle('director_capture', { mode: 'view' })) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(handle.capture).toHaveBeenCalled();
  });

  it('record: add_keyframe / export 参数校验', async () => {
    const noT = (await directorBridge.handle('director_record', { action: 'add_keyframe' })) as {
      ok: boolean;
    };
    expect(noT.ok).toBe(false);

    const added = (await directorBridge.handle('director_record', {
      action: 'add_keyframe',
      t: 2.5,
    })) as { ok: boolean; keyframe: { id: string; t: number } };
    expect(added.ok).toBe(true);
    expect(added.keyframe.t).toBe(2.5);
    expect(handle.recordAddKeyframe).toHaveBeenCalledWith(2.5);
  });

  it('director_exec 在 handle 上执行 JS 并回传结果', async () => {
    const res = (await directorBridge.handle('director_exec', {
      code: 'return director.listObjects().length',
    })) as { success: boolean; result?: unknown };
    expect(res.success).toBe(true);
    expect(res.result).toBe(1);
  });

  it('director_exec 抛错收敛为 success:false', async () => {
    const res = (await directorBridge.handle('director_exec', {
      code: 'throw new Error("boom")',
    })) as { success: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toContain('boom');
  });
});
