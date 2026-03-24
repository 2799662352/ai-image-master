# ProducerProject 预算池升级 — 增量实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ProducerProject 从纯标签升级为有预算池的项目，资金流改为 PRODUCER → ProducerProject → 个人，并支持 PRODUCER 停用时级联停用项目。

**Architecture:** ProducerProject 加 Balance 字段，新增两组资金划拨函数（PRODUCER↔ProducerProject、ProducerProject↔个人），修改现有 AllocateProducerToPersonal 改从 ProducerProject 扣费，扩展级联停用。管理后台组织树 PRODUCER 展开显示项目列表。

**Tech Stack:** Go 1.21+ / Gin / GORM (PostgreSQL) / Semi Design (JSX)

**Spec:** `docs/superpowers/specs/2026-03-23-producer-org-restructure-design.md` (v4)

**前置条件:** Phase 1-3 已实施完成（模型层 + 业务层 + BFF 层），本计划为增量升级。

---

## File Structure

### 需要修改的文件

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `new-api/model/producer_project.go` | ProducerProject 加 `Balance` 字段 |
| 修改 | `new-api/service/allocation.go` | 替换 `AllocateProducerToPersonal` → `AllocateProjectToPersonal`；新增 `AllocateProducerToProject` / `ReclaimProducerFromProject` / `ReclaimProjectToPersonal`；扩展级联停用 |
| 修改 | `new-api/controller/organization.go` | 新增 ProducerProject CRUD API（创建/列表/分配余额） |
| 修改 | `new-api/router/org-router.go` | 注册 ProducerProject 管理路由 |
| 修改 | `new-api/web/src/pages/OrgManagement/index.jsx` | PRODUCER 展开显示项目列表；项目余额管理 UI |

---

## Task 1: ProducerProject 模型加 Balance 字段

**Files:**
- Modify: `new-api/model/producer_project.go:5-14`

- [ ] **Step 1: 追加 Balance 字段**

在 `ProducerProject` struct 的 `Name` 字段后追加：

```go
Balance    int64     `json:"balance" gorm:"default:0"`
```

最终 struct 为：

```go
type ProducerProject struct {
	Id         int64     `json:"id" gorm:"primaryKey;autoIncrement"`
	ProducerId int64     `json:"producer_id" gorm:"not null;index"`
	Name       string    `json:"name" gorm:"type:varchar(100);not null"`
	Balance    int64     `json:"balance" gorm:"default:0"`
	IsActive   bool      `json:"is_active" gorm:"default:true"`
	CreatedAt  time.Time `json:"created_at" gorm:"autoCreateTime"`
	UpdatedAt  time.Time `json:"updated_at" gorm:"autoUpdateTime"`

	Producer *Organization `json:"producer,omitempty" gorm:"foreignKey:ProducerId"`
}
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./model/...`

- [ ] **Step 3: Commit**

```bash
git add model/producer_project.go
git commit -m "feat(model): add Balance field to ProducerProject"
```

---

## Task 2: 新增 AllocateProducerToProject / ReclaimProducerFromProject

**Files:**
- Modify: `new-api/service/allocation.go` (追加在文件末尾)

- [ ] **Step 1: 新增 AllocateProducerToProject**

```go
func AllocateProducerToProject(producerId int64, projectId int64, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("分配金额必须大于 0")
	}

	producer, err := model.GetOrganizationById(producerId)
	if err != nil {
		return fmt.Errorf("制作人不存在: %w", err)
	}
	if !producer.IsActive {
		return errors.New("制作人已停用")
	}
	if producer.Balance < amountQuota {
		return fmt.Errorf("制作人余额不足")
	}

	pp, err := model.GetProducerProjectById(projectId)
	if err != nil {
		return fmt.Errorf("项目不存在: %w", err)
	}
	if pp.ProducerId != producerId {
		return errors.New("项目不属于该制作人")
	}
	if !pp.IsActive {
		return errors.New("项目已停用")
	}

	return model.DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.Organization{}).
			Where("id = ? AND balance >= ?", producerId, amountQuota).
			Update("balance", gorm.Expr("balance - ?", amountQuota))
		if result.RowsAffected == 0 {
			return errors.New("制作人余额不足或并发冲突")
		}

		result = tx.Model(&model.ProducerProject{}).
			Where("id = ?", projectId).
			Update("balance", gorm.Expr("balance + ?", amountQuota))
		if result.Error != nil {
			return result.Error
		}

		txn := model.BalanceTransaction{
			Type:        constant.TxnTypeAllocate,
			FromOrgId:   &producerId,
			AmountQuota: amountQuota,
			AmountYuan:  amountYuan,
			OperatorId:  operatorId,
			Status:      "SUCCESS",
			Remark:      fmt.Sprintf("分配到项目: %s", pp.Name),
		}
		return tx.Create(&txn).Error
	})
}
```

