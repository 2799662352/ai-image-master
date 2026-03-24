# Producer 组织架构改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 New API 现有组织树（COMPANY→STUDIO→PROJECT）中新增 PRODUCER 层级，采用纯加法、双轨并行策略，零破坏性变更。

**Architecture:** PRODUCER 复用 Organization 模型，挂载在 STUDIO 下。ProducerProject 为纯标签表（无 Budget），统计走 Log 聚合。资金流复用 AllocateOrgToOrg，新增 AllocateProducerToPersonal。BFF 层新增代理路由，前端新增独立 producerStore。

**Tech Stack:** Go 1.21+ / Gin / GORM (PostgreSQL/MySQL/SQLite) / Node.js Express / Prisma 7 / React + Zustand

**Spec:** `docs/superpowers/specs/2026-03-23-producer-org-restructure-design.md`

---

## File Structure

### New API (Go) — 新增/修改

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `constant/org.go` | 追加 `OrgLevelProducer` 常量 |
| 修改 | `model/organization.go` | Organization struct 追加 `ProducerType` 字段；`CreateOrganization` 扩展 |
| 新建 | `model/producer_project.go` | ProducerProject + ProducerProjectMember 模型及 CRUD |
| 修改 | `model/personal_allocation.go` | 追加 `ProducerId`、`ProducerProjectId` 字段及新查询函数 |
| 修改 | `model/log.go` | Log struct 追加字段；RecordConsumeLogParams 追加字段；RecordConsumeLog 赋值 |
| 修改 | `model/main.go` | migrateDB / migrateDBFast 注册新模型 |
| 修改 | `service/allocation.go` | 新增 `AllocateProducerToPersonal`、`ReclaimProducerToPersonal`、`createNewApiUserForProducer` |
| 修改 | `controller/internal.go` | 新增 4 个 handler + 扩展 2 个 handler |
| 修改 | `router/org-router.go` | 注册新 Internal API 路由 |

### sora-ui-backend (Node.js) — 代理层

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/services/newApiService.ts` | 新增制作人相关 API 方法 |
| 修改 | `src/routes/userOrg.ts` | 新增制作人相关路由 |

---

## Task 1: 追加 OrgLevelProducer 常量

**Files:**
- Modify: `new-api/constant/org.go:3-7`

- [ ] **Step 1: 追加常量**

在 `OrgLevelProject` 下方追加：

```go
OrgLevelProducer = "PRODUCER"
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过，无错误

- [ ] **Step 3: Commit**

```bash
git add constant/org.go
git commit -m "feat(org): add OrgLevelProducer constant"
```

---

## Task 2: Organization struct 追加 ProducerType 字段

**Files:**
- Modify: `new-api/model/organization.go:11-29`

- [ ] **Step 1: 追加字段**

在 `Organization` struct 的 `IsActive` 字段后、`CreatedAt` 字段前追加：

```go
ProducerType *string `json:"producer_type" gorm:"type:varchar(20)"`
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add model/organization.go
git commit -m "feat(org): add ProducerType nullable field to Organization"
```

---

## Task 3: CreateOrganization 扩展支持 PRODUCER

**Files:**
- Modify: `new-api/model/organization.go:45-51`

- [ ] **Step 1: 修改 CreateOrganization 函数**

将现有的：

```go
func CreateOrganization(org *Organization) error {
	if org.Level == constant.OrgLevelStudio {
		code := GenerateInviteCode()
		org.InviteCode = &code
	}
	return DB.Create(org).Error
}
```

改为：

```go
func CreateOrganization(org *Organization) error {
	if org.Level == constant.OrgLevelStudio || org.Level == constant.OrgLevelProducer {
		code := GenerateInviteCode()
		org.InviteCode = &code
	}
	return DB.Create(org).Error
}
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add model/organization.go
git commit -m "feat(org): generate InviteCode for PRODUCER level"
```

---

## Task 4: 创建 ProducerProject + ProducerProjectMember 模型

**Files:**
- Create: `new-api/model/producer_project.go`

- [ ] **Step 1: 创建模型文件**

