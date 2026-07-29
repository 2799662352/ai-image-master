# 视频工作台·版本历史 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重新生成不再覆盖旧视频；每张卡保留历次成功产物，可左右切换回看。

**Architecture:** 在 `applyTaskUpdate` 判定成功的那一刻把产物 + 当时的规格归档进卡片的
`versions[]`，而**不是**在 `startCards` 清空前抓取——渲染中的卡片改不了规格，所以成功那一刻
卡上的规格必然就是产出该视频的规格；在重生那一刻抓则会把刚改的新提示词和旧视频存到一起。
UI 侧放宽结果区的显示门（渲染中也显示历史版本），并把播放器入参从整张卡放宽为播放源三元组。

**Tech Stack:** TypeScript / React 19 / zustand / vitest + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-29-workbench-version-history-design.md`

## Global Constraints

- **归档时机是「成功那一刻」**，不是「重生那一刻」。`startCards` 里那段带注释保护的清空逻辑一行不动。
- **版本记法一律 `v1`/`v2`**，绝不与位置号拼接——`11-2` 在「11 号卡第 2 版」与「11 号后插入第 2 张」
  之间二义（美标剧本 `47A` 已表示「第 47 场 A 机位」，同款坑）。
- **素材只记名字不记字节**：`referenceImages` 里可能是 `data:` URL，逐版复制会撑爆 IndexedDB。
- **版本是结果不是意图**：只进 `WorkbenchIRCardResult`（导出侧只读注解），`apply` 一律忽略；
  撤销/重做不得删除版本记录。
- **切换只是预览**，卡片的当前结果永远是最新那一版；预览下标是组件本地 state，不持久化。
- 版本数不设上限（每条仅几百字节）。
- 触及 UI 时沿用工作台既有的 zinc + `#FCE300` 配色；按 `DESIGN.md` 不加投影，用发丝线承担层次。
- 运行测试用 `npx vitest run <path>`；提交前跑 `npm run typecheck:ci`。

---

### Task 1: 版本类型与归档

**Files:**
- Modify: `src/types/videoWorkbench.ts`（新增版本类型；`VideoWorkbenchCard` 加 `versions?`）
- Modify: `src/renderer/src/features/video-workbench/store.ts`（`applyTaskUpdate` 归档 + 升级）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`

**Interfaces:**
- Consumes: `createId()`（`cardSpec.ts:41`，已导出）。
- Produces: `VideoWorkbenchVersion` / `VideoWorkbenchVersionSpec` 类型；
  `VideoWorkbenchCard.versions?: VideoWorkbenchVersion[]`。Task 2、3、4 都依赖它们。

- [ ] **Step 1: 写失败测试**

在 `src/renderer/src/features/video-workbench/__tests__/store.test.ts` 追加：

```ts
describe('版本历史', () => {
  it('成功一次产生 v1,规格快照与产出时一致', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '第一版', duration: 8 }])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions).toHaveLength(1)
    expect(card.versions![0]).toMatchObject({ seq: 1, localPath: 'C:/v1.mp4' })
    expect(card.versions![0].spec).toMatchObject({ prompt: '第一版', duration: 8 })
  })

  it('改提示词后重生:v1 保留旧提示词,v2 记新提示词', async () => {
    mockSubmit()
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '旧提示词' }])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))

    // 重生的典型动机就是改了提示词 —— 这一改必须只影响 v2。
    useVideoWorkbenchStore.getState().updateCard(id, { prompt: '新提示词' })
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id
          ? { ...c, taskId: 't2', status: 'running', historyRecorded: undefined, localPath: undefined }
          : c),
    })
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't2', status: 'succeeded', localPath: 'C:/v2.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions!.map((v) => v.spec.prompt)).toEqual(['旧提示词', '新提示词'])
    expect(card.versions!.map((v) => v.seq)).toEqual([1, 2])
    expect(card.versions!.map((v) => v.localPath)).toEqual(['C:/v1.mp4', 'C:/v2.mp4'])
  })

  it('持久地址后到时升级最新版本,而不是再追加一条', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })
    // 先只有上游临时地址
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', videoUrl: 'https://tmp/v.mp4',
    }))
    // 落盘 + 转存完成后带来持久地址
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v.mp4', remoteUrl: 'https://cos/v.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions).toHaveLength(1)
    expect(card.versions![0]).toMatchObject({
      localPath: 'C:/v.mp4',
      remoteUrl: 'https://cos/v.mp4',
    })
  })

  it('失败的一轮不产生版本记录', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'failed', error: '上游拒绝',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions ?? []).toHaveLength(0)
  })

  it('版本的素材快照只记名字,不复制字节', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([
      { prompt: 'p', referenceImages: ['data:image/png;base64,AAAABBBBCCCC'] },
    ])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v.mp4',
    }))

    const version = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.versions![0]
    expect(version.spec.referenceBrief.images).toHaveLength(1)
    expect(JSON.stringify(version)).not.toContain('base64')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t "版本历史"`
Expected: FAIL —— `card.versions` 为 `undefined`。

- [ ] **Step 3: 新增版本类型**

在 `src/types/videoWorkbench.ts` 的 `VideoWorkbenchInsertAnchor` 之后加入：

```ts
/**
 * 产出某一版时的意图快照。**素材只记名字不记字节** —— referenceImages 里可能是
 * data: URL，逐版复制会迅速撑爆 IndexedDB（WORKBENCH_MAX_CARDS 这个上限存在的
 * 唯一原因就是防素材膨胀）。
 */
