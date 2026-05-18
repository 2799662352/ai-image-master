# CATIMATION 热更新发布指南

## 架构概览

应用采用 **COS 优先 + GitHub 兜底** 的双源热更新机制：

```
用户客户端启动
  │
  ├─① 检查腾讯云 COS（国内加速）
  │    https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
  │
  ├─ 成功 → 提示更新 / 下载安装
  │
  └─ 失败 → ② 自动切换 GitHub Releases（海外 / 备用）
       https://github.com/2799662352/ai-image-master/releases
```

核心文件：

| 文件 | 作用 |
|------|------|
| `src/main/updater.ts` | AutoUpdater 类，封装 electron-updater，支持 `switchProvider` 和 `fallback` |
| `src/main/index.ts` | 初始化 updater，配置 COS 主源 + GitHub fallback |
| `electron-builder.yml` | 构建配置，`publish` 段声明 COS + GitHub 双发布目标 |
| `scripts/upload-cos.js` | COS 上传脚本（exe + blockmap + latest.yml） |
| `cos-credentials.json` | 腾讯云 COS 内置凭据（gitignored，打包时通过 extraResources 带入） |

## 发布新版本

### 1. 修改版本号

```bash
# package.json → "version": "x.y.z"
```

### 2. 构建

```bash
npm run build:win
```

产物在 `release/` 目录下：
- `catimation-cyberpunk-master-{version}-setup.exe` — 安装包
- `catimation-cyberpunk-master-{version}-setup.exe.blockmap` — 差分更新数据
- `latest.yml` — 版本元数据（electron-updater 靠它判断是否有新版）

### 3. 上传到 COS（国内用户）

```bash
npm run upload:cos
```

需要 `.env` 文件中配置：
```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=map-tiles-bucket-1345773498
COS_REGION=ap-guangzhou
```

或一步到位（构建 + 上传）：
```bash
npm run release:cn
```

### 4. 上传到 GitHub（海外 / 备用）

手动上传：
1. 到 https://github.com/2799662352/ai-image-master/releases 创建新 Release
2. Tag 填 `v{version}`（如 `v4.1.16`）
3. 上传 `release/` 下的三个文件

或用 CLI：
```bash
gh release create v4.1.16 --title "v4.1.16" --notes "更新说明" \
  release/catimation-cyberpunk-master-4.1.16-setup.exe \
  release/catimation-cyberpunk-master-4.1.16-setup.exe.blockmap \
  release/latest.yml
```

## Fallback 机制

在 `updater.ts` 中实现：

```typescript
// 初始化时配置 fallback
const updater = getAutoUpdaterInstance({
  provider: 'generic',
  url: 'https://...cos.../releases/',
  fallback: {
    provider: 'github',
    owner: '2799662352',
    repo: 'ai-image-master'
  }
})
```

当 COS 检查更新失败（网络超时、DNS 错误等），`autoUpdater.on('error')` 触发后：
1. 如果还没 fallback 过 → 自动调用 `switchProvider()` 切换到 GitHub
2. 用 GitHub 源重新 `checkForUpdates()`
3. 如果 GitHub 也失败 → 向用户显示错误

## 差分更新

`electron-builder` 的 NSIS 差分更新（blockmap）已启用：

```yaml
# electron-builder.yml
nsis:
  differentialPackage: true
```

用户更新时只下载变化的部分，而非整个 250MB 安装包。前提是 COS / GitHub 上同时存在：
- 新版 `.exe` + `.blockmap`
- `latest.yml`

## 常见问题

### Q: 老版本客户端检测不到 COS 上的更新？

老版本（< v4.1.15）在代码中硬编码了 `provider: 'github'`，只会检查 GitHub。用户需要先手动安装 v4.1.15+，之后的热更新才会走 COS。

### Q: COS 和 GitHub 的 latest.yml 版本不一致？

两边独立上传，可能短暂不一致。建议每次发版都同时上传两边。COS 用 `npm run upload:cos`，GitHub 手动上传或用 `gh` CLI。

### Q: 上传 COS 时 ECONNRESET？

通常是代理/VPN 干扰了 TLS 握手。切换直连或换节点后重试。

### Q: latest.yml 在 COS 上缓存了旧版本？

腾讯云 COS 默认不缓存，上传即生效。如果用了 CDN 加速，需要刷新缓存：
```
https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
```

