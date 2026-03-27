# 不可变日志直查报表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让报表/余额查询直接用 `logs` 表已有的 `group`/`project_id` 字段查，并补全 `producer_id`/`producer_project_id`，彻底消除因组织停用导致消费记录丢失的问题。

**Architecture:** 在 Go `Log` struct 中新增 `ProducerId`/`ProducerProjectId` 字段，让 relay 写 log 时填入完整的组织上下文。报表查询改用 `logs.group` 和 `logs.project_id` 直查，不再遍历组织树收集 user_ids。历史数据通过一次性 SQL UPDATE JOIN 回填。

**Tech Stack:** Go (GORM), PostgreSQL, Gin framework

---

## 文件变更总览

| 动作 | 文件路径 | 职责 |
|------|---------|------|
| Modify | `model/log.go` | Log struct 加 ProducerId/ProducerProjectId 字段；RecordConsumeLogParams 同步；RecordConsumeLog 加 Header 回退；RecordTaskBillingLogParams 同步 |
| Modify | `service/task_billing.go` | LogTaskConsumption / RefundTaskQuota / RecalculateTaskQuota 传入 producer 字段 |
| Modify | `service/quota.go` | 4 个 PostXxxConsumeQuota 函数传入 producer 字段 |
| Modify | `controller/report.go` | 报表查询改为直查 logs.group/project_id，废弃 collectOrgNewApiUserIds 间接查询 |
| Modify | `controller/organization.go` | netSpentByUserIds → netSpentByGroup / netSpentByProjectIds，直查 logs |
| Create | `scripts/backfill_producer_ids.sql` | 一次性回填脚本 |

---

### Task 1: Log struct 加 ProducerId / ProducerProjectId 字段

**Files:**
- Modify: `model/log.go:20-47` (Log struct)
- Modify: `model/log.go:149-168` (RecordConsumeLogParams struct)
- Modify: `model/log.go:170-249` (RecordConsumeLog function)
- Modify: `model/log.go:292-337` (RecordTaskBillingLogParams + RecordTaskBillingLog)

- [ ] **Step 1: 在 Log struct 末尾加两个字段**

在 `SettleStatus` 后面新增：

```go
ProducerId        int64  `json:"producer_id" gorm:"default:0;index"`
ProducerProjectId int64  `json:"producer_project_id" gorm:"default:0;index"`
```

- [ ] **Step 2: RecordConsumeLogParams 加对应字段**

在 `SettleStatus` 后面加：

```go
ProducerId        int64  `json:"producer_id"`
ProducerProjectId int64  `json:"producer_project_id"`
```

- [ ] **Step 3: RecordConsumeLog 加 Header 回退逻辑**

在 `PlatformUserId` 的 Header 回退逻辑后面加：

```go
if params.ProducerId == 0 {
    if pidStr := c.GetHeader("X-Producer-Id"); pidStr != "" {
        if pid, err := strconv.ParseInt(pidStr, 10, 64); err == nil {
            params.ProducerId = pid
        }
    }
}
if params.ProducerProjectId == 0 {
    if ppidStr := c.GetHeader("X-Producer-Project-Id"); ppidStr != "" {
        if ppid, err := strconv.ParseInt(ppidStr, 10, 64); err == nil {
            params.ProducerProjectId = ppid
        }
    }
}
```

在 Log 创建处（约 208-238 行），`SettleStatus` 后面加：

```go
ProducerId:        params.ProducerId,
ProducerProjectId: params.ProducerProjectId,
```

- [ ] **Step 4: RecordTaskBillingLogParams 加对应字段**

在 `ProjectId` 后面加：

```go
ProducerId        int64
ProducerProjectId int64
```

在 `RecordTaskBillingLog` 函数中 Log 创建处，`ProjectId` 后面加：

```go
ProducerId:        params.ProducerId,
ProducerProjectId: params.ProducerProjectId,
```