export interface VideoWorkbenchVersionSpec {
  prompt: string
  model: SeedanceModelAlias
  resolution: '480p' | '720p' | '1080p'
  ratio: '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | '21:9'
  duration: number
  generateAudio: boolean
  mode: VideoWorkbenchMode
  seed?: number
  webSearch: boolean
  referenceBrief: { images: string[]; videos: string[]; audios: string[] }
}

/**
 * 一次成功渲染的产物存档。追加序，末项即卡片当前结果。
 *
 * 存在的意义:重新生成不该让上一版消失。磁盘上的 mp4 本来就不互相覆盖(文件名嵌
 * taskId)，丢的只是卡片上指回去的那根指针 —— 这个数组就是那根指针。
 *
 * 存活性:`localPath` 快但会被 7 天清理扫掉(AttachmentService.cleanup 判断「仍被
 * 引用」时只扫聊天记录，工作台卡片对它隐形)，`remoteUrl` 才是耐久源。播放按
 * localPath → remoteUrl → videoUrl 逐级降级。
 */
export interface VideoWorkbenchVersion {
  id: string
  /** 卡内序号，从 1 起，只增不回收。UI 显示为 v1/v2，绝不与位置号拼接。 */
  seq: number
  createdAt: number
  taskId?: string
  localPath?: string
  remoteUrl?: string
  videoUrl?: string
  actualSeed?: number
  completionTokens?: number
  spec: VideoWorkbenchVersionSpec
}
```

在 `VideoWorkbenchCard` 接口里（`rev?: number` 之前）加入：

```ts
  /**
   * 历次成功产物。追加序，末项 = 当前结果。**是结果不是意图** —— 不进 apply、
   * 不进撤销栈、不参与 specEquals(它挂在 Card 上而非 Spec 上，天然被排除)。
   */
  versions?: VideoWorkbenchVersion[]
```

- [ ] **Step 4: 写归档逻辑**

在 `src/renderer/src/features/video-workbench/store.ts` 的 `applyTaskUpdate` 之前加入两个纯函数：

```ts
/** 素材只取展示名 —— 字节留在卡片上，版本记录不复制(见 VideoWorkbenchVersionSpec)。 */
function versionSpecOf(card: VideoWorkbenchCard): VideoWorkbenchVersionSpec {
  return {
    prompt: card.prompt,
    model: card.model,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    generateAudio: card.generateAudio,
    mode: card.mode,
    ...(card.seed !== undefined ? { seed: card.seed } : {}),
    webSearch: card.webSearch,
    referenceBrief: {
      images: card.referenceImages.map((m) => m.name),
      videos: card.referenceVideos.map((m) => m.name),
      audios: card.referenceAudios.map((m) => m.name),
    },
  }
}

