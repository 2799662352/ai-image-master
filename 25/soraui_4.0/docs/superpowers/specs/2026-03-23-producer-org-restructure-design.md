---
date: 2026-03-23
topic: producer-org-restructure
---

# 制作人 (Producer) 组织架构改造设计

## What We're Building

在 New API 现有的组织树（公司 → 工作室/部门 → 项目）中，新增「制作人 (PRODUCER)」层级，插在工作室与项目之间。项目从独立的 Organization 账号节点降级为挂在制作人下的轻量标签。制作人拥有统一的预算池、人员管理、邀请码机制，解决当前「一个项目一个账号、管理多项目需频繁切换」的核心痛点。同时新增公司级多维统计钻取能力。

**改造后层级：** `COMPANY → STUDIO → PRODUCER → PROJECT(tag)`

## Why This Approach

### 考虑过的方案

| 方案 | 描述 | 放弃原因 |
|------|------|----------|
| A (选中) | 在组织树新增 PRODUCER 层级 | — |
| B | 制作人作为「管理者角色」，项目仍为独立账号 | 不解决核心痛点，项目还是独立账号 |
| C | 制作人为独立实体，与组织树平行 | 重写整套 CRUD + 余额逻辑，工作量大，两套体系并行维护成本高 |

### 选择方案 A 的理由

1. **最大化复用**——组织树 CRUD、`AllocateOrgToOrg` 余额划拨、级联停用、邀请码全部复用
2. **模型语义清晰**——制作人就是一个 Organization 节点（Level=PRODUCER），与公司/部门同质
3. **资金流自然**——COMPANY→STUDIO→PRODUCER 完全适配现有的 `AllocateOrgToOrg` 链路
4. **改动可控**——核心变更集中在新增 PRODUCER 常量、ProducerProject 标签表、allocation 适配

## Key Decisions

### 1. 制作人 = Organization 节点（Level=PRODUCER）

制作人复用 Organization 模型，拥有 `Balance`、`InviteCode`、`AdminUserId`、`IsActive` 等现有字段。新增 `ProducerType` 字段区分内部人员 vs 外包供应商。

### 2. 项目降级为 ProducerProject 标签表

项目不再是 Organization 节点，改为独立的 `ProducerProject` 表：

```
ProducerProject
├── Id            int64  (PK, autoIncrement)
├── ProducerId    int64  (FK → Organization.Id where Level=PRODUCER, index)
├── Name          string (项目名称)
├── Budget        int64  (项目预算，从制作人池子分配)
├── Consumed      int64  (已消耗)
├── IsActive      bool
├── CreatedAt     time.Time
└── UpdatedAt     time.Time
```

### 3. 资金流：混合模式

- 公司→部门→制作人：复用 `AllocateOrgToOrg`（只校验 ParentId，不校验 Level）
- 制作人→项目标签：新增 `AllocateProducerToProject`（制作人 Balance → ProducerProject Budget）
- 制作人→个人：修改 `AllocateOrgToPersonal`，从 PRODUCER 级别分配

### 4. 人员挂在制作人下

- 成员通过制作人的 `InviteCode` 加入（复用工作室的邀请码机制）
- 加入后可自由选择参与该制作人下的不同项目标签
- `PersonalAllocation` 新增 `ProducerId` 字段，影子账号挂到制作人级别
- 影子用户名格式从 `pa_{uid}_{projectId}` 改为 `pa_{uid}_{producerId}`

### 5. Log 表新增 ProducerId 字段

- `Log.ProducerId int64`：按制作人维度聚合统计，无需 join ProducerProject
- `Log.ProjectId` 语义从 Organization.Id 变为 ProducerProject.Id
- `Task.PrivateData` 同步新增 `ProducerId`，任务创建时从 `X-Producer-Id` header 写入

### 6. 公司级统计钻取

多维度统计 API，基于 `BalanceTransaction` + `Log` 表聚合：