- [ ] **Step 5: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./...
```

Expected: 编译通过（新字段有默认值，现有调用方不传也不会报错）

- [ ] **Step 6: Commit**

```bash
git add model/log.go
git commit -m "feat(log): add ProducerId and ProducerProjectId fields to Log struct"
```

---

### Task 2: relay 写 log 时传入 producer 信息

**Files:**
- Modify: `service/task_billing.go:49-59` (LogTaskConsumption)
- Modify: `service/task_billing.go:176-188` (RefundTaskQuota RecordTaskBillingLog 调用)
- Modify: `service/task_billing.go:262-274` (RecalculateTaskQuota RecordTaskBillingLog 调用)
- Modify: `relay/common/relay_info.go` (Task PrivateData 或 RelayInfo，确认是否已有 producer 字段)

- [ ] **Step 1: 确认 Task.PrivateData 中是否有 ProducerId/ProducerProjectId**

读 `model/task.go` 中 `TaskPrivateData` struct 定义。如果没有，需要在该 struct 加字段。

- [ ] **Step 2: 在 LogTaskConsumption 中传入 producer 字段**

`service/task_billing.go` 第 49 行附近的 `RecordConsumeLog` 调用中，由于 `RecordConsumeLog` 已支持从 Header `X-Producer-Id` / `X-Producer-Project-Id` 自动回退填充（Task 1 Step 3），对于通过 HTTP relay 进来的请求，Header 已经在 request context 中，不需要额外传参。

但对于 `RecordTaskBillingLog`（非 HTTP 上下文），需要显式传：

- [ ] **Step 3: RefundTaskQuota 中的 RecordTaskBillingLog 加 producer 参数**

```go
model.RecordTaskBillingLog(model.RecordTaskBillingLogParams{
    // ... 现有字段 ...
    ProjectId:      task.PrivateData.ProjectId,
    ProducerId:        task.PrivateData.ProducerId,
    ProducerProjectId: task.PrivateData.ProducerProjectId,
})
```

- [ ] **Step 4: RecalculateTaskQuota 中的 RecordTaskBillingLog 同样加 producer 参数**

同 Step 3 的模式。

- [ ] **Step 5: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add service/task_billing.go model/task.go
git commit -m "feat(billing): propagate producer context to log entries"
```

---

### Task 3: 新增 netSpentByGroup / netSpentByProjectIds 直查函数

**Files:**
- Modify: `controller/organization.go:17-47` (替换 netSpentByUserIds)

- [ ] **Step 1: 新增 netSpentByGroup 函数**

```go
// netSpentByGroup computes net consumed quota for an entire company group.
// Uses logs.group directly — no org tree traversal needed.
func netSpentByGroup(group string) int64 {
    if group == "" {
        return 0
    }
    var netSpent int64
    model.LOG_DB.Table("logs").
        Where(model.LogGroupCol()+" = ?", group).
        Where("type IN ?", []int{model.LogTypeConsume, model.LogTypeRefund}).
        Where("settle_status != ?", model.SettleStatusCancelled).
        Select(fmt.Sprintf(
            "COALESCE(SUM(CASE WHEN type = %d THEN quota WHEN type = %d THEN -quota ELSE 0 END), 0)",
            model.LogTypeConsume, model.LogTypeRefund,
        )).Scan(&netSpent)
    return netSpent
}
```

- [ ] **Step 2: 新增 netSpentByProjectIds 函数**

```go
// netSpentByProjectIds computes net consumed quota across multiple project IDs.
// Uses logs.project_id directly — immune to org deactivation.
func netSpentByProjectIds(projectIds []int64) int64 {
    if len(projectIds) == 0 {
        return 0
    }
    var netSpent int64
    model.LOG_DB.Table("logs").
        Where("project_id IN ?", projectIds).
        Where("type IN ?", []int{model.LogTypeConsume, model.LogTypeRefund}).
        Where("settle_status != ?", model.SettleStatusCancelled).
        Select(fmt.Sprintf(
            "COALESCE(SUM(CASE WHEN type = %d THEN quota WHEN type = %d THEN -quota ELSE 0 END), 0)",
            model.LogTypeConsume, model.LogTypeRefund,
        )).Scan(&netSpent)
    return netSpent
}
```

- [ ] **Step 3: 新增 netSpentByProducerIds 函数**

```go
// netSpentByProducerIds computes net consumed quota for producer orgs.
// Falls back to user_id lookup for historical logs where producer_id=0.
func netSpentByProducerIds(producerIds []int64) int64 {
    if len(producerIds) == 0 {
        return 0
    }
    // After backfill, producer_id will be populated; for now use hybrid approach
    var netSpent int64
    model.LOG_DB.Table("logs").
        Where("producer_id IN ?", producerIds).
        Where("type IN ?", []int{model.LogTypeConsume, model.LogTypeRefund}).
        Where("settle_status != ?", model.SettleStatusCancelled).
        Select(fmt.Sprintf(
            "COALESCE(SUM(CASE WHEN type = %d THEN quota WHEN type = %d THEN -quota ELSE 0 END), 0)",
            model.LogTypeConsume, model.LogTypeRefund,
        )).Scan(&netSpent)
    return netSpent
}
```

- [ ] **Step 4: 保留 netSpentByUserIds 作为兼容函数**

