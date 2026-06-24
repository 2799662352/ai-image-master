---
name: ffmpeg-win
description: Process video/audio with FFmpeg 8.1, preferring the bundled local ffmpeg/ffprobe CLI (on PATH, zero Docker, zero install) with the ffmpeg-win Docker MCP tool as a parallel fallback. Use for transcoding, resizing, trimming, speed change, compression, audio extraction, concat, cropping, fades, overlays, thumbnails, GIFs, inspection, and the technical half of the inspect→process→verify loop that fires for ANY video/audio/multimedia task — autonomously probe the input BEFORE processing and verify the output AFTER, not just at 发布前审片 (ffprobe 粗检 + 九宫格视觉 + loudness + 修复 + release checkpoint; hands off to catimation-understand for model content review). Triggers on "用 ffmpeg", "处理/理解视频", "转码/压缩/裁剪/拼接视频", "提取音频", "竖屏适配", "加 BGM", "拿到一个视频/音频文件", "审片/质检/检查成片质量", "能不能发/达标了吗", "ffmpeg-win", or any multimedia handling / CATIMATION 出片 post-processing. References cover filters, codecs, audio, streaming/hwaccel, platform export, and the CATIMATION workflow.
---

# FFmpeg (local CLI preferred · ffmpeg-win Docker MCP fallback)

