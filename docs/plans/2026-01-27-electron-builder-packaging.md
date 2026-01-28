# CATIMATION-Cyberpunk Master Electron 打包计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 使用 electron-builder 最佳实践将 CATIMATION-Cyberpunk Master 打包为 Windows 桌面应用，使用新 logo 作为启动器图标。

**Architecture:** 
- 使用 electron-builder 26.4.0 进行打包
- 生成 NSIS 安装包（支持用户选择安装目录）和便携版
- 配置优化的文件排除规则，减小安装包体积
- 使用新 logo 生成多尺寸图标文件

**Tech Stack:** 
- Electron 28.0.0
- electron-builder 26.4.0
- NSIS (Windows 安装程序)
- ImageMagick 或在线工具 (图标转换)

---

## 前置条件

1. Node.js 已安装 (建议 18+)
2. 项目依赖已安装 (`npm install`)
3. 新 logo 文件位于项目根目录: `lQLPKIIzYQI-oU_MoMyusN5w3Ih7aMhgCVE586l9-QA_174_160.png`

---

## Task 1: 准备图标文件

**目标:** 从新 logo 创建 electron-builder 所需的各种格式图标

**Files:**
- Source: `lQLPKIIzYQI-oU_MoMyusN5w3Ih7aMhgCVE586l9-QA_174_160.png`
- Create: `build/icon.png` (256x256 或更大的 PNG)
- Create: `build/icon.ico` (Windows 多尺寸 ICO，包含 16x16, 32x32, 48x48, 64x64, 128x128, 256x256)
- Create: `build/icon.icns` (macOS 图标，如需要)

### Step 1: 复制新 logo 到 build 目录

**命令:**
```powershell
Copy-Item -Path "lQLPKIIzYQI-oU_MoMyusN5w3Ih7aMhgCVE586l9-QA_174_160.png" -Destination "build/icon.png" -Force
```

### Step 2: 创建 Windows ICO 文件

**方法 A: 使用在线工具 (推荐简单方案)**
1. 访问 https://icoconvert.com/ 或 https://convertico.com/
2. 上传 `build/icon.png`
3. 选择包含 16x16, 32x32, 48x48, 64x64, 128x128, 256x256 尺寸
4. 下载生成的 .ico 文件
5. 保存为 `build/icon.ico`

**方法 B: 使用 ImageMagick (如已安装)**
```powershell
# 安装 ImageMagick (如未安装)
# winget install ImageMagick.ImageMagick

# 生成多尺寸 ICO
magick convert build/icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico
```

**方法 C: 使用 npm 包 png-to-ico**
```powershell
npx png-to-ico build/icon.png > build/icon.ico
```

### Step 3: 验证图标文件

**检查文件是否存在:**
```powershell
Get-ChildItem build/icon.*
```

**预期输出:**
```
icon.ico
icon.png
```

---

## Task 2: 优化 electron-builder 配置

**目标:** 根据最佳实践优化 package.json 中的 build 配置

**Files:**
- Modify: `package.json`

### Step 1: 更新 package.json 的 build 配置

将 `package.json` 中的 `build` 部分替换为以下优化配置:

```json
{
  "name": "catimation-cyberpunk-master",
  "version": "1.0.0",
  "description": "CATIMATION-Cyberpunk Master - AI图片生成桌面应用",
  "main": "electron/main.js",
  "author": "CATIMATION",
  "license": "MIT",
  "scripts": {
    "start": "electron .",
    "dev": "electron . --dev",
    "build": "electron-builder",
    "build:win": "electron-builder --win",
    "build:win64": "electron-builder --win --x64",
    "build:win32": "electron-builder --win --ia32",
    "build:mac": "electron-builder --mac",
    "build:linux": "electron-builder --linux",
    "build:all": "electron-builder -mwl",
    "build:dir": "electron-builder --dir",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "electron-store": "^8.1.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^26.4.0"
  },
  "build": {
    "appId": "com.catimation.cyberpunk-master",
    "productName": "CATIMATION-Cyberpunk Master",
    "copyright": "Copyright © 2024-2026 CATIMATION",
    "artifactName": "${productName}-${version}-${os}-${arch}.${ext}",
    "directories": {
      "output": "dist",
      "buildResources": "build"
    },
    "files": [
      "**/*",
      "!dist/**",
      "!build/**",
      "!docs/**",
      "!node_modules/.cache/**",
      "!**/*.md",
      "!.git/**",
      "!.gitignore",
      "!*.mp4",
      "!videos/**",
      "!assets/templates/**",
      "!lQLPKIIzYQI-oU_MoMyusN5w3Ih7aMhgCVE586l9-QA_174_160.png",
      "!柏拉图api.md",
      "!**/*.map",
      "!**/*.ts",
      "!.env*",
      "!electron-builder.yml",
      "!tsconfig.json"
    ],
    "extraResources": [
      {
        "from": "assets/templates",
        "to": "templates",
        "filter": ["**/*.png", "**/*.jpg"]
      }
    ],
    "asar": true,
    "compression": "normal",
    "removePackageScripts": true,
    "win": {
      "target": [
        {
          "target": "nsis",
          "arch": ["x64"]
        },
        {
          "target": "portable",
          "arch": ["x64"]
        }
      ],
      "icon": "build/icon.ico",
      "publisherName": "CATIMATION",
      "legalTrademarks": "CATIMATION-Cyberpunk Master"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowElevation": true,
      "allowToChangeInstallationDirectory": true,
      "deleteAppDataOnUninstall": false,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "CATIMATION Cyberpunk Master",
      "installerIcon": "build/icon.ico",
      "uninstallerIcon": "build/icon.ico",
      "installerLanguages": ["zh_CN", "en_US"],
      "language": "2052",
      "runAfterFinish": true,
      "installerSidebar": null,
      "uninstallerSidebar": null
    },
    "portable": {
      "artifactName": "${productName}-${version}-Portable.${ext}"
    },
    "mac": {
      "target": ["dmg", "zip"],
      "icon": "build/icon.png",
      "category": "public.app-category.graphics-design",
      "darkModeSupport": true
    },
    "dmg": {
      "title": "${productName}",
      "icon": "build/icon.png"
    },
    "linux": {
      "target": ["AppImage", "deb"],
      "icon": "build/icon.png",
      "category": "Graphics",
      "maintainer": "CATIMATION <hi@lazycat.ai>",
      "synopsis": "AI图片生成桌面应用"
    }
  }
}
```

### Step 2: 验证 JSON 语法

```powershell
# 使用 Node.js 验证 JSON
node -e "require('./package.json'); console.log('✅ package.json 语法正确')"
```

**预期输出:** `✅ package.json 语法正确`

---

## Task 3: 更新 Electron 主进程图标路径

**目标:** 确保 Electron 窗口使用正确的图标

**Files:**
- Modify: `electron/main.js:48`

### Step 1: 检查并更新图标路径

在 `electron/main.js` 第 48 行，图标路径应该改为:

```javascript
// 原代码
icon: path.join(__dirname, '../images/icon.png'),

// 改为 (优化: 使用 build 目录的图标)
icon: path.join(__dirname, '../build/icon.png'),
```

**完整的 createWindow 函数应包含:**
```javascript
function createWindow() {
    console.log(`[Performance] Window created: ${Date.now() - startTime}ms`);
    
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'CATIMATION-Cyberpunk Master',
        icon: path.join(__dirname, '../build/icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });
    // ... 其余代码
}
```

---

## Task 4: 安装依赖并测试开发模式

**目标:** 确保所有依赖正确安装，应用可以在开发模式运行

### Step 1: 安装依赖

```powershell
cd D:\tecx\text\temp-ai-image-master-source
npm install
```

**预期输出:** 无错误，依赖安装成功

### Step 2: 运行开发模式测试

```powershell
npm run dev
```

**预期结果:**
- 应用窗口正常打开
- 左上角 logo 显示为新图标
- 任务栏图标显示为新图标
- 无控制台错误

### Step 3: 关闭应用后继续

按 `Ctrl+C` 或关闭应用窗口

---

## Task 5: 构建 Windows 安装包

**目标:** 使用 electron-builder 构建 Windows 安装包