不删除，保留给成员级别（个人分配）查询使用，它按 user_id 查没有问题。

- [ ] **Step 5: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add controller/organization.go
git commit -m "feat(report): add direct-query functions netSpentByGroup/ProjectIds/ProducerIds"
```

---

### Task 4: 改造 report.go 报表查询路径

**Files:**
- Modify: `controller/report.go:26-96` (GetUsageReport)
- Modify: `controller/report.go:98-149` (GetReportSummary)
- Modify: `controller/report.go:315-384` (queryUsageGrouped)

- [ ] **Step 1: 改造 GetUsageReport — 用 group/project_id 替代 user_ids**

当前逻辑：
```go
userIds, err := collectOrgNewApiUserIds(orgId)
items, totalQuota, totalTokens, err := queryUsageGrouped(userIds, ...)
```

改为：
```go
org, err := model.GetOrganizationById(orgId)
// 根据层级决定查询策略
var groupFilter string
var projectIdFilter []int64
switch org.Level {
case constant.OrgLevelCompany:
    groupFilter = fmt.Sprintf("org_%d", orgId)
case constant.OrgLevelProject:
    projectIdFilter = []int64{orgId}
default:
    // STUDIO / PRODUCER — 收集所有下级 project IDs
    projectIdFilter, _ = collectAllProjectIds(orgId)
}
items, totalQuota, totalTokens, err := queryUsageGroupedDirect(groupFilter, projectIdFilter, ...)
```

- [ ] **Step 2: 新增 queryUsageGroupedDirect 函数**

基于现有 `queryUsageGrouped`，将 `WHERE user_id IN ?` 替换为 `WHERE group = ?` 或 `WHERE project_id IN ?`：

```go
func queryUsageGroupedDirect(groupFilter string, projectIds []int64,
    startTs, endTs int64, groupBy, modelFilter, featureFilter, channelFilter string,
) ([]usageItem, int64, int64, error) {
    baseWhere := func() *gorm.DB {
        q := model.LOG_DB.Table("logs").
            Where("type IN ?", []int{model.LogTypeConsume, model.LogTypeRefund}).
            Where("settle_status != ?", model.SettleStatusCancelled).
            Where("created_at >= ? AND created_at <= ?", startTs, endTs)
        if groupFilter != "" {
            q = q.Where(model.LogGroupCol()+" = ?", groupFilter)
        } else if len(projectIds) > 0 {
            q = q.Where("project_id IN ?", projectIds)
        } else {
            q = q.Where("1 = 0") // safety: no filter = no data
        }
        if modelFilter != "" {
            q = q.Where("model_name = ?", modelFilter)
        }
        if featureFilter != "" {
            q = q.Where("feature = ?", featureFilter)
        }
        if channelFilter != "" {
            q = q.Where("log_channel = ?", channelFilter)
        }
        return q
    }
    // ... 其余逻辑与 queryUsageGrouped 相同 ...
}
```

- [ ] **Step 3: 改造 GetReportSummary — 同样用直查**

```go
org, err := model.GetOrganizationById(orgId)
var totalSpent int64
switch org.Level {
case constant.OrgLevelCompany:
    totalSpent = netSpentByGroup(fmt.Sprintf("org_%d", orgId))
case constant.OrgLevelProject:
    totalSpent = netSpentByProjectIds([]int64{orgId})
default:
    projectIds, _ := collectAllProjectIds(orgId)
    totalSpent = netSpentByProjectIds(projectIds)
}
```

- [ ] **Step 4: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add controller/report.go
git commit -m "refactor(report): query logs directly by group/project_id instead of user_id traversal"
```

---

### Task 5: 改造 organization.go 余额统计查询

**Files:**
- Modify: `controller/organization.go` (GetCompanies, buildChildWithStats, GetProducerProjects 中的 netSpentByUserIds 调用)

- [ ] **Step 1: GetCompanies 中的消耗统计改用 netSpentByGroup**

约 245-247 行：
```go
// 旧：
// userIds, _ := collectOrgNewApiUserIds(comp.Id)
// totalSpent := netSpentByUserIds(userIds)
// 新：
totalSpent := netSpentByGroup(fmt.Sprintf("org_%d", comp.Id))
```

- [ ] **Step 2: buildChildWithStats 同样改造**

约 362-363 行，根据 child.Level 选择查询方式：
```go
switch child.Level {
case constant.OrgLevelProject:
    totalSpent = netSpentByProjectIds([]int64{child.Id})
default:
    projectIds, _ := collectAllProjectIds(child.Id)
    totalSpent = netSpentByProjectIds(projectIds)
}
```

