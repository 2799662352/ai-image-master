"""高质量池(aes>0.7 & dyn>0.6 & text_prob<0.1)按 user_tags 技法标签蒸馏:
每个高频标签(≥3000 次,剔除非技法词)一篇 markdown——
共现标签 top10 + top15 高分描述范例(带 identifier/url/时间码)。
产物写到 videos/Sakuga-42M/corpus/(gitignored,可再生),供上传百炼 KB。
"""
import collections
import os

from common import read_train_full

OUT = os.path.join(
    os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "corpus"
)
# 非技法词:媒介/来源/免责类 + IP/系列/画师名,对提示词工程无指导意义
STOP = {
    "animated",
    "artist_unknown",
    "presumed",
    "western",
    "eastern",
    "production_materials",
    "cgi",
    "web",
    "remake",
    # IP / 系列 / 画师(高质量池 top70 中出现的)
    "gundam",
    "pokemon",
    "one_piece",
    "precure",
    "naruto",
    "naruto_shippuuden",
    "fate_series",
    "masaaki_iwane",
    "my_hero_academia",
    "senki_zesshou_symphogear_series",
    "sword_art_online_series",
    "bleach_series",
    "bleach",
    "mahou_shoujo_lyrical_nanoha",
    "hironori_tanaka",
    "digimon",
    "dragon_ball_series",
    "gintama",
    "jujutsu_kaisen_series",
    "pokemon_xy",
    "detective_conan",
    "dragon_quest",
    "gundam_build_series",
    "naotoshi_shida",
}
# 标志性作画技法:频次不足 MIN_COUNT 也强制收录
WHITELIST = {
    "kanada_light_flare",
    "itano_circus",
    "gattai",
    "henkei",
    "black_and_white",
    "crying",
}
MIN_COUNT = 3000
MAX_TAGS = 60
EXAMPLES_PER_TAG = 15


def main():
    df = read_train_full()
    pool = df[
        (df.aesthetic_score > 0.7) & (df.dynamic_score > 0.6) & (df.text_prob < 0.1)
    ].copy()
    pool["tags"] = pool.user_tags.fillna("").str.split()
    # 排序用双分:纯 aesthetic 会选出"画面漂亮但看不出技法"的片段,
    # 叠加 dynamic 让运动感强的范例优先(技法标签多为运动类)
    pool["rank_score"] = pool.aesthetic_score + pool.dynamic_score
    counts = collections.Counter(
        t for tags in pool.tags for t in tags if t not in STOP
    )
    top_tags = [t for t, n in counts.most_common(MAX_TAGS + 40) if n >= MIN_COUNT][
        :MAX_TAGS
    ]
    top_tags += [t for t in WHITELIST if t not in top_tags and counts[t] > 0]
    os.makedirs(OUT, exist_ok=True)
    print(f"pool={len(pool)} rows, tags selected={len(top_tags)}")

    for tag in top_tags:
        sub = pool[pool.tags.apply(lambda ts: tag in ts)].nlargest(
            EXAMPLES_PER_TAG, "rank_score"
        )
        co = collections.Counter(
            t for ts in sub.tags for t in ts if t != tag and t not in STOP
        )
        lines = [
            f"# Sakuga 作画技法:{tag}",
            "",
            f"来源:Sakuga-42M 高质量池(aesthetic>0.7 / dynamic>0.6 / text_prob<0.1),"
            f"含此标签共 {counts[tag]} 条。",
            f"常见共现标签:{', '.join(t for t, _ in co.most_common(10))}",
            "",
            "## 高分范例(供提示词参考,回源链接指向 sakugabooru 原片段)",
            "",
        ]
        for _, r in sub.iterrows():
            lines.append(
                f"- **{r.identifier}**(aes {r.aesthetic_score:.2f} / dyn {r.dynamic_score:.2f})"
                f":{r.text_description}\n"
                f"  回源:{r.url_link}({r.scene_start_time}–{r.scene_end_time})"
            )
        with open(
            os.path.join(OUT, f"sakuga-{tag}.md"), "w", encoding="utf8"
        ) as fh:
            fh.write("\n".join(lines) + "\n")
    print(f"wrote {len(top_tags)} tag docs to {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