/**
 * 把刚成功的这一轮存档。
 *
 * 抓取时机是「成功那一刻」而非「重生那一刻」:重生的典型动机就是改了提示词,
 * 那一刻卡上的规格已经是新的,和旧视频存在一起就是张冠李戴。而渲染中的卡片改不了
 * 规格(updateCard 对 preparing/queued/running 直接返回原卡),所以成功这一刻卡上的
 * 规格必然就是产出该视频的规格。
 */
function archiveVersion(card: VideoWorkbenchCard): VideoWorkbenchVersion[] {
  const prev = card.versions ?? []
  return [
    ...prev,
    {
      id: createId(),
      seq: (prev.at(-1)?.seq ?? 0) + 1,
      createdAt: Date.now(),
      ...(card.taskId ? { taskId: card.taskId } : {}),
      ...(card.localPath ? { localPath: card.localPath } : {}),
      ...(card.remoteUrl ? { remoteUrl: card.remoteUrl } : {}),
      ...(card.videoUrl ? { videoUrl: card.videoUrl } : {}),
      ...(card.actualSeed !== undefined ? { actualSeed: card.actualSeed } : {}),
      ...(card.completionTokens !== undefined ? { completionTokens: card.completionTokens } : {}),
      spec: versionSpecOf(card),
    },
  ]
}

/**
 * 持久地址后到 —— 把最新那一版的地址原地升级。必须整体替换而不是原地改:
 * workbenchHistory.captureIntent 与 store 共享卡片对象,原地 push/改会污染撤销快照。
 */
function upgradeLatestVersion(card: VideoWorkbenchCard): VideoWorkbenchVersion[] {
  const prev = card.versions ?? []
  const last = prev.at(-1)
  if (!last) return prev
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      ...(card.localPath ? { localPath: card.localPath } : {}),
      ...(card.remoteUrl ? { remoteUrl: card.remoteUrl } : {}),
      ...(card.actualSeed !== undefined ? { actualSeed: card.actualSeed } : {}),
      ...(card.completionTokens !== undefined ? { completionTokens: card.completionTokens } : {}),
    },
  ]
}
```

然后把 `applyTaskUpdate` 里那两个分支改成同时维护 `versions`：

```ts
        if (
          next.status === 'succeeded' &&
          !card.historyRecorded &&
          (next.remoteUrl || next.localPath || next.videoUrl)
        ) {
          next = { ...next, historyRecorded: true, versions: archiveVersion(next) }
          shouldRecordHistory = true
        } else if (
          next.status === 'succeeded' &&
          card.historyRecorded &&
          (next.remoteUrl || next.localPath)
        ) {
          // 已入库,而这一条广播带来了持久地址 → 把历史里的临时地址换掉。
          // 版本记录同样要升级,否则老版本手里只剩会过期的上游临时地址。
          next = { ...next, versions: upgradeLatestVersion(next) }
          shouldUpgradeHistory = true
        }
```

在 `store.ts` 顶部的类型导入里补上 `VideoWorkbenchVersion` 与 `VideoWorkbenchVersionSpec`，
并确认 `createId` 已从 `./cardSpec` 导入（若无则补）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench`
Expected: PASS（含既有的 `applyTaskUpdate` / 历史入库用例）。

- [ ] **Step 6: 加一条守卫测试，钉住「版本不参与规格比较」**

在 `src/renderer/src/features/video-workbench/__tests__/store.test.ts` 的「版本历史」块内追加：

