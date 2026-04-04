# 素材库/人像库首次加载性能优化

## 问题

素材库和人像库第一次打开时有明显卡顿（API 等待），后续打开会好一些。

**根因分析**：
- 素材库后端已有 Redis 缓存（`assetCacheService.ts`，24h TTL），首次 MISS 慢，后续 HIT 快
- 人像库后端无缓存，每次打开都直接调火山引擎外部 API
- 前端两个库的 Zustand store 在每次打开 modal 时无条件重新请求，即使 store 中已有数据
- Loading 状态仅显示居中 `<Spin>`，无骨架屏占位

## 设计

### 层 1：前端 Stale-While-Revalidate（两个库）

**改动文件**：`assetStore.ts`、`volcengineAssetStore.ts`、`AssetLibraryModal.tsx`、`PortraitLibraryModal.tsx`

**策略**：在两个 Zustand store 中增加 `lastFetchedAt: number` 字段。Modal 的 `useEffect` 判断：

- `assets.length > 0` → 立即展示旧数据，不设 `loading: true`
- 同时后台静默调用 `loadAssets()`，但用新的 `silentRefresh` 模式（不触发 loading spinner）
- 如果 `lastFetchedAt` 距现在 < 30s，跳过后台刷新（避免频繁开关 modal 造成无意义请求）

**Store 变更**（两个 store 同模式）：

```typescript
interface XxxStore {
  // 新增
  lastFetchedAt: number;
  // loadAssets 增加 silent 参数
  loadAssets: (silent?: boolean) => Promise<void>;
}

loadAssets: async (silent = false) => {
  if (!silent) set({ loading: true });
  try {
    const res = await fetchXxx(...);
    if (res.success) {
      set({ assets: res.data, lastFetchedAt: Date.now() });
    }
  } finally {
    if (!silent) set({ loading: false });
  }
}
```

**Modal 变更**（两个 modal 同模式）：

```typescript
useEffect(() => {
  if (open) {
    const hasData = assets.length > 0;
    const isStale = Date.now() - lastFetchedAt > 30_000;
    if (!hasData) {
      loadAssets(false); // 正常 loading
    } else if (isStale) {
      loadAssets(true);  // 静默刷新
    }
    setSelectedAssets([]);
    setSearch('');
  }
}, [open]);
```

### 层 2：人像库后端 Redis 缓存

**改动文件**：新建 `volcAssetCacheService.ts`、修改 `routes/volcengineAsset.ts`

**策略**：复用素材库 `assetCacheService.ts` 的模式，对人像库 list 接口加 Redis 缓存。

- **Key**：`volc-asset:{userId}:list`
- **TTL**：5 分钟（火山引擎素材状态可能变化，比素材库的 24h 短）
- **失效时机**：上传、删除、重命名时 invalidate
- **缓存条件**：无 filter 的默认列表请求

### 层 3：骨架屏代替 Spin

**改动文件**：`PortraitGrid.tsx`

**策略**：`loading === true && assets.length === 0` 时，渲染 8 个灰色占位卡片（shimmer 动画），而非居中 `<Spin>`。

骨架卡片与真实卡片尺寸一致（约 150×150），使用 CSS `@keyframes shimmer` 实现条纹动画。

## 不做的事

- **虚拟滚动**：当前 100-200 条素材，DOM 量尚可接受，YAGNI
- **分页 UI**：一次性加载对用户交互更友好，不引入分页控件
- **预加载**：不在登录时预加载素材列表，避免增加登录延迟

## 预期效果

| 场景 | 当前 | 优化后 |
|------|------|--------|
| 素材库首次打开 | Spin 等待 1-3s | 骨架屏等待 1-3s（感知更快） |
| 素材库再次打开 | Spin 等待 ~200ms（Redis HIT） | 秒开旧数据 + 静默刷新 |
| 人像库首次打开 | Spin 等待 2-5s（火山 API） | 骨架屏等待 2-5s |
| 人像库再次打开 | Spin 等待 2-5s（每次打火山 API） | 秒开旧数据 + 静默刷新；后端 Redis 缓存 ~50ms |