| API | 维度 |
|-----|------|
| `GET /api/org/:companyId/stats` | 公司级：总充值/总消耗/总剩余，按部门分组 |
| `GET /api/org/:producerId/stats` | 制作人级：按项目标签和成员分组 |
| `GET /api/org/:producerId/projects/:tagId/stats` | 项目标签级：成员消耗明细 |

### 7. 制作人类型

`Organization.ProducerType`：`"INTERNAL"` | `"OUTSOURCE"`

- INTERNAL：内部员工制作人
- OUTSOURCE：外包/供应商，按项目结算

## 三仓库改动范围

### New API (Go) — 核心改动

| 位置 | 改动 |
|------|------|
| `constant/org.go` | 新增 `OrgLevelProducer = "PRODUCER"` |
| `model/organization.go` | Organization struct 新增 `ProducerType string` |
| `model/producer_project.go` | 新增 ProducerProject 模型 + CRUD 方法 |
| `model/personal_allocation.go` | 新增 `ProducerId int64` 字段 |
| `model/log.go` | 新增 `ProducerId int64` 字段 + 索引 |
| `model/task.go` | PrivateData 新增 `ProducerId int64` |
| `service/allocation.go` | `AllocateOrgToPersonal`: Level 校验改为 PRODUCER |
|  | `createNewApiUserForAllocation`: 用户名格式改为 `pa_{uid}_{producerId}` |
|  | 新增 `AllocateProducerToProject` |
|  | 新增 `ReclaimProducerFromProject` |
|  | 新增 `deactivateProducerResources` |
|  | `CollectProjectIds`: PRODUCER 级别查 ProducerProject 表 |
| `controller/org.go` | 创建/编辑/停用支持 PRODUCER 类型 |
|  | 新增统计 API |
| `router/` | 注册新 API 路由 |
| `web/src/pages/OrgManagement/` | 树节点新增 PRODUCER 类型 + 项目标签管理 |
| `web/src/pages/BalanceManagement/` | 制作人级余额管理面板 + 公司级统计仪表板 |

### sora-ui-backend (Node.js/Prisma) — 适配改动

| 位置 | 改动 |
|------|------|
| `src/routes/userOrg.ts` | 适配新的 PRODUCER 相关 API 转发 |
| `src/services/newApiService.ts` | 新增制作人相关接口转发方法 |
| 统计聚合 | 新增公司级消耗统计接口 |

### sora-ui (React) — 前端改动

| 位置 | 改动 |
|------|------|
| `src/stores/orgStore.ts` | `currentProducerId` 替代 `currentProjectId`，项目选择变为标签切换 |
| 新增页面 | 制作人管理页面（成员管理、项目标签管理、预算分配） |
| 新增组件 | 公司统计仪表板（多维钻取：公司→制作人→项目→个人） |

## 核心不变项

- **User/Token/Channel 模型**不变
- **AllocateOrgToOrg** 逻辑完全复用（只校验 ParentId）
- **task_billing.go** 计费核心逻辑不变（仍走 User.quota + Token）
- **API Key 分发机制**不变（改挂到制作人级别）
- **GetAncestorChain** 向上遍历找 NewapiGroup 逻辑不变

## 验证过的兼容性

1. `AllocateOrgToOrg`（allocation.go:23-80）：只校验 `toOrg.ParentId == fromOrgId`，不校验 Level → STUDIO→PRODUCER 天然支持
2. `createNewApiUserForAllocation`（allocation.go:277-347）：`GetAncestorChain` 从 PRODUCER 向上遍历 PRODUCER→STUDIO→COMPANY → 能正确找到 NewapiGroup
3. `DeactivateOrganizationCascade`（allocation.go:446-513）：递归按 `GetOrganizationsByParentId` 遍历，PRODUCER 下无子 Organization → 不会错误递归
4. `task_billing.go` 全部函数：通过 `Task.UserId` 操作 `User.quota`，不涉及 Organization 层级 → 无影响

## Open Questions

无未解决问题。所有关键设计决策已在上方确认。

## Next Steps

→ 进入实施计划阶段，按仓库拆分实施步骤