## Changelog

### v4.3.7 (2026-05-19)

v4.3.5 落地 Skill Marketplace MVP 后，收到的 UX 反馈分两批：

1. "光在 tab bar 加一个『技能市场』tab 不够直观，应该在 Agent Workspace 的 Skills 页面有一个明显按钮一键跳过去；商城页本身应该像 Cursor 应用市场那样——左侧分类导航 + 右侧卡片 grid，而不是平铺三列。"
2. "点不动按钮 / 卸载按钮一直抽搐。"

第一批是预期 UI 抛光；第二批是 bug——marketplace tab 加在 React `useTabStore` 里却没在底层 vanilla DOM 体系（`TabManager.DEFAULT_VALID_TABS` + `index.html` 的 `<div id="xxxPanel">`）里注册，加上"已安装"按钮 hover 时切换两种文案的渲染宽度不一致导致 bounding box 跳变。v4.3.7 把这两批一并发掉。

> **注**：原计划的 v4.3.6 没真正进入仓库历史（commit/tag 都没存在），所以这次直接跳号到 v4.3.7。如果你看到 docs/聊天记录里出现过 v4.3.6 字样，对应的内容已合并进本条目。

| 改动 | 文件 | 说明 |
|------|------|------|
| Agent Workspace 入口 | `src/renderer/src/features/agent-workspace/SkillsSection.tsx` (+18) | "New Skill" 按钮旁加一颗亮黄色 "🛒 Skill 商城" 按钮,点击通过 `useTabStore.switchTab('marketplace')` 跳转。视觉上是头部 3 个 action 中最显眼的一个（cyberpunk yellow filled），优先级高于"打开 Skills 文件夹"和"New Skill" |
| 商城页重写 | `src/renderer/src/pages-react/MarketplacePage.tsx` (重写 ~280 行) | 从三列 tab（可安装/已安装/有更新）变成 Cursor-marketplace 风格的左侧 sidebar + 右侧 grid 卡片：sidebar 7 个分类（Featured / Director / Storyboard / Methodology / Other / Installed / Updates），每项带 emoji icon + 计数；顶部有搜索框（按名称或描述模糊匹配）；卡片每行 2 列（lg breakpoint），包含 emoji 图标 + skill 名称 + 版本号 + 2 行描述截断 + 体积 + 已认领 badge + Get / Installed ✓ / Update 按钮 |
| **Bugfix: marketplace tab 注册** | `src/renderer/src/features/tab-manager/TabManager.ts` (+1), `src/renderer/index.html` (+5), `src/renderer/src/react-app/main.tsx` (+27), `src/renderer/src/services/ServiceBridge.ts` (+8) | 项目目前是两套 tab 系统并存的渐进迁移状态：上层 React `useTabStore` 走 zustand 状态，下层是 vanilla DOM 的 `TabManager` + `index.html` 里手写的 `<div id="xxxPanel">` panel。`marketplace` 之前只加在 React 侧，导致 zustand subscribe 转发到 `TabManager.switchTab('marketplace')` 时被白名单拒绝（控制台 `无效的标签名: marketplace`），按钮点了没反应。修复：(a) `DEFAULT_VALID_TABS` 加 `'marketplace'`，(b) `index.html` 加 `<div id="marketplacePanel">` 容器 + 内嵌 `<div id="marketplace-react-root">`，(c) `react-app/main.tsx` 加 `mountMarketplaceReact` / `unmountMarketplaceReact`（与其他 React-only 页面同款 lazy + Suspense 模式），(d) `ServiceBridge.ts` 把 mount/unmount 接到 onTabChange 桥 + 启动时预 mount 一次 |
| **Bugfix: 已安装按钮抽搐** | `src/renderer/src/pages-react/MarketplacePage.tsx` (-5 +18) | 原实现用 `group-hover:hidden` 切换"✓ Installed" / "Uninstall" 两个 span 的 `display`，但两段文案渲染宽度不同 → hover 时按钮宽度跳变 → 鼠标恰好被甩出 button bounding box → leave 触发 → 文字切回 → 鼠标又落回 → enter 触发，进入 hover-flicker 死循环（CSS 经典坑）。修复：按钮固定 `w-24 h-7`(96×28px) bounding box 永不变；两个 span 全部 `absolute inset-0` 脱离布局流，互不影响尺寸；改用 `opacity` + `transition-opacity duration-150` 平滑切换。同时把 Get / Update 按钮也 lock 成相同尺寸，避免 busy 文案切换（Get ↔ 安装中…）抖动 |

