# Director 语义+结构双重强制横竖方向（C2）设计文档

**日期:** 2026-03-03  
**状态:** 已确认（C2：双字段解耦 + 结构/语义双重强制）

## 1. 背景与问题

导演模式需要"横/竖"控制能像宫格选择一样强制生效。当前实现中：

1. `layoutOrientation` 控制网格预览结构（rows/cols）。
2. `semanticOrientation`（已新增）控制模型语义方向（prompt 约束）。

问题在于：两层必须同时强制执行，用户点击横/竖后，既要看到网格变化，也要确保模型按对应方向构图。

## 2. 目标

1. 结构强制：横/竖直接决定 `rows x cols`（像宫格一样硬切）。
2. 语义强制：prompt 注入高优先级方向约束（每格必须横构图/竖构图）。
3. 双通道解耦：结构和语义分别持久化、分别控制，不互相覆盖。
4. 正方网格（4/9/16/25）行列数拓扑不变，但语义强制仍生效，UI 标记"已应用"。

## 3. 方案选择

已比较 C1/C2/C3 后，采用 **C2（推荐）**：

- 双字段解耦（`layoutOrientation` + `semanticOrientation`），各管一层。
- 双重强制同时执行，不互相替代。
- 不含生成后自动校验重试（C3），保持出图速度，后续可按需加入。

## 4. 行为定义（最终）

### 4.1 状态定义

| 字段 | 类型 | 职责 |
|------|------|------|
| `currentLayoutOrientation` | `landscape \| portrait` | 结构强制（rows x cols） |
| `isLayoutOrientationAuto` | `boolean` | 结构方向是否跟随 ratio |
| `currentSemanticOrientation` | `landscape \| portrait` | 语义强制（prompt 约束） |
| `isSemanticOrientationAuto` | `boolean` | 语义方向是否跟随 ratio |

### 4.2 执行规则

1. 生成时结构和语义都执行，不互相覆盖。
2. 非正方网格（`2closeup/6grid`）切换横竖时，行列互换。
3. 正方网格（`4/9/16/25`）行列数不变（数学事实），但语义强制 + panel_ratio 仍对模型生效。
4. 当结构与语义方向不一致时，UI 显示"结构与语义已同时强制执行"。

### 4.3 Auto 与回退

- 自动模式：两个方向都默认跟随 `ratio` 推导。
- `ratio=auto` 或非法：保持最近一次有效方向（持久化值），不回退。
- 缺失值时回退到 `landscape`，并保留 warning 日志。

## 5. 数据流

```
用户点击横/竖
  ├── layoutOrientation → getLayoutConfig() → rows/cols → pipeline.layout
  └── semanticOrientation → pipeline.semanticOrientation → extractVarsForContactSheet()
        → semantic_orientation_instruction → pass6 prompt 高优先级约束
```

## 6. 持久化策略

| Key | 用途 |
|-----|------|
| `director.layout-orientation.v1` | 结构方向 |
| `director.layout-orientation-auto.v1` | 结构 auto 开关 |
| `director.semantic-orientation.v1` | 语义方向 |
| `director.semantic-orientation-auto.v1` | 语义 auto 开关 |

## 7. UI 交互

- "布局选择"区域保留现有横/竖按钮组，改标识为"方向（预览+语义）"。
- 默认模式下，点击横/竖同时驱动两个通道。
- 正方网格场景下提示"拓扑不变但方向强制已应用"。
- 当两通道不一致时提示"结构与语义已同时强制执行"。

## 8. 测试策略

1. **Store**：双通道 auto/manual 行为、`ratio=auto` 保持值、持久化恢复、双通道独立切换。
2. **Hook**：`getLayoutConfig` 依赖 `layoutOrientation`；生成 payload 含 `semanticOrientation`。
3. **Pipeline**：prompt 变量必含 `semantic_orientation_instruction`；fallback 拼接同样注入。
4. **UI**：正方网格提示文案、冲突提示出现与隐藏、按钮 active 状态正确。

## 9. 验收标准

1. 非正方网格切换横竖时，结构必须变化（行列互换）。
2. 正方网格行列数不变，但 UI 标记"方向强制已应用"。
3. 任意布局下，生成输入必带 `semanticOrientation`，且 prompt 包含方向硬约束。
4. `ratio=auto` 不得触发方向回退。
5. `generate -> director` 切页开发态无 hooks/getSnapshot 报错。

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 字段混用导致回归 | 类型层面彻底分开；单测覆盖双通道独立性 |
| UI 文案不清致"按钮无效"误解 | 正方网格场景给"拓扑不变但强制已应用"提示 |
| Pipeline fallback 漏注入语义约束 | 主模板与 fallback 拼接都统一注入 `semantic_orientation_instruction` |

## 11. Context7 依据

1. **Zustand slices pattern**：新增字段使用 `StateCreator<DirectorStore, [], [], ConfigSlice>` 模式，保持与现有 slices 一致。
2. **Zustand persist**：手动 `localStorage` 读写（已有模式），不引入 `persist` 中间件以避免全量序列化。
3. **React useCallback**：依赖数组必须包含所有闭包引用值，避免 stale closure；新增 `currentSemanticOrientation` 已纳入依赖。
4. **React useShallow**：多字段选择器使用 `useShallow` 防止不必要重渲染。
5. **React Hooks rules**：所有 hooks 顶层、稳定顺序调用，不受条件分支影响。
