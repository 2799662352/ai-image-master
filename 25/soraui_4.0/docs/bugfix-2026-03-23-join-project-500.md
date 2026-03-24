# Bugfix: join-project 500 + balance 404

**日期**: 2026-03-23  
**影响服务**: sora-new-api (Go), sora-ui-backend (Node.js), sora-ui (React)  
**严重程度**: P1 — 用户无法加入项目、无法查看余额

---

## 1. 现象

前端控制台报两个错误：

```
GET  /api/user/balance       → 404  "获取余额失败"
POST /api/user/join-project  → 500  "加入项目失败: 重新加入项目失败: record not found"
```

sora-new-api Docker 日志关键行：

```
/build/model/personal_allocation.go:60 record not found
SELECT * FROM "personal_allocation" WHERE "personal_allocation"."id" = 0
```

## 2. 调用链

```
前端 (React orgStore)
  → sora-ui-backend (Express 代理层)
    → sora-new-api (Go/Gin 内部 API)
      → PostgreSQL (newapi 数据库)
```

| 前端调用 | Backend 路由 | New API 端点 |
|---------|-------------|-------------|
| `GET /api/user/balance?projectId=X` | `userOrg.ts:46` | `GET /api/internal/user-balance` |
| `POST /api/user/join-project` | `userOrg.ts:137` | `POST /api/internal/join-project` |

## 3. 根因分析

### 核心 Bug：`controller/internal.go` 第 300 行

```go
// 旧代码 — 丢弃了错误返回值
inactive, _ := model.GetPersonalAllocationIncludingInactive(req.PlatformUserId, req.ProjectId)
if inactive != nil && !inactive.IsActive {
    model.ReactivatePersonalAllocation(inactive.Id) // inactive.Id = 0 → record not found
}
```

**故障机制**：

1. 用户 `e6c63594` 在 `personal_allocation` 表中没有任何记录
2. `GetPersonalAllocationIncludingInactive` 查无记录，Docker 镜像中的旧编译版本返回了 `(&PersonalAllocation{}, gorm.ErrRecordNotFound)` — 非 nil 指针指向零值结构体
3. 控制器用 `_` 丢弃了 error
4. `inactive != nil` → true（非 nil 指针）
5. `!inactive.IsActive` → true（Go bool 零值 = false）
6. `inactive.Id` = 0（Go int64 零值）
7. `ReactivatePersonalAllocation(0)` 执行 `WHERE id = 0` → "record not found"
8. 返回 500："重新加入项目失败: record not found"

**余额 404 是连锁反应**：join-project 始终失败 → 用户永远没有 personal_allocation → balance 查询必然返回 "no allocation"。

### 数据层验证

```sql
-- 当前 soraui 用户（3 个）在 personal_allocation 中无记录
SELECT * FROM personal_allocation 
WHERE platform_user_id IN ('8814c33b-...', '226ab507-...', 'e6c63594-...');
-- 0 rows

-- 但 org_member 中有记录（用户已通过邀请码加入工作室）
SELECT * FROM org_member WHERE platform_user_id = 'e6c63594-...';
-- org_id=6 (it部, STUDIO)
```

## 4. 修复

### 4.1 代码修复：`controller/internal.go:300`

```go
// 新代码 — 三重防御：检查 error + 非 nil + id > 0
inactive, inactiveErr := model.GetPersonalAllocationIncludingInactive(req.PlatformUserId, req.ProjectId)
if inactiveErr == nil && inactive != nil && inactive.Id > 0 && !inactive.IsActive {
    // 只有真正找到了一条已停用的记录才走重新激活路径
    if reactivateErr := model.ReactivatePersonalAllocation(inactive.Id); reactivateErr != nil {
        c.JSON(http.StatusInternalServerError, gin.H{"error": "重新加入项目失败: " + reactivateErr.Error()})
        return
    }
    c.JSON(http.StatusOK, gin.H{"success": true, "project_name": project.Name})
    return
}
```

