---
date: 2026-03-23
topic: producer-org-restructure
revision: 4
---

# 制作人 (Producer) 组织架构改造设计 v4

## What We're Building

在 New API 现有的组织树（COMPANY → STUDIO → PROJECT）中，新增「制作人 (PRODUCER)」层级，插在 STUDIO 与 PROJECT 之间。采用**纯加法、双轨并行**策略：旧 PROJECT 体系完全保留不动，新 PRODUCER 体系作为独立链路并行运行，新功能只在 PRODUCER 体系提供，用户自然渐进迁移。

**核心约束**：不与已有数据冲突，不盲目迁移，零破坏性变更。

**改造后层级**：

```
旧体系（不变）：COMPANY → STUDIO → PROJECT (Organization)
新体系（新增）：COMPANY → STUDIO → PRODUCER (Organization) → ProducerProject (有预算池，无独立管理员)
```

## Why This Approach

### 考虑过的方案

| 方案 | 描述 | 结果 |
|------|------|------|
| A (选中) | 纯加法、双轨并行，旧体系零改动 | — |
| B | 软关联：旧 PROJECT 加 producer_id nullable 字段 | 语义模糊，PROJECT 定位不清 |
| C | 一步到位迁移：旧 PROJECT 转为 ProducerProject | 破坏已有数据，风险过高 |

### 选择方案 A 的理由

1. **零数据冲突** — 所有新增都是"加"而非"改"，GORM AutoMigrate 只加列不删列
2. **旧链路完全不碰** — 刚修好的 `join-project` 等 API 继续正常工作
3. **渐进切换路径清晰** — 新功能只在 PRODUCER 体系提供，用户按需迁移
4. **最大化复用** — 组织树 CRUD、`AllocateOrgToOrg`、级联停用全部复用

## Key Decisions

### 1. PRODUCER = Organization 节点

制作人复用 Organization 模型。新增字段：

```go
type Organization struct {
    // ... 现有字段全部不变 ...
    ProducerType *string `json:"producer_type" gorm:"type:varchar(20)"` // nullable, "INTERNAL"|"OUTSOURCE"
}
```

`CreateOrganization` 扩展：PRODUCER 级别也生成 InviteCode（与 STUDIO 相同逻辑）。

### 2. ProducerProject = 有预算池的项目（无独立管理员）

项目持有预算池，由制作人管理员全权管理。不需要独立管理员账号。统计走 Log 聚合。

```
ProducerProject（新表）
├── Id            int64     (PK, autoIncrement)
├── ProducerId    int64     (FK → Organization.Id, index)
├── Name          string    (项目名称)
├── Balance       int64     (预算池，default: 0)
├── IsActive      bool      (default: true)
├── CreatedAt     time.Time
└── UpdatedAt     time.Time
```

资金流：制作人的预算池（Organization.Balance）先分配到项目（ProducerProject.Balance），再从项目分配到个人。项目无独立管理员，由制作人管理员全权操作。

### 3. 成员-项目标签关联表

成员加入制作人后可自由选择参与哪些项目标签：

```
ProducerProjectMember（新表）
├── Id                  int64     (PK)
├── ProducerProjectId   int64     (FK → ProducerProject.Id)
├── PlatformUserId      string    (varchar(100))
├── CreatedAt           time.Time
└── @@unique(ProducerProjectId, PlatformUserId)
```

### 4. 现有表新增字段（全部 nullable/default，零改动旧数据）

**PersonalAllocation** — 使用 nullable 指针（避免零值陷阱）：

```go
type PersonalAllocation struct {
    // ... 现有字段全部不变 ...
    ProducerId        *int64 `json:"producer_id" gorm:"index"`
    ProducerProjectId *int64 `json:"producer_project_id" gorm:"index"`
}
```

- 旧记录：`project_id` 有值，`ProducerId` = nil → 走旧链路
- 新记录：`ProducerId` 有值 → 走新链路

**Log 表** — 使用 int64 default 0（高频写入，避免指针 GC 压力）：

```go
type Log struct {
    // ... 现有字段全部不变（project_id 含义不变）...
    ProducerId        int64 `json:"producer_id" gorm:"default:0;index;index:idx_log_producer,priority:1"`
    ProducerProjectId int64 `json:"producer_project_id" gorm:"default:0;index;index:idx_log_producer,priority:2"`
}
```

> 复合索引 `idx_log_producer(producer_id, producer_project_id)` 优化统计 API 中 `WHERE producer_id = ? AND producer_project_id = ?` 的聚合查询，与现有 Log 表的 `idx_created_at_id`、`idx_user_id_id` 等复合索引模式一致。