```ts
  it('版本变化不算规格变化(versions 挂在 Card 上而非 Spec 上)', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    const before = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    const after = { ...before, versions: [] as never[] }
    expect(specEquals(before, after)).toBe(true)
  })

  it('撤销只还原意图,不删版本记录', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '旧' }])
    useVideoWorkbenchStore.getState().updateCard(id, { prompt: '新' })
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.versions).toHaveLength(1)

    useVideoWorkbenchStore.getState().undo()

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    // 提示词回到「旧」,但产物存档必须还在 —— 版本是结果不是意图。
    expect(card.prompt).toBe('旧')
    expect(card.versions).toHaveLength(1)
  })
```

顶部 import 补 `specEquals`：

```ts
import { specEquals } from '../cardSpec'
```

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t "版本"`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/video-workbench
git commit -m "feat(workbench): 成功时归档版本,重生不再抹掉上一版"
```

---

### Task 2: 结果区显示历史版本 + 版本切换器

**Files:**
- Create: `src/renderer/src/pages-react/video-workbench/VersionSwitcher.tsx`
- Modify: `src/renderer/src/pages-react/video-workbench/ResultVideoPlayer.tsx:107`（入参放宽）
- Modify: `src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx:736-777`（显示门 + 切换器）
- Test: `src/renderer/src/pages-react/video-workbench/__tests__/VersionSwitcher.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `VideoWorkbenchVersion`。
- Produces: `VersionSwitcher` 组件，props `{ versions: VideoWorkbenchVersion[]; index: number;
  onChange: (index: number) => void }`；`ResultVideoPlayer` 入参改为
  `{ source: Pick<VideoWorkbenchCard, 'localPath' | 'remoteUrl' | 'videoUrl'> }`。

- [ ] **Step 1: 写失败测试**

新建 `src/renderer/src/pages-react/video-workbench/__tests__/VersionSwitcher.test.tsx`：

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchVersion } from '../../../../../types/videoWorkbench'
import { VersionSwitcher } from '../VersionSwitcher'

afterEach(() => {
  cleanup()
})

function version(seq: number): VideoWorkbenchVersion {
  return {
    id: `v${seq}`,
    seq,
    createdAt: 1_000 + seq,
    localPath: `C:/v${seq}.mp4`,
    spec: {
      prompt: `第 ${seq} 版`,
      model: '2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
      generateAudio: true,
      mode: 'multimodal_ref',
      webSearch: false,
      referenceBrief: { images: [], videos: [], audios: [] },
    },
  }
}

describe('VersionSwitcher', () => {
  it('只有一版时不渲染(没什么可切的)', () => {
    const { container } = render(
      <VersionSwitcher versions={[version(1)]} index={0} onChange={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('显示 v2/3 形式,记法不与位置号拼接', () => {
    render(
      <VersionSwitcher versions={[version(1), version(2), version(3)]} index={1} onChange={() => {}} />,
    )
    expect(screen.getByText('v2 / 3')).toBeTruthy()
  })

  it('某一版的播放源全丢失时不崩(7 天清理扫掉 localPath 且 COS 上传失败)', () => {
    const orphan: VideoWorkbenchVersion = { ...version(1), localPath: undefined }
    render(<VersionSwitcher versions={[orphan, version(2)]} index={0} onChange={() => {}} />)
    // 切换器本身照常渲染;播放降级由 ResultVideoPlayer 的 PlaybackFallback 负责。
    expect(screen.getByText('v1 / 2')).toBeTruthy()
  })

  it('左右按钮切换下标,到头即禁用', () => {
    const onChange = vi.fn()
    render(
      <VersionSwitcher versions={[version(1), version(2)]} index={0} onChange={onChange} />,
    )
    expect(screen.getByRole('button', { name: '上一版' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: '下一版' }))
    expect(onChange).toHaveBeenCalledWith(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench/__tests__/VersionSwitcher.test.tsx`
Expected: FAIL —— `Cannot find module '../VersionSwitcher'`。

- [ ] **Step 3: 写 VersionSwitcher**

新建 `src/renderer/src/pages-react/video-workbench/VersionSwitcher.tsx`：

