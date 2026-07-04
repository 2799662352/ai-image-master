# Sakuga-42M 纯云原生知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Sakuga-42M 全量元数据(1,117,898 行)以零信息丢失的方式搬上阿里云(OSS + DashVector + 百炼),并为 agent 提供 `query_sakuga_dataset` MCP 工具;3000 条精选视频片段进百炼音视频库试水。

**Architecture:** 四层——① OSS 原始 parquet 保险箱;② DashVector Serverless 全量层(dense 向量 + 25 列可过滤 fields);③ 百炼 KB 蒸馏文档(按 user_tags 技法标签);④ 百炼音视频搜索库(3000 条 pilot)。MCP 接入复用 cinematography-kb-mcp 的零依赖 stdio 模式与 catimation 式密钥注入。

**Tech Stack:** Python 3(pandas/pyarrow/requests,数据管线)、Node 内置模块(MCP server)、DashScope text-embedding-v4(512 维)、DashVector HTTP API、阿里云控制台(agent-browser 辅助,用户登录)。

**Spec:** `docs/superpowers/specs/2026-07-05-sakuga-cloud-native-kb-design.md`

**依赖用户的前置动作:** 阿里云控制台登录(用户已承诺协助);`.env` 或设置中提供 `DASHSCOPE_API_KEY`;DashVector 开通后获得 `DASHVECTOR_API_KEY` 与 Cluster Endpoint。

---

## 文件结构总览

```text
scripts/sakuga/                       # 数据管线(新建目录,均可断点重跑)
  common.py                           # 共享:读 parquet、DashScope embedding、DashVector HTTP 客户端
  create_collection.py                # P1: 建 Collection(幂等)
  embed_upsert.py                     # P1: embedding + 批量写入(checkpoint 续跑)
  verify_dashvector.py                # P1: 零丢失抽验(20 条逐字段比对)
  build_distilled_corpus.py           # P3: 蒸馏 50-70 篇 markdown
  select_pilot_clips.py               # P4: 3000 条分层选片 → pilot_manifest.csv
  download_clips.py                   # P4: 限速回源下载(候补补齐)
resources/cinematography-kb-mcp/index.js   # P2: 加 query_sakuga_dataset 工具(改为可 require 测试)
src/main/agent/codexProviders.ts           # P2: 新增 DASHVECTOR_PROVIDER_ID
src/main/agent/codexLaunch.ts              # P2: -c 注入 DASHVECTOR_API_KEY
src/main/agent/CodexLocalBackend.ts        # P2: spawn 时读取 dashvector key
src/main/agent/cinematographyKbMcpLauncher.ts  # P2: env scaffold 加 DASHVECTOR_API_KEY 占位
src/renderer/src/pages-react/SettingsPage.tsx  # P2: 运镜知识库区新增 DashVector key 输入
src/main/agent/__tests__/cinematographyKbMcpTools.test.ts  # P2: MCP 工具单测(新建)
videos/Sakuga-42M/                    # 已 gitignore;metadata/ 已有 6 parquet;新增 corpus/ pilot/
```

数据管线用 Python(pyarrow/pandas 已验证可用);凭证一律从环境变量/`.env` 读,不写死代码。

---

## Task 0: 脚手架与共享模块

**Files:**
- Create: `scripts/sakuga/common.py`

- [ ] **Step 0.1: 写 common.py**