**Task.PrivateData** — 新增 ProducerId + ProducerProjectId，任务创建时从 header 写入。

### 5. 资金流

| 链路 | 函数 | 状态 |
|------|------|------|
| COMPANY → STUDIO | `AllocateOrgToOrg` | **不变** |
| STUDIO → PRODUCER | `AllocateOrgToOrg` | **不变**（只校验 ParentId） |
| PRODUCER → ProducerProject | **新增** `AllocateProducerToProject` | 从 PRODUCER.Balance 分配到 ProducerProject.Balance |
| ProducerProject → 个人 | **新增** `AllocateProjectToPersonal` | 从 ProducerProject.Balance 分配到影子账号 |

旧的 `AllocateOrgToPersonal`（PROJECT 级别）保留不动。

### 6. 三级权限模型

| 层级 | 管辖范围 |
|------|---------|
| **部门 (STUDIO)** 管理员 | 所有制作人、所有项目、所有成员 |
| **制作人 (PRODUCER)** 管理员 | 自己负责的项目标签和成员 |
| **项目 (ProducerProject)** | 只看到本项目的成员和消耗 |

**加入方式双通道**：

- **部门邀请码** → 成员加入 STUDIO → 可被分配到具体 PRODUCER
- **制作人邀请码** → 成员直接加入 PRODUCER → 同时自动创建 STUDIO 的 OrgMember（保证部门管理员可见）

**成员加入项目**：加入制作人后，自由选择参与哪些项目标签（类似现有 join-project）。

**权限查询路径**：
- 部门管理员：`GetOrgMembersRecursive(studioId)` → 递归查所有子节点成员
- 制作人管理员：`GetOrgMembersByOrgId(producerId)` → 只查自己的成员
- 项目级查看：`SELECT FROM producer_project_member WHERE producer_project_id = ?`

### 7. 制作人类型

`Organization.ProducerType`：`"INTERNAL"` | `"OUTSOURCE"`（nullable，仅 PRODUCER 级别使用）

### 8. 统计 API

| API | 维度 |
|-----|------|
| `GET /api/org/:companyId/stats` | 公司级：总充值/总消耗，按部门→制作人钻取 |
| `GET /api/org/:producerId/stats` | 制作人级：按项目标签和成员分组 |
| `GET /api/org/:producerId/projects/:tagId/stats` | 项目标签级：成员消耗明细 |

统计基于 `Log` 表按 `producer_id` / `producer_project_id` 聚合，不依赖任何冗余 Budget 字段。

## API 设计

### 全新端点（不动旧的）

| 端点 | 用途 |
|------|------|
| `POST /api/internal/join-producer` | 用户加入制作人 |
| `GET /api/internal/user-producers` | 获取用户所在的制作人列表及项目标签 |
| `GET /api/internal/producer-balance` | 获取用户在某制作人下的余额 |
| `POST /api/internal/join-producer-project` | 成员选择参与某项目标签 |

### 向后兼容扩展（不影响旧逻辑）

| 端点 | 改动 |
|------|------|
| `POST /api/internal/join-by-invite` | 如果邀请码对应 PRODUCER 级别，走新逻辑；STUDIO 级别走原逻辑 |
| `GET /api/internal/user-orgs` | 同时返回 PRODUCER 类型的 OrgMember |
| `CreateOrganization` | PRODUCER 级别也生成 InviteCode |

### 绝对不动的旧端点

`join-project`、`user-balance`、`user-orgs`（旧返回格式不变）、`join-by-invite`（STUDIO 分支不变）

## 三仓库改动范围

### New API (Go) — 核心改动

| 类别 | 位置 | 改动 |
|------|------|------|
| 新增 | `constant/org.go` | `OrgLevelProducer = "PRODUCER"` |
| 新增 | `model/producer_project.go` | ProducerProject + ProducerProjectMember 模型 |
| 新增字段 | `model/organization.go` | `ProducerType *string` |
| 新增字段 | `model/personal_allocation.go` | `ProducerId *int64`, `ProducerProjectId *int64` |
| 新增字段 | `model/log.go` | `ProducerId int64`, `ProducerProjectId int64` |
| 新增 | `service/allocation.go` | `AllocateProducerToProject`、`ReclaimProducerFromProject`、`AllocateProjectToPersonal`、`ReclaimProjectToPersonal` |
| 新增 | `controller/internal.go` | `InternalJoinProducer`、`InternalGetUserProducers`、`InternalGetProducerBalance`、`InternalJoinProducerProject` |
| 扩展 | `controller/internal.go` | `InternalJoinByInvite` 支持 PRODUCER 邀请码 |
| 扩展 | `controller/internal.go` | `InternalGetUserOrgs` 返回 PRODUCER OrgMember |
| 扩展 | `model/organization.go` | `CreateOrganization` 为 PRODUCER 生成 InviteCode |
| 新增 | `controller/organization.go` | 统计 API |
| 新增 | `router/` | 注册新路由 |

