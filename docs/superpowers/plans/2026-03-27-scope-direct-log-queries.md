# Scope 层直查 logs 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 scoped usage / scoped logs 查询也像 report.go 一样直接用 `logs.group`/`project_id`/`producer_id` 查，彻底消除所有因组织/成员停用导致消费记录丢失的路径。

**Architecture:** 在 `ScopeResult` 中新增 `LogFilter` 结构体，替代 `UserIds` 作为日志查询条件。`scope_service.go` 的各 resolve 函数改为填充 `LogFilter`（group/project_id/producer_id）而非 user_ids。`scoped_query.go` 的 `buildScopedTx`/`GetScopedUsageByDimension`/`GetScopedUsageTotal` 改用 `LogFilter` 构建 WHERE 条件。`scoped_usage.go` 的 `GetScopedChildrenUsage` 和 `buildProducerProjectChildrenUsage` 也同步改造。

**Tech Stack:** Go (GORM Scopes pattern), PostgreSQL

---

## 文件变更总览

| 动作 | 文件路径 | 职责 |
|------|---------|------|
| Modify | `service/scope_service.go` | ScopeResult 加 LogFilter；各 resolve 函数改为填充 LogFilter |
| Modify | `model/scoped_query.go` | buildScopedTx 支持 LogFilter；GetScopedUsageByDimension / GetScopedUsageTotal 用 LogFilter |
| Modify | `controller/scoped_usage.go` | GetScopedChildrenUsage / buildProducerProjectChildrenUsage 改造 |
| Modify | `controller/scoped_log.go` | resolveScopeFromRequest 透传 LogFilter |

---

### Task 1: ScopeResult 加 LogFilter 结构体

**Files:**
- Modify: `service/scope_service.go:24-37`

- [ ] **Step 1: 在 ScopeResult 旁边定义 LogFilter**

```go
// LogFilter determines how to filter logs — exactly one field should be set.
// Priority: GroupFilter > ProjectIds > ProducerId > ProducerProjectId > UserIds.
// NoFilter=true means root admin global view (no WHERE clause on org).
type LogFilter struct {
	NoFilter          bool    // root global view — no org-level filtering
	GroupFilter       string  // company: WHERE group = 'org_X'
	ProjectIds        []int64 // studio/project: WHERE project_id IN ?
	ProducerId        int64   // producer: WHERE producer_id = ?
	ProducerProjectId int64   // producer project: WHERE producer_project_id = ?
	UserIds           []int   // personal: WHERE user_id IN ?
}
```

- [ ] **Step 2: 在 ScopeResult 中加 LogFilter 字段**

```go
type ScopeResult struct {
	UserIds    []int     `json:"userIds"`    // 保留向后兼容
	ProjectIds []int64   `json:"projectIds"`
	OrgIds     []int64   `json:"orgIds"`
	ScopeType  ScopeType `json:"scopeType"`
	OrgId      int64     `json:"orgId"`
	Filter     LogFilter `json:"filter"`     // 新增
}
```

- [ ] **Step 3: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./service/...
```

- [ ] **Step 4: Commit**

```bash
git add service/scope_service.go
git commit -m "feat(scope): add LogFilter struct to ScopeResult"
```

---

### Task 2: 各 resolve 函数填充 LogFilter

**Files:**
- Modify: `service/scope_service.go:56-226`

- [ ] **Step 1: resolveScopeAll — 设 NoFilter=true**

```go
func resolveScopeAll(currentUserRole int) (*ScopeResult, error) {
	if currentUserRole < common.RoleRootUser {
		return nil, errors.New("仅 Root 管理员可查看全局数据")
	}
	return &ScopeResult{
		UserIds:   nil,
		ScopeType: ScopeAll,
		Filter:    LogFilter{NoFilter: true},
	}, nil
}
```

- [ ] **Step 2: resolveScopeOrg — 按层级选择 filter**

在权限检查后，替换 `collectUserIdsFromProjects` 逻辑：

```go
	// 构建 LogFilter：直接按 group/project_id 查，不依赖 user_id
	var filter LogFilter
	switch org.Level {
	case constant.OrgLevelCompany:
		filter = LogFilter{GroupFilter: fmt.Sprintf("org_%d", req.OrgId)}
	case constant.OrgLevelProject:
		filter = LogFilter{ProjectIds: []int64{req.OrgId}}
	default: // STUDIO
		pids, _ := CollectProjectIds(req.OrgId)
		filter = LogFilter{ProjectIds: pids}
	}

	// 保留 userIds 向后兼容（其他地方可能还用）
	userIds, _ := collectUserIdsFromProjects(projectIds)

	return &ScopeResult{
		UserIds:    userIds,
		ProjectIds: projectIds,
		OrgIds:     orgIds,
		ScopeType:  req.ScopeType,
		OrgId:      req.OrgId,
		Filter:     filter,
	}, nil
