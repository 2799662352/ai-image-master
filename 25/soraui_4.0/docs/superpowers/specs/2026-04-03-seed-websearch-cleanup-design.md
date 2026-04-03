# Seedance 2.0 Seed / Web Search / Dead Code — 集中修复设计

> **日期**: 2026-04-03
> **优先级**: P2 (seed, web search) + P3 (dead code)
> **审计文档**: `docs/audits/2026-04-03-seed-websearch-deadcode-audit.md`
> **官方 API 参考**: https://www.volcengine.com/docs/82379/1520757

---

## 问题摘要

| # | 优先级 | 问题 | 影响 |
|---|--------|------|------|
| 1 | P2 | 后端不转发 `seed` 参数到 Seedance 2.0 API | 用户无法复现特定生成结果 |
| 2 | P2 | 前端没有 seed 输入 UI | 用户无法设定 seed 值 |
| 3 | P2 | 联网搜索开关被限制为 `text2video` 模式 | 图生视频等模式下无法启用联网搜索 |
| 4 | P3 | `VideoGenerator.tsx` 含 5 个 `{false && ...}` 死代码块 (~650 行) | 代码噪音，影响可维护性 |
| 5 | P2 | 生成完成后无法看到使用的 seed 值 | 用户无法复现随机生成的好结果 |

---

## 模块 1: 后端 — Seed 参数转发

### 问题

`seed` 已从 `req.body` 解构（`volcengineArkRelayController.ts:305`），Seedance 1.x 分支正确通过 `--seed` 拼入 prompt（line 389），但 Seedance 2.0 的 `metadata` 对象（lines 490-499）完全没有写入 `seed`。

### 官方 API 规范

```
seed  integer  默认值 -1
取值范围：[-1, 2^32-1]
- 不同 seed → 不同结果
- 相同 seed + 相同请求 → 类似结果（不保证完全一致）
```

`seed` 是所有 Seedance 模型均支持的顶层参数，与 `ratio`、`duration`、`generate_audio` 同级。

### 修复

在 `volcengineArkRelayController.ts` 的 isSeedance2 分支（line ~494 附近，`metadata.generate_audio` 之后）新增：

```typescript
if (seed !== undefined && seed !== null && seed !== -1) {
  metadata.seed = Number(seed);
}
```

不传 seed 或传 -1 时，API 自动随机生成。`seed=0` 是有效值，应转发。

> **注意**: Seedance 1.x 分支（line 389）使用 `if (seed && seed > 0)`，导致 `seed=0` 被跳过。这是一个已知的小 bug，但不在本次修复范围——1.x 模型使用率低，修复风险收益不对等。

### 文件变更

- **Modify**: `sora-ui-backend/src/controllers/volcengineArkRelayController.ts:490-499` — 新增 1 行

---

## 模块 2: 前端 — Seed 输入 UI

### 问题

前端 `apiConfigs` 中有 `seed` 字段，`volcengine-ark.ts:78` 已发送 `seed: arkConfig.seed`，但 `JimengStyleEditor` 编辑器底栏没有 seed 输入控件。

### 设计

在 `JimengStyleEditor.tsx` 底栏，位于 duration pill (`⏱`) 和 audio toggle (`🔊`) 之间，新增 seed pill：

**外观**: 与 duration pill 一致，Popover 触发

- 图标: `🎲`
- 未设 seed 时显示: `🎲 随机`
- 已设 seed 时显示: `🎲 {value}`
- 仅在 `isSeedance2 === true` 时显示

**Popover 内容**:

```tsx
<InputNumber
  min={0}
  max={4294967295}  // 2^32-1
  step={1}
  precision={0}
  placeholder="留空=随机"
  value={arkSeed}
  onChange={(v) => setArkSeed(v ?? undefined)}
  style={{ width: 160 }}
/>
<span style={{ fontSize: 11, color: '#9ca3af' }}>
  留空=随机 · 固定值→类似结果
</span>
```

**显示逻辑** (避免 `seed=0` 被当作 falsy):

```tsx
{arkSeed !== undefined ? `🎲 ${arkSeed}` : '🎲 随机'}
```

**JSX 插入位置**: 沿用 duration pill 的 `Popover` 模式（lines 1125-1150），在 `{isSeedance2 && (...)}` 块内、audio toggle 之前插入。

**Before** (`JimengStyleEditor.tsx:1152-1155`):

```tsx
{isSeedance2 && (
  <>
    <div className="jm-toggle-pill" title="有声视频">
```

**After**:

```tsx
{isSeedance2 && (
  <>
    <Popover
      content={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <InputNumber
            min={0} max={4294967295} step={1} precision={0}
            placeholder="留空=随机"
            value={arkSeed}
            onChange={(v) => setArkSeed(v ?? undefined)}
            style={{ width: 160 }}
          />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>固定值→类似结果</span>
        </div>
      }
      trigger="click" placement="top" arrow={false}
    >
      <div className="jm-pill">
        <span style={{ fontSize: 14 }}>🎲</span>
        <span>{arkSeed !== undefined ? arkSeed : '随机'}</span>
      </div>
    </Popover>
    <div className="jm-toggle-pill" title="有声视频">
```

