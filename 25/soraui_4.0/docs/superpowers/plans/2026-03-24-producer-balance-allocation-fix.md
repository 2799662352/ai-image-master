# 制作人余额分配完整链路修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复制作人（PRODUCER）级别的完整资金分配链路：制作人→项目→个人，以及成员显示名问题。

**Architecture:** 后端已有完整的 API（`allocate-to-project`, `allocate-project-to-personal`, `producer-project-members`），但前端管理面板缺少关键 UI 串联。核心是在 OrgManagement 和 BalanceManagement 页面补全 ProducerProject 级别的操作入口。

**Tech Stack:** Go (Gin/GORM), React (Semi UI), PostgreSQL

---

## 问题清单

| # | 问题 | 根因 | 影响页面 |
|---|------|------|----------|
| A | 余额管理成员显示 "8814c33b" 而非姓名 | `GetProjectMemberBalances` 的 PRODUCER 分支用 `GetOrgMembersByOrgId(producerId)` 查成员名，但 OrgMember 可能无 display_name | BalanceManagement |
| B | 制作人不能分配资金到项目后再分到个人 | OrgManagement ProducerProject 面板有"分配余额给成员"按钮，但没有先给项目充钱、项目也没成员 | OrgManagement |
| C | 余额管理不显示 ProducerProject 子项目列表 | BalanceManagement `loadChildren` 只查 `GetOrganizationsByParentId`，PRODUCER 的子项目是 ProducerProject 表 | BalanceManagement |
| D | 成员管理显示"暂无成员"后添加成员，与余额管理成员不一致 | 成员管理用 `GetOrgMembersByOrgId`，余额管理用 `GetPersonalAllocationsByProducer`，两者数据源不同 | MemberManagement, BalanceManagement |

## 文件结构

| 文件 | 角色 | 操作 |
|------|------|------|
| `new-api/controller/organization.go` | 后端：成员余额 API | 修改 |
| `new-api/web/src/pages/OrgManagement/index.jsx` | 管理面板：组织管理 | 修改 |
| `new-api/web/src/pages/BalanceManagement/index.jsx` | 管理面板：余额管理 | 修改 |

---

### Task 1: 修复 GetProjectMemberBalances PRODUCER 成员名解析

**问题**：PRODUCER 级别调用 `member-balances` 时，成员的 display_name 为空，前端显示原始 platform_user_id（如 "8814c33b"）。

**根因**：OrgMember 记录的 display_name 可能为空（用户通过 sora-ui 加入时未传入姓名）。

**Files:**
- Modify: `new-api/controller/organization.go` (GetProjectMemberBalances 函数，约 547-608 行)

- [ ] **Step 1: 修改 GetProjectMemberBalances，PRODUCER 分支增加 fallback 名称**

在查询 OrgMember 失败或 display_name 为空时，从 PersonalAllocation 关联的 User 获取 username 作为 fallback。

```go
// 在 GetProjectMemberBalances 函数中，result 构建循环里修改：
for _, alloc := range allocs {
    mb := MemberBalance{
        PlatformUserId: alloc.PlatformUserId,
        HasAllocation:  true,
    }
    if m, ok := memberMap[alloc.PlatformUserId]; ok {
        mb.DisplayName = m.DisplayName
        mb.Phone = m.Phone
        mb.Role = m.Role
    }
    // fallback: 如果 display_name 为空，用 platform_user_id 前 8 位
    if mb.DisplayName == "" {
        uid := alloc.PlatformUserId
        if len(uid) > 8 {
            uid = uid[:8]
        }
        mb.DisplayName = uid
    }
    mb.BalanceYuan = service.QuotaToYuan(int64(quotaMap[alloc.NewapiUserId]))
    result = append(result, mb)
}
```

- [ ] **Step 2: 验证编译**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go vet ./controller/...
```
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add controller/organization.go
git commit -m "fix: improve member name fallback in GetProjectMemberBalances for PRODUCER"
```

---

### Task 2: BalanceManagement 支持 PRODUCER 显示 ProducerProject 子项目