- [ ] **Step 2: 新增 ReclaimProducerFromProject**

```go
func ReclaimProducerFromProject(producerId int64, projectId int64, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("回收金额必须大于 0")
	}

	pp, err := model.GetProducerProjectById(projectId)
	if err != nil {
		return fmt.Errorf("项目不存在: %w", err)
	}
	if pp.ProducerId != producerId {
		return errors.New("项目不属于该制作人")
	}
	if pp.Balance < amountQuota {
		return fmt.Errorf("项目余额不足")
	}

	return model.DB.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.ProducerProject{}).
			Where("id = ? AND balance >= ?", projectId, amountQuota).
			Update("balance", gorm.Expr("balance - ?", amountQuota))
		if result.RowsAffected == 0 {
			return errors.New("项目余额不足或并发冲突")
		}

		result = tx.Model(&model.Organization{}).
			Where("id = ?", producerId).
			Update("balance", gorm.Expr("balance + ?", amountQuota))
		if result.Error != nil {
			return result.Error
		}

		txn := model.BalanceTransaction{
			Type:        constant.TxnTypeReclaim,
			FromOrgId:   &producerId,
			AmountQuota: amountQuota,
			AmountYuan:  amountYuan,
			OperatorId:  operatorId,
			Status:      "SUCCESS",
			Remark:      fmt.Sprintf("从项目回收: %s", pp.Name),
		}
		return tx.Create(&txn).Error
	})
}
```

- [ ] **Step 3: 编译验证**

Run: `cd new-api && go build ./service/...`

- [ ] **Step 4: Commit**

```bash
git add service/allocation.go
git commit -m "feat(service): add AllocateProducerToProject and ReclaimProducerFromProject"
```

---

## Task 3: 修改 AllocateProducerToPersonal → AllocateProjectToPersonal

**Files:**
- Modify: `new-api/service/allocation.go:753-827`

- [ ] **Step 1: 重命名并修改资金来源**

将 `AllocateProducerToPersonal` 改为 `AllocateProjectToPersonal`，资金从 `ProducerProject.Balance` 扣而不是 `PRODUCER.Balance`。

**关键修复点**（Review C1: 重新激活时更新 ProducerProjectId）：

```go
func AllocateProjectToPersonal(producerProjectId int64, platformUserId string, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("分配金额必须大于 0")
	}

	pp, err := model.GetProducerProjectById(producerProjectId)
	if err != nil {
		return fmt.Errorf("项目不存在: %w", err)
	}
	if !pp.IsActive {
		return errors.New("项目已停用，无法分配个人余额")
	}
	if pp.Balance < amountQuota {
		return fmt.Errorf("项目余额不足")
	}

	producerId := pp.ProducerId

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
				if err := tx.Model(&model.PersonalAllocation{}).Where("id = ?", inactive.Id).
					Updates(map[string]interface{}{
						"is_active":           true,
						"producer_project_id": producerProjectId,
					}).Error; err != nil {
					return fmt.Errorf("重新激活个人配额失败: %w", err)
				}
				if err := tx.Model(&model.Token{}).Where("user_id = ?", inactive.NewapiUserId).
					Update("status", 1).Error; err != nil {
					return fmt.Errorf("重新激活 Token 失败: %w", err)
				}
				alloc = inactive
			} else {
				ppid := producerProjectId
				newAlloc, createErr := createNewApiUserForProducer(tx, platformUserId, producerId, &ppid)
				if createErr != nil {
					return fmt.Errorf("创建个人配额失败: %w", createErr)
				}
				alloc = newAlloc
			}
		}

		result := tx.Model(&model.ProducerProject{}).
			Where("id = ? AND balance >= ?", producerProjectId, amountQuota).
			Update("balance", gorm.Expr("balance - ?", amountQuota))
		if result.RowsAffected == 0 {
			return errors.New("项目余额不足或并发冲突")
		}

		result = tx.Model(&model.User{}).
			Where("id = ?", alloc.NewapiUserId).
			Update("quota", gorm.Expr("quota + ?", int(amountQuota)))
		if result.Error != nil {
			return result.Error
		}

		pid := producerId
		txn := model.BalanceTransaction{
			Type:             constant.TxnTypeAllocate,
			FromOrgId:        &pid,
			ToPlatformUserId: platformUserId,
			AmountQuota:      amountQuota,
			AmountYuan:       amountYuan,
			OperatorId:       operatorId,
			Status:           "SUCCESS",
			Remark:           fmt.Sprintf("项目分配: %s (ID:%d)", pp.Name, producerProjectId),
		}
		return tx.Create(&txn).Error
	})
}
```

