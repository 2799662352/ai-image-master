"""为已下载的 pilot 片段生成"自带元数据"的命名副本(硬链接,不占空间)。

文件名 = {identifier}__{user_tags 全量拼接}.mp4
百炼音视频库检索结果每条都返回【文档名】,tags 里的技法词条(impact_frames/
smears/itano_circus...)与作画人员(yutaka_nakamura/hiroyuki_imaishi...)
就随每次检索一并返回,无需 Meta 模板。

用法: python build_named_clips.py            # 处理 pilot/clips 下全部已下载片段
"""
import csv
import json
import os
import re

import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
PILOT = os.path.normpath(os.path.join(HERE, "..", "..", "videos", "Sakuga-42M", "pilot"))
CLIPS = os.path.join(PILOT, "clips")
NAMED = os.path.join(PILOT, "clips_named")
MANIFEST = os.path.join(PILOT, "pilot_manifest.csv")
TRAIN_FULL = os.path.normpath(os.path.join(
    HERE, "..", "..", "videos", "Sakuga-42M", "metadata", "sakugadataset_train_full.parquet"
))
TAG_DICT = os.path.normpath(os.path.join(
    HERE, "..", "..", "resources", "cinematography-kb-mcp", "sakuga-tag-types.json"
))
# 百炼上传实测:文件名 >~110 字符被静默丢弃 → 含 .mp4 后缀整体压到 100
MAX_NAME = 96
# 截断时的保留优先级:作画人员 > 技法词条 > 工作室 > 作品 > 其余
TYPE_PRIORITY = {"artist": 0, "general": 1, "circle": 2, "copyright": 3}


def safe(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z_\-+]", "_", s)


def load_tag_priority() -> dict:
    """tag -> 排序优先级(小者优先保留)。词典缺失时全部按同级处理。"""
    prio = {}
    try:
        with open(TAG_DICT, encoding="utf-8") as f:
            dic = json.load(f)
        for type_name, names in dic.items():
            if type_name.startswith("_"):
                continue
            p = TYPE_PRIORITY.get(type_name, 4)
            for n in names:
                prio[n] = p
    except OSError:
        pass
    return prio


def main():
    os.makedirs(NAMED, exist_ok=True)
    with open(MANIFEST, encoding="utf-8-sig") as f:
        manifest_ids = [row["identifier"] for row in csv.DictReader(f)]
    wanted = set(manifest_ids)

    t = pq.read_table(TRAIN_FULL, columns=["identifier", "user_tags"])
    tags_by_id = {}
    for ident, tags in zip(t.column(0).to_pylist(), t.column(1).to_pylist()):
        if ident in wanted:
            tags_by_id[ident] = tags or ""

    prio = load_tag_priority()
    made = skipped = missing = 0
    for ident in manifest_ids:
        src = os.path.join(CLIPS, ident.replace(":", "_") + ".mp4")
        if not os.path.exists(src):
            missing += 1
            continue
        tags = tags_by_id.get(ident, "")
        # 去掉无信息量标签;按 作画人员>技法>工作室>作品 排序,超长时砍后面的
        toks = [x for x in tags.split() if x not in ("animated", "presumed", "artist_unknown")]
        toks.sort(key=lambda t: (prio.get(t, 4), t))
        stem = safe(ident.replace(":", "_")) + "__"
        budget = MAX_NAME - len(stem)
        kept = []
        for t in toks:
            piece = safe(t) if not kept else "+" + safe(t)
            if len(piece) > budget:
                break
            kept.append(safe(t))
            budget -= len(piece)
        name = stem + "+".join(kept) + ".mp4"
        dst = os.path.join(NAMED, name)
        if os.path.exists(dst):
            skipped += 1
            continue
        try:
            os.link(src, dst)  # 硬链接:零拷贝
        except OSError:
            import shutil
            shutil.copy2(src, dst)
        made += 1
    print(f"named clips: made={made} skipped={skipped} missing_src={missing} -> {NAMED}")


if __name__ == "__main__":
    main()
