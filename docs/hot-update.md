# CATIMATION 热更新发布指南

## 架构概览

应用采用 **COS 优先 + GitHub 兜底** 的双源热更新机制：

```
用户客户端启动
  │
  ├─① 检查腾讯云 COS（国内加速）
  │    https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
  │
  ├─ 成功 → 提示更新 / 下载安装
  │
  └─ 失败 → ② 自动切换 GitHub Releases（海外 / 备用）
       https://github.com/2799662352/ai-image-master/releases
```

核心文件：

| 文件 | 作用 |
|------|------|
| `src/main/updater.ts` | AutoUpdater 类，封装 electron-updater，支持 `switchProvider` 和 `fallback` |
| `src/main/index.ts` | 初始化 updater，配置 COS 主源 + GitHub fallback |
| `electron-builder.yml` | 构建配置，`publish` 段声明 COS + GitHub 双发布目标 |
| `scripts/upload-cos.js` | COS 上传脚本（exe + blockmap + latest.yml） |

## 发布新版本

### 1. 修改版本号

```bash
# package.json → "version": "x.y.z"
```

### 2. 构建

```bash
npm run build:win
```

产物在 `release/` 目录下：
- `catimation-cyberpunk-master-{version}-setup.exe` — 安装包
- `catimation-cyberpunk-master-{version}-setup.exe.blockmap` — 差分更新数据
- `latest.yml` — 版本元数据（electron-updater 靠它判断是否有新版）

### 3. 上传到 COS（国内用户）

```bash
npm run upload:cos
```

需要 `.env` 文件中配置：
```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=map-tiles-bucket-1345773498
COS_REGION=ap-guangzhou
```

或一步到位（构建 + 上传）：
```bash
npm run release:cn
```

### 4. 上传到 GitHub（海外 / 备用）

手动上传：
1. 到 https://github.com/2799662352/ai-image-master/releases 创建新 Release
2. Tag 填 `v{version}`（如 `v4.1.16`）
3. 上传 `release/` 下的三个文件

或用 CLI：
```bash
gh release create v4.1.16 --title "v4.1.16" --notes "更新说明" \
  release/catimation-cyberpunk-master-4.1.16-setup.exe \
  release/catimation-cyberpunk-master-4.1.16-setup.exe.blockmap \
  release/latest.yml
```

## Fallback 机制

在 `updater.ts` 中实现：

```typescript
// 初始化时配置 fallback
const updater = getAutoUpdaterInstance({
  provider: 'generic',
  url: 'https://...cos.../releases/',
  fallback: {
    provider: 'github',
    owner: '2799662352',
    repo: 'ai-image-master'
  }
})
```

当 COS 检查更新失败（网络超时、DNS 错误等），`autoUpdater.on('error')` 触发后：
1. 如果还没 fallback 过 → 自动调用 `switchProvider()` 切换到 GitHub
2. 用 GitHub 源重新 `checkForUpdates()`
3. 如果 GitHub 也失败 → 向用户显示错误

## 差分更新

`electron-builder` 的 NSIS 差分更新（blockmap）已启用：

```yaml
# electron-builder.yml
nsis:
  differentialPackage: true
```

用户更新时只下载变化的部分，而非整个 250MB 安装包。前提是 COS / GitHub 上同时存在：
- 新版 `.exe` + `.blockmap`
- `latest.yml`

## 常见问题

### Q: 老版本客户端检测不到 COS 上的更新？

老版本（< v4.1.15）在代码中硬编码了 `provider: 'github'`，只会检查 GitHub。用户需要先手动安装 v4.1.15+，之后的热更新才会走 COS。

### Q: COS 和 GitHub 的 latest.yml 版本不一致？

两边独立上传，可能短暂不一致。建议每次发版都同时上传两边。COS 用 `npm run upload:cos`，GitHub 手动上传或用 `gh` CLI。

### Q: 上传 COS 时 ECONNRESET？

通常是代理/VPN 干扰了 TLS 握手。切换直连或换节点后重试。

### Q: latest.yml 在 COS 上缓存了旧版本？

腾讯云 COS 默认不缓存，上传即生效。如果用了 CDN 加速，需要刷新缓存：
```
https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
```