```go
package model

import "time"

type ProducerProject struct {
	Id         int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	ProducerId int64     `json:"producer_id" gorm:"not null;index"`
	Name       string    `json:"name" gorm:"type:varchar(100);not null"`
	IsActive   bool      `json:"is_active" gorm:"default:true"`
	CreatedAt  time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt  time.Time `json:"updated_at" gorm:"autoUpdateTime"`

	Producer *Organization `json:"producer,omitempty" gorm:"foreignKey:ProducerId"`
}

func (ProducerProject) TableName() string {
	return "producer_project"
}

type ProducerProjectMember struct {
	Id                int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	ProducerProjectId int64     `json:"producer_project_id" gorm:"not null;uniqueIndex:idx_ppm_project_user"`
	PlatformUserId    string    `json:"platform_user_id" gorm:"type:varchar(100);not null;uniqueIndex:idx_ppm_project_user"`
	CreatedAt         time.Time `json:"created_at" gorm:"autoCreateTime"`
}

func (ProducerProjectMember) TableName() string {
	return "producer_project_member"
}

func CreateProducerProject(pp *ProducerProject) error {
	return DB.Create(pp).Error
}

func GetProducerProjectById(id int64) (*ProducerProject, error) {
	var pp ProducerProject
	err := DB.First(&pp, id).Error
	return &pp, err
}

func GetProducerProjectsByProducerId(producerId int64) ([]ProducerProject, error) {
	var projects []ProducerProject
	err := DB.Where("producer_id = ? AND is_active = ?", producerId, true).
		Order("created_at ASC").Find(&projects).Error
	return projects, err
}

func UpdateProducerProject(id int64, updates map[string]interface{}) error {
	return DB.Model(&ProducerProject{}).Where("id = ?", id).Updates(updates).Error
}

func DeactivateProducerProject(id int64) error {
	return DB.Model(&ProducerProject{}).Where("id = ?", id).
		Update("is_active", false).Error
}

func CreateProducerProjectMember(m *ProducerProjectMember) error {
	return DB.Create(m).Error
}

func GetProducerProjectMembers(projectId int64) ([]ProducerProjectMember, error) {
	var members []ProducerProjectMember
	err := DB.Where("producer_project_id = ?", projectId).
		Order("created_at ASC").Find(&members).Error
	return members, err
}

func DeleteProducerProjectMember(projectId int64, platformUserId string) error {
	return DB.Where("producer_project_id = ? AND platform_user_id = ?",
		projectId, platformUserId).Delete(&ProducerProjectMember{}).Error
}

func GetProducerProjectsByUser(platformUserId string) ([]ProducerProject, error) {
	var memberLinks []ProducerProjectMember
	if err := DB.Where("platform_user_id = ?", platformUserId).Find(&memberLinks).Error; err != nil {
		return nil, err
	}
	if len(memberLinks) == 0 {
		return []ProducerProject{}, nil
	}
	ids := make([]int64, len(memberLinks))
	for i, m := range memberLinks {
		ids[i] = m.ProducerProjectId
	}
	var projects []ProducerProject
	err := DB.Where("id IN ? AND is_active = ?", ids, true).Find(&projects).Error
	return projects, err
}
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add model/producer_project.go
git commit -m "feat(model): add ProducerProject and ProducerProjectMember models"
```

---

## Task 5: PersonalAllocation 追加 Producer 字段 + 修复唯一索引

**Files:**
- Modify: `new-api/model/personal_allocation.go:9-19`
- Modify: `new-api/model/main.go` (migrateDB, 追加索引迁移)

- [ ] **Step 1: 追加字段并扩展唯一索引**

在 `PersonalAllocation` struct 的 `IsActive` 字段前追加两个 nullable 字段：

```go
ProducerId        *int64 `json:"producer_id" gorm:"index;uniqueIndex:idx_pa_user_producer"`
ProducerProjectId *int64 `json:"producer_project_id" gorm:"index"`
```

> **关键**：现有 `idx_pa_user_project` 唯一索引 `(platform_user_id, project_id)` 会导致所有制作人分配记录的 `ProjectId=0` 冲突。新增 `idx_pa_user_producer` 唯一索引 `(platform_user_id, producer_id)` 用于制作人分配去重。由于 `ProducerId` 是 `*int64`（nullable），旧记录中 `ProducerId=NULL` 在所有三个数据库中不违反唯一约束。

- [ ] **Step 1.5: migrateDB 中追加索引迁移逻辑**

在 `model/main.go` 的 `migrateDB()` 函数中，`AutoMigrate` 调用**之前**，追加：

```go
if DB.Migrator().HasIndex(&PersonalAllocation{}, "idx_pa_user_project") {
	DB.Migrator().DropIndex(&PersonalAllocation{}, "idx_pa_user_project")
}
```

然后在 `PersonalAllocation` struct 中修改 `ProjectId` 字段的 GORM tag，去掉 `uniqueIndex:idx_pa_user_project`，改为只保留普通索引：

原来：
```go
PlatformUserId string `json:"platform_user_id" gorm:"type:varchar(100);not null;index;uniqueIndex:idx_pa_user_project"`
ProjectId      int64  `json:"project_id" gorm:"not null;index;uniqueIndex:idx_pa_user_project"`
```

改为：
```go
PlatformUserId string `json:"platform_user_id" gorm:"type:varchar(100);not null;index"`
ProjectId      int64  `json:"project_id" gorm:"not null;index"`
```

> **原因**：制作人分配记录中 `ProjectId=0`，多条记录会冲突。去掉旧唯一索引后，通过 `idx_pa_user_producer` 和应用层逻辑保证去重。旧链路的去重由 `GetPersonalAllocation` 查询保证（先查再创建），与 `InternalJoinProject` 中已有的幂等检查一致。

- [ ] **Step 2: 新增查询函数**

在文件末尾追加：

