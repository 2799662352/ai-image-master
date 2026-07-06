# 3D 导演台「动画」Tab 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为高级假人（Mixamo X/Y Bot）加 RunningHub 同款「动画」Tab：19 分类 / 2032 条 Mixamo FBX 动作，点选播放，浮动播放条支持 播放/暂停/停止/拖动。

**Architecture:** 数据层（紧凑目录 JSON 动态 import + 纯函数过滤/URL 解析）→ 场景层（`THREE.AnimationMixer` 挂选中假人，RAF 循环里 `mixer.update(dt)`，剪辑模块级缓存，瞬态不入撤销/工程）→ UI 层（DirectorEditor 第三个 Tab + 视口底部播放条）。

**Tech Stack:** three.js（AnimationMixer/FBXLoader）、React、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-06-director-animation-tab-design.md`

---

### Task 1: 数据层 — 目录 JSON + directorAnimations.ts（TDD）

**Files:**
- Create: `src/renderer/src/components/shared/image-editors/director/animation-catalog.json`（已由转换脚本生成：`{categories:[{code,name}×19], animations:[{id,cat,name,nameEn,uid,file?}×2032]}`，uid=CDN 路径 uuid，file 仅当文件名≠`animation` 时存在）
- Create: `src/renderer/src/components/shared/image-editors/director/directorAnimations.ts`
- Test: `tests/features/DirectorAnimations.test.ts`

- [x] **Step 1: 生成紧凑目录 JSON**（node 一次性脚本，源 `docs/director-animation-catalog.json`，清除零宽字符，2032/2032 解析成功，333KB）

- [x] **Step 2: 写失败测试**

```ts
// tests/features/DirectorAnimations.test.ts
import { describe, it, expect } from 'vitest';
import {
  animUrl,
  filterAnimations,
  type DirectorAnimation,
} from '../../src/renderer/src/components/shared/image-editors/director/directorAnimations';

const A = (p: Partial<DirectorAnimation>): DirectorAnimation => ({
  id: '1', cat: 'C', name: '走路', nameEn: 'Walking', uid: 'a'.repeat(32), ...p,
});

describe('animUrl', () => {
  it('无自有桶 → 拼原始 CDN(默认 animation.fbx)', () => {
    expect(animUrl(A({}), '')).toBe(
      `https://rh-canvas-files.xiaoyaoyou.com/default/animation/${'a'.repeat(32)}/animation.fbx`,
    );
  });
  it('保留非默认文件名', () => {
    expect(animUrl(A({ file: 'Funky_Pocoto' }), '')).toContain('/Funky_Pocoto.fbx');
  });
  it('自有桶 base → <base>/animations/<id>.fbx(容忍尾斜杠)', () => {
    expect(animUrl(A({ id: '42' }), 'https://cdn.me/dir/')).toBe('https://cdn.me/dir/animations/42.fbx');
  });
});

describe('filterAnimations', () => {
  const list = [
    A({ id: '1', cat: 'WALK', name: '走路', nameEn: 'Walking' }),
    A({ id: '2', cat: 'WALK', name: '跑步', nameEn: 'Running fast' }),
    A({ id: '3', cat: 'DANCE', name: '街舞', nameEn: 'Hip Hop Dance' }),
  ];
  it('默认返回全部', () => expect(filterAnimations(list)).toHaveLength(3));
  it('按分类过滤', () => expect(filterAnimations(list, { category: 'WALK' })).toHaveLength(2));
  it('中文关键词', () => expect(filterAnimations(list, { keyword: '街舞' })[0].id).toBe('3'));
  it('英文关键词不分大小写', () =>
    expect(filterAnimations(list, { keyword: 'runNING' })[0].id).toBe('2'));
  it('分类+关键词组合', () =>
    expect(filterAnimations(list, { category: 'WALK', keyword: 'dance' })).toHaveLength(0));
});
```

- [x] **Step 3: 跑测试确认失败**（模块不存在）

Run: `npx vitest run tests/features/DirectorAnimations.test.ts` → FAIL (cannot resolve module)

- [x] **Step 4: 实现 directorAnimations.ts**

```ts
import { DIRECTOR_ASSET_BASE } from './directorConstants';

