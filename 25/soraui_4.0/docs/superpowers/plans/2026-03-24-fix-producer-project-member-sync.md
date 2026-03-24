# 制作人项目成员同步修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复用户加入制作人项目后，在余额管理页面不显示为项目成员的问题。确保 sora-ui 前端加入流程与后端数据模型一致。

**Architecture:** 用户通过 sora-ui 加入 ProducerProject 时，只调用了 `joinProject`（创建 PersonalAllocation），但未调用 `joinProducerProject`（创建 ProducerProjectMember）。余额管理 Collapse 查询 ProducerProjectMember 表，所以显示空。修复前端加入流程 + 后端自动关联。

**Tech Stack:** React/TypeScript (sora-ui), Go/Gin (new-api backend)

---

## 数据模型关系

```
用户加入制作人后产生的记录：
┌─ OrgMember (org_id=producerId)          ← 制作人组织成员 ✓
├─ PersonalAllocation (producer_id=X)     ← 计费配额 ✓
└─ ProducerProjectMember (pp_id=Y)        ← 项目成员 ✗ 缺失！
```

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `sora-ui/src/components/miau-home/MiauNavBarFunctional.tsx` | 修改 | 前端加入流程：加入 ProducerProject 时同时创建 ProducerProjectMember |
| `new-api/controller/internal.go` | 修改 | 后端 `InternalJoinProject` PRODUCER 分支：自动创建 ProducerProjectMember |

---

### Task 1: 修复 sora-ui 前端加入流程

**问题**：`handleJoin` 函数只调用 `joinProject(token, org.id)`，不区分普通项目和 ProducerProject。对 ProducerProject 需要额外调用 `joinProducerProject` 创建项目成员记录。

**Files:**
- Modify: `sora-ui/src/components/miau-home/MiauNavBarFunctional.tsx` (handleJoin 函数，约 275-288 行)

- [ ] **Step 1: 修改 handleJoin 函数**

找到现有代码（约 275-288 行）：

```tsx
const handleJoin = async (e: React.MouseEvent, org: OrgProject) => {
    e.stopPropagation();
    if (!token || joining) return;
    setJoining(orgKey(org));
    try {
      const { joinProject } = await import('@/api/backend-api');
      await joinProject(token, org.id);
      await loadOrganizations();
    } catch (err: any) {
      console.error('加入项目失败:', err.message);
    } finally {
      setJoining(null);
    }
};
```

替换为：

```tsx
const handleJoin = async (e: React.MouseEvent, org: OrgProject) => {
    e.stopPropagation();
    if (!token || joining) return;
    setJoining(orgKey(org));
    try {
      const { joinProject, joinProducerProject } = await import('@/api/backend-api');
      await joinProject(token, org.id);
      if (org.producerProjectId) {
        await joinProducerProject(token, org.producerProjectId);
      }
      await loadOrganizations();
    } catch (err: any) {
      console.error('加入项目失败:', err.message);
    } finally {
      setJoining(null);
    }
};
```

- [ ] **Step 2: Commit**

```bash
git add sora-ui/src/components/miau-home/MiauNavBarFunctional.tsx
git commit -m "fix: join ProducerProject also creates ProducerProjectMember"
```

---

### Task 2: 后端 InternalJoinProject PRODUCER 分支自动关联 ProducerProjectMember

**问题**：当前 `InternalJoinProject` 处理 PRODUCER 级别时只创建 PersonalAllocation，不创建 ProducerProjectMember。这导致通过邀请码加入的用户也不会出现在项目成员列表中。

**注意**：这个函数在 `InternalJoinProject` 被 BFF `joinProject` 调用时，不知道用户要加入哪个 ProducerProject（因为前端传的是 `producerOrgId`，不是 `producerProjectId`）。所以这个修复主要是让 Task 1 的前端改动生效后，确保后端 `InternalJoinProducerProject` 也能正确处理已有 PersonalAllocation 的情况。

**实际上 `InternalJoinProducerProject` 已经能处理这种情况**——它只检查用户是否是 Producer 的 OrgMember，然后创建 ProducerProjectMember。无需修改后端。

**但需要修复一个存量数据问题**：已经加入的用户 admin11z 没有 ProducerProjectMember 记录。可以通过管理面板"组织管理→项目→添加成员"手动添加。

- [ ] **Step 1: 验证后端 InternalJoinProducerProject 无需修改**

确认函数逻辑正确（只需 OrgMember 存在即可创建 ProducerProjectMember），无需改动。

- [ ] **Step 2: 记录存量数据修复方式**

对于已加入但缺少 ProducerProjectMember 的用户（如 admin11z），管理员需要在"组织管理→选择 ProducerProject→添加成员"中手动添加 `admin11z` 的 platform_user_id。

---

### Task 3: 构建部署（仅 sora-ui 需要重建）

**注意**：本次只改了 sora-ui 前端代码，不需要重建 sora-new-api。

**Files:**
- Docker build: `docker-compose.local.yml` → `sora-ui` service

- [ ] **Step 1: 构建 sora-ui**

```bash
cd d:\tecx\text && docker compose -f docker-compose.local.yml build sora-ui
```

- [ ] **Step 2: 重启 sora-ui**

```bash
docker compose -f docker-compose.local.yml up -d sora-ui
```

- [ ] **Step 3: 管理面板手动修复存量数据**

1. 管理面板 → 组织管理 → 选择制作人 → 展开 ProducerProject "121212"
2. 点击"添加成员" → 输入 admin11z 的 platform_user_id
3. 确认成员出现在项目成员列表
4. 回到余额管理 → 展开项目 121212 → 确认 admin11z 显示

- [ ] **Step 4: 端到端验证新用户流程**

1. 用新账号在 sora-ui 填写邀请码加入制作人
2. 在项目下拉中选择一个 ProducerProject 并点击"加入"
3. 确认余额管理 → 展开该项目 → 新用户出现在成员列表