```go
func GetPersonalAllocationByProducer(platformUserId string, producerId int64) (*PersonalAllocation, error) {
	var alloc PersonalAllocation
	err := DB.Where("platform_user_id = ? AND producer_id = ? AND is_active = ?",
		platformUserId, producerId, true).First(&alloc).Error
	if err != nil {
		return nil, err
	}
	return &alloc, nil
}

func GetPersonalAllocationByProducerIncludingInactive(platformUserId string, producerId int64) (*PersonalAllocation, error) {
	var alloc PersonalAllocation
	err := DB.Where("platform_user_id = ? AND producer_id = ?",
		platformUserId, producerId).First(&alloc).Error
	if err != nil {
		return nil, err
	}
	return &alloc, nil
}

func GetPersonalAllocationsByProducer(producerId int64) ([]PersonalAllocation, error) {
	var allocs []PersonalAllocation
	err := DB.Where("producer_id = ? AND is_active = ?", producerId, true).
		Find(&allocs).Error
	return allocs, err
}
```

- [ ] **Step 3: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add model/personal_allocation.go
git commit -m "feat(model): add ProducerId/ProducerProjectId to PersonalAllocation"
```

---

## Task 6: Log struct 追加 Producer 字段

**Files:**
- Modify: `new-api/model/log.go:20-47` (Log struct)
- Modify: `new-api/model/log.go:149-168` (RecordConsumeLogParams)
- Modify: `new-api/model/log.go:170-250` (RecordConsumeLog)

- [ ] **Step 1: Log struct 追加字段**

在 Log struct 的 `SettleStatus` 字段（第 46 行）后追加：

```go
ProducerId        int64 `json:"producer_id" gorm:"default:0;index;index:idx_log_producer,priority:1"`
ProducerProjectId int64 `json:"producer_project_id" gorm:"default:0;index:idx_log_producer,priority:2"`
```

- [ ] **Step 2: RecordConsumeLogParams 追加字段**

在 `RecordConsumeLogParams` struct 的 `SettleStatus` 字段后追加：

```go
ProducerId        int64  `json:"producer_id"`
ProducerProjectId int64  `json:"producer_project_id"`
```

- [ ] **Step 3: RecordConsumeLog 赋值逻辑**

在 `RecordConsumeLog` 函数中，`params.PlatformUserId` 从 header 读取的逻辑块后（约第 196 行后），追加 ProducerId/ProducerProjectId 的 header 读取：

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

在创建 Log 对象时（约第 208-238 行的 `log := &Log{...}`），追加字段赋值：

```go
ProducerId:        params.ProducerId,
ProducerProjectId: params.ProducerProjectId,
```

- [ ] **Step 4: RecordTaskBillingLog 同步**

在 `RecordTaskBillingLogParams` struct 末尾追加：

```go
ProducerId        int64
ProducerProjectId int64
```

在 `RecordTaskBillingLog` 函数中 `log := &Log{...}` 末尾追加：

```go
ProducerId:        params.ProducerId,
ProducerProjectId: params.ProducerProjectId,
```

- [ ] **Step 5: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add model/log.go
git commit -m "feat(model): add ProducerId/ProducerProjectId to Log with composite index"
```

---

## Task 7: migrateDB 注册新模型

**Files:**
- Modify: `new-api/model/main.go:258-291` (migrateDB)
- Modify: `new-api/model/main.go:307-347` (migrateDBFast)

- [ ] **Step 1: migrateDB 追加新模型**

在 `migrateDB()` 函数的 `DB.AutoMigrate(...)` 调用中，在 `&OrgNotification{}` 后追加：

```go
&ProducerProject{},
&ProducerProjectMember{},
```

- [ ] **Step 2: migrateDBFast 追加新模型**

在 `migrateDBFast()` 函数的 `migrations` slice 中，在 `{&OrgNotification{}, "OrgNotification"}` 后追加：

```go
{&ProducerProject{}, "ProducerProject"},
{&ProducerProjectMember{}, "ProducerProjectMember"},
```

- [ ] **Step 3: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 4: Commit**

```bash
git add model/main.go
git commit -m "feat(migrate): register ProducerProject models in AutoMigrate"
```

---

## Task 8: Phase 1 集成验证

- [ ] **Step 1: 完整编译**

Run: `cd new-api && go build -o new-api-test ./...`
Expected: 编译通过，产出二进制文件

- [ ] **Step 2: Docker 构建验证**

Run: `cd .. && docker compose -f docker-compose.local.yml build sora-new-api`
Expected: 镜像构建成功

- [ ] **Step 3: 启动验证 AutoMigrate**

Run: `docker compose -f docker-compose.local.yml up -d sora-new-api`
Expected: 日志中出现 "database migrated"，无 AutoMigrate 错误。新表 `producer_project`、`producer_project_member` 已创建。`organization` 表新增 `producer_type` 列。`personal_allocation` 表新增 `producer_id`、`producer_project_id` 列。`logs` 表新增 `producer_id`、`producer_project_id` 列。

- [ ] **Step 4: 确认旧功能不受影响**

Run:
```bash
curl -s http://localhost:3000/api/internal/user-orgs?platform_user_id=test -H "X-Internal-Key: sk-internal-2024-secret"
```
Expected: 返回 JSON，与改动前格式一致

---

## Task 9: AllocateProducerToPersonal 服务函数

**Files:**
- Modify: `new-api/service/allocation.go`

- [ ] **Step 1: 新增 createNewApiUserForProducer 函数**