### sora-ui-backend (Node.js) — 代理层

| 位置 | 改动 |
|------|------|
| `src/routes/userOrg.ts` | 新增制作人相关路由转发 |
| `src/services/newApiService.ts` | 新增制作人相关接口方法 |
| 新增路由 | 统计聚合接口转发 |

### sora-ui (React) — 前端

| 位置 | 改动 |
|------|------|
| 新增 `src/stores/producerStore.ts` | 制作人状态管理（独立于 orgStore） |
| 新增页面 | 制作人管理（成员、项目标签） |
| 新增组件 | 统计仪表板（公司→制作人→项目→个人） |
| 扩展导航栏 | 同时展示旧项目和新制作人 |

**orgStore.ts 完全不动**。

## 兼容性验证（已对照源码）

| 函数 | 文件:行 | 结论 |
|------|---------|------|
| `AllocateOrgToOrg` | allocation.go:23-80 | **不变** — 只校验 ParentId，STUDIO→PRODUCER 天然支持 |
| `GetAncestorChain` | organization.go:121-136 | **不变** — PRODUCER→STUDIO→COMPANY = 3 层，循环上限 5 |
| `DeactivateOrganizationCascade` | allocation.go:446-513 | **需扩展** — PRODUCER 停用时级联停用所有 ProducerProject，回收项目余额到 PRODUCER |
| `task_billing.go` 全部函数 | task_billing.go | **不变** — 只操作 User.quota |
| `InternalJoinProject` | internal.go:260-317 | **不变** — 旧 PROJECT 体系继续工作 |
| `GetOrganizationTree` | organization.go:86-92 | **不变** — Preload 2 层够用 |
| `collectDescendantIds` | org_member.go:42-49 | **不变** — PRODUCER 作为子节点自动发现 |
| `CheckOrgPermission` | org_member.go:79-100 | **不变** — 沿 AncestorChain 向上查权限 |

## 核心不变项

- User / Token / Channel 模型
- `AllocateOrgToOrg` 逻辑
- `task_billing.go` 计费核心
- API Key 分发机制
- 所有旧 Internal API 端点及返回格式
- `orgStore.ts` 前端状态管理
- 已有 `personal_allocation` 记录的 `project_id` 含义
- 已有 `log` 记录的 `project_id` 含义
- 已有 `organization` 表中所有 PROJECT 级别记录

## 最佳实践验证（Context7 + 源码对照）

| 维度 | 验证结论 |
|------|---------|
| GORM AutoMigrate | **通过** — 只加列不删列，`*string`/`*int64` nullable、`int64 default:0` 均为官方推荐模式 |
| Prisma "No breaking changes" | **通过** — 只加 optional 字段、不重命名/删除、新功能新表 |
| 三数据库兼容 (SQLite/MySQL/PG) | **通过** — 所有新字段类型在三个数据库均原生支持 |
| 9 个关键函数兼容性 | **全部通过** — 对照源码逐一验证无需改动 |
| Log 表复合索引 | **已补充** — `idx_log_producer` 优化统计聚合查询 |

## 实施计划

### Phase 1 — New API 模型层（零业务逻辑，先让表结构就位）

**目标**：所有新表创建完毕，现有表新字段 AutoMigrate 成功，编译通过。

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1.1 | `constant/org.go` | 追加 `OrgLevelProducer = "PRODUCER"` |
| 1.2 | `model/organization.go` | Organization struct 追加 `ProducerType *string` 字段 |
| 1.3 | `model/organization.go` | `CreateOrganization` 扩展：`OrgLevelProducer` 也生成 InviteCode |
| 1.4 | `model/producer_project.go`（新文件） | 定义 `ProducerProject` 模型 + CRUD 函数 |
| 1.5 | `model/producer_project.go` | 定义 `ProducerProjectMember` 模型 + CRUD 函数 |
| 1.6 | `model/personal_allocation.go` | 追加 `ProducerId *int64`、`ProducerProjectId *int64` 字段 |
| 1.7 | `model/log.go` | 追加 `ProducerId int64`、`ProducerProjectId int64` 字段（含复合索引） |
| 1.8 | `model/log.go` | `RecordConsumeLogParams` 追加 `ProducerId`、`ProducerProjectId` 字段 |
| 1.9 | `model/main.go` | `migrateDB()` 和 `migrateDBFast()` 追加 `&ProducerProject{}`、`&ProducerProjectMember{}` |