#### 分类推导规则（不需要后端 taxonomy 字段）

```
director-*       → Director (12 个)
storyboard-*     → Storyboard (7 个)
codex-research-* → Methodology (1 个)
其他              → Other
```

Featured 是手动 curated 4 个推荐 skill（`codex-research-grounded-prompting` / `director-prompt-engineering` / `director-structured-captioning` / `storyboard-structure`），写死在 `FEATURED_NAMES` 集合里。后续要加分类只需改 `CATEGORIES` 数组，不动 catalog schema。

#### 双 tab 系统注释（给未来接手的人）

`useTabStore` 是 React 侧状态，`TabManager` + `index.html` panel 是 vanilla DOM 老体系，二者通过 `ServiceBridge` 双向 subscribe 同步。新增任何 React 路由 tab 必须**同时**：(1) 在 `useTabStore.VALID_TABS` 加，(2) 在 `TabManager.DEFAULT_VALID_TABS` 加，(3) 在 `index.html` 加 panel 容器，(4) 在 `react-app/main.tsx` 写 mount/unmount，(5) 在 `ServiceBridge` 接入 onTabChange + 预 mount。漏一处都会出现"按钮点不动"症状。

#### 用户可见行为

1. 升级 v4.3.5 → v4.3.7：自动检测热更新 → 安装 → 重启 → Agent Workspace → Skills tab 多了亮黄色 "Skill 商城" 按钮。
2. 点按钮跳转到全新商城页（左侧 sidebar 分类 + 右侧 grid），搜索 / 浏览 / 安装更顺手。
3. 已安装 skill 的卸载按钮 hover 不再抽搐：默认绿框绿字 "✓ Installed"，hover 平滑淡入红字 "Uninstall"，宽度不变。

### v4.3.6 (未发布 — 内容已合并进 v4.3.7)

### v4.3.5 (2026-05-18)

把 v4.3.3 / v4.3.4 强制 mirror 的"每次启动复制 20 个 bundled skill 到 `~/.agents/skills/`"流程**完全废弃**，改为**用户主动安装**的 Skill Marketplace（插件商城）。源头痛点：bundled skill 的目录级非覆盖镜像让升级用户必须手动删 `~/.agents/skills/<name>/` 才能拿到新版 SKILL.md（v4.3.4 changelog 里那段"升级用户需手动删除"就是这个 bug 的 UX）。MVP 把决定权还给用户——什么时候装、装哪几个、什么时候升级，全在 app 内一个新 tab 里完成。