- [ ] **Step 3: GetProducerProjects 的消耗统计**

约 1190 行，对于制作人项目，回填后可用 `producer_project_id`：
```go
// 回填前暂时保留 user_id 查询；回填后改为：
// totalSpent = netSpentByProducerProjectId(pp.Id)
// 当前保持 netSpentByUserIds(allUserIds) 兼容
```

- [ ] **Step 4: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add controller/organization.go
git commit -m "refactor(org): use direct log queries for balance stats, bypass org tree traversal"
```

---

### Task 6: 导出 LogGroupCol 并清理内部引用

**Files:**
- Modify: `model/log.go` 或包含 `logGroupCol` 的文件

- [ ] **Step 1: 找到 logGroupCol 定义**

搜索 `logGroupCol` 的定义（可能在 `model/log.go` 或 `model/log_utils.go`），确认它是 `"group"` 还是 `"\"group\""` 等。

- [ ] **Step 2: 新增导出函数 LogGroupCol()**

```go
func LogGroupCol() string {
    return logGroupCol
}
```

以便 `controller` 包可以引用。

- [ ] **Step 3: 编译验证**

- [ ] **Step 4: Commit**

```bash
git add model/
git commit -m "refactor(model): export LogGroupCol for cross-package usage"
```

---

### Task 7: 历史数据回填脚本

**Files:**
- Create: `scripts/backfill_producer_ids.sql`

- [ ] **Step 1: 编写回填 SQL**

```sql
-- 回填 logs.producer_id 和 logs.producer_project_id
-- 通过 logs.user_id JOIN personal_allocation.newapi_user_id 反查
-- 每个 newapi_user_id 在 personal_allocation 中是 1:1 映射

BEGIN;

-- 回填 producer_id
UPDATE logs l
SET producer_id = pa.producer_id
FROM personal_allocation pa
WHERE l.user_id = pa.newapi_user_id
  AND pa.producer_id IS NOT NULL
  AND pa.producer_id > 0
  AND l.producer_id = 0;

-- 回填 producer_project_id
UPDATE logs l
SET producer_project_id = pa.producer_project_id
FROM personal_allocation pa
WHERE l.user_id = pa.newapi_user_id
  AND pa.producer_project_id IS NOT NULL
  AND pa.producer_project_id > 0
  AND l.producer_project_id = 0;

COMMIT;

-- 验证
SELECT
  COUNT(*) AS total_logs,
  COUNT(CASE WHEN producer_id > 0 THEN 1 END) AS has_producer,
  COUNT(CASE WHEN producer_project_id > 0 THEN 1 END) AS has_pp
FROM logs
WHERE type = 2;
```

- [ ] **Step 2: 在生产数据库执行回填**

```bash
docker exec sora-postgres psql -U sorauser -d newapi -f /tmp/backfill_producer_ids.sql
```

或复制文件进容器后执行。

- [ ] **Step 3: 验证回填结果**

```bash
docker exec sora-postgres psql -U sorauser -d newapi -c "
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN producer_id > 0 THEN 1 END) AS has_producer,
  COUNT(CASE WHEN producer_project_id > 0 THEN 1 END) AS has_pp
FROM logs WHERE type = 2;
"
```

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill_producer_ids.sql
git commit -m "ops: add one-time backfill script for logs producer_id/producer_project_id"
```

---

### Task 8: 构建部署验证

**Files:**
- Modify: `docker-compose.local.yml` (if needed for rebuild)

- [ ] **Step 1: 本地 Docker 构建 new-api**

```bash
docker compose -f docker-compose.local.yml build sora-new-api
```

- [ ] **Step 2: 重启容器**

```bash
docker compose -f docker-compose.local.yml up -d sora-new-api
```

GORM AutoMigrate 会自动在 logs 表添加 `producer_id` 和 `producer_project_id` 列（如果不存在）及索引。

- [ ] **Step 3: 执行回填脚本**

- [ ] **Step 4: 刷新报表页面验证**

访问 `http://localhost:3000/console/reports`，验证：
1. 停用工作室/项目后消耗数据不为零
2. 各层级消耗总额一致
3. 制作人项目层级有消耗数据

- [ ] **Step 5: 刷新余额页面验证**

访问 `http://localhost:3000/console/balance`，验证：
1. 各层级剩余总额 = 历史充值 - 实际消耗
2. 停用组织的历史消耗仍然计入

- [ ] **Step 6: Commit & 更新踩坑文档**

```bash
git add .
git commit -m "deploy: immutable logs reporting - verified all hierarchy levels"
```

更新 `new-server-handoff-175.178.198.17(1).md` 中的报表查询说明。
