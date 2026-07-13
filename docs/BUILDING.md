# 构建与打包指南

本文档基于 [Context7](https://context7.com) 获取的 electron-builder 和 electron-vite 最佳实践编写。

## 目录

- [环境要求](#环境要求)
- [开发模式](#开发模式)
- [构建流程](#构建流程)
- [打包配置](#打包配置)
- [平台特定说明](#平台特定说明)
- [自动更新](#自动更新)
- [代码签名](#代码签名)
- [故障排除](#故障排除)

---

## 环境要求

| 工具 | 最低版本 | 推荐版本 |
|------|---------|---------|
| Node.js | 20.0.0 | 20.x LTS |
| pnpm | 10.12.4 | 10.12.4 |
| Python | 3.x | (仅 Windows 原生模块需要) |
| Visual Studio Build Tools | 2019+ | (仅 Windows 原生模块需要) |

## 开发模式

```bash
# 启动开发服务器 (带 HMR)
pnpm run dev

# 预览生产构建
pnpm run preview
```

## 构建流程

### 完整构建流程

```bash
# 1. 安装锁定依赖
pnpm install --frozen-lockfile

# 2. CI 诊断债务门禁（严格零错误检查仍为 pnpm run typecheck）
pnpm run typecheck:ci

# 3. 运行测试
pnpm run test:ci

# 4. 构建应用
pnpm run build:vite
pnpm run build:win64  # 本地 Windows x64 验证，不发布
```

### 构建脚本说明

| 脚本 | 说明 |
|------|------|
| `pnpm run build:vite` | 仅构建 main/preload/renderer |
| `pnpm run build:win64` | 本地 Windows x64 NSIS 验证 |
| `pnpm run build:dir` | 目录打包（用于调试） |
| `pnpm run pack` | 仅打包目录，不生成安装程序 |

正式安装包不从本地命令发布。唯一生产入口是 GitHub Actions 的 `Release` 工作流，
它调用 `_windows-release-build.yml` 并强制
`electron-builder --win --x64 --publish never`。
已有 canonical 目录可先设置 `$env:RELEASE_DIR='<目录>'`，再用
`pnpm run release:verify` 做只读复核；
配置 COS 只读凭据后，可用 `pnpm run release:cos:dry` 检查上传计划，不写远端。

### 构建输出

```
release/
├── win-unpacked/                    # Windows 解压版
│   ├── CATIMATION-Cyberpunk Master.exe
│   ├── resources/
│   │   ├── app.asar                 # 应用代码 (压缩)
│   │   └── app.asar.unpacked/       # 解压的资源
│   └── locales/                     # 语言包
├── catimation-cyberpunk-master-1.0.2-setup.exe  # NSIS 安装程序
├── catimation-cyberpunk-master-1.0.2-setup.exe.blockmap
├── latest.yml / beta.yml / alpha.yml            # 由版本频道决定
└── builder-debug.yml                # 构建调试信息
```

## 打包配置

### 配置文件结构

项目使用独立的 `electron-builder.yml` 配置文件（推荐方式）：

```yaml
# electron-builder.yml (摘要)
appId: com.catimation.cyberpunk-master
productName: CATIMATION-Cyberpunk Master

directories:
  output: release        # 输出目录
  buildResources: build  # 构建资源目录

files:
  - dist/**/*           # 包含 Vite 构建输出
  - package.json
  - "!**/*.ts"          # 排除 TypeScript 源码
  - "!**/*.map"         # 排除 sourcemap

asar: true              # 启用 ASAR 打包
compression: maximum    # 最大压缩
```

### 构建资源目录

```
build/
├── icon.ico            # Windows 图标
├── icon.png            # macOS/Linux 图标
├── entitlements.mac.plist  # macOS 权限
└── icons/              # 多尺寸图标
    ├── 16x16.png
    ├── 32x32.png
    ├── 64x64.png
    ├── 128x128.png
    ├── 256x256.png
    ├── 512x512.png
    ├── 1024x1024.png
    └── icon.icns       # macOS 图标包
```

## 平台特定说明

### Windows

**NSIS 安装程序特性：**
- 用户可选安装目录
- 桌面 + 开始菜单快捷方式
- 支持简体中文和英语
- 差分更新支持

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  differentialPackage: true
```

当前正式交付只包含 Windows x64 NSIS，不发布 Portable、macOS 或 Linux 制品。

### macOS

**权限配置 (entitlements.mac.plist)：**
```xml
<!-- 允许 JIT 编译 (Electron/V8 需要) -->
<key>com.apple.security.cs.allow-jit</key>
<true/>

<!-- 网络访问 -->
<key>com.apple.security.network.client</key>
<true/>
```

**Hardened Runtime：**
```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
```

### Linux

**支持格式：**
- AppImage (推荐，免安装)
- DEB (Debian/Ubuntu)

## 自动更新

### 配置

```yaml
# electron-builder.yml
publish:
  - provider: generic
    url: https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/

generateUpdatesFilesForAllChannels: true
```

### 使用方式

应用内置 `electron-updater`，启动时自动检查更新：

```typescript
// src/main/index.ts
import { autoUpdater } from 'electron-updater'

autoUpdater.checkForUpdatesAndNotify()
```

### 发布流程

更新 `package.json` / `pnpm-lock.yaml`，新增
`docs/releases/v<version>.md`，合并到 `main` 后手动运行 GitHub Actions
`Release`。先执行 `dry_run=true`；成功后再以相同版本正式运行。详细状态机、基线迁移和
回退见 `docs/hot-update.md`。

## 代码签名

### Windows

1. **获取证书**: 购买 EV 代码签名证书
2. **配置签名**:

```yaml
# electron-builder.yml
win:
  signingHashAlgorithms:
    - sha256
  certificateSubjectName: "Your Company Name"
  timeStampServer: "http://timestamp.digicert.com"
```

3. **环境变量**:
GitHub `production` Environment 使用：

```text
WIN_CERTIFICATE=<PFX/P12 的 base64、路径或 HTTPS URL>
WIN_CERTIFICATE_PASSWORD=<证书密码>
WIN_CERTIFICATE_SUBJECT_NAME=<可选的主题校验值>
```

三个值完全未配置时允许生成明确标记为 unsigned 的发布；证书或密码只配置一部分会阻止
发布。signed 模式必须通过 Authenticode 状态、主题和时间戳验证。

### macOS

1. **Apple Developer 账户**: 加入 Apple Developer Program
2. **配置公证**:

```yaml
mac:
  notarize:
    teamId: "YOUR_TEAM_ID"
```

3. **环境变量**:
```bash
APPLE_ID=your@email.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

## 故障排除

### 常见问题

**Q: 构建失败 "Cannot find module"**
```bash
# 重新安装依赖
rm -rf node_modules
pnpm install --frozen-lockfile
pnpm run postinstall
```

**Q: Windows 打包失败 "EPERM"**
- 关闭所有正在运行的应用实例
- 以管理员身份运行终端

**Q: macOS 签名失败**
- 检查 Keychain 中的证书
- 运行 `security find-identity -v -p codesigning`

**Q: ASAR 解包问题**
```yaml
# 特定模块需要解包
asarUnpack:
  - "**/node_modules/native-module/**"
```

### 调试构建

```bash
# 生成目录打包 (不压缩，便于检查)
pnpm run build:dir

# 查看构建调试信息
cat release/builder-debug.yml

# 验证 ASAR 内容
pnpm exec asar list release/win-unpacked/resources/app.asar
```

### 日志位置

| 平台 | 日志路径 |
|------|---------|
| Windows | `%APPDATA%\CATIMATION-Cyberpunk Master\logs\` |
| macOS | `~/Library/Logs/CATIMATION-Cyberpunk Master/` |
| Linux | `~/.config/CATIMATION-Cyberpunk Master/logs/` |

---

## 参考资源

- [electron-builder 文档](https://www.electron.build/)
- [electron-vite 文档](https://electron-vite.org/)
- [Electron 文档](https://www.electronjs.org/docs)
- [Context7 - electron-builder](https://context7.com/electron-userland/electron-builder)
- [Context7 - electron-vite](https://context7.com/alex8088/electron-vite-docs)