在 `createNewApiUserForAllocation` 函数后追加。此函数复用大部分逻辑，但 `ProjectId` 设为 0，`ProducerId` 设为实际值，用于制作人级别的个人分配：

```go
func createNewApiUserForProducer(tx *gorm.DB, platformUserId string, producerId int64, producerProjectId *int64) (*model.PersonalAllocation, error) {
	chain, err := model.GetAncestorChain(producerId)
	if err != nil {
		return nil, err
	}
	group := "default"
	for _, org := range chain {
		if org.Level == constant.OrgLevelCompany && org.NewapiGroup != "" {
			group = org.NewapiGroup
			break
		}
	}

	if err := model.EnsureGroupInAllChannels(group); err != nil {
		common.SysLog(fmt.Sprintf("EnsureGroupInAllChannels(%s) failed: %v", group, err))
	}

	uidShort := platformUserId
	if len(uidShort) > 8 {
		uidShort = uidShort[:8]
	}
	username := fmt.Sprintf("pp_%s_%d", uidShort, producerId)
	if len(username) > 20 {
		username = username[:20]
	}

	password := fmt.Sprintf("auto_%s", model.GenerateInviteCode())
	newUser := model.User{
		Username:    username,
		Password:    password,
		DisplayName: username,
		Role:        1,
		Status:      1,
		Group:       group,
		AffCode:     common.GetRandomString(8),
	}
	if err := tx.Create(&newUser).Error; err != nil {
		return nil, fmt.Errorf("创建 New API 用户失败: %w", err)
	}

	tokenSuffix := fmt.Sprintf("pp%s%d%s", uidShort, producerId, model.GenerateInviteCode())
	if len(tokenSuffix) > 45 {
		tokenSuffix = tokenSuffix[:45]
	}

	token := model.Token{
		UserId:         newUser.Id,
		Key:            tokenSuffix,
		Name:           fmt.Sprintf("制作人配额-%d", producerId),
		Status:         1,
		UnlimitedQuota: true,
		CreatedTime:    time.Now().Unix(),
		ExpiredTime:    -1,
	}
	if err := tx.Create(&token).Error; err != nil {
		return nil, fmt.Errorf("创建 Token 失败: %w", err)
	}

	pid := producerId
	alloc := &model.PersonalAllocation{
		PlatformUserId:    platformUserId,
		ProjectId:         0,
		ProducerId:        &pid,
		ProducerProjectId: producerProjectId,
		NewapiUserId:      newUser.Id,
		NewapiTokenKey:    "sk-" + tokenSuffix,
		IsActive:          true,
	}
	if err := tx.Create(alloc).Error; err != nil {
		return nil, fmt.Errorf("创建配额记录失败: %w", err)
	}

	return alloc, nil
}
```

- [ ] **Step 2: 新增 AllocateProducerToPersonal 函数（含重新激活逻辑）**

```go
func AllocateProducerToPersonal(producerId int64, platformUserId string, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("分配金额必须大于 0")
	}

	producer, err := model.GetOrganizationById(producerId)
	if err != nil {
		return fmt.Errorf("制作人不存在: %w", err)
	}
	if !producer.IsActive {
		return errors.New("制作人已停用，无法分配个人余额")
	}
	if producer.Level != constant.OrgLevelProducer {
		return errors.New("只能从制作人级别向个人分配")
	}
	if producer.Balance < amountQuota {
		return fmt.Errorf("制作人余额不足")
	}

	alloc, err := model.GetPersonalAllocationByProducer(platformUserId, producerId)
	notFound := errors.Is(err, gorm.ErrRecordNotFound)
	if err != nil && !notFound {
		return err
	}

	return model.DB.Transaction(func(tx *gorm.DB) error {
		if notFound {
			inactive, inactiveErr := model.GetPersonalAllocationByProducerIncludingInactive(
				platformUserId, producerId)
			if inactiveErr == nil && inactive != nil && !inactive.IsActive {
				if reactivateErr := model.ReactivatePersonalAllocation(inactive.Id); reactivateErr != nil {
					return fmt.Errorf("重新激活个人配额失败: %w", reactivateErr)
				}
				alloc = inactive
			} else {
				newAlloc, createErr := createNewApiUserForProducer(tx, platformUserId, producerId, nil)
				if createErr != nil {
					return fmt.Errorf("创建个人配额失败: %w", createErr)
				}
				alloc = newAlloc
			}
		}

		result := tx.Model(&model.Organization{}).
			Where("id = ? AND balance >= ?", producerId, amountQuota).
			Update("balance", gorm.Expr("balance - ?", amountQuota))
		if result.RowsAffected == 0 {
			return errors.New("制作人余额不足或并发冲突")
		}

		result = tx.Model(&model.User{}).
			Where("id = ?", alloc.NewapiUserId).
			Update("quota", gorm.Expr("quota + ?", int(amountQuota)))
		if result.Error != nil {
			return result.Error
		}

		txn := model.BalanceTransaction{
			Type:             constant.TxnTypeAllocate,
			FromOrgId:        &producerId,
			ToPlatformUserId: platformUserId,
			AmountQuota:      amountQuota,
			AmountYuan:       amountYuan,
			OperatorId:       operatorId,
			Status:           "SUCCESS",
		}
		return tx.Create(&txn).Error
	})
}
```