```python
"""Sakuga-42M 云化管线共享模块。凭证从环境变量读取:
DASHSCOPE_API_KEY / DASHVECTOR_API_KEY / DASHVECTOR_ENDPOINT(如 vrs-cn-xxx.dashvector.cn-hangzhou.aliyuncs.com)
"""
import os, json, time
import requests
import pyarrow.parquet as pq

METADATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "metadata")
TRAIN_FULL = os.path.join(METADATA_DIR, "sakugadataset_train_full.parquet")
COLLECTION = "sakuga42m"
DIM = 512

def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"missing env: {name}")
    return v

def embed_batch(texts: list[str], retries: int = 5) -> list[list[float]]:
    """DashScope text-embedding-v4,512 维,单请求 ≤10 条。限流退避。"""
    url = "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding"
    headers = {"Authorization": f"Bearer {env('DASHSCOPE_API_KEY')}", "Content-Type": "application/json"}
    body = {"model": "text-embedding-v4", "input": {"texts": texts}, "parameters": {"dimension": DIM}}
    for attempt in range(retries):
        r = requests.post(url, headers=headers, json=body, timeout=60)
        if r.status_code == 200:
            out = r.json()["output"]["embeddings"]
            return [e["embedding"] for e in sorted(out, key=lambda x: x["text_index"])]
        if r.status_code in (429, 500, 503):
            time.sleep(2 ** attempt)
            continue
        raise RuntimeError(f"embed HTTP {r.status_code}: {r.text[:300]}")
    raise RuntimeError("embed: retries exhausted")

class DashVector:
    def __init__(self):
        self.base = f"https://{env('DASHVECTOR_ENDPOINT')}/v1"
        self.h = {"dashvector-auth-token": env("DASHVECTOR_API_KEY"), "Content-Type": "application/json"}

    def create_collection(self, fields_schema: dict) -> dict:
        body = {"name": COLLECTION, "dimension": DIM, "metric": "cosine", "dtype": "FLOAT",
                "fields_schema": fields_schema}
        return requests.post(f"{self.base}/collections", headers=self.h, json=body, timeout=30).json()

    def describe(self) -> dict:
        return requests.get(f"{self.base}/collections/{COLLECTION}", headers=self.h, timeout=30).json()

    def upsert(self, docs: list[dict], retries: int = 5) -> dict:
        for attempt in range(retries):
            r = requests.put(f"{self.base}/collections/{COLLECTION}/docs", headers=self.h,
                             json={"docs": docs}, timeout=120)
            if r.status_code == 200 and r.json().get("code") == 0:
                return r.json()
            time.sleep(2 ** attempt)
        raise RuntimeError(f"upsert failed: {r.status_code} {r.text[:300]}")

    def fetch(self, ids: list[str]) -> dict:
        r = requests.get(f"{self.base}/collections/{COLLECTION}/docs",
                         headers=self.h, params={"ids": ",".join(ids)}, timeout=30)
        return r.json()

    def query(self, vector, topk=10, flt=None, output_fields=None) -> dict:
        body = {"vector": vector, "topk": topk, "include_vector": False}
        if flt: body["filter"] = flt
        if output_fields: body["output_fields"] = output_fields
        r = requests.post(f"{self.base}/collections/{COLLECTION}/query", headers=self.h, json=body, timeout=60)
        return r.json()

def read_train_full(columns=None):
    return pq.read_table(TRAIN_FULL, columns=columns).to_pandas()
```

> 注:DashVector HTTP 路径/请求体以官方文档为准(help.aliyun.com DashVector「HTTP API」章节);实现者跑 Task 2 Step 2.2 的 describe 校验即可发现偏差并就地修正,不改架构。

- [ ] **Step 0.2: Commit**

```bash
git add scripts/sakuga/common.py
git commit -m "feat(sakuga): shared pipeline module (embedding + DashVector client)"
```

---

## Task 1: P0 — OSS 原始层(需用户登录控制台)

**Files:** 无代码;控制台操作(agent-browser 辅助)。

- [ ] **Step 1.1: 用户登录阿里云控制台后,创建/复用 Bucket**

OSS 控制台 → Bucket(建议 `catimation-datasets`,标准存储,私有读写,地域与 DashVector/百炼一致,建议华东 1 杭州或华北 2 北京)。

- [ ] **Step 1.2: 上传 6 个 parquet**

目标路径 `datasets/sakuga-42m/metadata/`。控制台网页直传 6 个文件(共 715 MB)。上传后核对文件大小与本地一致:

```text
demo 26,871 B | test 29,951,366 B | val 29,990,416 B
train_small 56,277,740 B | train_aesthetic 78,218,606 B | train_full 554,727,885 B
```

- [ ] **Step 1.3: 记录 OSS 路径到 spec 附录**(`oss://<bucket>/datasets/sakuga-42m/metadata/`),commit spec 更新。

---

## Task 2: P1 — DashVector 开通与建 Collection

**Files:**
- Create: `scripts/sakuga/create_collection.py`

- [ ] **Step 2.1: 用户登录后开通 DashVector 免费试用,创建 Serverless Cluster**

控制台 dashvector.console.aliyun.com → 创建 Serverless 实例 → 记下 **API-KEY** 与 **Endpoint**,写入本地 `.env`(`DASHVECTOR_API_KEY` / `DASHVECTOR_ENDPOINT`),不入 git。

- [ ] **Step 2.2: 写 create_collection.py 并跑通(幂等)**