export interface DirectorAnimation {
  id: string;
  /** 分类 code(对应 AnimCategory.code). */
  cat: string;
  name: string;
  nameEn: string;
  /** CDN 路径里的 32 位 hex 目录名. */
  uid: string;
  /** FBX 文件名(不含扩展名);缺省 = 'animation'. */
  file?: string;
}
export interface AnimCategory { code: string; name: string }
export interface AnimCatalog { categories: AnimCategory[]; animations: DirectorAnimation[] }

const CDN_BASE = 'https://rh-canvas-files.xiaoyaoyou.com/default/animation';

let catalogPromise: Promise<AnimCatalog> | null = null;
/** 动态 import(≈330KB JSON 独立 chunk,首次打开动画 Tab 才加载),缓存单例. */
export function loadAnimCatalog(): Promise<AnimCatalog> {
  catalogPromise ??= import('./animation-catalog.json').then(
    (m) => (m as { default: unknown }).default as AnimCatalog,
  );
  return catalogPromise;
}

/** 双轨解析:自有桶 base 非空 → <base>/animations/<id>.fbx;否则原始 CDN. */
export function animUrl(a: DirectorAnimation, base: string = DIRECTOR_ASSET_BASE): string {
  const b = base.replace(/\/+$/, '');
  if (b) return `${b}/animations/${a.id}.fbx`;
  return `${CDN_BASE}/${a.uid}/${a.file ?? 'animation'}.fbx`;
}