- [ ] **Step 3: 新增 ReclaimProducerToPersonal 函数**

```go
func ReclaimProducerToPersonal(producerId int64, platformUserId string, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("回收金额必须大于 0")
	}

	alloc, err := model.GetPersonalAllocationByProducer(platformUserId, producerId)
	if err != nil {
		return fmt.Errorf("个人配额不存在: %w", err)
	}

	return model.DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.User{}).
			Where("id = ? AND quota >= ?", alloc.NewapiUserId, int(amountQuota)).
			Update("quota", gorm.Expr("quota - ?", int(amountQuota)))
		if result.RowsAffected == 0 {
			return errors.New("个人余额不足")
		}

		tx.Model(&model.Organization{}).
			Where("id = ?", producerId).
			Update("balance", gorm.Expr("balance + ?", amountQuota))

		txn := model.BalanceTransaction{
			Type:             constant.TxnTypeReclaim,
			ToOrgId:          &producerId,
			ToPlatformUserId: platformUserId,
			AmountQuota:      amountQuota,
			AmountYuan:       amountYuan,
			OperatorId:       operatorId,
			Status:           "SUCCESS",
		}
		return tx.Create(&txn).Error
	})
}
```

- [ ] **Step 4: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add service/allocation.go
git commit -m "feat(service): add AllocateProducerToPersonal and ReclaimProducerToPersonal"
```

---

## Task 10: Internal Controller — 新增 4 个 handler

**Files:**
- Modify: `new-api/controller/internal.go`

- [ ] **Step 1: 新增 InternalJoinProducer**

在文件末尾（`InternalGetUsageSummary` 后）追加：

```go
func InternalJoinProducer(c *gin.Context) {
	var req struct {
		PlatformUserId string `json:"platform_user_id" binding:"required"`
		Username       string `json:"username"`
		DisplayName    string `json:"display_name"`
		Phone          string `json:"phone"`
		ProducerId     int64  `json:"producer_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	producer, err := model.GetOrganizationById(req.ProducerId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "制作人不存在"})
		return
	}
	if producer.Level != constant.OrgLevelProducer {
		c.JSON(http.StatusBadRequest, gin.H{"error": "只能加入制作人级别的组织"})
		return
	}
	if !producer.IsActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "制作人已停用"})
		return
	}

	member := model.OrgMember{
		OrgId:          req.ProducerId,
		PlatformUserId: req.PlatformUserId,
		Username:       req.Username,
		DisplayName:    req.DisplayName,
		Phone:          req.Phone,
		Role:           constant.OrgRoleMember,
	}
	if err := model.CreateOrgMember(&member); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "已经是该制作人成员"})
		return
	}

	if producer.ParentId != nil {
		studioId := *producer.ParentId
		_, studioErr := model.GetOrgMember(studioId, req.PlatformUserId)
		if studioErr != nil {
			studioMember := model.OrgMember{
				OrgId:          studioId,
				PlatformUserId: req.PlatformUserId,
				Username:       req.Username,
				DisplayName:    req.DisplayName,
				Phone:          req.Phone,
				Role:           constant.OrgRoleMember,
			}
			model.CreateOrgMember(&studioMember)
		}
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "producer_name": producer.Name})
}
```

- [ ] **Step 2: 新增 InternalGetUserProducers**

```go
func InternalGetUserProducers(c *gin.Context) {
	platformUserId := c.Query("platform_user_id")
	if platformUserId == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing platform_user_id"})
		return
	}

	members, err := model.GetOrgsByPlatformUserId(platformUserId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type ProducerInfo struct {
		ProducerId   int64  `json:"producer_id"`
		ProducerName string `json:"producer_name"`
		ProducerType string `json:"producer_type"`
		StudioId     int64  `json:"studio_id"`
		StudioName   string `json:"studio_name"`
		BalanceYuan  float64 `json:"balance_yuan"`
		Role         string `json:"role"`
	}

	var producers []ProducerInfo
	for _, m := range members {
		if m.Organization == nil || m.Organization.Level != constant.OrgLevelProducer {
			continue
		}
		pi := ProducerInfo{
			ProducerId:   m.OrgId,
			ProducerName: m.Organization.Name,
			BalanceYuan:  service.QuotaToYuan(m.Organization.Balance),
			Role:         m.Role,
		}
		if m.Organization.ProducerType != nil {
			pi.ProducerType = *m.Organization.ProducerType
		}
		if m.Organization.ParentId != nil {
			pi.StudioId = *m.Organization.ParentId
			if studio, err := model.GetOrganizationById(*m.Organization.ParentId); err == nil {
				pi.StudioName = studio.Name
			}
		}
		producers = append(producers, pi)
	}

	type ProjectTag struct {
		Id         int64  `json:"id"`
		Name       string `json:"name"`
		ProducerId int64  `json:"producer_id"`
	}

	projectTags, _ := model.GetProducerProjectsByUser(platformUserId)
	var tags []ProjectTag
	for _, pp := range projectTags {
		tags = append(tags, ProjectTag{
			Id:         pp.Id,
			Name:       pp.Name,
			ProducerId: pp.ProducerId,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"producers":    producers,
		"project_tags": tags,
	})
}
```

- [ ] **Step 3: 新增 InternalGetProducerBalance**

```go
func InternalGetProducerBalance(c *gin.Context) {
	platformUserId := c.Query("platform_user_id")
	producerId, _ := strconv.ParseInt(c.Query("producer_id"), 10, 64)

	if platformUserId == "" || producerId == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing platform_user_id or producer_id"})
		return
	}

	alloc, err := model.GetPersonalAllocationByProducer(platformUserId, producerId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no allocation"})
		return
	}

	var user model.User
	model.DB.Select("quota").First(&user, alloc.NewapiUserId)

	c.JSON(http.StatusOK, gin.H{
		"balance_quota": user.Quota,
		"balance_yuan":  service.QuotaToYuan(int64(user.Quota)),
	})
}
```

- [ ] **Step 4: 新增 InternalJoinProducerProject**

```go
func InternalJoinProducerProject(c *gin.Context) {
	var req struct {
		PlatformUserId    string `json:"platform_user_id" binding:"required"`
		ProducerProjectId int64  `json:"producer_project_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pp, err := model.GetProducerProjectById(req.ProducerProjectId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目标签不存在"})
		return
	}
	if !pp.IsActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "项目标签已停用"})
		return
	}

	_, err = model.GetOrgMember(pp.ProducerId, req.PlatformUserId)
	if err != nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "请先加入该制作人"})
		return
	}

	member := model.ProducerProjectMember{
		ProducerProjectId: req.ProducerProjectId,
		PlatformUserId:    req.PlatformUserId,
	}
	if err := model.CreateProducerProjectMember(&member); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "已经加入该项目标签"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "project_name": pp.Name})
}
```

- [ ] **Step 5: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add controller/internal.go
git commit -m "feat(controller): add producer internal API handlers"
```