**数据流（端到端）**:

1. **State**: `VideoGenerator.tsx` 新增 `const [arkSeed, setArkSeed] = useState<number | undefined>(undefined)`
2. **Props**: 传给 `JimengStyleEditor`：`arkSeed={arkSeed}`, `setArkSeed={setArkSeed}`
3. **Request 写入**: `VideoGenerator.tsx:904` 附近新增一行：
   ```typescript
   arkSeed: isSeedance2 && arkSeed !== undefined ? arkSeed : undefined,
   ```
4. **SoraRequest 类型**: `types/index.ts:89` 附近新增字段：
   ```typescript
   arkSeed?: number;
   ```
5. **API 层合并**: `volcengine-ark.ts:78` 修改 seed 来源：
   ```typescript
   // Before:
   seed: arkConfig.seed,
   // After:
   seed: request.arkSeed !== undefined ? request.arkSeed : arkConfig.seed,
   ```

**Props 新增**:

```typescript
interface JimengStyleEditorProps {
  // ... existing props
  arkSeed: number | undefined;
  setArkSeed: (v: number | undefined) => void;
}
```

### 文件变更

- **Modify**: `sora-ui/src/types/index.ts:89` — 新增 `arkSeed?: number` 字段
- **Modify**: `sora-ui/src/api/volcengine-ark.ts:78` — seed 来源改为 `request.arkSeed !== undefined ? request.arkSeed : arkConfig.seed`
- **Modify**: `sora-ui/src/components/JimengStyleEditor.tsx` — 新增 props, 新增 seed Popover pill (~20 行)
- **Modify**: `sora-ui/src/components/VideoGenerator.tsx` — 新增 state, 传 props, 请求体写入 arkSeed

---

## 模块 3: 前端 — 联网搜索模式解限

### 问题

`JimengStyleEditor.tsx:1159` 的 `arkWebSearch` toggle 被 `volcengineArkMode === 'text2video'` 条件包裹。官方 API 对 `tools=[{"type":"web_search"}]` 没有任何模式限制。后端也不限制。

### 修复

移除 `volcengineArkMode === 'text2video'` 条件包裹，让 web search toggle 与 audio toggle 并列显示在 `{isSeedance2 && (...)}` 块内。

**Before** (`JimengStyleEditor.tsx:1153-1165`):

```tsx
{isSeedance2 && (
  <>
    <div className="jm-toggle-pill" title="有声视频">
      <span style={{ fontSize: 14 }}>🔊</span>
      <Switch checked={arkGenerateAudio} onChange={setArkGenerateAudio} size="small" />
    </div>
    {volcengineArkMode === 'text2video' && (
      <div className="jm-toggle-pill" title="联网搜索">
        <span style={{ fontSize: 14 }}>🌐</span>
        <Switch checked={arkWebSearch} onChange={setArkWebSearch} size="small" />
      </div>
    )}
  </>
)}
```

**After**:

```tsx
{isSeedance2 && (
  <>
    <div className="jm-toggle-pill" title="有声视频">
      <span style={{ fontSize: 14 }}>🔊</span>
      <Switch checked={arkGenerateAudio} onChange={setArkGenerateAudio} size="small" />
    </div>
    <div className="jm-toggle-pill" title="联网搜索">
      <span style={{ fontSize: 14 }}>🌐</span>
      <Switch checked={arkWebSearch} onChange={setArkWebSearch} size="small" />
    </div>
  </>
)}
```

### 文件变更

- **Modify**: `sora-ui/src/components/JimengStyleEditor.tsx:1159-1164` — 删除 2 行条件包裹

---

## 模块 2 + 3 合并后的最终 JSX

模块 2 和模块 3 都修改 `{isSeedance2 && (...)}` 块。实施顺序：**先 Module 2（插入 seed Popover），再 Module 3（去掉 web search 的 text2video 条件）**。最终结果：

```tsx
{isSeedance2 && (
  <>
    <Popover
      content={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <InputNumber
            min={0} max={4294967295} step={1} precision={0}
            placeholder="留空=随机"
            value={arkSeed}
            onChange={(v) => setArkSeed(v ?? undefined)}
            style={{ width: 160 }}
          />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>固定值→类似结果</span>
        </div>
      }
      trigger="click" placement="top" arrow={false}
    >
      <div className="jm-pill">
        <span style={{ fontSize: 14 }}>🎲</span>
        <span>{arkSeed !== undefined ? arkSeed : '随机'}</span>
      </div>
    </Popover>
    <div className="jm-toggle-pill" title="有声视频">
      <span style={{ fontSize: 14 }}>🔊</span>
      <Switch checked={arkGenerateAudio} onChange={setArkGenerateAudio} size="small" />
    </div>
    <div className="jm-toggle-pill" title="联网搜索">
      <span style={{ fontSize: 14 }}>🌐</span>
      <Switch checked={arkWebSearch} onChange={setArkWebSearch} size="small" />
    </div>
  </>
)}
```