/** 分类 + 关键词(中文子串 / 英文不分大小写)过滤;均可省略. */
export function filterAnimations(
  list: readonly DirectorAnimation[],
  opts: { category?: string; keyword?: string } = {},
): DirectorAnimation[] {
  const cat = opts.category ?? '';
  const kw = (opts.keyword ?? '').trim().toLowerCase();
  return list.filter((a) => {
    if (cat && a.cat !== cat) return false;
    if (!kw) return true;
    return a.name.toLowerCase().includes(kw) || a.nameEn.toLowerCase().includes(kw);
  });
}
```

- [x] **Step 5: 跑测试确认通过** → 8 passed

### Task 2: 场景层 — DirectorStageScene 动画播放

**Files:**
- Modify: `src/renderer/src/components/shared/image-editors/director/DirectorStageScene.tsx`
  - Handle 接口（~L237 `isAdvancedMannequin` 后）加 5 个方法 + `AnimTick` 导出类型
  - Props 加 `onAnimTick?`；组件加 `onAnimTickRef`（仿 `onSelRef` 模式,L461-489）
  - `StageState`（L373 `dragSnap` 后）加 `anim: ActiveAnim | null` 与 `clock: THREE.Clock`；state 初始化（L1563 后）加 `anim: null, clock: new THREE.Clock()`
  - RAF 循环（L1759）加 `mixer.update(dt)` + 节流 tick
  - `deselectAll`/`selectMany`/`deleteSelectedImpl`/`clearModels`/unmount 清理动画
  - 模块级 `loadAnimClip`（剪辑缓存）+ `retargetClipTracks`（骨骼名规范化兜底,复用 `normBone`）

- [x] **Step 1: 类型 + 状态字段**

```ts
/** 动画播放进度回传(null = 无活动动画). */
export interface AnimTick {
  url: string;
  name: string;
  time: number;
  duration: number;
  playing: boolean;
}
// Handle 新增(注释:动画为瞬态预览,不入撤销栈/不进保存工程):
playAnimation(url: string, name?: string): Promise<void>;
pauseAnimation(): void;
resumeAnimation(): void;
stopAnimation(): void;
seekAnimation(sec: number): void;
// Props 新增:
onAnimTick?: (tick: AnimTick | null) => void;
// StageState 新增:
anim: ActiveAnim | null;
clock: THREE.Clock;
// 新接口:
interface ActiveAnim {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  target: THREE.Object3D;
  poseSnap: PoseSnap; // 播放前姿势快照,stop 时恢复
  duration: number;
  url: string;
  name: string;
}
```

- [x] **Step 2: 组件内 emitAnimTick / stopAnimationImpl + 选择/删除/清空钩子**

```ts
const emitAnimTick = () => {
  const s = stateRef.current;
  if (!s) return;
  const a = s.anim;
  if (!a) { onAnimTickRef.current?.(null); return; }
  onAnimTickRef.current?.({
    url: a.url, name: a.name, time: a.action.time,
    duration: a.duration, playing: !a.action.paused,
  });
};
const stopAnimationImpl = () => {
  const s = stateRef.current;
  if (!s?.anim) return;
  s.anim.mixer.stopAllAction();
  restorePose(s.anim.poseSnap);
  s.anim = null;
  onAnimTickRef.current?.(null);
};
```
- `deselectAll` 开头：`if (s.anim) stopAnimationImpl();`
- `selectMany` dissolveMulti 后：`if (s.anim && (objs.length !== 1 || objs[0] !== s.anim.target)) stopAnimationImpl();`
- `deleteSelectedImpl` objs 计算后：`if (s.anim && objs.includes(s.anim.target)) stopAnimationImpl();`
- `clearModels` 开头：`if (s.anim) stopAnimationImpl();`
- unmount cleanup（L1777）：`if (state.anim) { state.anim.mixer.stopAllAction(); state.anim = null; }`（对象即将整体销毁,无需恢复姿势）

- [x] **Step 3: RAF 循环驱动 + 模块级剪辑加载**

```ts
let lastAnimTick = 0;
const animate = () => {
  state.frameId = requestAnimationFrame(animate);
  if (!state.recordPlaying) orbit.update();
  const dt = state.clock.getDelta();
  if (state.anim) {
    state.anim.mixer.update(dt);
    const now = performance.now();
    if (!state.anim.action.paused && now - lastAnimTick > 100) {
      lastAnimTick = now;
      emitAnimTick();
    }
  }
  renderStage(state, camera);
};
```

```ts
/** 动画剪辑缓存(URL → clip);失败不缓存以便重试. */
const animClipCache = new Map<string, Promise<THREE.AnimationClip>>();
function loadAnimClip(url: string): Promise<THREE.AnimationClip> {
  let p = animClipCache.get(url);
  if (!p) {
    p = fbxLoader.loadAsync(url).then((group) => {
      const clip = group.animations?.[0];
      if (!clip) throw new Error(`animation FBX has no clips: ${url}`);
      return clip;
    });
    p.catch(() => animClipCache.delete(url));
    animClipCache.set(url, p);
  }
  return p;
}
/** 轨道骨骼名兜底:目标里找不到同名节点时,按 normBone 匹配后重命名轨道. */
function retargetClipTracks(clip: THREE.AnimationClip, target: THREE.Object3D): THREE.AnimationClip {
  const byNorm = new Map<string, string>();
  for (const b of collectSkeletonBones(target)) {
    if (!hasSameNamedBoneAncestor(b)) byNorm.set(normBone(b.name), b.name);
  }
  const names = new Set([...byNorm.values()]);
  let changed = false;
  const tracks = clip.tracks.map((t) => {
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot);
    if (names.has(node)) return t;
    const mapped = byNorm.get(normBone(node));
    if (!mapped) return t;
    const c = t.clone();
    c.name = `${mapped}${t.name.slice(dot)}`;
    changed = true;
    return c;
  });
  if (!changed) return clip;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}