### 4.2 构建修复：`bun.lock` 镜像源

```bash
# bun.lock 中 1158 处 npmmirror 中国镜像 URL 在 Docker 容器内 CDN 解析异常
# 全量替换为官方 npm 源
sed -i 's/registry.npmmirror.com/registry.npmjs.org/g' web/bun.lock
```

### 4.3 完整 Docker 重建

```bash
cd new-api/
docker build -t new-api-custom:latest .   # 三阶段：bun→golang→debian
docker stop sora-new-api && docker rm sora-new-api
docker run -d --name sora-new-api \
  --network soraui_40_default \
  -p 3000:3000 \
  -e "SQL_DSN=postgres://sorauser:sora_password_2024@postgres:5432/newapi?sslmode=disable" \
  -e "REDIS_CONN_STRING=redis://:sora_redis_2024@redis:6379/2" \
  -e "SESSION_SECRET=random-session-secret-2024" \
  -e "INTERNAL_API_KEY=sk-internal-2024-secret" \
  -e "TZ=Asia/Shanghai" \
  new-api-custom:latest
```

## 5. 验证

```bash
# join-project
wget -qO- --header="X-Internal-Key: sk-internal-2024-secret" \
  --header="Content-Type: application/json" \
  --post-data='{"platform_user_id":"e6c63594-...","project_id":7}' \
  http://localhost:3000/api/internal/join-project
# → {"project_name":"神话复苏1","success":true}

# balance
wget -qO- --header="X-Internal-Key: sk-internal-2024-secret" \
  "http://localhost:3000/api/internal/user-balance?platform_user_id=e6c63594-...&project_id=7"
# → {"balance_quota":0,"balance_yuan":0}

# 管理后台
curl http://localhost:3000/
# → <!doctype html><html lang="zh">...
```

## 6. 经验教训

### Go/GORM 陷阱

| 陷阱 | 说明 | 防范 |
|------|------|------|
| `_` 丢弃 error | GORM 查不到记录返回 `gorm.ErrRecordNotFound`，丢弃后无法区分"没找到"和"找到了零值" | **永远不要丢弃 error**，即使你认为后续条件能兜底 |
| 零值结构体 ≠ nil | `var alloc PersonalAllocation` 始终非 nil，`&alloc` 也非 nil | 函数应在 error 时返回 `nil, err`，调用方应检查 error |
| `bool` 零值陷阱 | Go `bool` 默认 `false`，`!false = true` → 零值结构体会通过 `!IsActive` 检查 | 加 `Id > 0` 正值校验作为兜底 |

### Docker 构建

| 问题 | 解决 |
|------|------|
| `bun.lock` 硬编码中国镜像 URL，在容器内 CDN 404 | 替换为 `registry.npmjs.org` |
| 用占位文件编译导致前端丢失 | **永远做完整构建**，不要 hack 占位文件 |
| `docker cp` 替换运行中二进制 → "Text file busy" | 先 stop → cp → start |
| Docker Hub 连不上 | 确保 Docker Desktop 代理配置正确 |

### 调试技巧

```bash
# 查 Docker 容器日志定位错误源
docker logs sora-new-api --tail 50
docker logs sora-ui-backend --tail 50

# 直接查数据库验证数据状态
docker exec sora-postgres psql -U sorauser -d newapi -c "SELECT * FROM personal_allocation WHERE ..."

# 用 wget 从容器内部测试内部 API（绕过前端和代理层）
docker exec sora-new-api wget -qO- --post-data='...' http://localhost:3000/api/internal/...
```

## 7. 修改的文件

| 文件 | 修改内容 |
|------|---------|
| `new-api/controller/internal.go:300` | 加 `inactiveErr` + `inactive.Id > 0` 检查 |
| `new-api/web/bun.lock` | 1158 处 `npmmirror.com` → `npmjs.org` |
| `new-api/Dockerfile` | 无永久修改（临时修改已还原） |
