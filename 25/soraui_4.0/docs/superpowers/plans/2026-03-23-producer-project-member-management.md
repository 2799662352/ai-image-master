# ProducerProject 成员管理 — 功能对齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ProducerProject 的成员管理功能与旧 PROJECT 完全对齐：查看成员列表、查看成员余额、添加成员（自动创建影子账号）、移除成员（回收余额+停用 token），操作简化（无需独立管理员）。

**Architecture:** 复用旧 PROJECT 的 `GetProjectMembersViaAllocation` / `GetProjectMemberBalances` 模式，但数据源改为 ProducerProject。在现有的 `GetOrgMembers` / `AddOrgMember` / `RemoveOrgMember` 中增加 PRODUCER 分支，而不是创建独立端点——与旧代码保持一致的路由结构。管理后台 ProducerProject 详情面板增加成员管理 UI。

**Tech Stack:** Go 1.21+ / Gin / GORM / Semi Design JSX

**对照标准：** 旧 PROJECT 在 `controller/organization.go` 中的完整功能链

---

## 旧 PROJECT 功能 → ProducerProject 对应关系

| 旧 PROJECT 功能 | 代码位置 | ProducerProject 方案 |
|------|------|------|
| 查看成员列表 | `GetOrgMembers` → `GetProjectMembersViaAllocation` | 新增 `GetProducerProjectMembersWithBalance` |
| 查看成员余额 | `GetProjectMemberBalances` → 查 PersonalAllocation + User.quota | 同逻辑，查 `producer_id` 维度 |
| 添加成员 | `AddOrgMember` → 创建 OrgMember | 创建 ProducerProjectMember + 自动创建影子账号 |
| 移除成员 | `RemoveOrgMember` → `ReclaimAndDeactivateProjectMember` | 回收余额 + 停用 token + 删除 ProducerProjectMember |
| 分配余额给个人 | `AllocateBalance` → `AllocateOrgToPersonal` | `AllocateProjectToPersonal`（已实现） |

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `model/producer_project.go` | 新增 `GetProducerProjectMembersWithDetail` |
| 修改 | `controller/organization.go` | 新增 3 个 ProducerProject 成员管理 handler |
| 修改 | `router/org-router.go` | 注册 3 条新路由 |
| 修改 | `web/src/pages/OrgManagement/index.jsx` | ProducerProject 详情面板增加成员管理 |

---

## Task 1: Model 层 — ProducerProject 成员查询

**Files:**
- Modify: `new-api/model/producer_project.go`

- [ ] **Step 1: 追加查询函数**

在文件末尾追加：

```go
type ProducerProjectMemberDetail struct {
	PlatformUserId string  `json:"platform_user_id"`
	DisplayName    string  `json:"display_name"`
	Phone          string  `json:"phone"`
	BalanceYuan    float64 `json:"balance_yuan"`
	HasAllocation  bool    `json:"has_allocation"`
	JoinedAt       string  `json:"joined_at"`
}
```

> 这个 struct 只用于数据传输，不是 GORM 模型。实际的余额查询在 Controller 层做（和旧 `GetProjectMemberBalances` 一样）。

- [ ] **Step 2: Commit**

```bash
git add model/producer_project.go
git commit -m "feat(model): add ProducerProjectMemberDetail DTO"
```

---

## Task 2: Controller — ProducerProject 成员管理 API

**Files:**
- Modify: `new-api/controller/organization.go`

- [ ] **Step 1: 新增 GetProducerProjectMembers handler**

在 `DeactivateProducerProjectCtrl` 后追加。此函数对标旧 `GetProjectMemberBalances`（第 547-608 行），但数据源是 ProducerProjectMember + PersonalAllocation by producer：

```go
func GetProducerProjectMembersCtrl(c *gin.Context) {
	ppId, _ := strconv.ParseInt(c.Query("project_id"), 10, 64)
	if ppId == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "project_id 必填"})
		return
	}

	pp, err := model.GetProducerProjectById(ppId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	members, err := model.GetProducerProjectMembers(ppId)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	producerMembers, _ := model.GetOrgMembersByOrgId(pp.ProducerId)
	memberMap := make(map[string]*model.OrgMember)
	for i := range producerMembers {
		memberMap[producerMembers[i].PlatformUserId] = &producerMembers[i]
	}

	allocs, _ := model.GetPersonalAllocationsByProducer(pp.ProducerId)
	allocMap := make(map[string]*model.PersonalAllocation)
	for i := range allocs {
		allocMap[allocs[i].PlatformUserId] = &allocs[i]
	}

	var newapiUserIds []int
	for _, a := range allocs {
		newapiUserIds = append(newapiUserIds, a.NewapiUserId)
	}
	var users []model.User
	if len(newapiUserIds) > 0 {
		model.DB.Select("id, quota").Where("id IN ?", newapiUserIds).Find(&users)
	}
	quotaMap := make(map[int]int)
	for _, u := range users {
		quotaMap[u.Id] = u.Quota
	}

	type MemberInfo struct {
		PlatformUserId string  `json:"platform_user_id"`
		DisplayName    string  `json:"display_name"`
		Phone          string  `json:"phone"`
		BalanceYuan    float64 `json:"balance_yuan"`
		HasAllocation  bool    `json:"has_allocation"`
	}

	var result []MemberInfo
	for _, m := range members {
		mi := MemberInfo{
			PlatformUserId: m.PlatformUserId,
		}
		if om, ok := memberMap[m.PlatformUserId]; ok {
			mi.DisplayName = om.DisplayName
			mi.Phone = om.Phone
		}
		if a, ok := allocMap[m.PlatformUserId]; ok {
			mi.HasAllocation = true
			mi.BalanceYuan = service.QuotaToYuan(int64(quotaMap[a.NewapiUserId]))
		}
		result = append(result, mi)
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "data": result})
}
```