```tsx
// 卡内版本切换器。只在有两版及以上时出现 —— 一版没什么可切的。
//
// 记法固定为 v1/v2,**绝不与卡片位置号拼接**:美标剧本里 47A 已经表示「第 47 场的
// A 机位」,所以插入的场次要写 A47;同理「11-2」会在「11 号卡第 2 版」和「11 号后
// 插入的第 2 张卡」之间二义。
//
// 切换只是预览,卡片的当前结果永远是最新那一版。

import type { JSX } from 'react'
import type { VideoWorkbenchVersion } from '../../../../types/videoWorkbench'

interface VersionSwitcherProps {
  versions: VideoWorkbenchVersion[]
  index: number
  onChange: (index: number) => void
}

export function VersionSwitcher({
  versions,
  index,
  onChange,
}: VersionSwitcherProps): JSX.Element | null {
  if (versions.length < 2) return null
  const current = versions[index]
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="上一版"
        disabled={index <= 0}
        className="px-1 text-white/40 hover:text-[#FCE300] disabled:opacity-30 disabled:hover:text-white/40"
        onClick={() => onChange(index - 1)}
      >
        ◀
      </button>
      <span
        className="text-[#FCE300] tabular-nums"
        title={current ? `提示词:${current.spec.prompt}` : undefined}
      >
        v{current?.seq ?? index + 1} / {versions.length}
      </span>
      <button
        type="button"
        aria-label="下一版"
        disabled={index >= versions.length - 1}
        className="px-1 text-white/40 hover:text-[#FCE300] disabled:opacity-30 disabled:hover:text-white/40"
        onClick={() => onChange(index + 1)}
      >
        ▶
      </button>
    </span>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench/__tests__/VersionSwitcher.test.tsx`
Expected: PASS

- [ ] **Step 5: 放宽 ResultVideoPlayer 的入参**

组件现在吃整张卡，但它只用到三个播放源字段；版本记录也有这三个字段。把入参放宽到三元组，
它就能同时服务卡片和某一版。prop 名一并从 `card` 改为 `source` —— 它将要接收的不再只是卡片，
留着 `card` 会误导下一个读代码的人。

把 `src/renderer/src/pages-react/video-workbench/ResultVideoPlayer.tsx:103-127` 整段替换为：

```tsx
/** 可播放源:卡片当前结果或某一历史版本,两者都有这三个字段。 */
export type PlaybackSource = Pick<VideoWorkbenchCard, 'localPath' | 'remoteUrl' | 'videoUrl'>

/**
 * 结果视频播放器入口。localPath / remoteUrl / videoUrl 全缺时返回 null
 * (与旧 playbackSrc 返回 null 的分支等价,外层不渲染结果区)。
 */
export function ResultVideoPlayer({ source }: { source: PlaybackSource }) {
  const remote = remoteVideoSrc(source)
  const [remoteFailed, setRemoteFailed] = useState(false)
  if (source.localPath) {
    return <LocalResultVideo localPath={source.localPath} remoteSrc={remote} />
  }
  if (remote) {
    if (remoteFailed) return <PlaybackFallback reason="远程地址加载失败(可能已过期,可重新生成)" />
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        controls
        preload="metadata"
        src={remote}
        className={VIDEO_CLASS}
        onError={() => setRemoteFailed(true)}
      />
    )
  }
  return null
}
```

`remoteVideoSrc` 与 `hasPlaybackSource` 的签名本来就是 `Pick<>`，无需改动。

调用点共 8 处，全部把 `card={...}` 改成 `source={...}`：
`WorkbenchCard.tsx:740`（Step 6 会一并处理）与
`__tests__/ResultVideoPlayer.test.tsx` 的 72 / 82 / 91 / 101 / 115 / 126 / 136 行。

- [ ] **Step 6: 结果区放宽显示门并接上切换器**

`src/renderer/src/pages-react/video-workbench/WorkbenchCard.tsx`：

