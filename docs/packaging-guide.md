# CATIMATION Windows x64 打包指南

生产发布只支持 Windows x64 NSIS，并由 GitHub Actions 的手动 `Release` 工作流完成。
本地打包只用于诊断，不能上传 GitHub Release 或 COS。

## 前置条件

- Node.js 20；
- pnpm 10.12.4；
- `pnpm install --frozen-lockfile` 成功；
- `package.json` 与 `pnpm-lock.yaml` 版本一致。

## 本地验证

```bash
pnpm run typecheck:ci
pnpm run test:workflows
pnpm run test:release
pnpm run test:ci
pnpm run build:win64
```

本地输出在 `release/`，应包含：

- `catimation-cyberpunk-master-<version>-setup.exe`；
- 同名 `.exe.blockmap`；
- 由版本后缀决定的 `latest.yml`、`beta.yml` 或 `alpha.yml`；
- `win-unpacked/CATIMATION-Cyberpunk Master.exe`。

`electron-builder.yml` 是唯一打包配置。正式 workflow 额外生成并验证
`release-manifest.json`、`SHA256SUMS.txt`，然后将同一 canonical artifact 依次用于
GitHub Release 与 COS。无论制品是本次新构建还是从历史 run/Release 恢复，都会在
Windows runner 上重新核对 manifest 声明的 signed/unsigned 状态、签名主题和时间戳。

## 正式发布

1. 更新 `package.json` 和 `pnpm-lock.yaml`；
2. 新增 `docs/releases/v<version>.md`；
3. 合并到 `main` 并等待 CI；
4. 手动运行 `Release`，先使用 `dry_run=true`；
5. dry run 成功后，以同一版本运行正式发布。

不要恢复已删除的 `upload:cos`、`release:cn` 或本地 `release` 脚本。生产打包固定执行
`electron-builder --win --x64 --publish never`，外部发布由后续受保护 job 完成。

## 常见故障

- NSIS `mmap` / `cannot execute`：确认旧 `release/` 内容未被 `files` 规则重新打包；
- `dist/main/index.js not found`：确认日志只加载 `electron-builder.yml`，并先完成
  `pnpm run build:vite`；
- updater manifest 名称错误：检查 SemVer 后缀和 `generateUpdatesFilesForAllChannels`；
- Codex、FFmpeg 或 Docker MCP 下载散列不匹配：不要重试绕过；核对上游 Release，
  通过版本升级 PR 同步更新 `scripts/runtime-assets.lock.json`；
- 生产 workflow 因 signing 配置失败：证书与密码必须同时配置或同时留空；
- 远端同名对象冲突：不可覆盖；应恢复原 canonical artifact，而不是重建同版本。

完整发布状态机、回退和 COS 配置见 `docs/hot-update.md`。
