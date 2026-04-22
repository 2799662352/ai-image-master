## v4.0.6 更新内容

### 差分更新优化
- 修复 GitHub provider 下差分更新无法生效的问题
- 配置 `previousBlockmapBaseUrlOverride`，使 electron-updater 能正确定位旧版 blockmap 文件
- 相邻版本更新现在只需下载变更部分（约 5-15MB），而非完整安装包（~250MB）

### 更新日志增强
- 下载进度日志增加 total MB 和下载速度显示，便于验证差分更新效果
