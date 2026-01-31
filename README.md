# AI图片大师 - 完整源码参考

> 完整扒取自 https://imagen.apiyi.com/ (2025-12-01)
> 使用 Puppeteer MCP + Fetch 工具完整扒取
> 仅供学习参考使用

## 🚀 快速启动

```bash
cd "D:\tecx\text\nano banann"
python -m http.server 8888
# 浏览器访问 http://localhost:8888
```

## 📁 完整项目结构

```
nano banann/
├── index.html              ← 主页面 (完整版 95KB)
├── manifest.json           ← PWA 配置
├── version.json            ← 版本信息
├── sitemap.xml             ← 站点地图
├── browserconfig.xml       ← 浏览器配置
├── debug-helper.js         ← 调试工具
├── README.md               ← 说明文档
│
├── js/                     ← JavaScript 模块
│   ├── api.js              ← API 调用类 AIImageAPI (129KB)
│   ├── app.js              ← 主应用类 AIImageApp (123KB)
│   ├── components.js       ← UI 组件类 UIComponents
│   ├── modules/
│   │   ├── generate-page.js    ← 图片生成页面 (70KB)
│   │   ├── batch-page.js       ← 批量生成页面 (65KB)
│   │   ├── history-page.js     ← 历史记录页面 (36KB)
│   │   ├── compare-page.js     ← 模型对比页面 (38KB)
│   │   └── prompt-templates.js ← 提示词模板 (11KB)
│   └── services/
│       └── r2-storage.js       ← R2 云存储服务 (14KB)
│
├── css/                    ← 样式文件
│   ├── main.css            ← CSS 入口文件
│   ├── base.css            ← 基础样式 (渐变、毛玻璃)
│   ├── components.css      ← 组件样式 (按钮、模态框)
│   ├── animations.css      ← 动画效果
│   └── responsive.css      ← 响应式样式 (9KB)
│
├── images/                 ← 图片资源
│   ├── logo.png            ← 网站 Logo
│   ├── favicon.*           ← 各种尺寸的图标
│   ├── apple-touch-icon.png ← iOS 图标
│   ├── add-key-cost-by-call.png ← API 计费说明图
│   └── templates/          ← 提示词模板预览图 (12张)
│       ├── shouban.png     ← 手办场景
│       ├── tiezhi.png      ← 贴纸效果
│       ├── duoyuansu.png   ← 多元素融合
│       ├── simuphot.png    ← 模拟自拍
│       ├── 3dprint.png     ← 3D打印场景
│       ├── dongshen.png    ← 动漫转真人
│       ├── yinhua.png      ← 提取印花
│       ├── koutu.png       ← 精细抠图
│       ├── gaoqing.png     ← 模糊变清晰
│       ├── santu.png       ← 三视图
│       ├── yuansu.png      ← 元素替换
│       └── yizhi.png       ← 图案移植
│
└── data/
    └── prompt-templates.json ← 完整提示词模板数据
```

## 🛠 技术栈

| 技术 | 说明 |
|------|------|
| Tailwind CSS | CDN 方式引入，无需编译 |
| Font Awesome 6 | 图标库 |
| JSZip | 批量下载压缩功能 |
| 原生 ES6 Class | 无框架依赖，纯 JavaScript |
| LocalStorage | 本地历史记录存储 |
| R2 Storage | Cloudflare R2 云存储集成 |
| PWA | 渐进式 Web 应用支持 |

## 🎯 核心功能模块

### 1. 图片生成 (generate-page.js)
- 支持多种 AI 模型 (Gemini, Seedream, Sora, Flux)
- 参考图上传 (支持拖拽、粘贴、多图)
- 多种比例和分辨率选择
- 实时进度显示

### 2. 批量生成 (batch-page.js)
- 抽卡模式 (同一提示词生成多张)
- 多提示词模式 (批量不同提示词)
- 并发控制 (最多3个同时)
- 费用预估

### 3. 模型对比 (compare-page.js)
- 双模型同时生成对比
- 用户评价功能
- 自动同步参考图

### 4. 历史记录 (history-page.js)
- 自动保存生成记录
- R2 云端存储迁移
- 批量下载和删除

### 5. API 管理 (api.js)
- 多模型支持和切换
- 智能超时和重试机制
- 图片上传到 R2
- 网络可访问性检测

## 🎨 UI/UX 特点

- **紫色渐变背景** - 视觉冲击力强
- **毛玻璃效果** - backdrop-filter: blur()
- **响应式设计** - 移动端适配完善
- **无障碍优化** - ARIA 属性支持
- **动画效果** - 流畅的交互反馈

## 📝 学习要点

1. **模块化架构** - 每个功能独立模块
2. **事件驱动** - CustomEvent 模块间通信
3. **文件上传** - FileReader + Base64 转换
4. **批量并发** - Promise.all + 队列控制
5. **本地存储** - localStorage + 存储优化
6. **云端集成** - R2 Storage API 使用
7. **版本管理** - 自动检测更新机制

## ⚠️ 注意事项

1. 需要配置有效的 API Key 才能使用生成功能
2. R2 云存储需要配置 Worker URL
3. 部分模型有使用限制和计费说明
4. 本地运行需要 HTTP 服务器 (CORS 限制)

---

*扒取时间: 2025-12-01*
*扒取工具: Cursor + Puppeteer MCP + Fetch*
