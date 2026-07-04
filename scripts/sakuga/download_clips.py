"""P4 试水下载:按 pilot_manifest.csv 回源 sakugabooru。

实测要点(2026-07-05):
- sakugabooru 有 Cloudflare challenge,普通 requests/curl 一律 403;
  用 curl_cffi 的 TLS 浏览器伪装(impersonate='chrome')可正常 200。
- manifest 3000 行只对应 ~2500 个源视频 URL(一行 = 源视频内一个场景),
  故每个 URL 只下载一次,再用应用自带 ffmpeg 按 scene start/end 精切,
  切完删源视频省磁盘。

用法:python download_clips.py [--limit N]  (N 按"行"计,用于冒烟)
产物:videos/Sakuga-42M/pilot/clips/<identifier>.mp4 + failed.csv
中断可重跑(已存在的 clip 跳过)。依赖:pip install curl_cffi
"""
import csv
import os
import subprocess
import sys
import time

from curl_cffi import requests as cr

OUT = os.path.join(
    os.path.dirname(__file__), "..", "..", "videos", "Sakuga-42M", "pilot"
)
FFMPEG = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "resources",
    "ffmpeg",
    "win32-x64",
    "ffmpeg.exe",
)
RATE_SECONDS = 2


def cut_clip(src: str, dst: str, start: str, end: str) -> bool:
    """场景精切:重编码保证非关键帧切点也准。"""
    cmd = [
        FFMPEG, "-y", "-i", src, "-ss", start, "-to", end,
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-movflags", "faststart", "-pix_fmt", "yuv420p", dst,
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=300)
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 1024


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    with open(os.path.join(OUT, "pilot_manifest.csv"), encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    if limit:
        rows = rows[:limit]

    clips_dir = os.path.join(OUT, "clips")
    tmp_dir = os.path.join(OUT, "_src_tmp")
    os.makedirs(clips_dir, exist_ok=True)
    os.makedirs(tmp_dir, exist_ok=True)

    by_url = {}
    for row in rows:
        by_url.setdefault(row["url"], []).append(row)

    failed, done = [], 0
    for ui, (url, group) in enumerate(by_url.items()):
        pending = [
            r for r in group
            if not os.path.exists(
                os.path.join(clips_dir, r["identifier"].replace(":", "_") + ".mp4")
            )
        ]
        done += len(group) - len(pending)
        if not pending:
            continue
        src = os.path.join(tmp_dir, os.path.basename(url.split("?")[0]))
        try:
            resp = cr.get(url, impersonate="chrome", timeout=120)
            if resp.status_code != 200 or len(resp.content) < 1024:
                for r in pending:
                    failed.append({**r, "reason": f"HTTP {resp.status_code}"})
                time.sleep(RATE_SECONDS)
                continue
            with open(src, "wb") as fh:
                fh.write(resp.content)
            for r in pending:
                dst = os.path.join(
                    clips_dir, r["identifier"].replace(":", "_") + ".mp4"
                )
                if cut_clip(src, dst, r["start"], r["end"]):
                    done += 1
                else:
                    failed.append({**r, "reason": "ffmpeg cut failed"})
        except Exception as e:  # noqa: BLE001 - 单 URL 失败不拖垮批任务
            for r in pending:
                failed.append({**r, "reason": str(e)[:100]})
        finally:
            if os.path.exists(src):
                os.remove(src)
        time.sleep(RATE_SECONDS)
        if (ui + 1) % 50 == 0:
            print(
                f"url {ui + 1}/{len(by_url)} clips ok={done} failed={len(failed)}",
                flush=True,
            )

    if failed:
        with open(
            os.path.join(OUT, "failed.csv"), "w", newline="", encoding="utf-8-sig"
        ) as fh:
            w = csv.DictWriter(fh, fieldnames=list(failed[0].keys()))
            w.writeheader()
            w.writerows(failed)
    print(f"DONE clips ok={done} failed={len(failed)}")


if __name__ == "__main__":
    main()
