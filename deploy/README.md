# apiyi 远程 MCP 网关 —— 部署手册(EdgeOne + FastMCP)

把 apiyi-mcp 的能力(Gemini 多模态 + Google Search + Code Execution + 批量并发)挂在
`https://api.13797248455.xyz` 上,**每个用户填自己的 apiyi key**(BYOK,Bring Your Own Key)。
服务端不持有任何 key、不缓存任何 key —— 每次工具调用从客户端 `Authorization: Bearer sk-...`
header 里直接取,临时构造 google-genai 客户端打到 `api.apiyi.com`。

## 架构

```
┌────────────────────────────────┐    Authorization: Bearer sk-xxx
│ Client (Cursor / Codex / app)  │ ─────────────────────────────────┐
└────────────────────────────────┘                                    │
                                                                      ▼
                                          https://api.13797248455.xyz/mcp
                                                                      │
                                                                      ▼
                                                  ┌──────────────────────────────────┐
                                                  │  腾讯 EdgeOne                    │
                                                  │  - SSL 终止(自动证书)          │
                                                  │  - CDN / DDoS 防护              │
                                                  │  - WAF(可选,默认标准防护)      │
                                                  └────────────────┬─────────────────┘
                                                                   │ HTTP:80
                                                                   │ Host: api.13797248455.xyz
                                                                   │ Authorization: Bearer sk-xxx
                                                                   ▼
                                                ┌──────────────────────────────────────┐
                                                │ Lighthouse 42.194.167.238            │
                                                │  apiyi-fastmcp (Python / FastMCP)    │
                                                │  per-call: read Authorization header │
                                                │  → genai.Client(api_key=bearer,      │
                                                │       base_url=APIYI_BASE_URL)       │
                                                │  → generate_content / batch          │
                                                └────────────────────┬─────────────────┘
                                                                     │ HTTPS
                                                                     ▼
                                                              api.apiyi.com
```

> **为什么不用 Caddy?** EdgeOne 已经做了 SSL 终止 + CDN + DDoS,源站再做一遍 TLS 是
> 重复劳动。直接让 FastMCP 监听 80 端口、EdgeOne 回源 HTTP 即可。
>
> **如果不挂 EdgeOne 怎么办?** 翻 git 历史(commit 之前),`deploy/caddy/Caddyfile` +
> `docker-compose.yml` 里的 caddy 服务还在,把端口改回 443 + 加上 ACME 邮箱即可。

## 跟其他 MCP 网关方案的区别

| 维度 | Docker MCP Gateway | Supergateway | mcp-proxy(sparfenyuk) | **apiyi-fastmcp(本仓)** |
|------|---------------------|--------------|------------------------|--------------------------|
| 共享 key | ✅ 单 key 一次性配在宿主机 | ✅ `--oauth2Bearer` 启动期固定 | ✅ 启动期固定 | ❌ 每请求从 Bearer 取 |
| 每用户 BYOK | ❌ 只能多实例隔离 | ❌ 同上 | ❌ 同上 | ✅ **原生支持** |
| 容器隔离 | ✅ 每 server 一个容器 | ❌ 单进程 | ❌ 单进程 | ✅ 单容器(N 客户端并发安全) |
| 自带 OAuth | ✅(给上游 OAuth API 用) | ❌ | ✅(给上游 OAuth API 用) | ❌ |
| 适合 apiyi(裸 sk-key) | ❌ 设计目标不对路 | ⚠️ 只单租户 | ⚠️ 只单租户 | ✅ |

---

## 1. 一次性配置(EdgeOne + DNS + 防火墙)

EdgeOne 这套已经按下面配好了(`zone-3nwcs1j7cmz6`),只确认下别动:

### 1.1 EdgeOne 域名管理

| 加速域名 | 源站 | 回源协议 | 回源端口 | 回源 Host |
|---------|------|----------|----------|-----------|
| `api.13797248455.xyz` | IP `42.194.167.238` | HTTP | 80 | `api.13797248455.xyz` |

CNAME: `api.13797248455.xyz.eo.dnse0.com` (DNSPod 已自动指过去)。

### 1.2 Lighthouse 防火墙

只需要放行 **TCP 80**(给 EdgeOne 回源),443 不用对外开。

腾讯云控制台 → 轻量应用服务器 → 实例详情 → 防火墙 → 添加规则:

| 应用类型 | 协议 | 端口 | 来源 |
|---------|------|------|------|
| HTTP | TCP | 80 | 0.0.0.0/0 |