**验证**：`go build ./...` 编译通过，启动后 AutoMigrate 创建新表和新列无报错。

### Phase 2 — New API 业务层（Service + Controller + Router）

**目标**：所有新 API 端点可用，向后兼容扩展完成。

| 步骤 | 文件 | 改动 |
|------|------|------|
| 2.1 | `service/allocation.go` | 新增 `AllocateProducerToProject` — 从 PRODUCER.Balance 分配到 ProducerProject.Balance |
| 2.1b | `service/allocation.go` | 新增 `ReclaimProducerFromProject` — 从 ProducerProject 回收余额到 PRODUCER |
| 2.2 | `service/allocation.go` | 新增 `AllocateProjectToPersonal` — 从 ProducerProject.Balance 分配到影子账号 |
| 2.2b | `service/allocation.go` | 新增 `ReclaimProjectToPersonal` — 回收个人余额到 ProducerProject |
| 2.2c | `service/allocation.go` | 扩展 `DeactivateOrganizationCascade` — PRODUCER 停用时级联停用 ProducerProject + 回收项目余额 |
| 2.3 | `controller/internal.go` | 新增 `InternalJoinProducer` — 用户加入制作人（含自动创建 STUDIO OrgMember） |
| 2.4 | `controller/internal.go` | 新增 `InternalGetUserProducers` — 获取用户所在制作人列表及项目标签 |
| 2.5 | `controller/internal.go` | 新增 `InternalGetProducerBalance` — 获取用户在制作人下的余额 |
| 2.6 | `controller/internal.go` | 新增 `InternalJoinProducerProject` — 成员选择参与项目标签 |
| 2.7 | `controller/internal.go` | 扩展 `InternalJoinByInvite` — PRODUCER 邀请码走新逻辑 |
| 2.8 | `controller/internal.go` | 扩展 `InternalGetUserOrgs` — 同时返回 PRODUCER OrgMember |
| 2.9 | `controller/organization.go` | 新增统计 API（公司级、制作人级、项目标签级） |
| 2.10 | `router/` | 注册所有新路由 |

**验证**：用 curl 测试新端点（join-producer、user-producers、producer-balance），确认旧端点（join-project、user-balance）行为不变。

### Phase 3 — sora-ui-backend 代理层（Node.js）

**目标**：前端可通过 BFF 层调用所有制作人相关 API。

| 步骤 | 文件 | 改动 |
|------|------|------|
| 3.1 | `src/services/newApiService.ts` | 新增 `joinProducer`、`getUserProducers`、`getProducerBalance`、`joinProducerProject` 方法 |
| 3.2 | `src/routes/userOrg.ts` | 新增 `/api/user/join-producer`、`/api/user/producers`、`/api/user/producer-balance`、`/api/user/join-producer-project` 路由 |
| 3.3 | 新增路由文件或扩展 | 统计 API 转发（`/api/org/:id/stats`） |

**验证**：前端 → BFF → New API 全链路联调通。

### Phase 4 — sora-ui 前端（React）

**目标**：用户可在界面中管理制作人、项目标签、查看统计。

| 步骤 | 文件 | 改动 |
|------|------|------|
| 4.1 | 新增 `src/stores/producerStore.ts` | 制作人状态管理（独立于 orgStore） |
| 4.2 | 新增页面 | 制作人管理页：成员列表、项目标签管理、邀请码展示 |
| 4.3 | 新增组件 | 统计仪表板：公司→制作人→项目→个人层级钻取 |
| 4.4 | 扩展导航栏 | 同时展示旧项目和新制作人入口 |
| 4.5 | 新增组件 | 制作人邀请码加入流程（复用现有 STUDIO 邀请码 UI 模式） |

**验证**：全流程 E2E 测试——创建制作人 → 邀请成员 → 创建项目标签 → 分配余额 → 使用 API → 查看统计。

### 实施顺序与依赖

```
Phase 1 (模型层) → Phase 2 (业务层) → Phase 3 (代理层) → Phase 4 (前端)
         ↓                  ↓                  ↓                ↓
   编译+迁移验证       curl 端点测试       全链路联调        E2E 测试
```

每个 Phase 完成后做一次 Docker 构建部署验证，确保增量交付。