| 改动 | 文件 | 说明 |
|------|------|------|
| 废弃 bundled mirror | `src/main/index.ts` (-60) + `electron-builder.yml` (-15) | 删除 `bundledCodexSkillsMirrorPromise` 与 `bundledCodexSkillsDir`；`load-skills` IPC 只 await legacy `<userData>/skills` 迁移那一份。installer 不再把 `resources/codex-skills/` 打入 extraResources（用户机器从此不会被自动塞 20 个 skill） |
| 新增 marketplace service | `src/main/marketplace/marketplaceService.ts` (+225) + `src/main/marketplace/ipc.ts` (+100) | DI 化的 `MarketplaceService` 类：`fetchCatalog`（缓存 + force 刷新）/ `install`（下载 zip → sha256 校验 → temp 解压 → 原子 rename → 写 state，**任何失败都不留半成品**）/ `uninstall`（删目录 + 删 state）/ `listInstalled`（读 ledger）/ `adoptExisting`（首启认领 v4.3.4 leftover）。fetcher 注入 `fetch()`（Node 18 全局），不走 Chromium 网络栈 |
| 共享类型 | `src/types/marketplace.ts` (+55) | `Catalog` / `CatalogEntry` / `InstalledRecord` / 5 个 IPC envelope。main + preload + renderer 三处共用 |
| 启动认领 | `src/main/index.ts` | 启动时 fire-and-forget 跑 `adoptExisting()`：扫 `~/.agents/skills/<name>/`，若 `<name>` 命中 catalog 且 state 里没记录 → 写入 `marketplace-state.json` 标记 `source: 'adopted'`。结果：v4.3.4 老用户升级到 v4.3.5 后，marketplace 的"已安装"页直接列出他们机器上现有的 20 个 skill，**不需要重新下载** |
| 上传脚本 | `scripts/upload-skills-to-cos.mjs` (+185) + `resources/codex-skills/skill-versions.json` (+30) | 扫 `resources/codex-skills/*` 每个目录 → 读 SKILL.md `description` + skill-versions.json 的 version → `JSZip` 打包 → sha256 → 上传 `cos://image-master-1345773498/skills/<name>-<version>.zip` → 聚合上传 `catalog.json`。`--dry-run` 不动 COS 只打印。新增 `npm run publish:skills` |
| 渲染层 marketplace 页 | `src/renderer/src/pages-react/MarketplacePage.tsx` (+275) | 三栏视图（可安装 / 已安装 / 有更新）+ 安装/升级/卸载按钮 + sha256 校验失败的 toast。卸载前 `confirm()` 二次确认。版本不一致即显示"有更新"，不假设 semver 比较——避免误判 |
| Tab 入口 | `useTabStore.ts` + `TabBar.tsx` + `AppLayout.tsx` + `pages-react/index.ts` | 新增 `marketplace` tab（🛒 技能市场），居于 Agent Workspace 与设置之间 |
| Preload bridge | `src/preload/index.ts` (+30) | 暴露 `window.electronAPI.marketplace.{fetchCatalog,install,uninstall,listInstalled,adoptExisting}`，复用现有 `safeInvoke` |
| 测试 | `src/main/marketplace/__tests__/marketplaceService.test.ts` (+340) | TDD 11 测试：catalog 缓存 / install 成功+sha256 不匹配+目录消失原子回滚 / 升级覆盖 / uninstall 含 no-op / adopt 认领 + 幂等 + 非 catalog 目录忽略 / state 跨进程持久化。+ legacy migration 6 测试不动。**17 测试全过** |

#### COS 布局

```
image-master-1345773498/
└── skills/
    ├── catalog.json                                  # ~19 KB, 20 skill entries
    ├── codex-research-grounded-prompting-1.0.0.zip   # ~21 KB
    ├── director-anchor-extraction-quality-1.0.0.zip  # ~1.2 KB
    └── ... 18 more zips
```

`catalog.json` 是 source of truth，每个 entry 含 `{name, version, description, size, sha256, url}`。客户端先拉 catalog，安装时按 `url` 下载 zip，按 `sha256` 校验，落盘到 `~/.agents/skills/<name>/`。

#### 用户可见行为

1. 全新安装 v4.3.5：`~/.agents/skills/` 是空的。打开"技能市场"tab → 可安装列表显示 20 个 skill → 用户挑想要的点"安装"。
2. v4.3.4 老用户升级：原 `~/.agents/skills/` 里的 20 个 skill 保留不动，启动时自动被 `adoptExisting` 标记为 `源: 已认领`（蓝色 badge），在"已安装"列表里直接可见。如果 catalog 里的版本与本地一致 → "有更新"是空的；如果 catalog 之后发版了新 skill 内容 → "有更新"亮起对应条目，点"升级"即可。
3. 单 skill 升级：marketplace 不再触发 app 全量热更新——`scripts/upload-skills-to-cos.mjs` 单独跑就能换 skill 内容，无需 build app/发 installer。

#### 发布步骤

```
npm run publish:skills:dry  # build & inspect catalog, no upload
npm run publish:skills      # upload to image-master-1345773498/skills/
npm run release:cn          # then build & publish app binary as usual
```

参考：
- `src/main/marketplace/`（service + ipc）
- `scripts/upload-skills-to-cos.mjs`
- `src/types/marketplace.ts`

### v4.3.4 (2026-05-18)