```

- [x] **Step 4: useImperativeHandle 五个方法**（插在 `isAdvancedMannequin` 后）

```ts
async playAnimation(url, name = '') {
  const s = stateRef.current;
  const target = s?.selected;
  if (!s || !target || !target.userData?.isFbxBot) return;
  const clip = await loadAnimClip(url);
  const st = stateRef.current;
  if (!st || st.selected !== target) return; // 加载期间选择已变,丢弃
  if (st.anim && st.anim.target !== target) stopAnimationImpl();
  const prev = st.anim; // null 或同目标(换剪辑)
  const poseSnap = prev ? prev.poseSnap : capturePose(target);
  const mixer = prev ? prev.mixer : new THREE.AnimationMixer(target);
  mixer.stopAllAction();
  const action = mixer.clipAction(retargetClipTracks(clip, target));
  action.reset();
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();
  st.anim = { mixer, action, target, poseSnap, duration: clip.duration, url, name };
  emitAnimTick();
},
pauseAnimation() { const s = stateRef.current; if (s?.anim) { s.anim.action.paused = true; emitAnimTick(); } },
resumeAnimation() { const s = stateRef.current; if (s?.anim) { s.anim.action.paused = false; emitAnimTick(); } },
stopAnimation() { stopAnimationImpl(); },
seekAnimation(sec) {
  const s = stateRef.current;
  if (!s?.anim) return;
  s.anim.action.time = THREE.MathUtils.clamp(sec, 0, s.anim.duration);
  s.anim.mixer.update(0);
  emitAnimTick();
},
```

- [x] **Step 5: `npx tsc --noEmit` 零新增错误**

### Task 3: UI 层 — DirectorEditor 动画 Tab + 播放条

**Files:**
- Modify: `src/renderer/src/components/shared/image-editors/director/DirectorEditor.tsx`
  - import directorAnimations + `AnimTick`
  - 动画状态组(catalog/err/cat/kw/shown/tick/busy)
  - `switchTab` 类型扩为三态：进 anim 懒加载目录；离开 pose 归还 gizmo（条件从 `t === 'props'` 改为 `t !== 'pose'`）；进 pose 时停动画（姿势编辑与 mixer 冲突）
  - Tab 行加「动画」按钮；右栏内容三分支；视口加浮动播放条
  - styles 加 `animSelect/animSearch/animBar/animBarName/animBarTime`

- [x] **Step 1: 状态 + 处理器**

```ts
// ── 动画 Tab(瞬态预览;目录懒加载)──
const [animCatalog, setAnimCatalog] = useState<AnimCatalog | null>(null);
const [animLoadErr, setAnimLoadErr] = useState(false);
const [animCat, setAnimCat] = useState('');
const [animKw, setAnimKw] = useState('');
const [animShown, setAnimShown] = useState(30);
const [animTick, setAnimTick] = useState<AnimTick | null>(null);
const [animBusy, setAnimBusy] = useState<string | null>(null);
const animList = useMemo(
  () => (animCatalog ? filterAnimations(animCatalog.animations, { category: animCat, keyword: animKw }) : []),
  [animCatalog, animCat, animKw],
);
const playAnim = useCallback(async (a: DirectorAnimation) => {
  const st = stageRef.current;
  if (!st) return;
  const url = animUrl(a);
  setAnimBusy(url);
  try { await st.playAnimation(url, a.name); }
  catch { alert(`动画加载失败:${a.name}(网络或资源不可用)`); }
  finally { setAnimBusy(null); }
}, []);
```

- [x] **Step 2: switchTab 三态 + Tab 按钮 + 内容分支 + 播放条**（详见 spec §3;分类下拉 `全部分类(2032)` + 19 类,搜索框,poseGrid 复用,每页 30「加载更多」,播放条 absolute bottom-center: 名称 + ⏸/▶ + range(0..duration,step .01) + 时间读数 + ⏹）

- [x] **Step 3: `<DirectorStageScene …/>` 传 `onAnimTick={setAnimTick}`**

- [x] **Step 4: 验证** — `npx tsc --noEmit` 零新增、改动文件零 lint、`npm run build:vite` 通过、`npx vitest run tests/features/DirectorAnimations.test.ts` 通过

### Task 4: 提交

- [x] `git add` 新增/改动文件,按仓库风格提交（spec/plan 文档 + 数据层 + 场景层 + UI 层可合为一个 feat commit）

## Self-Review 结论

- Spec 覆盖：数据层→Task1；场景层(播放/暂停/停止/seek/瞬态清理)→Task2；UI(Tab/搜索/分页/播放条)→Task3 ✓
- 无占位符;类型/方法名跨任务一致（`AnimTick`/`playAnimation`/`animUrl`）✓
- 风险已带兜底：动画轨道骨骼名与双骨架 rig 的绑定 → `retargetClipTracks` + 手动验证