> 如果你想再严点,把"来源"改成 [EdgeOne 回源 IP 段](https://cloud.tencent.com/document/product/1552/55222),
> 仅放行 EdgeOne 节点,任何人绕过 CDN 直连 IP 都打不到。

### 1.3 验证 DNS

本地或 OrcaTerm 跑:

```bash
dig +short api.13797248455.xyz @8.8.8.8
# 期望返回类似:
# api.13797248455.xyz.eo.dnse0.com.
# <某 EdgeOne 边缘节点 IP>
```

---

## 2. 在 Lighthouse 上拉起 FastMCP

**镜像已经发布到 Docker Hub:[`zuozuoliang999/apiyi-fastmcp`](https://hub.docker.com/r/zuozuoliang999/apiyi-fastmcp)**
(`linux/amd64`,~150 MB,直接从 Docker Hub 拉,不用 build)。

### 2.1 极简 —— 一行 `docker run`(推荐)

OrcaTerm 直接贴:

```bash
docker rm -f apiyi-fastmcp 2>/dev/null; \
docker run -d --name apiyi-fastmcp --restart unless-stopped \
  -p 80:8000 \
  -e APIYI_BASE_URL=https://api.apiyi.com \
  -e GEMINI_MODEL=gemini-3.1-pro-preview-thinking \
  -e GEMINI_MAX_OUTPUT_TOKENS=65536 \
  -e GEMINI_TEMPERATURE=0.2 \
  -e GEMINI_MAX_FILES=10 \
  -e GEMINI_MAX_TOTAL_FILE_SIZE=50 \
  -e GEMINI_MEDIA_RESOLUTION=MEDIUM \
  -e FASTMCP_HOST=0.0.0.0 \
  -e FASTMCP_PORT=8000 \
  -e FASTMCP_PATH=/mcp \
  -e FASTMCP_TRANSPORT=http \
  -e LOG_LEVEL=INFO \
  zuozuoliang999/apiyi-fastmcp:latest
```

首次 ~30 秒(拉镜像),之后 docker run 重启 < 2 秒。

看日志:

```bash
docker logs -f apiyi-fastmcp
# 启动 15 秒后应能看到:
#   FastMCP HTTP server running on 0.0.0.0:8000 at /mcp (BYOK mode)
```

升级:

```bash
docker pull zuozuoliang999/apiyi-fastmcp:latest
docker rm -f apiyi-fastmcp
# 然后重跑上面那一行 docker run
```

### 2.2 进阶 —— `docker compose`(如果你要改本地 server.py)

```bash
cd /opt
rm -rf ai-image
git clone -b feature/apiyi-mcp-integration https://github.com/2799662352/ai-image-master.git ai-image
cd ai-image/deploy

docker compose up -d           # 默认拉 Docker Hub 镜像,~30 秒
# 改了 deploy/apiyi-fastmcp/server.py 想本机 build:
#   把 docker-compose.yml 里 image: 那行注释,放开 build: 段,再:
#   docker compose up -d --build

docker compose ps
docker compose logs -f gateway
```

---

## 3. 验证

### 3.1 本机直连(绕过 EdgeOne)

```bash
# 本机 → Docker(走 host:80 → container:8000)
curl -s http://127.0.0.1/healthz
# 期望: ok

curl -s http://127.0.0.1/
# 期望: 一段 JSON,含 "byok": true
```

### 3.2 经 EdgeOne 的 HTTPS

```bash
# 装 jq(可选)
yum install -y jq bind-utils

curl -s https://api.13797248455.xyz/healthz
# 期望: ok

curl -s https://api.13797248455.xyz/ | python3 -m json.tool
# 期望: JSON
```

### 3.3 真正打一次 MCP 协议

```bash
curl -s -X POST https://api.13797248455.xyz/mcp \
  -H "Authorization: Bearer sk-你自己的apiyi-key" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"tools/list"}'
# 期望: 返回 tools 列表(包含 generate_content / generate_content_batch)
```

---

## 4. 客户端怎么连

### 4.1 Cursor / Codex —— 走原生 streamable-http

```json
{
  "mcpServers": {
    "apiyi": {
      "url": "https://api.13797248455.xyz/mcp",
      "headers": {
        "Authorization": "Bearer sk-你自己的apiyi-key"
      }
    }
  }
}
```

### 4.2 只认 stdio 的客户端 —— mcp-remote 在本机包一层

```json
{
  "mcpServers": {
    "apiyi": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.13797248455.xyz/mcp",
        "--header",
        "Authorization: Bearer sk-你自己的apiyi-key"
      ]
    }
  }
}
```

或用 supergateway:

```json
{
  "mcpServers": {
    "apiyi": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--streamableHttp",
        "https://api.13797248455.xyz/mcp",
        "--oauth2Bearer",
        "sk-你自己的apiyi-key"
      ]
    }
  }
}
```

### 4.3 远程调用时的文件参数

`generate_content` / `generate_content_batch` 的 `files[].path` 在远程模式下基本没用
(它指的是 **服务端文件系统**)。远程客户端请用 `files[].content` 传 base64:

```json
{
  "user_prompt": "Describe this image",
  "files": [
    {
      "name": "photo.png",
      "type": "image/png",
      "content": "<base64-encoded-bytes>"
    }
  ]
}
```

支持的 MIME 自动识别:JPG/PNG/GIF/WebP/SVG/BMP/TIFF、MP4/AVI/MOV/WebM/FLV/MPG/WMV、
MP3/WAV/AIFF/AAC/OGG/FLAC、PDF/DOCX/XLSX/PPTX、TXT/MD/JSON/XML/CSV/HTML。
单次最多 10 个文件,总大小 ≤ 50 MB(可改 `GEMINI_MAX_FILES` / `GEMINI_MAX_TOTAL_FILE_SIZE`)。

---

## 5. 运维

### 5.1 用 docker run 部署的(2.1 那一行)

```bash
docker logs -f apiyi-fastmcp           # 实时日志(Bearer 已脱敏)
docker ps --filter name=apiyi-fastmcp  # 看健康状态
docker restart apiyi-fastmcp           # 重启
docker stop apiyi-fastmcp              # 关停(保留容器)
docker rm -f apiyi-fastmcp             # 销毁容器(下次重跑 2.1 那一行 docker run)

# 升级
docker pull zuozuoliang999/apiyi-fastmcp:latest
docker rm -f apiyi-fastmcp
# 重跑 2.1 的 docker run 一行
```

### 5.2 用 docker compose 部署的(2.2)

```bash
cd /opt/ai-image/deploy
docker compose logs -f gateway     # 实时日志
docker compose ps                  # 看健康状态
docker compose restart gateway     # 重启
docker compose down                # 关停

# 升级(用远端镜像)
cd /opt/ai-image && git pull && cd deploy && docker compose pull && docker compose up -d

# 升级(本机重 build)
cd /opt/ai-image && git pull && cd deploy && docker compose up -d --build
```

EdgeOne 这层在腾讯云控制台清缓存即可:
EdgeOne 控制台 → 节点缓存清理 → 输入 `https://api.13797248455.xyz/*` → 清除。

---

## 6. 安全模型

| 风险 | 现状 |
|------|------|
| key 被人偷 | TLS 1.2+ 全程加密(EdgeOne → Lighthouse 内网走 HTTP,在腾讯骨干网内)。FastMCP 进程内存里 LRU 缓存 256 个 client 实例,不写盘、不入日志。 |
| 公网被滥用 | 没有内置 rate-limit。任何拿合法 sk-xxx 的人都能用,流量算 key 主人。**强烈建议**在 EdgeOne 启用 [Web 防护 → 自定义规则](https://cloud.tencent.com/document/product/1552/86237),给 `/mcp` 加速率限制 + 黑白名单。 |
| 源站被直连 | 把 Lighthouse 防火墙的"来源"改成 EdgeOne 回源 IP 段,绕过 CDN 直连 IP 就连不上。 |
| LRU 缓存被毒化 | api_key 哈希查找,跨 key 不串数据;每个 client 实例只跟自己的 key 绑定。 |

---

## 7. 常见问题

**Q: `curl https://api.13797248455.xyz/healthz` 返回 "Unauthorized"。**
A: 这是 EdgeOne 在源站不可用 / WAF 默认拦截时的兜底响应。先 SSH 上 Lighthouse 跑
`curl -s http://127.0.0.1/healthz`,如果连本机都不通,说明 docker compose 没起来。

**Q: 本机直连 OK,但走 HTTPS 还是 401。**
A: 检查 EdgeOne 控制台:
1. 域名管理 → 编辑 `api.*` → 确认源站还是 `42.194.167.238`、HTTP、80
2. 安全防护 → Web 防护 → 看是否有拦截策略,临时改成"观察"模式
3. 站点加速 → 节点缓存 → 清缓存

**Q: 客户端报 `No apiyi API key provided`。**
A: 没传 `Authorization: Bearer sk-...` header,或者 header 名拼错。也支持
`X-Apiyi-Key` / `X-Api-Key`。

**Q: 客户端报 `Gemini API error: ... invalid api key`。**
A: Bearer 里的 sk-xxx 在 apiyi 那边无效 / 余额不足。直接 cURL 测一下:
```bash
curl -H "Authorization: Bearer sk-xxx" https://api.apiyi.com/v1beta/models
```

**Q: 视频太大 / 上传慢 / 大文件被 EdgeOne 切断。**
A: 实测 ~12 MB base64 + Gemini Thinking(~50s 推理)会被 EdgeOne 默认 timeout 切断
(`IncompleteRead`)。两种解法:
1. **视频分析这种大请求走直连 IP**:`http://42.194.167.238/mcp`(防火墙记得放行
   你自己的客户端 IP)。日常对话调用继续走 HTTPS 域名。
2. **改 EdgeOne 配置**:控制台 → 站点加速 → 规则引擎 → 新建规则 →
   匹配 `path 等于 /mcp` → 操作:`回源超时 180s` + `请求体大小 100MB`。
另外:`GEMINI_MAX_TOTAL_FILE_SIZE`(MB,默认 50)是服务端硬上限,要更大改这个。

**Q: 想跑单租户(自己用,不公网开放)。**
A: `docker-compose.yml` 的 `gateway.environment` 加 `APIYI_API_KEY=sk-xxx`,客户端
不传 Authorization 时 fallback 到这个 key。再把 Lighthouse 防火墙"来源"改成自己 IP。

**Q: 想本机直接跑(不要 Docker)。**
A:
```bash
cd deploy/apiyi-fastmcp
pip install fastmcp google-genai pydantic starlette 'uvicorn[standard]'
APIYI_API_KEY=sk-xxx FASTMCP_PORT=8000 python server.py
# 客户端连 http://127.0.0.1:8000/mcp
```