```

需要在文件顶部加 `"fmt"` import（如果还没有的话）。

- [ ] **Step 3: resolveScopeProducer — 用 producer_id filter**

```go
	return &ScopeResult{
		UserIds:   userIds, // 保留兼容
		OrgIds:    []int64{req.OrgId},
		ScopeType: req.ScopeType,
		OrgId:     req.OrgId,
		Filter:    LogFilter{ProducerId: req.OrgId},
	}, nil
```

同时把 `GetPersonalAllocationsByProducer` 改为 `GetAllPersonalAllocationsByProducer` 以确保 userIds 也包含已停用的。

- [ ] **Step 4: resolveScopeProducerProject — 用 producer_project_id filter**

```go
	return &ScopeResult{
		UserIds:   userIds, // 保留兼容
		OrgIds:    []int64{pp.ProducerId},
		ScopeType: req.ScopeType,
		OrgId:     pp.ProducerId,
		Filter:    LogFilter{ProducerProjectId: req.ProducerProjectId},
	}, nil
```

同时把 `GetPersonalAllocationsByProducerProject` 改为 `GetAllPersonalAllocationsByProducerProject`。

- [ ] **Step 5: collectUserIdsFromProjects — 改用 GetAll 版本**

行 228-257，将 `GetPersonalAllocationsByProject` 改为：

```go
	for _, pid := range projectIds {
		allocs, err := model.GetAllPersonalAllocationsByProject(pid)
```

- [ ] **Step 6: collectOrgIds — 改用 GetAllOrganizationsByParentId**

行 271，将 `GetOrganizationsByParentId` 改为 `GetAllOrganizationsByParentId`。

- [ ] **Step 7: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./service/... ./model/...
```

- [ ] **Step 8: Commit**

```bash
git add service/scope_service.go
git commit -m "feat(scope): populate LogFilter in all resolve functions, use GetAll for allocations"
```

---

### Task 3: scoped_query.go 支持 LogFilter

**Files:**
- Modify: `model/scoped_query.go:13-80` (ScopedLogQuery + buildScopedTx)
- Modify: `model/scoped_query.go:159-223` (GetScopedUsageByDimension)
- Modify: `model/scoped_query.go:261-293` (GetScopedUsageTotal)

- [ ] **Step 1: ScopedLogQuery 加 LogFilter 字段**

在 `model/scoped_query.go` 顶部 import `service` 包会造成循环依赖。所以把 `LogFilter` 定义移到 `model` 包，或者在 `model` 包中定义一个等价的类型。

最简方案：在 `model/scoped_query.go` 中直接加字段：

```go
type ScopedLogQuery struct {
	UserIds           []int
	// 新增：直查字段（优先级高于 UserIds）
	GroupFilter       string  // WHERE group = ?
	ProjectIdFilter   []int64 // WHERE project_id IN ?
	ProducerIdFilter  int64   // WHERE producer_id = ?
	PPIdFilter        int64   // WHERE producer_project_id = ?
	NoUserFilter      bool    // root view: skip user_id filter entirely
	// 原有字段...
	LogType        int
	StartTimestamp int64
	EndTimestamp   int64
	ModelName      string
	Username       string
	TokenName      string
	Channel        int
	Group          string
	RequestId      string
	Feature        string
	LogChannel     string
	ProjectId      int64
	StartIdx       int
	Num            int
}
```

- [ ] **Step 2: buildScopedTx 优先使用直查字段**

替换行 34-41 的 user_id 逻辑：

```go
func buildScopedTx(q ScopedLogQuery) *gorm.DB {
	tx := LOG_DB.Model(&Log{})

	// 优先使用直查字段（不依赖 user_id）
	switch {
	case q.GroupFilter != "":
		tx = tx.Where(logGroupCol+" = ?", q.GroupFilter)
	case len(q.ProjectIdFilter) > 0:
		tx = tx.Where("project_id IN ?", q.ProjectIdFilter)
	case q.ProducerIdFilter > 0:
		tx = tx.Where("producer_id = ?", q.ProducerIdFilter)
	case q.PPIdFilter > 0:
		tx = tx.Where("producer_project_id = ?", q.PPIdFilter)
	case q.NoUserFilter:
		// root global view: no user/org filter
	case q.UserIds == nil:
		// nil → no user_id filter (legacy root)
	case len(q.UserIds) == 0:
		tx = tx.Where("1 = 0")
	default:
		tx = tx.Where("user_id IN ?", q.UserIds)
	}

	// ... 其余过滤条件不变 ...
```

- [ ] **Step 3: GetScopedUsageByDimension 也支持直查**

函数签名改为：
```go
func GetScopedUsageByDimension(userIds []int, projectIds []int64,
	startTs, endTs int64, dimension string,
	modelFilter, featureFilter, channelFilter string,
	groupFilter string, producerIdFilter int64, ppIdFilter int64,
) ([]ScopedUsageSummary, error) {
```

在 `base()` 闭包中加入直查字段优先逻辑：
```go
	base := func() *gorm.DB {
		q := LOG_DB.Table("logs").
			Where("type IN ?", []int{LogTypeConsume, LogTypeRefund}).
			Where("settle_status != ?", SettleStatusCancelled).
			Where("created_at >= ? AND created_at <= ?", startTs, endTs)
		// 优先直查
		switch {
		case groupFilter != "":
			q = q.Where(logGroupCol+" = ?", groupFilter)
		case producerIdFilter > 0:
			q = q.Where("producer_id = ?", producerIdFilter)
		case ppIdFilter > 0:
			q = q.Where("producer_project_id = ?", ppIdFilter)
		case userIds != nil:
			q = q.Where("user_id IN ?", userIds)
		}
		// 其余 filter...
```

- [ ] **Step 4: GetScopedUsageTotal 同样改造**

签名加 `groupFilter, producerIdFilter, ppIdFilter` 参数，逻辑同上。

- [ ] **Step 5: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./model/...
```

会有编译错误（调用方签名不匹配），下个 Task 修。

- [ ] **Step 6: Commit**

```bash
git add model/scoped_query.go
git commit -m "feat(scoped_query): support direct group/project_id/producer_id filters"
```

---

### Task 4: 调用方适配新签名

**Files:**
- Modify: `controller/scoped_usage.go` (GetScopedUsageGrouped, GetScopedChildrenUsage, buildProducerProjectChildrenUsage)
- Modify: `controller/scoped_log.go` (GetScopedLogs 的 ScopedLogQuery 构建)

- [ ] **Step 1: GetScopedUsageGrouped 传递 LogFilter**

```go
	items, err := model.GetScopedUsageByDimension(
		scope.UserIds, scope.ProjectIds, startTs, endTs,
		groupBy, modelFilter, featureFilter, channelFilter,
		scope.Filter.GroupFilter, scope.Filter.ProducerId, scope.Filter.ProducerProjectId,
	)
```

注意：`scope.Filter` 是 `service.LogFilter` 类型，需要在 controller 中引用 `service` 包（已有）。

- [ ] **Step 2: GetScopedChildrenUsage — 子组织用量也用直查**

行 123，将 `GetOrganizationsByParentId` 改为 `GetAllOrganizationsByParentId`：
```go
	children, err := model.GetAllOrganizationsByParentId(orgId)
```

行 139，`GetScopedUsageTotal` 调用改为传入直查参数：
```go
	var gf string
	var pids []int64
	switch child.Level {
	case constant.OrgLevelCompany:
		gf = fmt.Sprintf("org_%d", child.Id)
	case constant.OrgLevelProject:
		pids = []int64{child.Id}
	default:
		pids, _ = service.CollectProjectIds(child.Id)
	}
	quota, tokens, count, err := model.GetScopedUsageTotal(nil, nil, startTs, endTs, gf, 0, 0)
	// 或者用 pids 版本
```

实际上更简洁的做法是让 `GetScopedUsageTotal` 接收一个 filter struct。我们统一用 struct 传参。

- [ ] **Step 3: buildProducerProjectChildrenUsage — 直查 producer_project_id**

行 170，将 `GetPersonalAllocationsByProducerProject` + user_id 查询替换为直查：
```go
	for _, pp := range ppList {
		quota, tokens, count, err := model.GetScopedUsageTotal(nil, nil, startTs, endTs, "", 0, pp.Id)
		if err != nil {
			quota, tokens, count = 0, 0, 0
		}
		rows = append(rows, childUsageRow{
			OrgId:  pp.Id,
			Name:   pp.Name,
			Level:  "PRODUCER_PROJECT",
			Quota:  quota,
			Yuan:   service.QuotaToYuan(quota),
			Tokens: tokens,
			Count:  count,
		})
	}
```

- [ ] **Step 4: scoped_log.go — ScopedLogQuery 传递直查字段**

在 `GetScopedLogs` 中构建 `model.ScopedLogQuery` 时加入 filter 字段：
```go
	q := model.ScopedLogQuery{
		UserIds:          scope.UserIds,
		GroupFilter:      scope.Filter.GroupFilter,
		ProjectIdFilter:  scope.Filter.ProjectIds,  // 注意类型是 []int64
		ProducerIdFilter: scope.Filter.ProducerId,
		PPIdFilter:       scope.Filter.ProducerProjectId,
		NoUserFilter:     scope.Filter.NoFilter,
		// ... 其余字段不变 ...
	}
```

注意：`LogFilter` 在 `service` 包定义，这里的字段名需要对应上。如果 `service.LogFilter.ProjectIds` 和 `model.ScopedLogQuery.ProjectIdFilter` 类型不同，需要适配。

- [ ] **Step 5: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go build ./model/... ./controller/... ./service/...
```

- [ ] **Step 6: Commit**

```bash
git add controller/scoped_usage.go controller/scoped_log.go
git commit -m "feat(scoped): wire LogFilter through all scoped query callers"
```

---

### Task 5: 构建部署验证

**Files:**
- `docker-compose.local.yml`

- [ ] **Step 1: 本地 Docker 构建**

```bash
docker compose -f d:\tecx\text\docker-compose.local.yml build sora-new-api
```

- [ ] **Step 2: 重启容器**

```bash
docker compose -f d:\tecx\text\docker-compose.local.yml up -d sora-new-api
```

- [ ] **Step 3: 验证制作人项目报表**

1. 打开 `http://localhost:3000/console/reports`
2. 切换到制作人 zuozuoliangOOO 的用量报表
3. 移除一个成员
4. 刷新 — 消耗金额应保持不变（不因移除而清零）

- [ ] **Step 4: 验证各层级报表**

| 层级 | 操作 | 预期 |
|------|------|------|
| 公司 | 查看总消耗 | 数据完整 |
| 工作室 | 停用后查看 | 消耗不丢失 |
| 项目 | 移除成员后 | 消耗保留 |
| 制作人 | 移除成员后 | 消耗保留 |
| 制作人项目 | 移除成员后 | 消耗保留 |

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "deploy: scope direct log queries - all hierarchy levels verified"
```