---

## Task 11: 扩展 InternalVerifyInviteCode + InternalJoinByInvite 支持 PRODUCER

**Files:**
- Modify: `new-api/controller/internal.go:145-196` (InternalVerifyInviteCode)
- Modify: `new-api/controller/internal.go:198-240` (InternalJoinByInvite)

- [ ] **Step 0: 修改 InternalVerifyInviteCode**

将 `InternalVerifyInviteCode`（第 164 行）中的检查逻辑：

```go
if org.Level != constant.OrgLevelStudio {
	c.JSON(http.StatusBadRequest, gin.H{"error": "邀请码只能对应工作室"})
	return
}
```

替换为：
```go
if org.Level != constant.OrgLevelStudio && org.Level != constant.OrgLevelProducer {
	c.JSON(http.StatusBadRequest, gin.H{"error": "邀请码只能对应工作室或制作人"})
	return
}
```

- [ ] **Step 1: 修改 InternalJoinByInvite**

将 `InternalJoinByInvite` 中的检查逻辑从只支持 STUDIO 改为同时支持 PRODUCER：

将：
```go
if org.Level != constant.OrgLevelStudio {
	c.JSON(http.StatusBadRequest, gin.H{"error": "邀请码只能对应工作室级别的组织"})
	return
}
```

替换为：
```go
if org.Level != constant.OrgLevelStudio && org.Level != constant.OrgLevelProducer {
	c.JSON(http.StatusBadRequest, gin.H{"error": "邀请码只能对应工作室或制作人级别的组织"})
	return
}
```

在 `model.CreateOrgMember(&member)` 成功后、返回响应前，追加 PRODUCER 自动加入 STUDIO 的逻辑：

```go
if org.Level == constant.OrgLevelProducer && org.ParentId != nil {
	studioId := *org.ParentId
	_, studioErr := model.GetOrgMember(studioId, req.PlatformUserId)
	if studioErr != nil {
		studioMember := model.OrgMember{
			OrgId:          studioId,
			PlatformUserId: req.PlatformUserId,
			Username:       req.Username,
			DisplayName:    req.DisplayName,
			Phone:          req.Phone,
			Role:           constant.OrgRoleMember,
		}
		model.CreateOrgMember(&studioMember)
	}
}
```

修改返回的成功响应以反映加入的组织类型：

```go
c.JSON(http.StatusOK, gin.H{
	"success":    true,
	"org_name":   org.Name,
	"org_level":  org.Level,
	"studio_name": func() string {
		if org.Level == constant.OrgLevelStudio {
			return org.Name
		}
		return ""
	}(),
})
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add controller/internal.go
git commit -m "feat(controller): extend InternalJoinByInvite to support PRODUCER invite codes"
```

---

## Task 12: 扩展 InternalGetUserOrgs 返回 PRODUCER

**Files:**
- Modify: `new-api/controller/internal.go:45-124`

- [ ] **Step 1: 修改 InternalGetUserOrgs**

在现有的 `projects` 遍历逻辑后（约第 118 行 `}`后），追加 producers 返回：