把 `codex-research-grounded-prompting`（方法论 skill）和 v4.3.3 同期落地的 19 个 `director-* / storyboard-*` cookbook（具体写法 skill）显式建立 method → recipe 两层关系——之前它们仅"并存"，Codex agent 没有信号知道走到某一步该 *调用* 哪一条 cookbook。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 `<companion-skills>` 章节 | `resources/codex-skills/codex-research-grounded-prompting/SKILL.md` (+35 行) | 在 `</verification>` 与 `<references>` 之间插入一节：(1) 用 method/recipe 二级模型重述 20 个 skill 的关系；(2) 给出"任务步骤 → 调用哪个 sibling cookbook"路由表，覆盖 Pillar 2/4/5、Lens 1-4 全部主线 + audio/dialogue/sensitive-dodge 三条横切；每行点名 sibling 贡献的具体规则（如 *色彩比 ≥7:3*、*7 字段 prompt 顺序*、*运动矢量 °/cm/m·s⁻¹*）便于模型自校；(3) 调用协议：reasoning 中 call out by name → 引用具体规则 → 多 sibling 冲突时按非重叠子维度组合；(4) caveat 解释 `appliesTo` 在移植中被剥除（pipeline hook，Codex 不认）但 rule body 域无关；(5) "don't double up" 守则——单一 recipe 任务别再戴上五 Pillar 的全套帽子 |
| 镜像生效路径 | `$HOME\.agents\skills\codex-research-grounded-prompting\SKILL.md` | 沿用 v4.3.3 的 `bundledCodexSkillsMirrorPromise` 路径，目录级非覆盖。已知行为：旧版若已存在则新版不会覆盖；release 后用户首次升级时，原 v4.3.3 mirror 仍是上一版 SKILL.md。**升级用户需手动删除** `$HOME\.agents\skills\codex-research-grounded-prompting` 一次再重启 app 才能拿到 `<companion-skills>` 章节；全新安装无需此步 |

参考：
- 5747f45 `feat(codex-skills): wire codex-research-grounded-prompting to dispatch the 19 cookbook siblings`
- 母 skill：`resources/codex-skills/codex-research-grounded-prompting/SKILL.md`
- 19 子 cookbook：`resources/codex-skills/{director-*,storyboard-*}/SKILL.md`

### v4.3.3 (2026-05-18)

Codex agent 获得首个内置 USER-scope skill：`codex-research-grounded-prompting`。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新 skill 源 | `resources/codex-skills/codex-research-grounded-prompting/{SKILL.md, references/methodology-rationale.md, references/papers.md}` | Codex 体例（语义标签 + 散文），五大方法论支柱 + 五个抽取镜头；明确要求模型用自带 `web_search` / `fetch` 工具针对用户实际 brief 验证引用——文档内出现的所有导演 / 作画师 / 影片名都是 *illustrative*，决不作为默认套用 |
| 启动镜像 | `src/main/index.ts` `bundledCodexSkillsMirrorPromise` | 启动时把 `<resources>/codex-skills/` 整目录 **非覆盖** 复制到 `$HOME/.agents/skills/`；用户事后改动永远胜出，下次安装不会被回滚 |
| 打包注入 | `electron-builder.yml` extraResources 新增 `resources/codex-skills → codex-skills` | bundled 源跟随安装包分发 |
| Regression test | `src/main/agent/__tests__/legacySkillsMigration.test.ts` | 新 case 验证 bundled→user 镜像的"用户编辑在再镜像时保留" |

参考：设计 spec `docs/superpowers/specs/2026-05-18-codex-research-grounded-prompting-design.md`

### v4.2.9 (2026-05-16)

Codex 模式附件面板 live-update。修"chat 上传图片之后 ATTACHMENTS 面板不刷新，要重启 app 才能看到"。

