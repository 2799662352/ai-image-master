# 修复 electron-builder 配置

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 electron-builder 26.4.0 配置错误，恢复构建能力

**Architecture:** 
- electron-builder 26.4.0 有 breaking changes
- `mac.notarize` 现在是 boolean 类型（启用/禁用）
- `win.publisherName` 已弃用，需移除

**Tech Stack:** electron-builder 26.4.0, package.json

---

## 问题分析

| 问题 | 当前值 | 修复方案 |
|-----|-------|---------|
| `mac.notarize` 类型错误 | `{ teamId: "..." }` | 改为 `false`（禁用）或移除 |
| `win.publisherName` 已弃用 | `"CATIMATION"` | 移除此属性 |

### Context7 参考

electron-builder 26.4.0 的 notarize 配置说明：
> "Whether to disable electron-builder's @electron/notarize integration."
> 
> Note: In order to activate the notarization step You MUST specify one of the following via environment variables:
> 1. `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
> 2. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
> 3. `APPLE_KEYCHAIN` and `APPLE_KEYCHAIN_PROFILE`

---

## Task 1: 修复 mac.notarize 配置

**Files:**
- Modify: `package.json:154-156`

**Step 1: 将 notarize 对象改为 boolean**

将：
```json
"notarize": {
  "teamId": "${env.APPLE_TEAM_ID}"
}
```

改为：
```json
"notarize": false
```

**说明：** 
- 设为 `false` 禁用内置公证
- 如果需要公证，只需设环境变量 `APPLE_TEAM_ID` 等，然后设为 `true`
- 当前没有配置 Apple 证书，先禁用

---

## Task 2: 移除 win.publisherName

**Files:**
- Modify: `package.json:112`

**Step 1: 删除 publisherName 行**

删除：
```json
"publisherName": "CATIMATION",
```

**说明：**
- `publisherName` 在 electron-builder 26.x 中已弃用
- `legalTrademarks` 仍然有效，保留

---

## Task 3: 验证构建

**Step 1: 运行构建命令**

```bash
npm run build:vite && npm run build
```

预期结果：构建成功，无配置错误

**Step 2: 提交修复**

```bash
git add package.json
git commit -m "fix: update electron-builder config for v26.4.0

- Change mac.notarize from object to boolean (false)
- Remove deprecated win.publisherName property"
```

---

## 验证清单

- [ ] `npm run build` 成功
- [ ] 无配置验证错误
- [ ] 测试仍然 100% 通过