```go
type ProducerInfo struct {
	ProducerId   int64   `json:"producer_id"`
	ProducerName string  `json:"producer_name"`
	StudioId     int64   `json:"studio_id"`
	StudioName   string  `json:"studio_name"`
	BalanceYuan  float64 `json:"balance_yuan"`
}
var producerList []ProducerInfo
for _, m := range members {
	if m.Organization == nil || m.Organization.Level != constant.OrgLevelProducer {
		continue
	}
	pi := ProducerInfo{
		ProducerId:   m.OrgId,
		ProducerName: m.Organization.Name,
	}
	if m.Organization.ParentId != nil {
		pi.StudioId = *m.Organization.ParentId
		if studio, err := model.GetOrganizationById(*m.Organization.ParentId); err == nil {
			pi.StudioName = studio.Name
		}
	}
	alloc, allocErr := model.GetPersonalAllocationByProducer(platformUserId, m.OrgId)
	if allocErr == nil && alloc != nil {
		var user model.User
		model.DB.Select("quota").First(&user, alloc.NewapiUserId)
		pi.BalanceYuan = service.QuotaToYuan(int64(user.Quota))
	}
	producerList = append(producerList, pi)
}
```

在返回的 JSON 中追加 `"producers"` 字段：

```go
c.JSON(http.StatusOK, gin.H{
	"organizations": result,
	"projects":      projects,
	"producers":     producerList,
})
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add controller/internal.go
git commit -m "feat(controller): extend InternalGetUserOrgs to return producers"
```

---

## Task 13: 注册新路由

**Files:**
- Modify: `new-api/router/org-router.go:96-111`

- [ ] **Step 1: 追加 4 个新 Internal 路由**

在 `internalApi` group 的最后一行（`internalApi.GET("/member-profile", ...)`）后追加：

```go
internalApi.POST("/join-producer", controller.InternalJoinProducer)
internalApi.GET("/user-producers", controller.InternalGetUserProducers)
internalApi.GET("/producer-balance", controller.InternalGetProducerBalance)
internalApi.POST("/join-producer-project", controller.InternalJoinProducerProject)
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add router/org-router.go
git commit -m "feat(router): register producer internal API routes"
```

---

## Task 14: Phase 2 集成验证

- [ ] **Step 1: Docker 构建 + 启动**

Run:
```bash
docker compose -f docker-compose.local.yml up -d --build sora-new-api
```
Expected: 构建成功，启动无错误

- [ ] **Step 2: curl 测试新端点**

```bash
# 测试 join-producer（预期成功或 404 "制作人不存在"）
curl -s -X POST http://localhost:3000/api/internal/join-producer \
  -H "X-Internal-Key: sk-internal-2024-secret" \
  -H "Content-Type: application/json" \
  -d '{"platform_user_id":"test","producer_id":999}'

# 测试 user-producers
curl -s http://localhost:3000/api/internal/user-producers?platform_user_id=test \
  -H "X-Internal-Key: sk-internal-2024-secret"

# 测试 producer-balance
curl -s http://localhost:3000/api/internal/producer-balance?platform_user_id=test\&producer_id=1 \
  -H "X-Internal-Key: sk-internal-2024-secret"
```

- [ ] **Step 3: 确认旧端点不受影响**

```bash
curl -s http://localhost:3000/api/internal/user-orgs?platform_user_id=test \
  -H "X-Internal-Key: sk-internal-2024-secret"

curl -s -X POST http://localhost:3000/api/internal/join-project \
  -H "X-Internal-Key: sk-internal-2024-secret" \
  -H "Content-Type: application/json" \
  -d '{"platform_user_id":"test","project_id":1}'
```
Expected: 返回格式与改动前一致

---

## Task 15: BFF 代理层 — newApiService 新增方法

**Files:**
- Modify: `sora-ui-backend/src/services/newApiService.ts`

- [ ] **Step 1: 新增 4 个制作人方法**

在 `getUsageSummary` 方法后追加：

```typescript
async joinProducer(platformUserId: string, producerId: number, username: string, displayName: string, phone: string) {
  const resp = await client.post('/api/internal/join-producer', {
    platform_user_id: platformUserId,
    producer_id: producerId,
    username,
    display_name: displayName,
    phone,
  });
  return resp.data;
},

async getUserProducers(platformUserId: string) {
  const resp = await client.get('/api/internal/user-producers', {
    params: { platform_user_id: platformUserId },
  });
  return resp.data;
},

async getProducerBalance(platformUserId: string, producerId: number) {
  const resp = await client.get('/api/internal/producer-balance', {
    params: { platform_user_id: platformUserId, producer_id: producerId },
  });
  return resp.data;
},

async joinProducerProject(platformUserId: string, producerProjectId: number) {
  const resp = await client.post('/api/internal/join-producer-project', {
    platform_user_id: platformUserId,
    producer_project_id: producerProjectId,
  });
  return resp.data;
},
```

- [ ] **Step 2: Commit**

```bash
git add src/services/newApiService.ts
git commit -m "feat(bff): add producer API methods to newApiService"
```

---

## Task 16: BFF 代理层 — userOrg 路由

**Files:**
- Modify: `sora-ui-backend/src/routes/userOrg.ts`

- [ ] **Step 1: 新增 4 个路由**