- [ ] **Step 2: 新增 AddProducerProjectMemberCtrl handler**

添加成员到 ProducerProject。成员必须已是 PRODUCER 的 OrgMember。

```go
func AddProducerProjectMemberCtrl(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	var req struct {
		ProjectId      int64  `json:"project_id" binding:"required"`
		PlatformUserId string `json:"platform_user_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pp, err := model.GetProducerProjectById(req.ProjectId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}
	if pp.ProducerId != producerId {
		c.JSON(http.StatusBadRequest, gin.H{"error": "项目不属于该制作人"})
		return
	}

	_, err = model.GetOrgMember(producerId, req.PlatformUserId)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "该用户不是制作人成员，请先加入制作人"})
		return
	}

	member := model.ProducerProjectMember{
		ProducerProjectId: req.ProjectId,
		PlatformUserId:    req.PlatformUserId,
	}
	if err := model.CreateProducerProjectMember(&member); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "该用户已在此项目中"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true})
}
```

- [ ] **Step 3: 新增 RemoveProducerProjectMemberCtrl handler**

移除成员：回收个人余额到 ProducerProject.Balance，停用 token，删除 ProducerProjectMember。

```go
func RemoveProducerProjectMemberCtrl(c *gin.Context) {
	producerId, _ := strconv.ParseInt(c.Param("org_id"), 10, 64)
	var req struct {
		ProjectId      int64  `json:"project_id" binding:"required"`
		PlatformUserId string `json:"platform_user_id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pp, err := model.GetProducerProjectById(req.ProjectId)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}
	if pp.ProducerId != producerId {
		c.JSON(http.StatusBadRequest, gin.H{"error": "项目不属于该制作人"})
		return
	}

	operatorId := c.GetInt("id")
	alloc, allocErr := model.GetPersonalAllocationByProducer(req.PlatformUserId, producerId)
	if allocErr == nil && alloc != nil {
		if txErr := model.DB.Transaction(func(tx *gorm.DB) error {
			var user model.User
			if err := tx.Select("id, quota").First(&user, alloc.NewapiUserId).Error; err != nil {
				return err
			}
			if user.Quota > 0 {
				remainingQuota := int64(user.Quota)
				if err := tx.Model(&model.User{}).Where("id = ?", alloc.NewapiUserId).
					Update("quota", 0).Error; err != nil {
					return err
				}
				if err := tx.Model(&model.ProducerProject{}).Where("id = ?", req.ProjectId).
					Update("balance", gorm.Expr("balance + ?", remainingQuota)).Error; err != nil {
					return err
				}
				pid := producerId
				txn := model.BalanceTransaction{
					Type:             constant.TxnTypeReclaim,
					ToOrgId:          &pid,
					ToPlatformUserId: req.PlatformUserId,
					AmountQuota:      remainingQuota,
					AmountYuan:       service.QuotaToYuan(remainingQuota),
					OperatorId:       operatorId,
					Status:           "SUCCESS",
					Remark:           fmt.Sprintf("移除项目成员回收: %s", req.PlatformUserId),
				}
				if err := tx.Create(&txn).Error; err != nil {
					return err
				}
			}
			if err := tx.Model(&model.Token{}).
				Where("user_id = ? AND status = ?", alloc.NewapiUserId, common.TokenStatusEnabled).
				Update("status", common.TokenStatusDisabled).Error; err != nil {
				return err
			}
			return tx.Model(&model.PersonalAllocation{}).Where("id = ?", alloc.Id).
				Update("is_active", false).Error
		}); txErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "回收余额失败: " + txErr.Error()})
			return
		}
	}

	model.DeleteProducerProjectMember(req.ProjectId, req.PlatformUserId)

	c.JSON(http.StatusOK, gin.H{"success": true})
}
```

- [ ] **Step 4: 编译验证**

Run: `cd new-api && go build ./...`

> 注意：`RemoveProducerProjectMemberCtrl` 需要 `gorm` import。检查 `controller/organization.go` 顶部 import 是否已有 `"gorm.io/gorm"`，如果没有则需要添加。

- [ ] **Step 5: Commit**

```bash
git add controller/organization.go
git commit -m "feat(controller): add ProducerProject member management handlers"
```

---

## Task 3: Router — 注册成员管理路由

**Files:**
- Modify: `new-api/router/org-router.go`

- [ ] **Step 1: 在 orgById group 中追加路由**

在 `orgById.POST("/deactivate-producer-project", ...)` 后追加：

```go
			orgById.GET("/producer-project-members", controller.GetProducerProjectMembersCtrl)
			orgById.POST("/add-producer-project-member", controller.AddProducerProjectMemberCtrl)
			orgById.POST("/remove-producer-project-member", controller.RemoveProducerProjectMemberCtrl)
```

- [ ] **Step 2: 编译验证**

Run: `cd new-api && go build ./...`

- [ ] **Step 3: Commit**

```bash
git add router/org-router.go
git commit -m "feat(router): register ProducerProject member management routes"
```

---

## Task 4: 管理后台 UI — ProducerProject 详情面板增强

**Files:**
- Modify: `new-api/web/src/pages/OrgManagement/index.jsx`

- [ ] **Step 1: ProducerProject 详情面板加载成员数据**

在 `handleSelectOrg` 函数中，`pp_` 分支里，选中 ProducerProject 后额外请求成员列表。

在现有的 `setOrgDetail({_isProducerProject: true, ...})` 块后追加：

```js
// 加载项目成员
try {
  const membersRes = await API.get(`/api/org/${node?.producer_id}/producer-project-members`, {
    params: { project_id: node?.id || parseInt(String(key).replace('pp_', '')) },
  });
  if (membersRes.data.success) {
    setOrgDetail(prev => ({ ...prev, members: membersRes.data.data || [] }));
  }
} catch (e) { /* ignore */ }
```

- [ ] **Step 2: ProducerProject 详情面板渲染成员表格**

在 ProducerProject Card 中，在余额 Table 后追加成员表格：

```jsx
{orgDetail.members && orgDetail.members.length > 0 && (
  <div className='mt-4'>
    <Typography.Text strong className='mb-2 block'>{t('项目成员')}</Typography.Text>
    <Table
      dataSource={orgDetail.members.map((m, i) => ({ ...m, key: i }))}
      columns={[
        { title: t('用户 ID'), dataIndex: 'platform_user_id', width: 150 },
        { title: t('姓名'), dataIndex: 'display_name', width: 120 },
        { title: t('余额'), dataIndex: 'balance_yuan', width: 100,
          render: (v) => v != null ? `¥${(v || 0).toFixed(2)}` : '-' },
        { title: t('操作'), width: 80,
          render: (_, record) => (
            <Popconfirm
              title={t('确认移除该成员？余额将回收到项目')}
              onConfirm={async () => {
                try {
                  await API.post(`/api/org/${orgDetail.producer_id}/remove-producer-project-member`, {
                    project_id: orgDetail.id,
                    platform_user_id: record.platform_user_id,
                  });
                  showSuccess(t('成员已移除'));
                  handleSelectOrg(selectedOrg);
                } catch (e) {
                  showError(e.response?.data?.error || e.message);
                }
              }}
            >
              <Button size='small' type='danger'>{t('移除')}</Button>
            </Popconfirm>
          ),
        },
      ]}
      pagination={false}
      size='small'
    />
  </div>
)}
```

- [ ] **Step 3: ProducerProject 详情面板添加"分配余额"按钮**

在停用按钮旁边追加一个"分配余额给成员"的操作：暂时不做完整 Modal（YAGNI），后续需要时再加。

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/OrgManagement/index.jsx
git commit -m "feat(admin-ui): ProducerProject detail shows member list with balance and remove"
```

---

## Task 5: 检查 controller import 并统一构建

- [ ] **Step 1: 确认 organization.go import 包含 gorm**

检查 `controller/organization.go` 的 import 块是否有 `"gorm.io/gorm"`。`RemoveProducerProjectMemberCtrl` 中使用了 `gorm.Expr`。如果没有，追加。

- [ ] **Step 2: 统一构建**

```bash
cd d:\tecx\text && docker compose -f docker-compose.local.yml build sora-new-api
```

- [ ] **Step 3: 部署 + 验证**

```bash
docker compose -f docker-compose.local.yml up -d sora-new-api
```

curl 测试：
```bash
# 查看项目成员（project_id=1）
curl "http://localhost:3000/api/org/60/producer-project-members?project_id=1" \
  -H "Cookie: session=<admin>"

# 添加成员到项目
curl -X POST http://localhost:3000/api/org/60/add-producer-project-member \
  -H "Cookie: session=<admin>" \
  -H "Content-Type: application/json" \
  -d '{"project_id":1,"platform_user_id":"user123"}'
```

---

## 实施顺序

```
Task 1 → Model DTO（极小改动）
Task 2 → Controller 3 个 handler（核心逻辑）
Task 3 → Router 注册
Task 4 → 管理后台 UI
Task 5 → Import 检查 + 统一构建
```

全部完成后，ProducerProject 成员管理功能与旧 PROJECT 完全对齐，且操作更简化（无独立管理员、由制作人统一管理）。
