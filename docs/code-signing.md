# 代码签名配置指南

本文档说明如何为 CATIMATION-Cyberpunk Master 配置代码签名。
当前生产流水线只发布 Windows x64，并直接支持可导出的 PFX/P12 证书。Azure Trusted
Signing、SignPath 和下文 macOS 流程仅作选型参考，尚未接入正式 workflow。

---

## 证书获取指南

### 证书类型选择

| 平台 | 证书类型 | 价格 | 推荐供应商 | 说明 |
|------|---------|------|-----------|------|
| Windows | **Azure Trusted Signing** | **$9.99/月** | Microsoft | 新服务，性价比最高 |
| Windows | SignPath (开源项目) | **免费** | SignPath.io | 仅限开源项目 |
| Windows | EV Code Signing | $300-500/年 | DigiCert, Sectigo | 即时信任，无 SmartScreen 警告 |
| Windows | OV Code Signing | $100-200/年 | Comodo, GlobalSign | 需要积累信誉 |
| macOS | Developer ID | $99/年 | Apple Developer Program | 必需，否则无法运行 |

### 免费/低成本 Windows 签名选项

#### 1. Azure Trusted Signing (推荐 - $9.99/月)

Microsoft 2024 年推出的新服务，是目前**性价比最高**的选择：

- **价格**: $9.99/月 (~$120/年)
- **优势**: 微软官方服务，即时 SmartScreen 信任
- **要求**: Azure 订阅 + 身份验证

