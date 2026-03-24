# 管理面板页面同步支持 PRODUCER 层级

**日期**: 2026-03-24
**状态**: 设计中

## 我们要做什么

将管理面板的 4 个页面（余额管理、用量报表、成员管理、API Key 管理）全部同步支持 PRODUCER 层级和 ProducerProject，使其与现有 PROJECT 级别功能一致。

## 为什么选择这个方案

制作人（PRODUCER）管理员目前只能通过"组织管理"页面操作 ProducerProject。但"余额管理"、"用量报表"、"成员管理"、"API Key 管理"四个独立页面完全不认识 PRODUCER 层级，导致制作人管理员无法在这些页面中看到/操作自己管理的项目。

## 现状分析

### 各页面 PRODUCER 支持缺口

| 页面 | 路由 | 当前支持层级 | PRODUCER 缺口 |
|------|------|-------------|---------------|
| **余额管理** | `/console/balance` | COMPANY, STUDIO, PROJECT | `LEVEL_LABEL` 无 PRODUCER；`children` 只用 `/children` 不加载 ProducerProject；成员余额仅 `PROJECT` 级显示 |
| **用量报表** | `/console/reports` | COMPANY, STUDIO, PROJECT | `LEVEL_LABELS` 无 PRODUCER；`ScopeSelector` 不认识 PRODUCER；后端 scoped API 可能不支持 |
| **成员管理** | `/console/members` | COMPANY, STUDIO, PROJECT | `loadOrgs` 递归 `children` 时不加载 ProducerProject；`isProjectLevel` 判断不含 PRODUCER |
| **API Key 管理** | `/console/api-keys` | 按组织筛选 | 组织下拉不含 PRODUCER 层级 |
| **ScopeSelector** | 共享组件 | COMPANY, STUDIO, PROJECT | `LEVEL_LABELS` 和 `LEVEL_COLORS` 缺少 PRODUCER |

### 后端 API 情况

| API | 状态 | 备注 |
|-----|------|------|
| `GET /api/org/:id/producer-projects` | 已有 | 获取 ProducerProject 列表 |
| `POST /api/org/:id/allocate-to-project` | 已有 | 制作人 → ProducerProject 划拨 |
| `POST /api/org/:id/reclaim-from-project` | 已有 | 从 ProducerProject 回收 |
| `POST /api/org/:id/allocate-project-to-personal` | 已有 | ProducerProject → 成员分配 |
| `POST /api/org/:id/reclaim-project-from-personal` | 已有 | 成员回收 |
| `GET /api/org/:id/producer-project-members` | 已有 | 获取项目成员 |
| `GET /api/org/:id/transactions` | 已有 | 交易流水 |
| `GET /api/org/:id/member-balances` | 已有，但仅 PROJECT 级 | PRODUCER 级需新逻辑 |
| `GET /api/data/scoped/usage` | 不在 org-router 中 | 可能在上游 new-api 中 |
| `POST /api/org/:id/api-keys` | 已有 | API Key 创建 |

## 关键决策

### 决策 1: 制作人管理员在"余额管理"看到的内容

**选定方案**: 和现有 PROJECT 管理员一致
- 顶部：自身余额卡片（制作人余额）
- 中部：ProducerProject 列表（代替 childOrgs），每个显示余额 + 划拨/回收/流水按钮
- 底部：如果选中某个 ProducerProject，显示该项目的成员余额列表

### 决策 2: "成员管理"中的 PRODUCER 处理

- 制作人管理员的 `loadOrgs` 需要识别 PRODUCER 层级
- 加载 ProducerProject 列表作为可选择的"子组织"
- 选中 ProducerProject 后，调用 `producer-project-members` API 显示成员

### 决策 3: "用量报表"中的 PRODUCER 处理

- `ScopeSelector` 需支持 PRODUCER 层级标签
- 需要确认后端 `/api/data/scoped/*` 是否支持 PRODUCER 组织
- 备选方案：使用 `/api/org/report/:org_id/*` 代替

### 决策 4: "API Key 管理"中的 PRODUCER 处理

- 组织下拉需要能选中 PRODUCER 类型的组织
- API Key 创建/管理 API (`/api/org/:id/api-keys`) 已与组织 ID 关联

## 修改范围

### 前端文件

1. **`BalanceManagement/index.jsx`**
   - 添加 `PRODUCER` 到 `LEVEL_LABEL` 和 `LEVEL_COLOR`
   - `loadData` / `refreshMyOrg`: 当 `myOrg.level === 'PRODUCER'` 时用 `producer-projects` 替代 `children`
   - 渲染 ProducerProject 列表卡片（划拨/回收按钮调 `allocate-to-project` / `reclaim-from-project`）
   - 成员余额部分：`myOrg.level === 'PROJECT' || myOrg.level === 'PRODUCER'` 时显示
   - PRODUCER 时需选中某个 ProducerProject 后再显示成员

2. **`UsageReports/index.jsx`**
   - 添加 `PRODUCER` 到 `LEVEL_LABELS` 和 `LEVEL_COLORS`
   - 确认 scope 导航能下钻到 PRODUCER 的 ProducerProject

3. **`MemberManagement/index.jsx`**
   - `loadOrgs` 递归时识别 `PRODUCER` 层级，加载 `producer-projects`
   - `isProjectLevel` 条件扩展包含 PRODUCER

4. **`ApiKeyManagement/index.jsx`**
   - 组织加载逻辑识别 PRODUCER

5. **`ScopeSelector.jsx`**
   - `LEVEL_LABELS` / `LEVEL_COLORS` 添加 PRODUCER

### 后端文件（可能需要）

- `member-balances` 端点需要支持 PRODUCER 级别的查询（汇总所有 ProducerProject 成员的余额）
- 确认 scoped usage API 对 PRODUCER 组织的支持

## Resolved Questions

1. **后端 `/api/data/scoped/usage` 在哪里定义？**
   - **答**: 还没实现。用量报表页面可能有 bug。优先做余额管理和成员管理，用量报表需要先实现后端 API。

2. **制作人的"成员余额"应该展示什么？**
   - **答**: 两种都支持——默认汇总所有 ProducerProject 的成员，可按项目筛选。

## Resolved Questions (cont.)

3. **余额管理中的 ProducerProject 列表 UI**
   - **答**: 可展开/收缩。每个 ProducerProject 显示为卡片，默认收起只显示名称和余额，点击展开显示成员列表。

## 实施优先级

1. **余额管理** (BalanceManagement) — 最高优先级
2. **成员管理** (MemberManagement) — 次之
3. **API Key 管理** (ApiKeyManagement) — 中等
4. **用量报表** (UsageReports) — 最低（需先实现后端 scoped API）
5. **ScopeSelector** 共享组件 — 与用量报表同步