| 改动 | 文件 | 说明 |
|------|------|------|
| Track A — in-process 成功信号 | `src/main/agent/AttachmentService.ts` | `ingestOne` 写完 disk + Prisma 后 `emit('attachment-added', { saved })`，对偶 `attachment-error` 失败通道，**保证 chat 上传场景毫秒级触达** renderer 不依赖文件系统事件 |
| Track A — 广播桥 | `src/main/file-explorer/AttachmentTreeProvider.ts` + `__tests__/AttachmentTreeProvider.test.ts` | 新增 `wireAttachmentBroadcast(service, windowsGetter)`，监听 `attachment-added` → 向所有 BrowserWindow 发 `attachments:changed` IPC，自动跳过 destroyed window |
| Track B — 原生 FS watcher | `src/main/file-explorer/AttachmentDirWatcher.ts` (新) + `__tests__/AttachmentDirWatcher.test.ts` (新, 11 tests) | 对齐 VSCode `parcelWatcher.ts` 设计：用 `@parcel/watcher@2.5.6`（VSCode 同款）监听 `userData/agent/uploads/` 递归。Windows 走 ReadDirectoryChangesW、macOS 走 FSEvents、Linux 走 inotify，C++ 层自带 `MIN_WAIT=50 / MAX_WAIT=500` debounce 保证 burst 期间 callback 不超 500ms 不 fire。JS 层加 75ms trailing aggregator（match VSCode `FILE_CHANGES_HANDLER_DELAY`）合并 callback 间事件。**覆盖 chokidar 在 Windows 高负载 burst（robocopy /MT、备份还原）下 ReadDirectoryChangesW kernel buffer 溢出丢事件的盲区** |
| 噪音过滤 | `AttachmentDirWatcher.ts` | parcel `ignore: ['**/_tmp_*']` 把 AttachmentService 的中间 tmp 文件在 C++ 层就过滤掉，砍掉 ingest 期间 ~2/3 事件量（原 3 事件：create tmp / delete tmp / create sha，过滤后只剩 create sha） |
| Race 处理 | `AttachmentDirWatcher.start()` | 处理 dispose-during-subscribe 竞态：如果 `dispose()` 在 `subscribe()` Promise resolved 之前调用，等 resolve 后立即 `unsubscribe()`，避免泄漏 native watcher |
| 渲染端订阅 | `src/preload/index.ts` + `src/renderer/src/features/file-explorer/{store,FileTree}.tsx` + 各自 `__tests__/` | preload 暴露 `attachments.onChanged(cb)` IPC，store 加 `ensureSubscriptions()` 动作（200ms trailing debounce 合并 burst），`FileTree` mount 时调用——单一入口、可测试、race-free |
| 打包配置 | `electron.vite.config.ts` + `electron-builder.yml` | `@parcel/watcher` + `/^@parcel\/watcher-/` 加入 main external（native .node 不可 bundle）；`**/node_modules/@parcel/watcher*/**` 加入 `asarUnpack`（wildcard 通配 wrapper + 平台二进制子包 `@parcel/watcher-win32-x64` 等） |

参考：
- VSCode 文件 watcher：[parcelWatcher.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts)（`FILE_CHANGES_HANDLER_DELAY=75`，excludes 模式，watcher fail 容灾）
- parcel C++ debounce 源码：[Debounce.cc](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Debounce.cc)（`MIN_WAIT_TIME=50`, `MAX_WAIT_TIME=500`）
- 没采用 ThrottledWorker(500) chunk size：我们的 broadcast 无 payload，C++ → JS marshal 后只 check `.length`，没有 per-event 工作可 chunk

#### 用户可见行为
- chat 上传图片或拖文件进 chat → ATTACHMENTS 面板 75-275ms 内自动出现新条目（不需重启 app）
- 外部修改 uploads 目录（手动拖入、还原备份、其他进程写入）→ 75-700ms 内面板自动刷新
- 沙箱/EACCES 等极端环境 native watcher 启动失败 → log warn 后降级运行，chat 上传仍能即时刷新（Track A in-process 兜底）

### v4.2.8 (2026-05-15)

三个用户反馈直击的修复。

| 改动 | 文件 | 说明 |
|------|------|------|
| Smart Erase 去超时 | `src/main/services/smartErase/runner.ts` | 删掉 `POLL_TIMEOUT`（原 60min 硬 deadline），改 `while(true)` 直到 MPS 终态（SUCCESS / FAIL / CANCELLED）或用户取消。长任务（≥200 次 PROCESSING）不再被代码主动杀掉 |
| Smart Erase 真实进度 | `runner.ts` + `src/types/smartErase.ts` + `src/renderer/src/pages-react/smart-erase/{EraseQueue,useEraseEvents}.tsx` | 新增 `summarizeTaskDetail()` 把 `DescribeTaskDetail` curate 成 `EraseTaskDetailSnapshot`（progress / workflowStatus / smartEraseStatus / errCode / message / output path / timing），每次 poll 通过 `onProgress` + IPC 透传到 renderer。UI 优先用真实 `mpsProgress`，估计值加 `~` 后缀区分 |
| Smart Erase 查看详情 | `EraseQueue.tsx` | 每行加 `[详情]` 按钮，展开内嵌 `DetailPanel` 显示 curated 字段，对标腾讯控制台"查看结果详情" |
| 批量队列爆发并发 | `src/renderer/src/stores/useBatchStore.ts` | `addItem` 在跑批中触发 `_spawnWorker`；`concurrency` 改为只决定初始池大小，`HARD_MAX_WORKERS = 6` 兜上限。修第二批任务不会立即启动的 UX 问题 |
| 参考图上限 8 → 12 | `ReferenceImageUpload.tsx` / `PunkRefDrop.tsx` / `BatchRefDrop.tsx` / `ExampleGallery.tsx` / `useDirectorStore.ts` / 4 语言 i18n / `index.html` / `GeneratePage.ts` | 所有上传入口、store guard、提示文案统一升到 12 张 |
| 视觉 Prompt 辅助上 Generate / Compare | 新增 `GeneratePromptHelperBar.tsx` + `ComparePromptHelperBar.tsx` + `useVanillaPageRefImages.ts` hook | 多角度 / 打光 按钮在 Generate 和 Compare 也能用了，参考图有/无状态用 `MutationObserver` 事件驱动联动 |

