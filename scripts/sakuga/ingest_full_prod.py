"""全量 1.1M → 付费 Serverless 集群灌入(断点续跑 + 复用已有 embedding 缓存)。

- 自然顺序遍历 train_full 全部行;checkpoint_full_prod.txt 记录进度。
- 启动时合并 vectors_top/ + vectors/ + vectors_full/ 所有 .npy 分片为
  identifier→vec 缓存;命中的行跳过 embedding 直接 upsert。
- 新算出的 embedding 按全局行号分片写入 vectors_full/,支持再次迁移零重算。

用法: python ingest_full_prod.py   (env: DASHSCOPE_API_KEY/DASHVECTOR_API_KEY/DASHVECTOR_ENDPOINT)
"""
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from common import DashVector, doc_id, embed_batch, read_train_full

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT = os.path.join(HERE, "checkpoint_full_prod.txt")
VEC_FULL_DIR = os.path.join(HERE, "vectors_full")
CACHE_DIRS = [os.path.join(HERE, "vectors_top"), os.path.join(HERE, "vectors"), VEC_FULL_DIR]
EMBED_BATCH = 10
EMBED_WORKERS = 6
UPSERT_BATCH = 120
VEC_SHARD = 10000

STR_COLS = [
    "identifier", "hash_identifier", "url_link", "scene_start_time",
    "scene_end_time", "anime_tags", "user_tags", "text_description",
    "rating", "file_ext", "Taxonomy_Time", "Taxonomy_Venue", "Taxonomy_Media",
    "Taxonomy_Filming", "Taxonomy_Composition", "Taxonomy_Character",
]
FLOAT_COLS = ["frame_number", "key_frame_number", "aesthetic_score",
              "dynamic_score", "text_prob", "fps"]
INT_COLS = ["width", "height"]


def row_fields(row) -> dict:
    f = {}
    for c in STR_COLS:
        v = row[c]
        f[c] = "" if pd.isna(v) else str(v)
    for c in FLOAT_COLS:
        v = row[c]
        f[c] = 0.0 if pd.isna(v) else float(v)
    for c in INT_COLS:
        v = row[c]
        f[c] = 0 if pd.isna(v) else int(v)
    return f


def embed_text_of(row) -> str:
    t = row["text_description"]
    if pd.isna(t) or not str(t).strip():
        t = row["user_tags"] if not pd.isna(row["user_tags"]) else ""
    if not str(t).strip():
        t = row["anime_tags"] if not pd.isna(row["anime_tags"]) else "animation clip"
    return str(t)[:2000]


def load_cache() -> dict:
    cache = {}
    for d in CACHE_DIRS:
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".npy"):
                cache.update(np.load(os.path.join(d, name), allow_pickle=True).item())
    return cache


def main():
    os.makedirs(VEC_FULL_DIR, exist_ok=True)
    df = read_train_full()
    total = len(df)
    start = int(open(CKPT).read().strip() or 0) if os.path.exists(CKPT) else 0
    if start >= total:
        print(f"checkpoint {start} >= total {total}, nothing to do")
        return

    print("loading embedding cache ...", flush=True)
    cache = load_cache()
    print(f"cache: {len(cache)} vectors", flush=True)

    dv = DashVector()
    print(f"ingest rows [{start}, {total})", flush=True)
    t0 = time.time()
    shard_idx = start // VEC_SHARD
    shard_file = os.path.join(VEC_FULL_DIR, f"vec_{shard_idx:05d}.npy")
    shard_buf = np.load(shard_file, allow_pickle=True).item() if os.path.exists(shard_file) else {}

    for lo in range(start, total, UPSERT_BATCH):
        hi = min(lo + UPSERT_BATCH, total)
        chunk = df.iloc[lo:hi]
        rows = list(chunk.iterrows())
        ids = [str(r["identifier"]) for _, r in rows]

        # 缓存命中直接用;缺的批量 embedding
        missing = [(i, r) for i, (_, r) in enumerate(rows) if ids[i] not in cache]
        if missing:
            texts = [embed_text_of(r) for _, r in missing]
            batches = [texts[i:i + EMBED_BATCH] for i in range(0, len(texts), EMBED_BATCH)]
            with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as ex:
                results = list(ex.map(embed_batch, batches))
            new_vecs = [v for b in results for v in b]
            for (i, r), v in zip(missing, new_vecs):
                cache[ids[i]] = np.asarray(v, dtype=np.float32)

        docs = []
        for i, (_, row) in enumerate(rows):
            docs.append({
                "id": doc_id(row["identifier"]),
                "vector": [float(x) for x in cache[ids[i]]],
                "fields": row_fields(row),
            })
        dv.upsert(docs)

        # 新 embedding 持久化(按全局行号分片;命中老缓存的行不重复写)
        for off, (_, row) in enumerate(rows):
            gidx = lo + off
            si = gidx // VEC_SHARD
            if si != shard_idx:
                np.save(os.path.join(VEC_FULL_DIR, f"vec_{shard_idx:05d}.npy"),
                        shard_buf, allow_pickle=True)
                shard_idx, shard_buf = si, {}
                sf = os.path.join(VEC_FULL_DIR, f"vec_{si:05d}.npy")
                if os.path.exists(sf):
                    shard_buf = np.load(sf, allow_pickle=True).item()
            shard_buf[str(row["identifier"])] = cache[str(row["identifier"])]

        with open(CKPT, "w") as f:
            f.write(str(hi))
        if (hi - start) % 2400 < UPSERT_BATCH or hi == total:
            rate = (hi - start) / max(time.time() - t0, 1)
            eta = (total - hi) / max(rate, 0.01)
            print(f"  {hi}/{total}  {rate:.1f} rows/s  ETA {eta/3600:.1f}h", flush=True)

    np.save(os.path.join(VEC_FULL_DIR, f"vec_{shard_idx:05d}.npy"), shard_buf, allow_pickle=True)
    print(f"DONE_FULL_INGEST rows={total} in {(time.time()-t0)/3600:.2f}h", flush=True)


if __name__ == "__main__":
    main()