在 `usage-summary` 路由后、`export default router` 前追加：

```typescript
/**
 * GET /api/user/producers — 获取当前用户的制作人列表
 */
router.get('/producers', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const data = await newApiService.getUserProducers(user.userId);
    res.json({ success: true, data } as APIResponse);
  } catch (error: any) {
    console.error('[UserOrg] 获取制作人列表失败:', error.response?.data || error.message);
    res.status(error.response?.status || 502).json({
      success: false,
      message: '获取制作人列表失败',
    } as APIResponse);
  }
});

/**
 * GET /api/user/producer-balance?producerId=xxx — 获取用户在某制作人的余额
 */
router.get('/producer-balance', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const producerId = parseInt(req.query.producerId as string, 10);
    if (!producerId || isNaN(producerId)) {
      return res.status(400).json({
        success: false,
        message: 'producerId 参数必填且为数字',
      } as APIResponse);
    }
    const data = await newApiService.getProducerBalance(user.userId, producerId);
    res.json({ success: true, data } as APIResponse);
  } catch (error: any) {
    console.error('[UserOrg] 获取制作人余额失败:', error.response?.data || error.message);
    res.status(error.response?.status || 502).json({
      success: false,
      message: '获取制作人余额失败',
    } as APIResponse);
  }
});

/**
 * POST /api/user/join-producer — 用户加入制作人
 */
router.post('/join-producer', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { producerId } = req.body;
    if (!producerId) {
      return res.status(400).json({
        success: false,
        message: 'producerId 不能为空',
      } as APIResponse);
    }
    const { userRepository } = await import('../repositories/userRepository');
    const dbUser = await userRepository.findById(user.userId);
    const data = await newApiService.joinProducer(
      user.userId,
      producerId,
      dbUser?.username || '',
      (dbUser as any)?.displayName || '',
      dbUser?.phone || ''
    );
    res.json({ success: true, data } as APIResponse);
  } catch (error: any) {
    console.error('[UserOrg] 加入制作人失败:', error.response?.data || error.message);
    const status = error.response?.status || 502;
    res.status(status).json({
      success: false,
      message: error.response?.data?.error || '加入制作人失败',
    } as APIResponse);
  }
});

/**
 * POST /api/user/join-producer-project — 用户加入制作人项目标签
 */
router.post('/join-producer-project', authMiddleware, async (req, res) => {
  try {
    const user = (req as any).user;
    const { producerProjectId } = req.body;
    if (!producerProjectId) {
      return res.status(400).json({
        success: false,
        message: 'producerProjectId 不能为空',
      } as APIResponse);
    }
    const data = await newApiService.joinProducerProject(user.userId, producerProjectId);
    res.json({ success: true, data } as APIResponse);
  } catch (error: any) {
    console.error('[UserOrg] 加入项目标签失败:', error.response?.data || error.message);
    const status = error.response?.status || 502;
    res.status(status).json({
      success: false,
      message: error.response?.data?.error || '加入项目标签失败',
    } as APIResponse);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/routes/userOrg.ts
git commit -m "feat(bff): add producer routes to userOrg"
```

---

## Task 17: Phase 3 全链路联调

- [ ] **Step 1: Docker 构建**

```bash
docker compose -f docker-compose.local.yml up -d --build sora-new-api sora-backend
```

- [ ] **Step 2: BFF → New API 端点验证**

```bash
# 通过 BFF 调用制作人列表
curl -s http://localhost:8081/api/user/producers \
  -H "Authorization: Bearer <test-jwt>"

# 通过 BFF 调用制作人余额
curl -s "http://localhost:8081/api/user/producer-balance?producerId=1" \
  -H "Authorization: Bearer <test-jwt>"
```

- [ ] **Step 3: 确认旧路由正常**

```bash
curl -s http://localhost:8081/api/user/organizations \
  -H "Authorization: Bearer <test-jwt>"

curl -s "http://localhost:8081/api/user/balance?projectId=1" \
  -H "Authorization: Bearer <test-jwt>"
```

---

## 延迟实施项（Phase 4 或独立计划）

以下功能在核心 CRUD + 资金流完成后再实施，不阻塞 Phase 1-3：

| 功能 | 原因 |
|------|------|
| **统计 API**（`GET /api/org/:id/stats` 三级钻取） | 依赖 Log 表中有 `producer_id` 数据积累后才有意义，可在前端 Phase 4 同步实现 |
| **`Task.PrivateData`** 追加 `ProducerId`/`ProducerProjectId` | 需要修改 relay 层请求链路，与统计 API 一起实施 |
| **前端** producerStore + 管理页面 + 统计仪表板 | 依赖 Phase 3 完成 |

## 实施顺序总览

```
Task 1-7   → Phase 1: 模型层（编译+迁移验证）
Task 8     → Phase 1 集成验证
Task 9-13  → Phase 2: 业务层（Service + Controller + Router）
Task 14    → Phase 2 集成验证
Task 15-16 → Phase 3: BFF 代理层
Task 17    → Phase 3 全链路联调
延迟实施项 → 统计 API + Task.PrivateData + 前端
```

每个 Task 完成后立即 commit，确保增量可回溯。