```python
from common import DashVector

FIELDS = {
    "identifier": "STRING", "hash_identifier": "STRING", "url_link": "STRING",
    "scene_start_time": "STRING", "scene_end_time": "STRING",
    "frame_number": "FLOAT", "key_frame_number": "FLOAT",
    "anime_tags": "STRING", "user_tags": "STRING", "text_description": "STRING",
    "aesthetic_score": "FLOAT", "dynamic_score": "FLOAT", "rating": "STRING",
    "text_prob": "FLOAT", "width": "INT", "height": "INT",
    "file_ext": "STRING", "fps": "FLOAT",
    "taxonomy_time": "STRING", "taxonomy_venue": "STRING", "taxonomy_media": "STRING",
    "taxonomy_filming": "STRING", "taxonomy_composition": "STRING", "taxonomy_character": "STRING",
}

if __name__ == "__main__":
    dv = DashVector()
    print("create:", dv.create_collection(FIELDS))
    print("describe:", dv.describe())
```

Run: `python scripts/sakuga/create_collection.py`
Expected: describe 返回 `code=0`、`dimension=512`、fields_schema 与上表一致(已存在时 create 报"已存在"也算通过)。

> 25 列中 `__index_level_0__` 是 pandas 残留索引,弃掉;`Taxonomy_*` 列名转小写(DashVector field 命名规范);此两点为 schema 唯一有意的偏差,记入 verify 脚本。

- [ ] **Step 2.3: Commit**

```bash
git add scripts/sakuga/create_collection.py
git commit -m "feat(sakuga): DashVector collection bootstrap (25-field schema)"
```

---

## Task 3: P1 — 全量 embedding + 写入 + 零丢失抽验

**Files:**
- Create: `scripts/sakuga/embed_upsert.py`
- Create: `scripts/sakuga/verify_dashvector.py`

- [ ] **Step 3.1: 写 embed_upsert.py(checkpoint 续跑)**

```python
"""全量 1,117,898 行:embedding(10 条/请求)+ upsert(100 条/批)。
checkpoint: scripts/sakuga/.upsert_checkpoint(已完成的行区间上界);失败行落盘 .upsert_failed.jsonl 可重跑。
预估:~11.2 万次 embedding 请求;按 5 QPS 约 6-7 小时,可随时 Ctrl+C 后续跑。
"""
import os, json, math
import pandas as pd
from common import DashVector, embed_batch, read_train_full

CKPT = os.path.join(os.path.dirname(__file__), ".upsert_checkpoint")
FAILED = os.path.join(os.path.dirname(__file__), ".upsert_failed.jsonl")
EMBED_BATCH = 10
UPSERT_BATCH = 100

def row_to_fields(r) -> dict:
    def s(x): return "" if pd.isna(x) else str(x)
    def f(x): return 0.0 if pd.isna(x) else float(x)
    return {
        "identifier": s(r.identifier), "hash_identifier": s(r.hash_identifier), "url_link": s(r.url_link),
        "scene_start_time": s(r.scene_start_time), "scene_end_time": s(r.scene_end_time),
        "frame_number": f(r.frame_number), "key_frame_number": f(r.key_frame_number),
        "anime_tags": s(r.anime_tags), "user_tags": s(r.user_tags), "text_description": s(r.text_description),
        "aesthetic_score": f(r.aesthetic_score), "dynamic_score": f(r.dynamic_score), "rating": s(r.rating),
        "text_prob": f(r.text_prob), "width": int(r.width), "height": int(r.height),
        "file_ext": s(r.file_ext), "fps": f(r.fps),
        "taxonomy_time": s(r.Taxonomy_Time), "taxonomy_venue": s(r.Taxonomy_Venue),
        "taxonomy_media": s(r.Taxonomy_Media), "taxonomy_filming": s(r.Taxonomy_Filming),
        "taxonomy_composition": s(r.Taxonomy_Composition), "taxonomy_character": s(r.Taxonomy_Character),
    }

def main():
    df = read_train_full()
    start = int(open(CKPT).read().strip()) if os.path.exists(CKPT) else 0
    dv = DashVector()
    print(f"rows={len(df)} resume from {start}")
    for lo in range(start, len(df), UPSERT_BATCH):
        chunk = df.iloc[lo:lo + UPSERT_BATCH]
        texts = [("" if pd.isna(t) else str(t))[:2000] or "(no description)" for t in chunk.text_description]
        vectors = []
        for i in range(0, len(texts), EMBED_BATCH):
            vectors.extend(embed_batch(texts[i:i + EMBED_BATCH]))
        docs = [{"id": str(r.identifier), "vector": vectors[j], "fields": row_to_fields(r)}
                for j, (_, r) in enumerate(chunk.iterrows())]
        try:
            dv.upsert(docs)
        except Exception as e:
            with open(FAILED, "a", encoding="utf8") as fh:
                fh.write(json.dumps({"lo": lo, "err": str(e)}) + "\n")
        with open(CKPT, "w") as fh:
            fh.write(str(lo + UPSERT_BATCH))
        if (lo // UPSERT_BATCH) % 50 == 0:
            print(f"progress {lo + UPSERT_BATCH}/{len(df)} ({(lo + UPSERT_BATCH) / len(df):.1%})")

if __name__ == "__main__":
    main()
```