**问题**：余额管理页面查看 PRODUCER 组织时，不显示其下的 ProducerProject 列表（无法分配/回收项目余额）。

**根因**：`loadData` 中加载子组织用的是 `GET /api/org/:id/children`（查 Organization 表 parent_id），但 PRODUCER 的子项目在 ProducerProject 表中。

**Files:**
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx` (loadData 函数 + 子组织渲染区域)

- [ ] **Step 1: loadData 中对 PRODUCER 加载 ProducerProject 列表**

在 `loadData` 函数 `setMyOrg(orgs[0])` 之后，根据 level 选择不同的子项目加载方式：

```jsx
if (orgs.length > 0) {
  setMyOrg(orgs[0]);
  try {
    if (orgs[0].level === 'PRODUCER') {
      // PRODUCER 的子项目在 producer-projects API
      const childRes = await API.get(`/api/org/${orgs[0].id}/producer-projects`);
      if (childRes.data.success) {
        const ppList = (childRes.data.data || []).map(pp => ({
          ...pp,
          _isProducerProject: true,
          level: 'PRODUCER_PROJECT',
        }));
        setChildOrgs(ppList);
      }
    } else {
      const childRes = await API.get(`/api/org/${orgs[0].id}/children`);
      if (childRes.data.success) setChildOrgs(childRes.data.data || []);
    }
  } catch {}
}
```

- [ ] **Step 2: refreshMyOrg 中同样处理 PRODUCER**

```jsx
const refreshMyOrg = async () => {
  if (!myOrg) return;
  try {
    const res = await API.get(`/api/org/${myOrg.id}`);
    if (res.data.success) setMyOrg(res.data.data);
    if (myOrg.level === 'PRODUCER') {
      const childRes = await API.get(`/api/org/${myOrg.id}/producer-projects`);
      if (childRes.data.success) {
        setChildOrgs((childRes.data.data || []).map(pp => ({
          ...pp, _isProducerProject: true, level: 'PRODUCER_PROJECT',
        })));
      }
    } else {
      const childRes = await API.get(`/api/org/${myOrg.id}/children`);
      if (childRes.data.success) setChildOrgs(childRes.data.data || []);
    }
  } catch {}
};
```

- [ ] **Step 3: 子组织卡片渲染中支持 ProducerProject**

在渲染子组织列表的地方，对 `_isProducerProject` 的项用不同的标签和余额显示：

```jsx
// 子组织卡片中的 level 标签
<Tag color={child._isProducerProject ? 'cyan' : (LEVEL_COLOR[child.level] || 'grey')} size="small">
  {child._isProducerProject ? '项目' : (LEVEL_LABEL[child.level] || child.level)}
</Tag>

// 余额显示：ProducerProject 的余额字段是 balance（quota 值），非 Organization 的 balance
const childBalance = child._isProducerProject
  ? toYuan(child.balance)
  : toYuan(child.balance);
```

- [ ] **Step 4: ProducerProject 分配/回收按钮**

在子组织操作按钮区域，对 ProducerProject 使用 `allocate-to-project` / `reclaim-from-project` API：

```jsx
// 对 ProducerProject 子项目的分配按钮
onClick={() => {
  if (child._isProducerProject) {
    // 调用 Producer → ProducerProject 分配
    setAllocTarget({ ...child, _isProducerProject: true });
  } else {
    setAllocTarget(child);
  }
  setAllocModalVisible(true);
}}

// 在分配 Modal 的 onOk 中：
if (allocTarget._isProducerProject) {
  await API.post(`/api/org/${myOrg.id}/allocate-to-project`, {
    project_id: allocTarget.id,
    amount_yuan: amount,
  });
} else {
  await API.post(`/api/org/${myOrg.id}/allocate`, {
    to_org_id: allocTarget.id,
    amount_yuan: amount,
  });
}
```

- [ ] **Step 5: 验证编译**

本地打开页面检查无 JS 错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/BalanceManagement/index.jsx
git commit -m "feat: BalanceManagement supports PRODUCER showing ProducerProject children"
```

