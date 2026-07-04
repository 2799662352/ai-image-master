"""P4 试水选片:高质量池按 top50 技法标签分层抽样,每标签按 aes+dyn 双分
降序取 60 条,跨标签去重(先到先得),不足 3000 从池内高分补齐。
产物 videos/Sakuga-42M/pilot/pilot_manifest.csv(gitignored,可再生)。
"""
import collections
import os

import pandas as pd

from build_distilled_corpus import STOP
from common import read_train_full

OUT = os.path.join(
    os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "pilot"
)
TARGET = 3000
PER_TAG = 60
TOP_TAGS = 50


def main():
    df = read_train_full()
    pool = df[
        (df.aesthetic_score > 0.7) & (df.dynamic_score > 0.6) & (df.text_prob < 0.1)
    ].copy()
    pool["tags"] = pool.user_tags.fillna("").str.split()
    pool["rank_score"] = pool.aesthetic_score + pool.dynamic_score
    counts = collections.Counter(
        t for ts in pool.tags for t in ts if t not in STOP
    )
    picked, seen = [], set()
    for tag, _ in counts.most_common(TOP_TAGS):
        sub = pool[pool.tags.apply(lambda ts: tag in ts)].nlargest(
            PER_TAG * 2, "rank_score"
        )
        n = 0
        for _, r in sub.iterrows():
            if r.identifier in seen or n >= PER_TAG:
                continue
            seen.add(r.identifier)
            picked.append((tag, r))
            n += 1
    if len(picked) < TARGET:
        for _, r in pool.nlargest(TARGET * 2, "rank_score").iterrows():
            if len(picked) >= TARGET:
                break
            if r.identifier not in seen:
                seen.add(r.identifier)
                picked.append(("_backfill", r))
    rows = [
        {
            "tag": t,
            "identifier": r.identifier,
            "url": r.url_link,
            "start": r.scene_start_time,
            "end": r.scene_end_time,
            "desc": r.text_description,
            "aes": round(float(r.aesthetic_score), 4),
            "dyn": round(float(r.dynamic_score), 4),
        }
        for t, r in picked[:TARGET]
    ]
    os.makedirs(OUT, exist_ok=True)
    out_csv = os.path.join(OUT, "pilot_manifest.csv")
    pd.DataFrame(rows).to_csv(out_csv, index=False, encoding="utf-8-sig")
    tags_covered = len(set(x["tag"] for x in rows))
    print(f"picked {len(rows)} clips, tags covered: {tags_covered} -> {out_csv}")


if __name__ == "__main__":
    main()