- [ ] **Step 3.2: 先跑 500 行冒烟**(临时把 `len(df)` 改 500 或加 `--limit` 参数跑),控制台核对 Collection 文档数 = 500,费用与预估同数量级(写单元/embedding token)。

- [ ] **Step 3.3: 全量批跑**(后台运行,断点续跑;完成后 describe 文档数 = 1,117,898)。

- [ ] **Step 3.4: 写 verify_dashvector.py 并跑**

```python
"""零丢失抽验:随机 20 个 identifier,fetch 回来逐字段与 parquet 原值比对。"""
import random
import pandas as pd
from common import DashVector, read_train_full
from embed_upsert import row_to_fields

def main():
    df = read_train_full()
    sample = df.sample(20, random_state=7)
    dv = DashVector()
    got = dv.fetch([str(i) for i in sample.identifier])["output"]
    bad = 0
    for _, r in sample.iterrows():
        want = row_to_fields(r)
        have = got.get(str(r.identifier), {}).get("fields", {})
        for k, v in want.items():
            hv = have.get(k)
            if isinstance(v, float):
                ok = hv is not None and abs(float(hv) - v) < 1e-4
            else:
                ok = hv == v
            if not ok:
                bad += 1
                print(f"MISMATCH {r.identifier}.{k}: want={v!r} have={hv!r}")
    print("PASS" if bad == 0 else f"FAIL ({bad} mismatches)")

if __name__ == "__main__":
    main()
```

Run: `python scripts/sakuga/verify_dashvector.py` → Expected: `PASS`

- [ ] **Step 3.5: 语义查询冒烟**(临时脚本或 REPL):embed "fast smear animation during a chase" → `dv.query(vec, topk=5, flt="aesthetic_score > 0.7 and user_tags like '%smears%'")` → 返回相关行且带 url_link。

- [ ] **Step 3.6: Commit**

```bash
git add scripts/sakuga/embed_upsert.py scripts/sakuga/verify_dashvector.py
git commit -m "feat(sakuga): full-corpus embed+upsert pipeline with checkpoint & zero-loss verify"
```

---

## Task 4: P2 — MCP 工具 `query_sakuga_dataset`(TDD)

**Files:**
- Modify: `resources/cinematography-kb-mcp/index.js`
- Create: `src/main/agent/__tests__/cinematographyKbMcpTools.test.ts`
- Modify: `src/main/agent/codexProviders.ts`(~L154 后)
- Modify: `src/main/agent/codexLaunch.ts`(镜像 L569-578 的 cinematographyKbKey 注入)
- Modify: `src/main/agent/CodexLocalBackend.ts`(镜像 L129-133 的 key 读取)
- Modify: `src/main/agent/cinematographyKbMcpLauncher.ts`(env scaffold 加 `DASHVECTOR_API_KEY: ''` 占位)
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`(运镜知识库区加 DashVector key 输入,走 `setProviderApiKey('dashvector', …)`,复用现有 cinematography-kb 输入组件的样式与保存逻辑)
- Modify: `src/main/agent/__tests__/codexLaunch.test.ts`(加 2 个注入用例,镜像 L507-528)

**设计要点:**
- index.js 保持零依赖;新增常量 `DASHVECTOR_ENDPOINT`(Task 2 创建的 cluster endpoint,像 `ENDPOINT_HOST` 一样硬编码)与 `DASHVECTOR_KEY_ENV = 'DASHVECTOR_API_KEY'`。
- 查询向量:复用 `DASHSCOPE_API_KEY` 调 text-embedding-v4(512 维)得 query vector,再 POST DashVector `/v1/collections/sakuga42m/query`。
- 模块化改造:文件末尾 `if (require.main === module) main()`,并 `module.exports = { buildSakugaQueryBody, formatSakugaHits, TOOLS }` 供 vitest 直测纯函数(不发网络)。

- [ ] **Step 4.1: 写失败测试** `src/main/agent/__tests__/cinematographyKbMcpTools.test.ts`

```ts
import { describe, it, expect } from 'vitest'
// resources 下的零依赖 CJS,直接 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('../../../../resources/cinematography-kb-mcp/index.js')