### v4.2.6 (2026-05-14)

修复"Codex 连接失败：PGlite worker error: Aborted()"——升级覆盖安装 / 强杀 / 双开后启动崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/pgliteRecovery.ts` (新) + `__tests__/pgliteRecovery.test.ts` (新, 15 tests) | 三个纯函数：`isPgliteAbortedError`（容忍 `Aborted()` / `RuntimeError + callMain` / `wasm-function + callMain` 三种 wrapper）、`moveCorruptDataDir`（同毫秒冲突用 `-N` 防撞）、`isResetAllowedNow` + `recordResetAttempt`（24h 滚动窗口的电路断路器） |
| Phase 2 | `src/main/agent/db.ts` | `startEmbeddedPGlite` 重写：第一次启动失败 → 命中 `Aborted` → 检查 24h 内重置次数 < 4 → 把 `pgdata/` 改名为 `pgdata.corrupted-{ISO}` 留档 → 用同名空目录重试一次。重试也失败 / 断路器跳闸 → 切换到 `pgdata-ephemeral-{pid}` 临时模式（本会话不持久但 app 不再卡死）。三种结果都通过 `consumeStartupNotice()` 留通知 |
| Phase 3 | `src/main/index.ts` | (A) `app.requestSingleInstanceLock()` + `second-instance` 聚焦回主窗口——堵住 PGlite #884 的"双开 → 同时打开同一 dataDir → 必腐化"通道；(B) `initAgentRuntime` 在 `agentManager.start()` 后用 `did-finish-load` + 250ms grace 把 `consumeStartupNotice()` 的内容通过 `agent:event` 发到 renderer，避开 `webContents.send` 在 listener 未挂时静默丢消息的 race |
| Phase 4 | `src/types/agent.ts` + `src/renderer/src/features/agent-chat/NoticesBanner.tsx` | 新 `AgentNotice` kind `pgliteReset`（warning 级别）+ Banner 标签 `database`，details 携带 `backupPath` / `ephemeralDir` / `reason: aborted-recovered \| aborted-rebuild-failed \| breaker-tripped` |

参考：
- 上游 issue 串：[electric-sql/pglite#884](https://github.com/electric-sql/pglite/issues/884)（`Aborted()` 在 callMain，PR #892 in flight 未合）+ [#794](https://github.com/electric-sql/pglite/issues/794)（同根因，第二次 open 必崩）
- PGlite 自陈："Postgres in 'single user mode'... will corrupt the database if you open it multiple times at once"（docs/filesystems.md）
- Codex 类比：[openai/codex#11435](https://github.com/openai/codex/issues/11435)（"per-process unique session directories"，本次 ephemeral 兜底借鉴）

#### 用户可见行为
- 旧用户升级后第一次启动如果命中此 bug：弹一条黄色 banner "数据库目录无法打开（PGlite #884 已知 bug），已自动重建。旧数据备份在：…\pgdata.corrupted-2026-05-14T…"，agent 历史归零但 app 立即可用。备份目录可手动检查或在上游修复后导入。
- 24h 内连续 4 次重置触发断路器后：banner 变成 "切换到临时模式"，提示用户手动清理或排查硬件 / 杀软干扰。
- 双开第二个实例：第二个进程立即 quit，第一个窗口被 focus 到前台。

### v4.2.5 (2026-05-13)

修复"PlanCard 不渲染 / `update_plan` 工具仍走通用 chip"的双向问题。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/codexNotificationRouter.ts` | `TurnPlanStepStatus` 在 v2 协议是 camelCase（`inProgress`），工具参数是 snake_case（`in_progress`）—— 新增 `normalisePlanStepStatus` 折叠大小写 + 分隔符 + 同义词（`done`/`active`/`running`），所有渠道统一规一化为 snake_case。证据：`codex-rs/app-server-protocol/src/protocol/v2.rs:6450` |
| Phase 2 | `src/main/agent/codexNotificationRouter.ts` | v2 `ThreadItem::DynamicToolCall` 的工具名字段是 `tool`，旧 build 是 `toolName`，MCP 是 `name`。`summarizeActivity` + `readToolName` 都改成 canonical-first（`tool → toolName → name`）。证据：v2.rs:5578 |
| Phase 3 | `src/main/agent/codexNotificationRouter.ts` | plan tool 命中后**始终路由**，即便 args 完全没有结构化 plan 数据也发 placeholder 事件。新增 `extractStepsFromAnywhere` 覆盖 `plan`/`todo`/`todos`/`steps`/`items`/`args` 自身 5+ 种字段形状，外加自由文本回退：解析 `1./1)/1、/-/•/①…⑩` 列表标记 + `[x]/[-]/[ ]` 复选框 + 周围 prose 的"第 N 项进行中" / "已完成第 1、2 项" 状态线索 |
| Phase 4 | `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx` | PlanCard 视觉重写：单行头部 `☰ X of Y Done`（图 1 spec），干净状态图标（`○` pending / `→` in_progress / `⊘` completed），空步骤态显示 `Creating plan…` placeholder 占位（不再回退到通用 chip） |
| Phase 5 | 测试 | +5 router 测试（camelCase / kebab / Pascal / 同义词 / 自由文本 markdown / `args.todo` 单数 / checkbox 标记）；+2 PlanCard 测试（placeholder 态 + explanation 显示）；总计 87 plan 相关测试全过 |

