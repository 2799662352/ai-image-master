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
| Node.js | 18.0.0 | 20.x LTS |
| npm | 9.0.0 | 10.x |
| Python | 3.x | (仅 Windows 原生模块需要) |
| Visual Studio Build Tools | 2019+ | (仅 Windows 原生模块需要) |

## 开发模式

```bash
# 启动开发服务器 (带 HMR)
npm run dev

# 预览生产构建
npm run preview
```

## 构建流程

### 完整构建流程

```bash
# 1. 安装依赖
npm install

# 2. 类型检查
npm run typecheck

# 3. 运行测试
npm test

# 4. 构建应用
npm run build:win     # Windows
npm run build:mac     # macOS
npm run build:linux   # Linux
npm run build:all     # 所有平台
```

### 构建脚本说明

| 脚本 | 说明 |
|------|------|
| `npm run build:vite` | 仅构建 Vite (main/preload/renderer) |
| `npm run build` | Vite 构建 + Windows 打包 |
| `npm run build:win` | Windows NSIS + Portable |
| `npm run build:win64` | Windows x64 |
| `npm run build:mac` | macOS DMG + ZIP |
| `npm run build:linux` | Linux AppImage + DEB |
| `npm run build:all` | 所有平台 |
| `npm run build:dir` | 目录打包 (用于测试) |
| `npm run pack` | 仅打包目录，不生成安装程序 |
| `npm run dist` | 仅 electron-builder (需先运行 build:vite) |
| `npm run release` | 构建并发布到 GitHub |

### 构建输出

```
release/
├── win-unpacked/                    # Windows 解压版
│   ├── CATIMATION-Cyberpunk Master.exe
│   ├── resources/
│   │   ├── app.asar                 # 应用代码 (压缩)
│   │   └── app.asar.unpacked/       # 解压的资源
│   └── locales/                     # 语言包
├── CATIMATION-Cyberpunk Master-1.0.2-Setup.exe  # NSIS 安装程序
├── CATIMATION-Cyberpunk Master-1.0.2-Portable.exe  # 便携版
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

**Portable 便携版：**
- 无需安装，解压即用
- 配置文件存储在应用目录

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
  provider: github
  owner: 2799662352
  repo: ai-image-master
  releaseType: release

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

```bash
# 1. 更新版本号
npm version patch  # 或 minor, major

# 2. 构建并发布
npm run release

# 3. 在 GitHub 发布 Release
# electron-builder 会自动上传构建产物
```

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
```bash
CSC_LINK=path/to/certificate.pfx
CSC_KEY_PASSWORD=your_password
```

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
npm install
npm run postinstall
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
npm run build:dir

# 查看构建调试信息
cat release/builder-debug.yml

# 验证 ASAR 内容
npx asar list release/win-unpacked/resources/app.asar
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