---

### Task 3: OrgManagement ProducerProject 成员分配个人余额流程完善

**问题**：OrgManagement 的 ProducerProject 面板有"分配余额给成员"按钮，但实际操作前需要：
1. 先给 ProducerProject 充钱（Producer → ProducerProject）
2. 项目中有成员（通过"添加成员"）
3. 然后才能分配给成员（ProducerProject → Personal）

当前按钮和 API 都已存在并正确连接 (`allocate-project-to-personal`)，但用户体验上缺少引导。

**Files:**
- Modify: `new-api/web/src/pages/OrgManagement/index.jsx` (ProducerProject detail panel, 约 430-560 行)

- [ ] **Step 1: ProducerProject 面板增加余额不足提示**

当 ProducerProject 余额为 0 时，在"分配余额给成员"按钮旁显示提示：

```jsx
{orgDetail.is_active && orgDetail.members && orgDetail.members.length > 0 && (orgDetail.balance || 0) <= 0 && (
  <Typography.Text type="warning" style={{ fontSize: 12 }}>
    {t('项目余额为0，请先从制作人分配资金到此项目')}
  </Typography.Text>
)}
```

- [ ] **Step 2: 成员操作列增加"分配余额"按钮的 disabled 状态**

当 ProducerProject 余额为 0 时，"分配余额"按钮 disabled：

```jsx
<Button
  size='small'
  disabled={(orgDetail.balance || 0) <= 0}
  onClick={() => {
    setAllocMemberTarget(record);
    setAllocAmount('');
    setAllocMemberModalVisible(true);
  }}
>
  {t('分配余额')}
</Button>
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/OrgManagement/index.jsx
git commit -m "feat: ProducerProject panel shows balance warning and disables alloc when empty"
```

---

### Task 4: 构建部署验证

**Files:**
- Docker build: `docker-compose.local.yml` → `sora-new-api` service

- [ ] **Step 1: 编译验证**

```bash
cd d:\tecx\text\25\soraui_4.0\new-api && go vet ./controller/... ./service/...
```

- [ ] **Step 2: Docker 构建**

```bash
cd d:\tecx\text && docker compose -f docker-compose.local.yml build sora-new-api
```

- [ ] **Step 3: 重启容器**

```bash
docker compose -f docker-compose.local.yml up -d sora-new-api
```

- [ ] **Step 4: 端到端验证**

1. 管理面板 → 组织管理 → 选择制作人 → 点击 ProducerProject
2. 点击 "分配余额" → 输入金额 → 确认 → ProducerProject 余额更新
3. 点击 "添加成员" → 输入用户 ID → 确认 → 成员出现在列表
4. 点击成员的 "分配余额" → 输入金额 → 确认 → 成员余额更新
5. 管理面板 → 余额管理 → 确认制作人的子项目列表正确显示
6. 管理面板 → 余额管理 → 确认成员显示正确姓名（非 "8814c33b"）
7. 前端 sora-ui → 选择制作人项目 → 确认余额非 0

---

## 完整资金流向图

```
Company (充值)
  └→ Studio (分配)
      └→ Producer Organization (balance=¥1000) ← 管理面板"组织管理"可见
          ├→ ProducerProject A (balance=¥0→¥500)  ← Task 2: 余额管理展示 + 分配
          │   ├→ Member X (personal quota=¥0→¥200) ← Task 3: OrgManagement 成员分配
          │   └→ Member Y (personal quota=¥0→¥100)
          └→ ProducerProject B (balance=¥0→¥300)
              └→ Member Z (personal quota=¥0→¥150)
```

**操作步骤**：
1. 余额管理/组织管理 → 给 ProducerProject 分配 (Producer→Project)
2. 组织管理 → 给 ProducerProject 添加成员
3. 组织管理 → 给成员分配个人余额 (Project→Personal)
4. 前端 sora-ui → 用户看到余额，可以使用 API 生成内容