参考：
- Codex protocol 源：`codex-rs/app-server-protocol/src/protocol/v2.rs`
- Codex plan_tool 源：`codex-rs/protocol/src/plan_tool.rs`
- Codex PR #7329（`turn/plan/updated` 通知）/ PR #10124（`update_plan` → `todo_write` rename，未合并）

### v4.2.4 (2026-05-11)

修复"拖大文件进对话框 → Prisma `Server has closed the connection`"崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase A | `src/main/agent/AttachmentService.ts` | 改成**流式 ingest**：`pipeline(createReadStream → writeStream)` + chunk-level sha256，串行处理 + 每文件后 `setImmediate` 让出事件循环，单文件失败通过 `attachment-error` event 隔离不杀整轮 |
| Phase A | `src/main/agent/AgentManager.ts` + `src/types/agent.ts` + `src/renderer/src/features/agent-chat/{store,NoticesBanner}` | 新增 `attachment_error` 流事件 + `attachmentSkipped` notice，前端显示"已跳过 xx.md：原因" |
| Phase B | `src/renderer/src/features/agent-chat/MentionInput.tsx` | picker 路径优先用 `webUtils.getPathForFile`（preload 已暴露），只在 fallback 时才读 `arrayBuffer()`。从此 N 个 100MB 文件不再经 IPC structuredClone |
| Phase C | `src/main/agent/pgliteWorker.ts` + `src/main/agent/db.ts` + `scripts/build-pglite-worker.mjs` | PGlite + `PGLiteSocketServer` 搬到 Electron `utilityProcess`，主进程偶发卡顿不再饿死数据库 socket。worker 用 esbuild 单独打成 1.6KB CJS bundle |

参考：
- 复盘 spec：`docs/superpowers/specs/2026-05-11-attachment-streaming-design.md`
- Codex 同类问题：openai/codex#13508、#15270、PR #21108

### v4.2.3 (2026-05-10)

- 取消客户端显式超时（"天荒地老"模式）：删除 `ApiService` 中的 `composeTimeoutSignal`
- 进度条动画窗口从 5 分钟拉到 15 分钟（`GeneratePage`）
- BatchPage 全量重写为 zinc + 赛博朋克黄风格

### v4.2.2 (2026-05-09)

- MCP 端口绑定方案 B：默认 7842 优先，`EACCES`/`EADDRINUSE` 自动回退 ephemeral，全部失败时优雅降级
