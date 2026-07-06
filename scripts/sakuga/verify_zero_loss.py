"""零丢失抽验:随机抽已灌入的行,fetch 回来逐字段与 parquet 原值比对。
用法: python verify_zero_loss.py --rows 500 --sample 20
      python verify_zero_loss.py --top 300000 --sample 40   # 抽验 top-N 子集
"""
import argparse

from common import DashVector, doc_id, read_train_full
from ingest import STR_COLS, FLOAT_COLS, INT_COLS, row_fields


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=500, help="已灌入的行数范围(自然顺序)")
    ap.add_argument("--top", type=int, default=0, help="抽验 top N 高分子集(与 ingest --top 同排序)")
    ap.add_argument("--sample", type=int, default=20)
    args = ap.parse_args()

    df = read_train_full()
    if args.top:
        df = (
            df.assign(_rank=df.aesthetic_score.fillna(0) + df.dynamic_score.fillna(0))
            .sort_values(["_rank", "identifier"], ascending=[False, True])
            .head(args.top)
            .drop(columns="_rank")
            .reset_index(drop=True)
        )
    else:
        df = df.iloc[:args.rows]
    picks = df.sample(n=min(args.sample, len(df)), random_state=42)
    dv = DashVector()
    ids = [doc_id(r["identifier"]) for _, r in picks.iterrows()]
    resp = dv.fetch(ids)
    if resp.get("code") != 0 or "output" not in resp:
        raise SystemExit(f"fetch failed: {resp}")
    docs = resp["output"]

    bad = 0
    for _, row in picks.iterrows():
        rid = doc_id(row["identifier"])
        doc = docs.get(rid)
        if not doc:
            print(f"MISSING doc: {rid}")
            bad += 1
            continue
        expect = row_fields(row)
        got = doc["fields"]
        for k, ev in expect.items():
            gv = got.get(k)
            if k in FLOAT_COLS:
                ok = abs(float(gv) - float(ev)) < 1e-4
            elif k in INT_COLS:
                ok = int(gv) == int(ev)
            else:
                ok = str(gv) == str(ev)
            if not ok:
                print(f"DIFF {rid}.{k}: parquet={ev!r} dashvector={gv!r}")
                bad += 1
    print(f"checked {len(picks)} docs x {len(STR_COLS)+len(FLOAT_COLS)+len(INT_COLS)} fields, mismatches: {bad}")
    if bad == 0:
        print("ZERO-LOSS VERIFIED")


if __name__ == "__main__":
    main()
