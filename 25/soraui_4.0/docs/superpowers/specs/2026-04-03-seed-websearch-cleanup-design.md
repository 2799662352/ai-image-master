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
| 4 | P3 | `VideoGenerator.tsx` 含 ~100 行 `{false && ...}` 死代码 | 代码噪音，影响可维护性 |

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

**数据流**:

1. `VideoGenerator.tsx` 新增 `const [arkSeed, setArkSeed] = useState<number | undefined>(undefined)`
2. 通过 props 传给 `JimengStyleEditor`：`arkSeed`, `setArkSeed`
3. `VideoGenerator.tsx` 发送请求时，将 `arkSeed` 写入请求体
4. `volcengine-ark.ts` 已有 `seed: arkConfig.seed`，只需确保 `arkSeed` 覆盖/合并到 `arkConfig`

**Props 新增**:

```typescript
interface JimengStyleEditorProps {
  // ... existing props
  arkSeed: number | undefined;
  setArkSeed: (v: number | undefined) => void;
}
```

### 文件变更

- **Modify**: `sora-ui/src/components/JimengStyleEditor.tsx` — 新增 props, 新增 seed pill (~20 行)
- **Modify**: `sora-ui/src/components/VideoGenerator.tsx` — 新增 state, 传 props, 请求体写入

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

## 模块 4: 前端 — 死代码清理

### 问题

`VideoGenerator.tsx:2811-2912` 含 3 个被 `{false && ...}` 包裹的旧版上传 UI 块（已被 `JimengStyleEditor` 完全替代）：

1. **Lines 2811-2865**: 旧版参考视频上传卡片 (~55 行)
2. **Lines 2867-2907**: 旧版参考音频上传卡片 (~40 行)
3. **Lines 2912-~2960**: 旧版多模态参考图片上传 (~48 行)

### 修复

直接删除这 3 个 `{false && ...}` 块及其间的注释。保留 line 2909 的单行注释 `{/* ⏩ 延长视频模式提示 */}` 如果有后续内容引用。

### 文件变更

- **Modify**: `sora-ui/src/components/VideoGenerator.tsx:2811-~2960` — 删除 ~100+ 行死代码

---

## 不做的事情 (YAGNI)

- 不添加后端 seed 校验（API 自身校验）
- 不清理后端 43 条 `console.log`（调试价值 > 清洁度，未来迁移到分级 logger）
- 不增加 seed 回显功能（需轮询 API 获取实际使用的 seed，复杂度高收益低）
- 不修改 `apiConfigs` 存储结构
- 不转发 `watermark`、`return_last_frame` 等低优先级参数（默认值已满足需求）

---

## 验证标准

1. **TypeScript 编译**: `npx tsc --noEmit` 无新增错误
2. **Vite 构建**: `npx vite build` 成功
3. **Lint**: `ReadLints` 无新增错误
4. **功能验证**:
   - Seed pill 在 Seedance 2.0 模式下显示，非 Seedance 2.0 模式下隐藏
   - Seed 为空时 pill 显示"🎲 随机"，有值时显示"🎲 {value}"
   - 联网搜索开关在所有 Seedance 2.0 模式下可见
   - 删除死代码后页面功能不受影响
   - 后端正确将 seed 写入 Seedance 2.0 metadata（日志可验证）