This skill drives FFmpeg through **two interchangeable backends**. Every recipe
below is written as a **Backend A command** (`ffmpeg …` with native Windows
paths) — decide the backend once (Step 0), then run that command on Backend A,
or map it to the Backend B tool call (it's a mechanical transform, see below).

## Step 0 — Pick the backend (do this first)

Probe the environment once via the shell:

```
ffmpeg -version
```

- **It prints a version → Backend A (LOCAL CLI). Prefer this.** This CATIMATION
  desktop app bundles a full gyan.dev **FFmpeg 8.1** (`ffmpeg.exe` + `ffprobe.exe`)
  and injects it onto the agent's PATH, so Backend A normally just works — **no
  Docker, no install**. You get native Windows paths, a real `ffprobe`, and no
  container overhead. Use it well: this is the default.
- **No shell available, or `ffmpeg` not found → Backend B (DOCKER MCP).** Use the
  **`ffmpeg-win`** MCP tool (runs the `zuozuoliang999/ffmpeg:8.1-cli` image, needs
  Docker Desktop running). It auto-converts Windows paths and needs no local
  binary. This is the **parallel fallback** for environments without a local
  ffmpeg.

Both backends are FFmpeg 8.1 with the same codecs/filters, so every recipe is
identical — only the *call shape* differs.

## The two call shapes

**Backend A — local CLI (preferred).** Run the recipe's `ffmpeg` / `ffprobe`
command directly with normal Windows paths. The shell is available:

```
ffmpeg -y -i "D:/in/input.mov" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "D:/out/output.mp4"
```

**Backend B — ffmpeg-win MCP tool (fallback).** Take the SAME command, **drop the
leading `ffmpeg`**, split the rest into the `args` array (one token per element,
filter strings whole), and wrap it with a drive-root `basedir`:

```json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args": ["-y","-i","D:/in/input.mov","-c:v","libx264","-preset","medium","-crf","23","-c:a","aac","-b:a","128k","D:/out/output.mp4"] } }
```

Every recipe section below gives the **Backend A command** once. For **Backend B**
apply that one transform (drop `ffmpeg`, tokenize into `args`, add `basedir`).

### Universal rules (both backends)

1. **Always pass `-y` first** — there is no TTY, so an overwrite prompt hangs.
2. **One token per arg** (matters for Backend B). A filter string is ONE token:
   `-vf scale=1920:1080` → `["-vf","scale=1920:1080"]`; never split
   `scale=1920:1080`.
3. **Keep filter strings whole.** On Backend A quote paths that contain spaces.

### Backend A (local CLI) specifics

- Use native Windows paths directly (`D:/folder/file.mp4`) — **no `basedir`, no
  `/work` mounting**.
- The shell IS available, but for batches prefer enumerating the files and
  running one `ffmpeg` call per file (portable, and matches Backend B).
- **`ffprobe` IS available** — use it for inspection (see [Inspect](#inspect)).
- Hardware encoders (`h264_nvenc`/`hevc_nvenc`/`*_qsv`/`*_amf`) work when the host
  GPU/driver supports them — the bundled build enables nvenc/qsv/amf/vaapi/d3d11/
  d3d12; fall back to `libx264` if a HW encoder errors.

### Backend B (Docker MCP tool) specifics

- `basedir` **MUST be a drive root** (`D:/`, `E:/`, `C:/`); subdirs auto-correct
  to the root. The whole drive mounts at `/work`; full `D:/...` paths auto-convert.
- **No shell**: no `for` loops, no `|` pipes, no `>` redirects, no `&&`, no
  `*.mp4` globs. Batch = call the tool once per file.
- **5-minute timeout** — prefer `-preset fast`, trim first, or split big jobs.
- **No standalone `ffprobe`** here — inspect with `ffmpeg -i` instead. For images
  use `imagemagick-win`; to check a file exists use `file-exists-win`.
- **concat list files** can't be made with `echo` — write the list with your
  file-write tool first (it lands on the mounted drive), then point `-f concat`
  at it. Hardware encoders are usually unavailable inside the Linux container;
  prefer `libx264`/`libvpx-vp9`.

## Transcode

```
ffmpeg -y -i "D:/in/input.mov" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "D:/out/output.mp4"
```

WebM (VP9 + Opus):

```
ffmpeg -y -i "D:/in/input.mp4" -c:v libvpx-vp9 -crf 30 -b:v 0 -c:a libopus -b:a 128k "D:/out/output.webm"
```

## Resize

Exact size:
```
ffmpeg -y -i "D:/in.mp4" -vf scale=1920:1080 "D:/out.mp4"
```
Keep aspect ratio (letterbox):
```
ffmpeg -y -i "D:/in.mp4" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" "D:/out.mp4"
```
Crop to fill (no bars):
```
ffmpeg -y -i "D:/in.mp4" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" "D:/out.mp4"
```
Scale to width, auto even height: `-vf scale=1280:-2`. Half size: `-vf scale=iw/2:ih/2`.

## Trim and Cut

Re-encode (accurate — recommended):
```
ffmpeg -y -i "D:/in.mp4" -ss 00:00:30 -t 00:00:15 -c:v libx264 -c:a aac "D:/clip.mp4"
```
Start→end:
```
ffmpeg -y -i "D:/in.mp4" -ss 00:00:30 -to 00:00:45 -c:v libx264 -c:a aac "D:/clip.mp4"
```
Fast seek for big files (put `-ss` before `-i`), stream copy:
```
ffmpeg -y -ss 00:10:00 -i "D:/big.mp4" -t 00:05:00 -c copy "D:/clip.mp4"
```
**Note:** `-c copy` is fast but may drop frames at non-keyframe cut points. Re-encode when accuracy matters.

## Speed Adjustment

2x (video + audio):
```
ffmpeg -y -i "D:/in.mp4" -filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" -map "[v]" -map "[a]" "D:/fast.mp4"
```
0.5x slow motion: `setpts=2.0*PTS` + `atempo=0.5`. Video only: `-filter:v setpts=0.5*PTS -an`.

Calculate: to fit X sec into Y sec → speed = X/Y; `setpts` multiplier = 1/speed; `atempo` = speed (chain `atempo` for >2x or <0.5x, e.g. 4x = `atempo=2.0,atempo=2.0`).

## Compress

```
ffmpeg -y -i "D:/in.mp4" -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k "D:/out.mp4"
```
Target bitrate (~10MB/60s ≈ 1300k): `-b:v 1300k`. Smaller web preview: `-crf 28 -preset fast`. Platform targets → [references/platform-export.md](references/platform-export.md).

## Extract / Convert Audio

To MP3:
```
ffmpeg -y -i "D:/in.mp4" -vn -acodec libmp3lame -q:a 2 "D:/out.mp3"
```
To AAC: `-vn -acodec aac -b:a 192k "D:/out.m4a"`. To WAV: `-vn "D:/out.wav"`. Volume: `-filter:a volume=1.5`. More → [references/audio-processing.md](references/audio-processing.md).

## Crop

`crop=w:h:x:y`:
```
ffmpeg -y -i "D:/in.mp4" -vf crop=640:480:100:50 "D:/out.mp4"
```
Center crop to 16:9: `crop=ih*16/9:ih`.

## Concatenate

1. Write a list file with your file-write tool. On **Backend A** use native
   Windows paths; on **Backend B** the same `D:/...` paths auto-map to `/work/...`
   (you may also write `/work/in/clipN.mp4`). Example `D:/in/list.txt`:
   ```
   file 'D:/in/clip1.mp4'
   file 'D:/in/clip2.mp4'
   file 'D:/in/clip3.mp4'
   ```
2. Same codec/resolution (fast):
   ```
   ffmpeg -y -f concat -safe 0 -i "D:/in/list.txt" -c copy "D:/out.mp4"
   ```
   Different sources → re-encode: replace `-c copy` with `-c:v libx264 -c:a aac`.

## Fade

Video fade in (first 1s) + fade out (last 1s — set `st=` to `duration-1`):
```
ffmpeg -y -i "D:/in.mp4" -vf "fade=t=in:st=0:d=1,fade=t=out:st=9:d=1" -c:a copy "D:/out.mp4"
```
Audio fade:
```
ffmpeg -y -i "D:/in.mp4" -af "afade=t=in:st=0:d=1,afade=t=out:st=9:d=1" -c:v copy "D:/out.mp4"
```

## Overlay / Composition

Watermark bottom-right:
```
ffmpeg -y -i "D:/video.mp4" -i "D:/wm.png" -filter_complex "overlay=W-w-10:H-h-10" "D:/out.mp4"
```
Text overlay: `-vf "drawtext=text='Hello':fontsize=24:fontcolor=white:x=10:y=10"`.
Picture-in-picture: `-filter_complex "[1:v]scale=320:-1[pip];[0:v][pip]overlay=W-w-10:H-h-10"`.

## Thumbnails / GIF

Single frame at timestamp:
```
ffmpeg -y -i "D:/video.mp4" -ss 00:00:10 -vframes 1 -q:v 2 "D:/thumb.jpg"
```
GIF (palette, best quality/size):
```
ffmpeg -y -i "D:/in.mp4" -vf "fps=10,scale=480:-1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "D:/out.gif"
```

## Inspect

**Backend A (local) — use the real `ffprobe`** and parse its JSON from stdout:
```
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name,r_frame_rate -of json "D:/video.mp4"
```

**Backend B (Docker MCP) — no `ffprobe`.** Run `ffmpeg -i` with no output file
(`{ "args": ["-i","D:/video.mp4"], "basedir": "D:/" }`); details print to the
result's `error` (FFmpeg writes info to stderr) — read duration / resolution /
codecs from there. To confirm a path before processing, use a normal file check
(Backend A) or **`file-exists-win`** (Backend B) with the full Windows path.

## Batch Processing

Enumerate the files yourself and issue **one ffmpeg call per file** — `ffmpeg ...`
(Backend A) or one `ffmpeg-win` tool call (Backend B). On Backend B verify each
input first with `file-exists-win` if unsure.

## Reading the Result

**Backend A:** check the process exit code (0 = success); FFmpeg logs progress and
file info to **stderr**, so non-empty stderr on success is normal.

**Backend B:** the tool returns JSON — `success` (exit 0), `output` (stdout),
`error` (stderr — progress AND info), and `command` (the docker line run).
`success: true` with text in `error` is normal — FFmpeg logs to stderr.

## Multimedia discipline (inspect → process → verify) — one staged loop across TWO linked skills

**This loop is NOT only for 发布前审片.** It is the default discipline for **ANY
task that understands or processes a video / audio / multimedia file**, and you
**trigger it autonomously — don't wait to be asked**:
- **About to understand / analyze** a clip → Stage 0 probe it FIRST (know its real
  duration / streams / codec / resolution) before you reason about or describe it.
- **About to process** it (转码 / 剪辑 / 拼接 / 压缩 / 提取音频 / 加 BGM / 竖屏适配 /
  变速 …) → probe the **input** first (Stage 0) so you choose correct params, THEN
  **verify the output** afterward (Stage 0–1, plus Stage 2 if it's narrative). Never
  hand back a file you produced without re-probing/eyeballing it.
- **Just generated** a video → grid it and understand it before claiming it's done.
- **发布/交付前审片** → run the whole loop through Stage 4 + human sign-off.

It is **NOT a single pass**, and it is **NOT all done here**. It is a **loop you
climb stage by stage**, spanning two skills that hand off to each other:

- **`ffmpeg-win` (this skill)** — the *technical* eye + the *fixer*: probe streams,
  build a visual contact sheet, measure loudness, and apply every repair
  (transcode / crop / loudnorm / concat / scale).
- **`catimation-understand`** — the *model content* eye: calls `understand_video`
  to judge 剧情 / 字幕 / 动作 / 连续性 / 穿帮 against the brief. ffmpeg cannot judge
  story or continuity — only pixels and streams — so that half lives there.

Run only the stages a task needs, and **escalate one stage at a time** — a plain
transcode/understand needs just a Stage 0 probe-first + a Stage 0–1 verify-after; a
quick "能不能发" needs Stage 0–1; a narrative or publish-bound deliverable runs the
whole loop. The point is: **probe before you act, verify after you act — every time
multimedia is involved**, not only at publish.

```
Stage0 ffprobe 粗检 ──▶ Stage1 九宫格视觉 ──▶ Stage2 understand_video 模型内容审查
        │ (catimation-understand)                                  │
        └────────────  Stage3 不达标 → ffmpeg 修复 → 回到 Stage0 复检  ◀┘
                                    │ pass
                                    ▼
                       Stage4 release checkpoint + 人工签收
```

**Stage 0 — 粗检 (ffprobe, the cheap gate).** Probe the file and judge it against
the brief:
```
ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate -of json "D:/out/final.mp4"
```
Flag (and fix in Stage 3) before going further:
- **No audio stream** when the brief wanted sound (no `"codec_type":"audio"`).
- **Odd width/height** (not divisible by 2) → re-encode with
  `scale=trunc(iw/2)*2:trunc(ih/2)*2`.
- **Wrong aspect / resolution** for the target platform (e.g. not 9:16 for a Reel).
- **A/V duration mismatch** (video vs audio stream durations differ a lot).
- **Suspiciously low bitrate** for the resolution (blocky output).
On Backend B (no ffprobe) use `ffmpeg -i` and read the stderr report instead.

**Stage 1 — 视觉细检 (3×3 contact sheet).** You cannot "watch" an MP4 — build a
九宫格 of evenly-spaced frames and inspect that ONE montage (e.g. with the app's
`view_image`) to catch melting/teleporting subjects, extra limbs, artifacts, and
prompt drift:
```
ffmpeg -y -i "D:/out/final.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 "D:/out/final_grid.png"
```
Set `<DURATION>` to the real clip length (for a 5s clip, `fps=9/5`).

**Stage 2 — 模型内容审查 (hand off to the OTHER skill).** The contact sheet shows
*pixels*; it cannot tell you whether the *content* is right. Hand off to the
**`catimation-understand`** skill: in-app, call `understand_video` on the clip with
a review question — e.g. *"这段视频:剧情/字幕/动作是否符合需求?有无穿帮、错字、
连续性断裂?"*. (Outside the app, where `understand_video` is unavailable, use your
own video-understanding / vision tool for this stage.) This is the **content half
of the same loop** — do not skip it for anything narrative.

**Stage 3 — 修复并复检 (the loop back).** If any stage flags a problem, **fix it
here** with the recipes above (transcode / crop / `loudnorm` / concat / scale),
then **re-enter the loop at Stage 0** — re-probe, re-grid, re-understand. Iterate
at most **2–3 times**; each fix+recheck costs time. Loudness fix (when there's
audio): measure EBU R128
```
ffmpeg -i "D:/out/final.mp4" -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=summary -f null -
```
target ≈ **-14 LUFS** for web/social; if off, bake in normalization by re-encoding
with the same `loudnorm` as an audio filter.

**Stage 4 — 发布前 release checkpoint (only when the loop passes).** For a
publish-bound deliverable, emit a poster frame and leave it beside the contact
sheet for a human:
```
ffmpeg -y -ss <BEST_T> -i "D:/out/final.mp4" -frames:v 1 -q:v 2 "D:/out/final_poster.jpg"
```
Then tell the user it passed QC and point them at `final_grid.png` /
`final_poster.jpg`. **Do not auto-publish** — the loop plus human sign-off comes
first.

### Preflight guardrails (sanity-check BEFORE the encode)

Validate risky parameters before you render, so you don't produce garbage:
- **Overlay / watermark / chroma**: opacity in `[0,1]`; the overlaid layer fits
  inside the frame.
- **concat**: all inputs share codec, resolution, fps, and pixel format —
  re-encode mismatched inputs to a common spec first (a plain `-f concat` of
  incompatible clips corrupts output).
- **Audio mix**: summed volumes don't clip; use `amix`/`volume` deliberately.
- **Speed change**: alter BOTH `setpts` (video) and `atempo` (audio) together, or
  audio desyncs.
- **Animated text / grid / split-screen**: text fits on-screen and within the clip
  duration; tile/layout counts match the number of inputs.

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| Hangs until timeout | Missing `-y`, overwrite prompt | Always pass `-y` first |
| "height not divisible by 2" | Odd dimensions | `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"` |
| "No such file or directory" | basedir not drive root, or wrong path | basedir = `D:/`; use full `D:/...` path; check with `file-exists-win` |
| Won't play in browser | Missing web flags | `-movflags faststart -pix_fmt yuv420p -c:v libx264` |
| Audio desync after speed | Only one filter changed | Use `filter_complex` with both `setpts` + `atempo` |
| Timeout at 5 min | Slow/large encode | `-preset fast`, trim first, or split job |
| Filter split into pieces | Tokens wrongly separated | Keep each filter string as ONE array element |

## Quality Guidelines

| Use case | CRF | Preset |
|----------|-----|--------|
| Master/archive | 18 | slow |
| Production | 20–22 | medium |
| Web/preview | 23–25 | fast |
| Draft | 28+ | veryfast |

Preset (faster = bigger files, quicker): `ultrafast > superfast > veryfast > faster > fast > medium > slow > slower > veryslow`.

## References

- [references/catimation-workflow.md](references/catimation-workflow.md) — **CATIMATION 出片速查**:竖屏 9:16 适配、拼接 Seedance 片段、加 BGM(人声闪避)、封面/压缩/GIF
- [references/reference.md](references/reference.md) — filters, codecs, CRF, containers, options
- [references/audio-processing.md](references/audio-processing.md) — normalization, noise reduction, mixing
- [references/streaming-and-hwaccel.md](references/streaming-and-hwaccel.md) — HLS/DASH + NVENC/VideoToolbox/QSV
- [references/platform-export.md](references/platform-export.md) — YouTube/X/LinkedIn/IG/TikTok/web export

> All recipes and reference snippets are plain `ffmpeg ...` CLI in **Backend A**
> form. **Backend A (local):** run them as-is with native Windows paths.
> **Backend B (Docker MCP):** drop the leading `ffmpeg`, split the rest into the
> `args` array (one token per element, filter strings whole), keep `-y`, set
> `basedir` to the drive root, and use full Windows paths. Hardware encoders
> (NVENC/QSV/AMF) work on **Backend A** when the host GPU/driver supports them;
> inside the **Backend B** Linux container they're usually unavailable — there
> prefer `libx264`/`libvpx-vp9`.

---
*Knowledge base adapted from [jakenuts/ffmpeg-toolkit](https://github.com/jakenuts/agent-skills). Rewritten to drive the bundled local FFmpeg 8.1 CLI (preferred) and the ffmpeg-win MCP tool (Dockerized FFmpeg, Windows-path aware).*