describe('cinematography-kb-mcp sakuga tool', () => {
  it('exposes query_sakuga_dataset alongside search_cinematography_kb', () => {
    const names = mcp.TOOLS.map((t: { name: string }) => t.name)
    expect(names).toContain('search_cinematography_kb')
    expect(names).toContain('query_sakuga_dataset')
  })

  it('buildSakugaQueryBody assembles topk/filter/output_fields', () => {
    const body = mcp.buildSakugaQueryBody([0.1, 0.2], { top_k: 5, filter: "aesthetic_score > 0.7" })
    expect(body.topk).toBe(5)
    expect(body.filter).toBe("aesthetic_score > 0.7")
    expect(body.vector).toEqual([0.1, 0.2])
    expect(body.include_vector).toBe(false)
    expect(body.output_fields).toContain('text_description')
    expect(body.output_fields).toContain('url_link')
  })

  it('formatSakugaHits renders score/desc/tags/url lines', () => {
    const text = mcp.formatSakugaHits({ output: [{ id: '1:2', score: 0.83, fields: {
      text_description: 'A smear-heavy chase.', user_tags: 'smears fighting',
      aesthetic_score: 0.9, dynamic_score: 0.8, url_link: 'https://sakugabooru.com/x.mp4',
      scene_start_time: '00:00:01', scene_end_time: '00:00:04' } }] })
    expect(text).toContain('1:2')
    expect(text).toContain('smears fighting')
    expect(text).toContain('https://sakugabooru.com/x.mp4')
  })
})
```

- [ ] **Step 4.2: 跑测试确认 RED**

Run: `npx vitest run src/main/agent/__tests__/cinematographyKbMcpTools.test.ts`
Expected: FAIL(`mcp.TOOLS` undefined——index.js 尚未导出)。

- [ ] **Step 4.3: 实现 index.js 改造**

要点(完整代码由实现者按现有文件风格写,以下为必须包含的骨架):

```js
const DASHVECTOR_ENDPOINT = 'REPLACE_WITH_CLUSTER_ENDPOINT' // Task 2 后回填
const DASHVECTOR_KEY_ENV = 'DASHVECTOR_API_KEY'
const SAKUGA_COLLECTION = 'sakuga42m'
const SAKUGA_OUTPUT_FIELDS = ['identifier','text_description','anime_tags','user_tags',
  'aesthetic_score','dynamic_score','rating','url_link','scene_start_time','scene_end_time',
  'taxonomy_filming','taxonomy_composition','taxonomy_media','fps','width','height']

function buildSakugaQueryBody(vector, args) {
  const body = { vector, topk: Math.min(Number(args.top_k) || 10, 50),
    include_vector: false, output_fields: SAKUGA_OUTPUT_FIELDS }
  if (args.filter) body.filter = String(args.filter)
  return body
}

function formatSakugaHits(payload) { /* output[] → "[i] score=… id=…\ndesc…\ntags…\nurl (start-end)" 拼接 */ }

