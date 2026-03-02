# CATIMATION 打包指南

本文档用于本项目的标准打包流程（Windows 为主），并包含版本升级、产物校验与常见故障排查。

## 1. 前置条件

- Node.js 18+（建议 20+）
- npm 9+
- 已在项目根目录执行 `npm install`
- 项目路径示例：`D:\tecx\text\temp-ai-image-master-source`

## 2. 配置位置说明

- 版本号来源：`package.json` 的 `version`
- 打包配置来源：`electron-builder.yml`
- 技能资源目录：项目根目录 `skills/`
- 打包输出目录：`release/`

说明：
- 本项目使用外部配置文件 `electron-builder.yml`。
- `skills/**/*.md` 通过 `extraResources` 打入安装资源目录（`resources/skills`）。

## 3. 升级版本号

发布前先改 `package.json`：

```json
{
  "version": "2.0.6"
}
```

建议每次发布只改一个版本，避免跳号和历史混乱。

## 4. 标准打包命令

在项目根目录执行：

```bash
npm run build
```

该命令会顺序执行：
1. `npm run build:vite`
2. `electron-builder`

## 5. 产物检查（必须）

打包完成后检查以下内容：

1. 安装包存在  
   - `release/catimation-cyberpunk-master-<version>-setup.exe`

2. 更新元数据版本正确  
   - `release/latest.yml` 中 `version` 与 `package.json` 一致

3. 技能资源已打包  
   - `release/win-unpacked/resources/skills/` 存在并包含 `SKILL.md`

4. 可执行文件可启动  
   - `release/win-unpacked/CATIMATION-Cyberpunk Master.exe`

## 6. 常见问题与处理

### 问题 A：NSIS 打包报错（mmap / cannot execute）

现象（示例）：
- `makensis.exe process failed`
- `failed creating mmap of ... nsis.7z`

常见原因：
- 旧构建产物被错误打入包内，导致体积异常大。

处理建议：
1. 确认 `electron-builder.yml` 被正确加载（看构建日志 `loaded configuration file=...`）。
2. 清理历史产物后重试（尤其 `release/win-unpacked` 和旧安装包）。
3. 确认 `files` 规则不会把安装包、缓存等再打回应用。

### 问题 B：`dist/main/index.js` not found in app.asar

常见原因：
- 构建配置冲突，导致 `files` 规则未按预期生效。

处理建议：
1. 统一只使用一套配置（本项目使用 `electron-builder.yml`）。
2. 重新执行完整构建，观察 `loaded configuration` 日志与 `files` 生效情况。

## 7. 推荐发布流程

1. 修改版本号（`package.json`）
2. 执行 `npm run build`
3. 完成产物检查（安装包、`latest.yml`、`skills`、启动）
4. 再进行推送与发布

---

如需按平台分别打包，可使用：
- `npm run build:win`
- `npm run build:mac`
- `npm run build:linux`