---

## 模块 4: 前端 — 死代码清理

### 问题

`VideoGenerator.tsx` 含 **5 个** 被 `{false && ...}` 包裹的旧版 UI 块（全部已被 `JimengStyleEditor` 替代），共约 **650 行**死代码：

| # | 行范围 | 内容 | 约行数 |
|---|--------|------|--------|
| 1 | 2311-2516 | 旧版模式选择器卡片 | ~205 |
| 2 | 2518-2809 | 旧版图片上传区域 | ~291 |
| 3 | 2811-2865 | 旧版参考视频上传卡片 | ~55 |
| 4 | 2867-2907 | 旧版参考音频上传卡片 | ~40 |
| 5 | 2911-2963 | 旧版多模态参考图片上传 | ~52 |

### 修复

直接删除全部 5 个 `{false && ...}` 块及其前置注释行（行号含前置注释）。Line 2909 的 `{/* ⏩ 延长视频模式提示 */}` 注释已无对应 UI，一并删除。

删除后 `VideoGenerator.tsx` 将减少约 650 行，从 ~3300 行降至 ~2650 行。

### 文件变更

- **Modify**: `sora-ui/src/components/VideoGenerator.tsx:2311-2963` — 删除 5 个 `{false && ...}` 死代码块 (~650 行)

---

## 模块 5: Seed 回显（后端存储 + 前端展示）

### 问题

用户生成视频后无法看到使用的 seed 值。如果用户不指定 seed（随机生成），就无法复现喜欢的结果。

### 设计

**后端（创建任务时保存发送的 seed）**:

在 `volcengineArkRelayController.ts` 创建 `videoTask` 时，将发送的 seed 值存入 task metadata：

```typescript
const taskMetadata: Record<string, any> = {
  // ... existing fields
  requestedSeed: seed !== undefined && seed !== null && seed !== -1 ? Number(seed) : undefined,
};
```

**后端（轮询成功时捕获 API 返回的 seed）**:

在 polling 成功分支（line ~159-169，`usageMetadata` 构建处），新增：

```typescript
if (response.data.seed !== undefined) {
  usageMetadata.actualSeed = response.data.seed;
} else if (response.data.metadata?.seed !== undefined) {
  usageMetadata.actualSeed = response.data.metadata.seed;
}
```

如果 API 不返回 seed，`actualSeed` 为空，前端回退显示 `requestedSeed`。

**前端（历史详情展示）**:

在 `VideoDetailModal.tsx` 或视频历史卡片中，当 metadata 含 `actualSeed` 或 `requestedSeed` 时，显示一个可点击复制的 seed 标签：

```tsx
{seedValue !== undefined && (
  <span className="seed-tag" onClick={() => navigator.clipboard.writeText(String(seedValue))}>
    🎲 {seedValue}
  </span>
)}
```

其中 `seedValue = metadata.actualSeed ?? metadata.requestedSeed`。

### 文件变更

- **Modify**: `sora-ui-backend/src/controllers/volcengineArkRelayController.ts` — 创建任务时存 `requestedSeed`，轮询时存 `actualSeed`
- **Modify**: `sora-ui/src/components/VideoDetailModal.tsx` — 显示 seed 标签（可点击复制）

---

## 不做的事情 (YAGNI)

- 不添加后端 seed 校验（API 自身校验）
- 不清理后端 43 条 `console.log`（调试价值 > 清洁度，未来迁移到分级 logger）
- 不修改 `apiConfigs` 存储结构
- 不转发 `watermark`、`return_last_frame` 等低优先级参数（默认值已满足需求）

---

## 验证标准

> **注意**: `isSeedance2` 检查为 `arkModel?.includes('seedance-2-0')`，同时匹配 Seedance 2.0 和 Seedance 2.0 fast。以下"Seedance 2.0 系列"指两者。

1. **TypeScript 编译**: `npx tsc --noEmit` 无新增错误
2. **Vite 构建**: `npx vite build` 成功
3. **Lint**: `ReadLints` 无新增错误
4. **功能验证**:
   - Seed pill 在 Seedance 2.0 系列（含 fast）模式下显示，其他模型下隐藏
   - Seed 为空时 pill 显示"🎲 随机"，有值时显示"🎲 {value}"（seed=0 正确显示）
   - 联网搜索开关在 Seedance 2.0 系列所有视频模式下可见
   - 删除死代码后页面功能不受影响
   - 后端正确将 seed 写入 Seedance 2.0 metadata（日志可验证）
   - 视频详情中显示 seed 值（如有），可点击复制
