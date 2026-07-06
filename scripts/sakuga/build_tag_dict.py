"""从 sakugabooru tag API 拉标签分类词典,输出给 MCP 用的紧凑 JSON。

sakugabooru 是 moebooru 系,/tag.json 的 type 字段:
  0=general(技法/内容词条) 1=artist(作画人员) 3=copyright(作品)
  4=character(角色) 5=circle(工作室/团体) 6=faults
只保留出现在我们 train_full user_tags 里的 token,体积可控。
产物: resources/cinematography-kb-mcp/sakuga-tag-types.json
      { "artist": [...], "copyright": [...], "general": [...], ... }

需要 curl_cffi 过 Cloudflare(与视频下载脚本同法)。
"""
import json
import os
import time

import pandas as pd
from curl_cffi import requests as creq

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_FULL = os.path.normpath(os.path.join(
    HERE, "..", "..", "videos", "Sakuga-42M", "metadata", "sakugadataset_train_full.parquet"
))
OUT = os.path.normpath(os.path.join(
    HERE, "..", "..", "resources", "cinematography-kb-mcp", "sakuga-tag-types.json"
))
TYPE_NAMES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "circle", 6: "faults"}


def wanted_tokens() -> set:
    df = pd.read_parquet(TRAIN_FULL, columns=["user_tags"])
    toks = set()
    for tags in df["user_tags"]:
        if isinstance(tags, str):
            toks.update(tags.split())
    return toks


def fetch_all_tags() -> list:
    tags, page = [], 1
    while True:
        for attempt in range(5):
            try:
                r = creq.get(
                    "https://www.sakugabooru.com/tag.json",
                    params={"limit": 1000, "page": page, "order": "count"},
                    impersonate="chrome", timeout=60,
                )
                if r.status_code == 200:
                    batch = r.json()
                    break
            except Exception:
                pass
            time.sleep(2 ** attempt)
        else:
            raise RuntimeError(f"tag.json page {page} failed")
        if not batch:
            return tags
        tags.extend(batch)
        print(f"page {page}: +{len(batch)} (total {len(tags)})", flush=True)
        page += 1
        time.sleep(0.4)


def main():
    wanted = wanted_tokens()
    print(f"dataset unique user_tag tokens: {len(wanted)}")
    all_tags = fetch_all_tags()
    print(f"booru tags fetched: {len(all_tags)}")

    by_type = {}
    seen = set()
    for t in all_tags:
        name, ttype = t.get("name"), t.get("type")
        if name in wanted and name not in seen:
            seen.add(name)
            by_type.setdefault(TYPE_NAMES.get(ttype, f"type{ttype}"), []).append(name)
    for k in by_type:
        by_type[k].sort()
    unknown = sorted(wanted - seen)
    by_type["_unmatched"] = unknown
    print({k: len(v) for k, v in by_type.items()})

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(by_type, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")


if __name__ == "__main__":
    main()