在组件内、`hasResultVideo` 附近加入：

```tsx
  const versions = card.versions ?? []
  // 预览下标:纯 UI 状态,不持久化。新版本到达时自动跳过去 —— 那正是用户在等的东西。
  const [versionIdx, setVersionIdx] = useState(versions.length > 0 ? versions.length - 1 : 0)
  useEffect(() => {
    setVersionIdx(versions.length > 0 ? versions.length - 1 : 0)
  }, [versions.length])
  const shown = versions[versionIdx]
  // 渲染中也要能看历史版本 —— 「重新生成不该隐藏之前的视频」正是本刀要修的。
  const playbackSource = shown ?? card
```

把 `{card.status === 'succeeded' && hasResultVideo && (` 这一行的条件改为：

```tsx
        {(hasResultVideo || versions.length > 0) && (
```

把 `<ResultVideoPlayer card={card} />` 改为：

```tsx
            <ResultVideoPlayer source={playbackSource} />
            {isActiveStatus(card.status) && versions.length > 0 && (
              <p className="text-[10px] text-white/40">新版本生成中,当前显示历史版本</p>
            )}
```

在元信息行（`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]` 那个 div）的**最前面**
插入切换器：

```tsx
              <VersionSwitcher
                versions={versions}
                index={versionIdx}
                onChange={setVersionIdx}
              />
```

补入 import：

```tsx
import { VersionSwitcher } from './VersionSwitcher'
```

并确认 `isActiveStatus` 已从 `../../features/video-workbench/cardSpec` 导入（若无则补）。

- [ ] **Step 7: 跑页面套件**

Run: `npx vitest run src/renderer/src/pages-react/video-workbench`
Expected: PASS。若既有用例因 `ResultVideoPlayer` 改签名而失败，把其调用点从 `card={...}`
改为 `source={...}`。

- [ ] **Step 8: 提交**

```bash
git add src/renderer/src/pages-react/video-workbench
git commit -m "feat(workbench): 结果区版本切换,渲染中仍可回看历史版本"
```

---

### Task 3: 版本对 agent 可见（MCP + IR）

**Files:**
- Modify: `src/renderer/src/features/video-workbench/store.ts`（`snapshotCard` 带版本摘要）
- Modify: `src/main/mcp/tools/videoWorkbenchTools.ts`（`cardSnapshotSchema`）
- Modify: `src/renderer/src/features/video-workbench/workbenchIR.ts:110-116`（导出侧结果注解）
- Modify: `src/types/videoWorkbench.ts`（`WorkbenchIRCardResult` 加 `versions`）
- Test: `src/renderer/src/features/video-workbench/__tests__/store.test.ts`
- Test: `src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `VideoWorkbenchVersion`。
- Produces: `WorkbenchCardSnapshot.versions?: Array<{ seq, localPath?, remoteUrl?, prompt }>`。

- [ ] **Step 1: 写失败测试**

在 `store.test.ts` 的「版本历史」块内追加：

```ts
  it('snapshotCard 带出版本摘要,供 agent 引用具体某一版', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId: 't1', status: 'running' } : c),
    })
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', remoteUrl: 'https://cos/v1.mp4',
    }))

    const snap = snapshotCard(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!)
    expect(snap.versions).toEqual([
      { seq: 1, remoteUrl: 'https://cos/v1.mp4', prompt: 'p' },
    ])
  })