### Step 1: 构建打包目录 (测试构建配置)

```powershell
npm run build:dir
```

**预期输出:**
- `dist/win-unpacked/` 目录创建
- 包含可执行文件和资源

### Step 2: 验证打包目录

```powershell
Get-ChildItem dist/win-unpacked/*.exe
```

**预期输出:** `CATIMATION-Cyberpunk Master.exe`

### Step 3: 测试打包后的应用

```powershell
# 运行打包后的应用
Start-Process "dist/win-unpacked/CATIMATION-Cyberpunk Master.exe"
```

**预期结果:**
- 应用正常启动
- 图标显示正确
- 功能正常工作

---

## Task 6: 构建完整安装包

**目标:** 构建 NSIS 安装包和便携版

### Step 1: 构建完整安装包

```powershell
npm run build:win
```

**预期耗时:** 2-5 分钟

**预期输出文件 (在 dist/ 目录):**
- `CATIMATION-Cyberpunk Master-1.0.0-win-x64.exe` (NSIS 安装包)
- `CATIMATION-Cyberpunk Master-1.0.0-Portable.exe` (便携版)

### Step 2: 验证生成的文件

```powershell
Get-ChildItem dist/*.exe | Select-Object Name, Length, LastWriteTime
```

### Step 3: 测试 NSIS 安装包

1. 双击运行 `CATIMATION-Cyberpunk Master-1.0.0-win-x64.exe`
2. 验证:
   - 安装向导正常显示
   - 可以选择安装目录
   - 安装程序图标显示为新 logo
   - 安装完成后桌面快捷方式图标正确
   - 开始菜单快捷方式正确
   - 应用启动正常

### Step 4: 测试便携版

1. 将便携版 exe 复制到其他目录
2. 双击运行
3. 验证应用正常启动，无需安装

---

## Task 7: 清理和提交

**目标:** 清理不必要的文件并提交更改

### Step 1: 清理临时文件

```powershell
# 删除临时构建文件 (可选，保留 dist 以供分发)
Remove-Item -Recurse -Force dist/win-unpacked -ErrorAction SilentlyContinue
```

### Step 2: 提交更改 (如使用 Git)

```bash
git add build/icon.png build/icon.ico package.json electron/main.js
git commit -m "feat: 配置 electron-builder 打包，使用新 logo 作为应用图标"
```

---

## 构建产物清单

构建完成后，`dist/` 目录应包含:

| 文件名 | 类型 | 说明 |
|--------|------|------|
| `CATIMATION-Cyberpunk Master-1.0.0-win-x64.exe` | NSIS 安装包 | 完整安装程序，支持自定义安装目录 |
| `CATIMATION-Cyberpunk Master-1.0.0-Portable.exe` | 便携版 | 免安装，可直接运行 |
| `win-unpacked/` | 目录 | 解压后的应用文件 (调试用) |

---

## 故障排除

### 问题: 图标不显示或显示错误
- 确保 `build/icon.ico` 包含多尺寸图标
- 清除 electron-builder 缓存: `Remove-Item -Recurse $env:LOCALAPPDATA\electron-builder\Cache`

### 问题: 构建失败 "icon not found"
- 确保 `build/icon.ico` 和 `build/icon.png` 都存在
- 检查文件路径大小写

### 问题: 安装包太大
- 检查 `files` 排除规则是否正确
- 使用 `npm run build:dir` 检查打包内容
- 确认视频文件和大型资源已被排除

### 问题: 应用启动慢
- 确保 `asar: true` 开启
- 检查是否有不必要的文件被打包

---

## 进阶配置 (可选)

### 代码签名 (生产环境推荐)

如需对安装包进行代码签名，添加以下配置:

```json
"win": {
  "signtoolOptions": {
    "certificateFile": "path/to/certificate.pfx",
    "certificatePassword": "${env.WIN_CSC_KEY_PASSWORD}"
  }
}
```

### 自动更新 (需服务器支持)

```json
"publish": {
  "provider": "generic",
  "url": "https://your-update-server.com/updates"
}
```

---

**计划完成！准备好执行了吗？**
