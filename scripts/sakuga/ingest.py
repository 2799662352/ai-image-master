"""train_full → DashVector 灌入(断点续跑)。

用法:
  python ingest.py --limit 500        # 冒烟:只灌前 500 行(自然顺序)
  python ingest.py --top 300000       # top N 高分子集(aesthetic+dynamic 排序)
  python ingest.py                    # 全量 1,117,898 行
断点:checkpoint*.txt 记录已完成的行区间末尾,重跑自动跳过(--top 用独立
checkpoint_top.txt / vectors_top/,与自然顺序模式互不干扰)。
向量缓存:embeddings 落盘 *.npy 分片,免费试用集群到期迁移时无需重新 embedding。
"""
import argparse
import os
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from common import DashVector, doc_id, embed_batch, read_train_full

HERE = os.path.dirname(os.path.abspath(__file__))
EMBED_BATCH = 10    # DashScope 单请求上限
EMBED_WORKERS = 6   # 并行 embedding 请求数(遇 429 由 embed_batch 内部退避)
UPSERT_BATCH = 120  # 一次 upsert 的 doc 数
VEC_SHARD = 10000   # 每个 .npy 分片行数

STR_COLS = [
    "identifier", "hash_identifier", "url_link", "scene_start_time",
    "scene_end_time", "anime_tags", "user_tags", "text_description",
    "rating", "file_ext", "Taxonomy_Time", "Taxonomy_Venue", "Taxonomy_Media",
    "Taxonomy_Filming", "Taxonomy_Composition", "Taxonomy_Character",
]
FLOAT_COLS = ["frame_number", "key_frame_number", "aesthetic_score",
              "dynamic_score", "text_prob", "fps"]
INT_COLS = ["width", "height"]


def load_ckpt(path: str) -> int:
    if os.path.exists(path):
        return int(open(path).read().strip() or 0)
    return 0


def save_ckpt(path: str, n: int):
    with open(path, "w") as f:
        f.write(str(n))


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


def embed_texts(df: pd.DataFrame) -> list:
    """text_description 为空时退化用 user_tags,再不行用 anime_tags。"""
    texts = []
    for _, row in df.iterrows():
        t = row["text_description"]
        if pd.isna(t) or not str(t).strip():
            t = row["user_tags"] if not pd.isna(row["user_tags"]) else ""
        if not str(t).strip():
            t = row["anime_tags"] if not pd.isna(row["anime_tags"]) else "animation clip"
        texts.append(str(t)[:2000])
    batches = [texts[i:i + EMBED_BATCH] for i in range(0, len(texts), EMBED_BATCH)]
    with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as ex:
        results = list(ex.map(embed_batch, batches))
    return [v for batch in results for v in batch]


def vec_shard_path(vec_dir: str, shard_idx: int) -> str:
    return os.path.join(vec_dir, f"vec_{shard_idx:05d}.npy")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 行(冒烟,自然顺序)")
    ap.add_argument("--top", type=int, default=0,
                    help="只灌 top N 高分子集(aesthetic_score+dynamic_score 降序)")
    args = ap.parse_args()

    df = read_train_full()
    if args.top:
        # 与 build_distilled_corpus 同口径的双分排序;identifier 作稳定次序键,
        # 保证断点续跑时选集与顺序完全可复现
        df = (
            df.assign(_rank=df.aesthetic_score.fillna(0) + df.dynamic_score.fillna(0))
            .sort_values(["_rank", "identifier"], ascending=[False, True])
            .head(args.top)
            .drop(columns="_rank")
            .reset_index(drop=True)
        )
        ckpt_path = os.path.join(HERE, "checkpoint_top.txt")
        vec_dir = os.path.join(HERE, "vectors_top")
    else:
        ckpt_path = os.path.join(HERE, "checkpoint.txt")
        vec_dir = os.path.join(HERE, "vectors")

    os.makedirs(vec_dir, exist_ok=True)
    total = len(df) if not args.limit else min(args.limit, len(df))
    start = load_ckpt(ckpt_path)
    if start >= total:
        print(f"checkpoint {start} >= total {total}, nothing to do")
        return

    dv = DashVector()
    print(f"ingest rows [{start}, {total}) of {len(df)} (mode: {'top' if args.top else 'natural'})")
    t0 = time.time()
    done = start
    # 向量分片缓存:内存中攒当前分片,写满或结束时落盘
    shard_idx = start // VEC_SHARD
    shard_buf = {}
    shard_file = vec_shard_path(vec_dir, shard_idx)
    if os.path.exists(shard_file):
        shard_buf = np.load(shard_file, allow_pickle=True).item()

    for lo in range(start, total, UPSERT_BATCH):
        hi = min(lo + UPSERT_BATCH, total)
        chunk = df.iloc[lo:hi]
        vecs = embed_texts(chunk)
        docs = []
        for (_, row), v in zip(chunk.iterrows(), vecs):
            docs.append({
                "id": doc_id(row["identifier"]),
                "vector": v,
                "fields": row_fields(row),
            })
        dv.upsert(docs)
        # 缓存向量(按子集行号分片落盘,集群到期迁移时无需重新 embedding)
        for off, ((_, row), v) in enumerate(zip(chunk.iterrows(), vecs)):
            gidx = lo + off
            si = gidx // VEC_SHARD
            if si != shard_idx:
                np.save(vec_shard_path(vec_dir, shard_idx), shard_buf, allow_pickle=True)
                shard_idx, shard_buf = si, {}
                sf = vec_shard_path(vec_dir, si)
                if os.path.exists(sf):
                    shard_buf = np.load(sf, allow_pickle=True).item()
            shard_buf[str(row["identifier"])] = np.asarray(v, dtype=np.float32)
        done = hi
        save_ckpt(ckpt_path, done)
        if (done - start) % 1200 < UPSERT_BATCH or done == total:
            rate = (done - start) / max(time.time() - t0, 1)
            eta = (total - done) / max(rate, 0.01)
            print(f"  {done}/{total}  {rate:.1f} rows/s  ETA {eta/3600:.1f}h", flush=True)

    np.save(vec_shard_path(vec_dir, shard_idx), shard_buf, allow_pickle=True)
    print(f"done: {done} rows in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