**设置步骤:**
1. 创建 Azure 账户: [portal.azure.com](https://portal.azure.com)
2. 搜索 "Trusted Signing" 服务
3. 创建 Trusted Signing 账户
4. 完成身份验证
5. 配置 GitHub Actions 使用 Azure CLI 签名

#### 2. SignPath (开源项目免费)

如果项目是**开源**的，SignPath 提供免费签名：

- **价格**: 免费 (开源项目)
- **要求**: 
  - 项目必须开源 (GitHub/GitLab 公开仓库)
  - 通过 SignPath 审核
  
**申请步骤:**
1. 访问 [signpath.io](https://signpath.io/)
2. 选择 "Open Source" 计划
3. 提交项目申请
4. 等待审核 (通常 1-2 周)

#### 3. 自签名证书 (仅供开发测试)

免费但**不推荐用于生产**，用户会看到安全警告：

```powershell
# 创建自签名证书
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=My Dev Cert" -CertStoreLocation Cert:\CurrentUser\My
Export-PfxCertificate -Cert $cert -FilePath "dev-cert.pfx" -Password (ConvertTo-SecureString -String "password" -Force -AsPlainText)
```

### 推荐方案

| 场景 | 推荐方案 | 年成本 |
|------|---------|--------|
| 开源项目 | SignPath 免费 + macOS $99 | ~$99/年 |
| 个人/小团队 | Azure Trusted Signing + macOS | ~$220/年 |
| 商业项目 | OV/EV 证书 + macOS | ~$250-500/年 |

### Windows 证书获取步骤

1. **选择证书供应商**
   - [DigiCert](https://www.digicert.com/code-signing/) - 业界标准，即时 SmartScreen 信任
   - [Sectigo](https://sectigo.com/ssl-certificates-tls/code-signing) - 性价比高
   - [SSL.com](https://www.ssl.com/certificates/ev-code-signing/) - 支持 HSM 托管
   - [Comodo](https://www.comodo.com/e-commerce/ssl-certificates/code-signing-certificate.php) - 入门级选择

2. **购买流程**
   - 访问供应商网站，选择 OV 或 EV 证书
   - 提交组织验证材料:
     - 营业执照 / 公司注册文件
     - 域名验证 (whois 或 DNS)
     - 电话验证

3. **接收证书**
   - 供应商会发送 .p12 或 .pfx 文件
   - 或通过 USB 令牌 (EV 证书) 交付

4. **证书编码 (CI/CD 用)**
   ```bash
   # Windows (PowerShell)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Out-File -Encoding ASCII cert-base64.txt
   
   # macOS/Linux
   base64 -i certificate.pfx -o cert-base64.txt
   ```

5. **存储到 GitHub `production` Environment Secrets**
   - 转到仓库 Settings > Environments > production
   - 添加 `WIN_CERTIFICATE`: Base64 编码的证书内容
   - 添加 `WIN_CERTIFICATE_PASSWORD`: 证书密码
   - 可选添加 `WIN_CERTIFICATE_SUBJECT_NAME`: 预期证书主题

### macOS 证书获取步骤

1. **注册 Apple Developer Program**
   - 访问 [developer.apple.com](https://developer.apple.com/programs/)
   - 费用: $99/年 (个人或组织)

2. **创建 Developer ID 证书**
   - 登录 [Apple Developer Portal](https://developer.apple.com/account/)
   - 进入 Certificates, Identifiers & Profiles
   - 创建 "Developer ID Application" 证书

3. **导出 .p12 文件**
   ```bash
   # 在 Keychain Access 中找到证书
   # 右键 > Export > 保存为 .p12 格式
   ```

4. **创建 App-Specific Password**
   - 访问 [appleid.apple.com](https://appleid.apple.com/)
   - Security > App-Specific Passwords > Generate

5. **存储到 GitHub Secrets**
   - `MAC_CERTIFICATE`: Base64 编码的 .p12
   - `MAC_CERTIFICATE_PASSWORD`: .p12 导出密码
   - `APPLE_ID`: Apple 账号邮箱
   - `APPLE_APP_SPECIFIC_PASSWORD`: App-Specific Password
   - `APPLE_TEAM_ID`: 团队 ID (在开发者门户中查看)

---

## Windows 代码签名

### 准备工作

1. **获取代码签名证书**
   - 从受信任的证书颁发机构 (CA) 购买代码签名证书
   - 推荐: DigiCert, Sectigo, GlobalSign, Comodo
   - 参考上方 "证书获取指南"

2. **本地构建环境变量**
   
   ```bash
   # Windows 签名证书配置
   set CSC_LINK=path/to/your-certificate.pfx
   set CSC_KEY_PASSWORD=your-certificate-password
   ```

   GitHub Actions 不直接读取以上本地变量。受保护的 `production` Environment 使用
   `WIN_CERTIFICATE` / `WIN_CERTIFICATE_PASSWORD`，工作流仅在打包 step 内映射到
   electron-builder 的 `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`。

   或在本地使用 Windows 证书存储:
   
   ```bash
   set CSC_NAME="Your Certificate Subject Name"
   ```

### electron-builder 配置

项目使用 `electron-builder.yml`，不提交证书路径或密码：

```yaml
win:
  target:
    - target: nsis
      arch: [x64]
  forceCodeSigning: false
```

`forceCodeSigning: false` 允许明确的 unsigned 模式；它不放宽 signed 模式的发布验证。

## macOS 代码签名

### 准备工作

1. **注册 Apple 开发者账户**
   - https://developer.apple.com/

2. **创建证书**
   - Developer ID Application (用于分发)
   - Developer ID Installer (用于 pkg 安装包)

3. **设置环境变量**
   
   ```bash
   # macOS 签名配置
   export CSC_NAME="Developer ID Application: Your Company (TEAM_ID)"
   export APPLE_ID=your-apple-id@example.com
   export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   export APPLE_TEAM_ID=YOUR_TEAM_ID
   ```

### 公证 (Notarization)

macOS 10.15+ 要求应用公证:

```json
{
  "build": {
    "mac": {
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build/entitlements.mac.plist",
      "entitlementsInherit": "build/entitlements.mac.plist",
      "notarize": {
        "teamId": "YOUR_TEAM_ID"
      }
    }
  }
}
```

### entitlements.mac.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
</dict>
</plist>
```

## CI/CD 集成

正式 Windows x64 签名只在
`.github/workflows/_windows-release-build.yml` 中执行，并由手动 `Release` 工作流调用。
PR 工作流不声明 `production` Environment，也接触不到证书。

签名状态采用 fail-closed 三态：

1. 证书和密码都未配置：允许构建，但 manifest 与 Release 正文明确标记
   `unsigned`；
2. 证书和密码都配置：自动签名，并要求 Authenticode `Valid`、主题匹配（若配置）且
   `TimeStamperCertificate` 存在；
3. 只配置一部分：立即失败，不产出可晋级制品。

`electron-builder` 始终使用 `--publish never`。签名后的同一个 canonical `.exe`
经过 PowerShell 验证、SHA-256/SHA-512 记录后，才上传为 Actions artifact；后续
GitHub Release 与 COS 都只复用该文件。发布编排在使用本次构建或恢复出的 canonical
artifact 前，还会在独立 Windows job 上再次核对实际 `.exe` 与 manifest 的
signed/unsigned 声明、证书主题和可信时间戳，Ubuntu 上的散列验证不能替代该步骤。

## 验证签名

### Windows

```powershell
# 验证签名
signtool verify /pa /v your-app.exe
```

### macOS

```bash
# 验证签名
codesign --verify --verbose=4 YourApp.app

# 验证公证
spctl --assess --verbose=4 YourApp.app
```

## 注意事项

1. **保护证书安全**
   - 不要将证书提交到版本控制
   - 使用 CI/CD 的密钥管理功能

2. **测试签名**
   - 在发布前测试签名是否有效
   - 确保所有平台都能正常验证

3. **定期更新证书**
   - 证书有有效期，需定期更新

## 相关资源

- [electron-builder 代码签名文档](https://www.electron.build/code-signing)
- [Apple 开发者文档](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution)
- [Microsoft 代码签名指南](https://docs.microsoft.com/en-us/windows/win32/seccrypto/signing-code-with-a-certificate)