async function embedQuery(text) { /* DashScope text-embedding-v4, dimension 512, 复用 DASHSCOPE_API_KEY */ }
async function querySakuga(args) { /* embedQuery → https.request DashVector query → formatSakugaHits */ }
```

- TOOLS 数组追加 `query_sakuga_dataset`,description 写明分工:"query the raw Sakuga-42M dataset (1.1M hand-drawn animation clips with sakugabooru technique tags like smears/impact_frames/character_acting). Supports DashVector filter expressions (e.g. \"aesthetic_score > 0.7 and user_tags like '%smears%'\"). Use `search_cinematography_kb` for concepts/specs; use this for real example rows with source URLs." inputSchema: `query`(required)、`filter`、`top_k`。
- `tools/call` 分支处理该工具:缺 `DASHVECTOR_API_KEY` / `DASHSCOPE_API_KEY` 时返回 isError 文案(与现有错误风格一致)。
- 末尾:`if (require.main === module) main();  module.exports = { TOOLS, buildSakugaQueryBody, formatSakugaHits }`。

- [ ] **Step 4.4: 跑测试确认 GREEN**;全套件回归 `npx vitest run src/main/agent` 无新失败。

- [ ] **Step 4.5: 主进程注入链(镜像 cinematography-kb 前例)**

1. `codexProviders.ts`:`export const DASHVECTOR_PROVIDER_ID = 'dashvector' as const`(注释镜像 L141-154 的说明,secret 为 DashVector API-KEY)。
2. `codexLaunch.ts`:参数加 `dashVectorKey?: string`;在 L569-578 的 cinematographyKbKey 块后追加:

```ts
if (dashVectorKey) {
  args.push('-c', `mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY=${quote(dashVectorKey)}`)
}
```

3. `CodexLocalBackend.ts`:镜像 `getCinematographyKbKey`,读 `DASHVECTOR_PROVIDER_ID` 槽位传给 launch。
4. `cinematographyKbMcpLauncher.ts`:env scaffold 增加 `DASHVECTOR_API_KEY: ''` 占位(外部 codex CLI 用户可手填)。
5. `SettingsPage.tsx`:运镜知识库设置区加"DashVector 数据集检索 Key"输入,保存走 `setProviderApiKey('dashvector', …)`(完全复用现有 cinematography-kb key 输入的组件/保存/回显逻辑)。

- [ ] **Step 4.6: codexLaunch 测试加 2 用例**(镜像 L511-528):有 key 时出现 `mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY="…"`;无 key 时不出现任何 DASHVECTOR `-c`。跑 `npx vitest run src/main/agent/__tests__/codexLaunch.test.ts` GREEN。

- [ ] **Step 4.7: 端到端冒烟**:本机 `.env` 注入两把 key 后,用 stdio 直接起 `node resources/cinematography-kb-mcp/index.js`,发 `tools/call query_sakuga_dataset {"query":"smear frames in a sword fight","filter":"aesthetic_score > 0.7"}`,确认返回真实行。

- [ ] **Step 4.8: Commit**

```bash
git add resources/cinematography-kb-mcp/index.js src/main/agent src/renderer/src/pages-react/SettingsPage.tsx
git commit -m "feat(sakuga): query_sakuga_dataset MCP tool + DashVector key injection chain"
```

---

## Task 5: P3 — 蒸馏语料 → 百炼 KB

**Files:**
- Create: `scripts/sakuga/build_distilled_corpus.py`
- Output: `videos/Sakuga-42M/corpus/*.md`(gitignored,产物可再生)

- [ ] **Step 5.1: 写 build_distilled_corpus.py**

```python
"""高质量池(aes>0.7 & dyn>0.6 & text_prob<0.1,~24.4 万行)按 user_tags 技法标签蒸馏:
每个高频标签(出现 ≥3000 次的 ~50-60 个,剔除 animated/artist_unknown/presumed 等非技法词)一篇 markdown:
定义占位段 + top15 高分描述范例(带 identifier/url/时间码)+ 共现标签 top10 + 六维分布统计。
另产总纲 _overview.md(标签体系 + CHAI motion 维映射)。
"""
import os, collections
import pandas as pd
from common import read_train_full

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "corpus")
STOP = {"animated", "artist_unknown", "presumed", "western", "production_materials", "cgi"}

def main():
    df = read_train_full()
    pool = df[(df.aesthetic_score > 0.7) & (df.dynamic_score > 0.6) & (df.text_prob < 0.1)].copy()
    pool["tags"] = pool.user_tags.fillna("").str.split()
    counts = collections.Counter(t for tags in pool.tags for t in tags if t not in STOP)
    top_tags = [t for t, n in counts.most_common(80) if n >= 3000][:60]
    os.makedirs(OUT, exist_ok=True)
    for tag in top_tags:
        sub = pool[pool.tags.apply(lambda ts: tag in ts)].nlargest(15, "aesthetic_score")
        co = collections.Counter(t for ts in sub.tags for t in ts if t != tag and t not in STOP)
        lines = [f"# Sakuga 作画技法:{tag}", "",
                 f"来源:Sakuga-42M 高质量池({counts[tag]} 条含此标签)。",
                 f"常见共现标签:{', '.join(t for t, _ in co.most_common(10))}", "", "## 高分范例", ""]
        for _, r in sub.iterrows():
            lines.append(f"- **{r.identifier}**(aes {r.aesthetic_score:.2f}/dyn {r.dynamic_score:.2f})"
                         f":{r.text_description}\n  回源:{r.url_link}({r.scene_start_time}–{r.scene_end_time})")
        with open(os.path.join(OUT, f"sakuga-{tag}.md"), "w", encoding="utf8") as fh:
            fh.write("\n".join(lines) + "\n")
    print(f"wrote {len(top_tags)} tag docs to {OUT}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 5.2: 跑脚本**,抽查 3 篇产物(内容通顺、URL 完整、无乱码)。总纲 `_overview.md` 手写(标签清单 + 与 CHAI 五维 motion 的映射说明,~1 页)。

- [ ] **Step 5.3: 上传到现有 cinematography KB**(百炼控制台,用户已登录;与 CHAI-text 语料同库同类目 `sakuga-technique`)。

- [ ] **Step 5.4: 命中测试**:控制台命中测试 "impact frames 怎么写提示词" / "smear 拖影作画范例" 能召回对应文档;再用 `search_cinematography_kb` MCP 复测一次。

- [ ] **Step 5.5: Commit**(仅脚本;corpus 产物不入库)

```bash
git add scripts/sakuga/build_distilled_corpus.py
git commit -m "feat(sakuga): distilled corpus generator (user_tags technique docs for Bailian KB)"
```

---

## Task 6: P4 — 3000 条视频试水(音视频库)

**Files:**
- Create: `scripts/sakuga/select_pilot_clips.py`
- Create: `scripts/sakuga/download_clips.py`
- Output: `videos/Sakuga-42M/pilot/`(manifest + mp4,gitignored)

- [ ] **Step 6.1: 写 select_pilot_clips.py**

```python
"""高质量池按 top50 技法标签分层抽样:每标签按 aesthetic_score 降序取 60 条,
去重(一条可属多标签,先到先得),不足 3000 从池内高分补齐 → pilot_manifest.csv。"""
import os, collections
import pandas as pd
from build_distilled_corpus import STOP
from common import read_train_full

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "pilot")
TARGET, PER_TAG = 3000, 60

def main():
    df = read_train_full()
    pool = df[(df.aesthetic_score > 0.7) & (df.dynamic_score > 0.6) & (df.text_prob < 0.1)].copy()
    pool["tags"] = pool.user_tags.fillna("").str.split()
    counts = collections.Counter(t for ts in pool.tags for t in ts if t not in STOP)
    picked, seen = [], set()
    for tag, _ in counts.most_common(50):
        sub = pool[pool.tags.apply(lambda ts: tag in ts)].nlargest(PER_TAG * 2, "aesthetic_score")
        n = 0
        for _, r in sub.iterrows():
            if r.identifier in seen or n >= PER_TAG: continue
            seen.add(r.identifier); picked.append((tag, r)); n += 1
    if len(picked) < TARGET:
        for _, r in pool.nlargest(TARGET * 2, "aesthetic_score").iterrows():
            if len(picked) >= TARGET: break
            if r.identifier not in seen:
                seen.add(r.identifier); picked.append(("_backfill", r))
    rows = [{"tag": t, "identifier": r.identifier, "url": r.url_link,
             "desc": r.text_description, "aes": r.aesthetic_score} for t, r in picked[:TARGET]]
    os.makedirs(OUT, exist_ok=True)
    pd.DataFrame(rows).to_csv(os.path.join(OUT, "pilot_manifest.csv"), index=False)
    print(f"picked {len(rows)} clips, tags covered: {len(set(x['tag'] for x in rows))}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 6.2: 写 download_clips.py(限速 + 候补)**

```python
"""按 manifest 回源下载 sakugabooru(1 req/2s 限速,UA 标识,404/失败记 failed.csv 跳过)。
预估 3000 条 × 2-5MB ≈ 6-15GB;中断可重跑(已存在文件跳过)。"""
import os, time, csv
import requests
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "pilot")
UA = {"User-Agent": "catimation-research/1.0 (dataset pilot; contact: internal)"}

def main():
    rows = list(csv.DictReader(open(os.path.join(OUT, "pilot_manifest.csv"), encoding="utf8")))
    clips = os.path.join(OUT, "clips"); os.makedirs(clips, exist_ok=True)
    failed = []
    for i, row in enumerate(rows):
        ident = row["identifier"].replace(":", "_")
        dst = os.path.join(clips, f"{ident}.mp4")
        if os.path.exists(dst) and os.path.getsize(dst) > 0: continue
        try:
            r = requests.get(row["url"], headers=UA, timeout=60)
            if r.status_code == 200 and len(r.content) > 1024:
                open(dst, "wb").write(r.content)
            else:
                failed.append({**row, "reason": f"HTTP {r.status_code}"})
        except Exception as e:
            failed.append({**row, "reason": str(e)[:100]})
        time.sleep(2)
        if i % 100 == 0: print(f"{i}/{len(rows)} failed={len(failed)}")
    if failed:
        with open(os.path.join(OUT, "failed.csv"), "w", newline="", encoding="utf8") as fh:
            w = csv.DictWriter(fh, fieldnames=failed[0].keys()); w.writeheader(); w.writerows(failed)
    print(f"done, failed={len(failed)}(候补:从 manifest 外高分池补齐至 3000,重跑 select 加 --exclude failed)")

if __name__ == "__main__":
    main()
```

> 限速 2s/条 → 3000 条约 100 分钟纯等待 + 下载时间,预留半天挂机。

- [ ] **Step 6.3: 跑 select + download**(先 50 条冒烟确认 URL 可达,再全量)。

> **实施修正(2026-07-05,已落地)**:sakugabooru 有 Cloudflare challenge,普通 requests 一律 403;实际实现改用 `curl_cffi`(`impersonate='chrome'`)回源。且 manifest 3000 行只对应 ~2500 个源视频 URL(一行 = 源视频内一个场景),实际实现按 URL 去重下载一次,再用应用自带 ffmpeg(`resources/ffmpeg/win32-x64`)按 `scene_start_time/end_time` 重编码精切出每条 clip,切完删源省磁盘。见 `scripts/sakuga/download_clips.py` 实码;6 行冒烟已通过(ok=6 failed=0,ffprobe 校验 h264/时长与场景吻合)。

- [ ] **Step 6.4: 上传 OSS**(`datasets/sakuga-42m/pilot-clips/`,控制台或 ossutil)。

- [ ] **Step 6.5: 建百炼「音视频搜索类知识库」**(控制台,用户已登录):数据源选 OSS 导入 pilot-clips;开启视频帧提取;**剧情解析关**;Meta 信息抽取配 `file_name` 变量(identifier 可回查 manifest)。等待解析完成。

- [ ] **Step 6.6: 命中测试**:控制台测 "烟雾爆炸效果的作画片段" / "角色快速拖影打斗" 能召回相关片段与时间戳;记录召回质量观感。

- [ ] **Step 6.7: 试水报告**:`docs/superpowers/specs/2026-07-05-sakuga-cloud-native-kb-design.md` 追加"P4 试水结果"小节——召回效果、解析费用账单数字、是否扩量/是否开剧情解析的建议。Commit。

- [ ] **Step 6.8: Commit 脚本**

```bash
git add scripts/sakuga/select_pilot_clips.py scripts/sakuga/download_clips.py
git commit -m "feat(sakuga): pilot clip selection & rate-limited sourcing pipeline (3000 clips)"
```

---

## Self-Review 结论

- **Spec 覆盖**:①OSS=Task1;②DashVector=Task2/3;③蒸馏=Task5;④音视频 3000=Task6;MCP 工具+注入链=Task4;验收标准 1-4 分别落在 Step 3.4/4.7/5.4/6.6,标准 5(账单)落在 6.7。
- **一致性**:`COLLECTION='sakuga42m'`、512 维、字段小写化贯穿 common.py/create_collection/embed_upsert/verify/index.js;`row_to_fields` 被 verify 复用,单一事实源。
- **占位符**:index.js 的 `DASHVECTOR_ENDPOINT = 'REPLACE_WITH_CLUSTER_ENDPOINT'` 是刻意的实施期回填点(cluster 在 Task 2 才创建),Step 4.7 端到端冒烟会强制暴露漏填;DashVector HTTP 细节以官方文档为准并由 Step 2.2 描述校验兜底。
- **顺序依赖**:Task 2 依赖用户登录/开通;Task 3 依赖 Task 2;Task 4 的 Step 4.3 依赖 Task 2 的 endpoint,但 4.1-4.2(纯函数 TDD)可提前;Task 5/6 只依赖本地 parquet + 用户登录,可与 Task 3 并行。
