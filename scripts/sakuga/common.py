"""Sakuga-42M 云化管线共享模块。凭证从环境变量读取:
DASHSCOPE_API_KEY / DASHVECTOR_API_KEY / DASHVECTOR_ENDPOINT
(DASHVECTOR_ENDPOINT 形如 vrs-cn-xxx.dashvector.cn-hangzhou.aliyuncs.com)
"""
import os
import time

import requests
import pyarrow.parquet as pq

METADATA_DIR = os.path.join(
    os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "metadata"
)
TRAIN_FULL = os.path.join(METADATA_DIR, "sakugadataset_train_full.parquet")
COLLECTION = "sakuga42m"
DIM = 512


def doc_id(identifier: str) -> str:
    """DashVector doc id 只允许 [a-zA-Z0-9_-!@#$%+=.];原始 identifier
    形如 '127464:15',冒号非法 → 换 '_'。原值完整保留在 identifier 字段。"""
    return str(identifier).replace(":", "_")


def env(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise SystemExit(f"missing env: {name}")
    return v


def embed_batch(texts: list, retries: int = 8) -> list:
    """DashScope text-embedding-v4,512 维,单请求 ≤10 条。限流与网络瞬断
    (SSL EOF/连接重置/超时)均指数退避重试。"""
    url = (
        "https://dashscope.aliyuncs.com/api/v1/services/embeddings/"
        "text-embedding/text-embedding"
    )
    headers = {
        "Authorization": f"Bearer {env('DASHSCOPE_API_KEY')}",
        "Content-Type": "application/json",
    }
    body = {
        "model": "text-embedding-v4",
        "input": {"texts": texts},
        "parameters": {"dimension": DIM},
    }
    last_err = None
    for attempt in range(retries):
        try:
            r = requests.post(url, headers=headers, json=body, timeout=60)
        except requests.exceptions.RequestException as e:
            last_err = f"{type(e).__name__}: {str(e)[:200]}"
            time.sleep(min(2**attempt, 60))
            continue
        if r.status_code == 200:
            out = r.json()["output"]["embeddings"]
            return [e["embedding"] for e in sorted(out, key=lambda x: x["text_index"])]
        last_err = f"HTTP {r.status_code}: {r.text[:300]}"
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(min(2**attempt, 60))
            continue
        raise RuntimeError(f"embed {last_err}")
    raise RuntimeError(f"embed: retries exhausted ({last_err})")


class DashVector:
    """DashVector HTTP API 极简客户端(路径/请求体以官方文档为准,
    describe 校验一跑即可暴露偏差)。"""

    def __init__(self):
        self.base = f"https://{env('DASHVECTOR_ENDPOINT')}/v1"
        self.h = {
            "dashvector-auth-token": env("DASHVECTOR_API_KEY"),
            "Content-Type": "application/json",
        }

    def create_collection(self, fields_schema: dict) -> dict:
        body = {
            "name": COLLECTION,
            "dimension": DIM,
            "metric": "cosine",
            "dtype": "FLOAT",
            "fields_schema": fields_schema,
        }
        r = requests.post(f"{self.base}/collections", headers=self.h, json=body, timeout=30)
        return r.json()

    def describe(self) -> dict:
        r = requests.get(f"{self.base}/collections/{COLLECTION}", headers=self.h, timeout=30)
        return r.json()

    def upsert(self, docs: list, retries: int = 5) -> dict:
        """POST /docs/upsert(PUT /docs 是 update 语义,key 不存在会失败)。
        顶层 code==0 不代表逐条成功,必须校验 output 里每条的 code。"""
        last_err = None
        for attempt in range(retries):
            try:
                r = requests.post(
                    f"{self.base}/collections/{COLLECTION}/docs/upsert",
                    headers=self.h,
                    json={"docs": docs},
                    timeout=120,
                )
            except requests.exceptions.RequestException as e:
                last_err = f"{type(e).__name__}: {str(e)[:200]}"
                time.sleep(min(2**attempt, 60))
                continue
            if r.status_code == 200:
                j = r.json()
                per_doc = j.get("output") or []
                bad = [o for o in per_doc if o.get("code") != 0]
                if j.get("code") == 0 and not bad:
                    return j
                if bad:
                    raise RuntimeError(f"upsert per-doc failures: {bad[:3]}")
            last_err = f"HTTP {r.status_code}: {r.text[:300]}"
            time.sleep(min(2**attempt, 60))
        raise RuntimeError(f"upsert failed: {last_err}")

    def fetch(self, ids: list) -> dict:
        r = requests.get(
            f"{self.base}/collections/{COLLECTION}/docs",
            headers=self.h,
            params={"ids": ",".join(ids)},
            timeout=30,
        )
        return r.json()

    def query(self, vector, topk=10, flt=None, output_fields=None) -> dict:
        body = {"vector": vector, "topk": topk, "include_vector": False}
        if flt:
            body["filter"] = flt
        if output_fields:
            body["output_fields"] = output_fields
        r = requests.post(
            f"{self.base}/collections/{COLLECTION}/query",
            headers=self.h,
            json=body,
            timeout=60,
        )
        return r.json()


def read_train_full(columns=None):
    return pq.read_table(TRAIN_FULL, columns=columns).to_pandas()