- [ ] **Step 2: 同样修改 ReclaimProducerToPersonal → ReclaimProjectToPersonal**

将回收目标从 `PRODUCER.Balance` 改为 `ProducerProject.Balance`：

```go
func ReclaimProjectToPersonal(producerProjectId int64, platformUserId string, amountYuan float64, operatorId int) error {
	amountQuota := YuanToQuota(amountYuan)
	if amountQuota <= 0 {
		return errors.New("回收金额必须大于 0")
	}

	pp, err := model.GetProducerProjectById(producerProjectId)
	if err != nil {
		return fmt.Errorf("项目不存在: %w", err)
	}

	alloc, err := model.GetPersonalAllocationByProducer(platformUserId, pp.ProducerId)
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

		result = tx.Model(&model.ProducerProject{}).
			Where("id = ?", producerProjectId).
			Update("balance", gorm.Expr("balance + ?", amountQuota))
		if result.Error != nil {
			return result.Error
		}

		pid := pp.ProducerId
		txn := model.BalanceTransaction{
			Type:             constant.TxnTypeReclaim,
			ToOrgId:          &pid,
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

- [ ] **Step 3: 删除旧函数**

删除 `AllocateProducerToPersonal` 和 `ReclaimProducerToPersonal` 两个旧函数（已被新函数替代）。

- [ ] **Step 4: 编译验证**

Run: `cd new-api && go build ./...`
Expected: 如果有其他地方引用了旧函数名会编译失败 — 需要同步更新调用点。

- [ ] **Step 5: Commit**

```bash
git add service/allocation.go
git commit -m "feat(service): replace AllocateProducerToPersonal with AllocateProjectToPersonal"
```

---

## Task 4: 扩展 DeactivateOrganizationCascade 支持 PRODUCER 级联

**Files:**
- Modify: `new-api/service/allocation.go` (DeactivateOrganizationCascade 函数，约第 446-513 行)

- [ ] **Step 1: 在 PRODUCER 停用时级联停用 ProducerProject**

在 `DeactivateOrganizationCascade` 函数中，找到处理 `OrgLevelProject` 的分支（约第 465 行）：

```go
if org.Level == constant.OrgLevelProject {
	if err := deactivateProjectResources(org, operatorId); err != nil {
		return err
	}
}
```

在其后追加 PRODUCER 处理分支：

```go
if org.Level == constant.OrgLevelProducer {
	if err := deactivateProducerProjects(org, operatorId); err != nil {
		return err
	}
}
```

- [ ] **Step 2: 新增 deactivateProducerProjects 函数**

在 `deactivateProjectResources` 函数后追加：

**关键修复点**（Review Critical: 使用 SELECT FOR UPDATE 避免 TOCTOU 竞态）：

```go
func deactivateProducerProjects(producer *model.Organization, operatorId int) error {
	projects, err := model.GetProducerProjectsByProducerId(producer.Id)
	if err != nil {
		return fmt.Errorf("获取制作人项目失败: %w", err)
	}

	for _, pp := range projects {
		if txErr := model.DB.Transaction(func(tx *gorm.DB) error {
			var currentPP model.ProducerProject
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Select("id, balance").Where("id = ?", pp.Id).First(&currentPP).Error; err != nil {
				return err
			}

			if currentPP.Balance > 0 {
				if err := tx.Model(&model.ProducerProject{}).
					Where("id = ?", pp.Id).Update("balance", 0).Error; err != nil {
					return err
				}

				if err := tx.Model(&model.Organization{}).
					Where("id = ?", producer.Id).
					Update("balance", gorm.Expr("balance + ?", currentPP.Balance)).Error; err != nil {
					return err
				}

				pid := producer.Id
				txn := model.BalanceTransaction{
					Type:        constant.TxnTypeReclaim,
					FromOrgId:   &pid,
					AmountQuota: currentPP.Balance,
					AmountYuan:  QuotaToYuan(currentPP.Balance),
					OperatorId:  operatorId,
					Status:      "SUCCESS",
					Remark:      fmt.Sprintf("停用制作人回收项目余额: %s", pp.Name),
				}
				if err := tx.Create(&txn).Error; err != nil {
					return err
				}
			}

			return tx.Model(&model.ProducerProject{}).
				Where("id = ?", pp.Id).Update("is_active", false).Error
		}); txErr != nil {
			return fmt.Errorf("回收项目 %s 余额失败: %w", pp.Name, txErr)
		}
	}

	allocs, err := model.GetPersonalAllocationsByProducer(producer.Id)
	if err != nil {
		return fmt.Errorf("获取制作人个人配额失败: %w", err)
	}
	for _, alloc := range allocs {
		if txErr := model.DB.Transaction(func(tx *gorm.DB) error {
			var user model.User
			if err := tx.Select("id, quota").First(&user, alloc.NewapiUserId).Error; err != nil {
				return err
			}
			if user.Quota > 0 {
				if err := tx.Model(&model.User{}).Where("id = ?", alloc.NewapiUserId).
					Update("quota", 0).Error; err != nil {
					return err
				}
				if err := tx.Model(&model.Organization{}).Where("id = ?", producer.Id).
					Update("balance", gorm.Expr("balance + ?", int64(user.Quota))).Error; err != nil {
					return err
				}
			}
			if err := tx.Model(&model.Token{}).Where("user_id = ? AND status = ?", alloc.NewapiUserId, common.TokenStatusEnabled).
				Update("status", common.TokenStatusDisabled).Error; err != nil {
				return err
			}
			return tx.Model(&model.PersonalAllocation{}).Where("id = ?", alloc.Id).
				Update("is_active", false).Error
		}); txErr != nil {
			return fmt.Errorf("回收个人配额失败: %w", txErr)
		}
	}

	return nil
}
```

- [ ] **Step 3: 编译验证**

Run: `cd new-api && go build ./...`

- [ ] **Step 4: Commit**

```bash
git add service/allocation.go
git commit -m "feat(service): cascade deactivate ProducerProjects when PRODUCER is deactivated"
```

---

## Task 5: ProducerProject 管理 API（Controller + Router）

**Files:**
- Modify: `new-api/controller/organization.go` (追加新 handler)
- Modify: `new-api/router/org-router.go` (追加新路由)

- [ ] **Step 1: 在 controller/organization.go 末尾追加 3 个 handler**

```go
func GetProducerProjects(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	projects, err := model.GetProducerProjectsByProducerId(producerId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": projects})
}

func CreateProducerProjectCtrl(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	var req struct {
		Name string `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	producer, err := model.GetOrganizationById(producerId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "制作人不存在"})
		return
	}
	if producer.Level != constant.OrgLevelProducer {
		c.JSON(http.StatusBadRequest, gin.H{"error": "只能在制作人下创建项目"})
		return
	}

	pp := model.ProducerProject{
		ProducerId: producerId,
		Name:       req.Name,
	}
	if err := model.CreateProducerProject(&pp); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建项目失败: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": pp})
}

func AllocateToProducerProject(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	var req struct {
		ProjectId  int64   `json:"project_id" binding:"required"`
		AmountYuan float64 `json:"amount_yuan" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	operatorId := c.GetInt("id")
	if err := service.AllocateProducerToProject(producerId, req.ProjectId, req.AmountYuan, operatorId); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
```

- [ ] **Step 2: 补充 3 个缺失的 handler**

```go
func ReclaimFromProducerProject(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	var req struct {
		ProjectId  int64   `json:"project_id" binding:"required"`
		AmountYuan float64 `json:"amount_yuan" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	operatorId := c.GetInt("id")
	if err := service.ReclaimProducerFromProject(producerId, req.ProjectId, req.AmountYuan, operatorId); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func AllocateProjectToPersonalCtrl(c *gin.Context) {
	var req struct {
		ProducerProjectId int64   `json:"producer_project_id" binding:"required"`
		PlatformUserId    string  `json:"platform_user_id" binding:"required"`
		AmountYuan        float64 `json:"amount_yuan" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	operatorId := c.GetInt("id")
	if err := service.AllocateProjectToPersonal(req.ProducerProjectId, req.PlatformUserId, req.AmountYuan, operatorId); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func ReclaimProjectFromPersonalCtrl(c *gin.Context) {
	var req struct {
		ProducerProjectId int64   `json:"producer_project_id" binding:"required"`
		PlatformUserId    string  `json:"platform_user_id" binding:"required"`
		AmountYuan        float64 `json:"amount_yuan" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	operatorId := c.GetInt("id")
	if err := service.ReclaimProjectToPersonal(req.ProducerProjectId, req.PlatformUserId, req.AmountYuan, operatorId); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}
```

- [ ] **Step 3: 在 router/org-router.go 的 orgById group 中追加路由**

在 `orgById.POST("/transfer-admin", ...)` 后追加：

```go
orgById.GET("/producer-projects", controller.GetProducerProjects)
orgById.POST("/producer-projects", controller.CreateProducerProjectCtrl)
orgById.POST("/allocate-to-project", controller.AllocateToProducerProject)
orgById.POST("/reclaim-from-project", controller.ReclaimFromProducerProject)
orgById.POST("/allocate-project-to-personal", controller.AllocateProjectToPersonalCtrl)
orgById.POST("/reclaim-project-from-personal", controller.ReclaimProjectFromPersonalCtrl)
```

- [ ] **Step 3: 编译验证**

Run: `cd new-api && go build ./...`

- [ ] **Step 4: Commit**

```bash
git add controller/organization.go router/org-router.go
git commit -m "feat(api): add ProducerProject management endpoints"
```

---

## Task 6: 管理后台 UI — PRODUCER 展开显示项目

**Files:**
- Modify: `new-api/web/src/pages/OrgManagement/index.jsx`

- [ ] **Step 1: PRODUCER 不再是叶子节点**

找到 `isLeaf` 判断（约第 72 行）：

```js
isLeaf: org.level === 'PROJECT' || org.level === 'PRODUCER',
```

改为：

```js
isLeaf: org.level === 'PROJECT',
```

- [ ] **Step 2: loadChildren 支持加载 ProducerProject**

在 `loadChildren` 函数（约第 117 行）中，当 `org.level === 'PRODUCER'` 时调用不同的 API。将整个 `loadChildren` 函数替换为：

```js
const loadChildren = async (nodeKey, orgData) => {
  try {
    if (orgData && orgData.level === 'PRODUCER') {
      const res = await API.get(`/api/org/${nodeKey}/producer-projects`);
      const { success, data } = res.data;
      if (success && data) {
        return (data || []).map((pp) => ({
          key: `pp_${pp.id}`,
          label: (
            <span>
              {pp.name}{' '}
              <Tag size='small' color='cyan'>
                ¥{((pp.balance || 0) / QUOTA_PER_YUAN).toFixed(2)}
              </Tag>
            </span>
          ),
          value: `pp_${pp.id}`,
          orgData: { ...pp, level: 'PRODUCER_PROJECT' },
          isLeaf: true,
        }));
      }
    } else {
      const res = await API.get(`/api/org/${nodeKey}/children`);
      const { success, data } = res.data;
      if (success && data) {
        return (data || []).map((child) => makeTreeNode(child));
      }
    }
  } catch (e) {
    showError(e.message);
  }
  return [];
};
```

- [ ] **Step 3: handleTreeLoad 传递 orgData**

将 `handleTreeLoad` 调用改为传递 `orgData`：

```js
const handleTreeLoad = async (node) => {
  const children = await loadChildren(node.key, node.orgData);
  setTreeData((prev) => updateTreeNode(prev, node.key, children));
};
```

- [ ] **Step 4: 修复 refreshParentChildren 传递 orgData**

`refreshParentChildren` 也需要传递 `orgData`。修改为从 treeData 中查找节点数据：

```js
const findNodeData = (nodes, key) => {
  for (const n of nodes) {
    if (n.key === key) return n.orgData;
    if (n.children) {
      const found = findNodeData(n.children, key);
      if (found) return found;
    }
  }
  return null;
};

const refreshParentChildren = async (parentId) => {
  if (!parentId) {
    await loadCompanies();
    return;
  }
  const parentKey = String(parentId);
  const orgData = findNodeData(treeData, parentKey);
  const children = await loadChildren(parentKey, orgData);
  setTreeData((prev) => updateTreeNode(prev, parentKey, children));
};
```

- [ ] **Step 5: handleSelectOrg 处理 ProducerProject 选择**

在 `handleSelectOrg` 中，如果 key 以 `pp_` 开头，获取 ProducerProject 详情：

```js
if (String(key).startsWith('pp_')) {
  setSelectedOrg(key);
  const ppId = key.replace('pp_', '');
  try {
    const node = findNodeData(treeData, key);
    setOrgDetail({
      _isProducerProject: true,
      id: parseInt(ppId),
      name: node?.name || '',
      balance: node?.balance || 0,
      producer_id: node?.producer_id || 0,
      is_active: node?.is_active ?? true,
    });
    setAdminUsername('');
  } catch (e) {
    showError(e.message);
  }
  return;
}
```

- [ ] **Step 6: 详情面板条件渲染 ProducerProject**

在详情面板中（`orgDetail ?` 分支内），在现有 Card 外层包裹条件判断：

```jsx
{orgDetail._isProducerProject ? (
  <Card className='!rounded-xl'>
    <div className='flex items-center justify-between mb-4'>
      <div>
        <Typography.Title heading={5}>{orgDetail.name}</Typography.Title>
        <Tag color='cyan'>{t('项目')}</Tag>
      </div>
    </div>
    <Table
      dataSource={[
        { key: 'id', field: 'ID', value: orgDetail.id },
        { key: 'balance', field: t('余额'), value: `¥${((orgDetail.balance || 0) / QUOTA_PER_YUAN).toFixed(2)}` },
      ]}
      columns={[
        { title: t('字段'), dataIndex: 'field', width: 150 },
        { title: t('值'), dataIndex: 'value' },
      ]}
      pagination={false}
      size='small'
    />
  </Card>
) : (
  /* 现有的 Organization 详情面板代码不变 */
)}
```

同时在 Organization 详情面板的编辑/停用/转移按钮区域，确认它们只在非 `_isProducerProject` 时渲染（已通过上面的条件分支自动实现）。

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/OrgManagement/index.jsx
git commit -m "feat(admin-ui): PRODUCER expands to show ProducerProject list with balance"
```

---

## Task 7: Docker 构建 + 集成验证

- [ ] **Step 1: Docker 构建**

```bash
cd d:\tecx\text && docker compose -f docker-compose.local.yml build sora-new-api
```

- [ ] **Step 2: 部署并启动**

```bash
docker compose -f docker-compose.local.yml up -d sora-new-api
```

- [ ] **Step 3: 验证 AutoMigrate 加列**

```bash
docker exec sora-postgres psql -U sorauser -d newapi -c "SELECT column_name FROM information_schema.columns WHERE table_name='producer_project' AND column_name='balance'"
```
Expected: `balance` 列存在

- [ ] **Step 4: curl 测试新端点**

```bash
# 在制作人下创建项目
curl -X POST http://localhost:3000/api/org/57/producer-projects \
  -H "Cookie: session=<admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"name":"测试项目"}'

# 查看制作人下的项目列表
curl http://localhost:3000/api/org/57/producer-projects \
  -H "Cookie: session=<admin-session>"

# 给项目分配余额
curl -X POST http://localhost:3000/api/org/57/allocate-to-project \
  -H "Cookie: session=<admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":1,"amount_yuan":100}'
```

- [ ] **Step 5: 管理后台 UI 验证**

打开 `http://localhost:3000`，在组织树中展开 PRODUCER 节点，应该能看到下面的项目列表及余额。

---

## 实施顺序

```
Task 1 → 模型加字段（Balance）
Task 2 → PRODUCER ↔ ProducerProject 资金划拨
Task 3 → ProducerProject ↔ 个人 资金划拨（替换旧函数）
Task 4 → 级联停用扩展
Task 5 → Controller + Router
Task 6 → 管理后台 UI
Task 7 → Docker 构建 + 集成验证
```