```

在 `workbenchIR.test.ts` 追加：

```ts
  it('版本进导出侧结果注解,但 apply 一律忽略(结果不是意图)', () => {
    const src = source()
    src.cards[0] = {
      ...src.cards[0],
      versions: [{
        id: 'ver1', seq: 1, createdAt: 1, remoteUrl: 'https://cos/v1.mp4',
        spec: {
          prompt: 'p', model: '2.0', resolution: '720p', ratio: '16:9', duration: 5,
          generateAudio: true, mode: 'multimodal_ref', webSearch: false,
          referenceBrief: { images: [], videos: [], audios: [] },
        },
      }],
    }
    const ir = exportWorkbenchIR(src)
    expect(ir.boards[0].cards[0].result!.versions).toHaveLength(1)

    // 把注解改掉再 apply —— 不该有任何效果。
    ir.boards[0].cards[0].result!.versions = []
    const plan = planApplyIR(src, ir)
    expect(plan.next!.cards[0].versions).toHaveLength(1)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/store.test.ts -t "snapshotCard 带出版本"`
Expected: FAIL —— `snap.versions` 为 `undefined`。

Run: `npx vitest run src/renderer/src/features/video-workbench/__tests__/workbenchIR.test.ts -t "版本进导出侧"`
Expected: FAIL —— `result.versions` 为 `undefined`。

- [ ] **Step 3: 快照带出版本摘要**

在 `src/renderer/src/features/video-workbench/store.ts` 的 `WorkbenchCardSnapshot` 接口加入：

```ts
  /**
   * 历次成功产物的摘要（每版只给 seq + 地址 + 当时的提示词）。给 agent 一个能引用
   * 具体某一版的抓手，同时不把整份规格塞进回包。
   */
  versions?: Array<{ seq: number; localPath?: string; remoteUrl?: string; prompt: string }>
```

在 `snapshotCard` 的 return 里、`remoteUrl` 之后加入：

```ts
    ...(card.versions && card.versions.length > 0
      ? {
          versions: card.versions.map((v) => ({
            seq: v.seq,
            ...(v.localPath ? { localPath: v.localPath } : {}),
            ...(v.remoteUrl ? { remoteUrl: v.remoteUrl } : {}),
            prompt: v.spec.prompt,
          })),
        }
      : {}),
```

- [ ] **Step 4: MCP schema 跟上**

在 `src/main/mcp/tools/videoWorkbenchTools.ts` 的 `cardSnapshotSchema` 里加入：

```ts
  versions: z.array(z.object({
    seq: z.number(),
    localPath: z.string().optional(),
    remoteUrl: z.string().optional(),
    prompt: z.string(),
  })).optional().describe(
    'Successful renders of this card, oldest first. Regenerating no longer discards the previous '
    + 'video — each entry keeps the prompt that produced it. Refer to them as v1/v2, never as '
    + '"<card number>-<n>": card numbers shift when cards are inserted or dragged.',
  ),
```

- [ ] **Step 5: IR 导出侧注解**

在 `src/types/videoWorkbench.ts` 的 `WorkbenchIRCardResult` 加入：

```ts
  /** 历次成功产物（只读注解，apply 一律忽略）。 */
  versions?: Array<{ seq: number; localPath?: string; remoteUrl?: string; prompt: string }>
```

在 `src/renderer/src/features/video-workbench/workbenchIR.ts` 的 `exportCard` 的 `result` 块里，
`remoteUrl` 之后加入：

```ts
      ...(card.versions && card.versions.length > 0
        ? {
            versions: card.versions.map((v) => ({
              seq: v.seq,
              ...(v.localPath ? { localPath: v.localPath } : {}),
              ...(v.remoteUrl ? { remoteUrl: v.remoteUrl } : {}),
              prompt: v.spec.prompt,
            })),
          }
        : {}),
```

`planApplyIR` **不需要任何改动** —— 它本来就整块忽略 `result`，版本自然不会被回灌。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/features/video-workbench src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/types/videoWorkbench.ts src/renderer/src/features/video-workbench src/main/mcp/tools
git commit -m "feat(workbench): 版本摘要进快照与 IR 导出注解"
```

---

## 收尾验证

- [ ] Run: `npx vitest run src/renderer/src/features/video-workbench src/renderer/src/pages-react/video-workbench src/main/mcp/tools/__tests__/videoWorkbenchTools.test.ts src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.videoWorkbench.test.ts`
- [ ] Run: `npm run typecheck:ci` —— 新增错误为 0
- [ ] Run: `npm run build:vite` —— 通过
