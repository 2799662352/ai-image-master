---
name: ffmpeg-win
description: Process video/audio with FFmpeg 8.1, preferring the bundled local ffmpeg/ffprobe CLI (on PATH, zero Docker, zero install) with the ffmpeg-win Docker MCP tool as a parallel fallback. Use for transcoding, resizing, trimming, speed change, compression, audio extraction, concat, cropping, fades, overlays, thumbnails, GIFs, inspection, and 审片/quality-check (ffprobe report + loudness + 3×3 contact sheet + release checkpoint before publishing). Triggers on "用 ffmpeg", "处理视频", "转码/压缩/裁剪/拼接视频", "提取音频", "竖屏适配", "加 BGM", "审片/质检/检查成片", "ffmpeg-win", or any CATIMATION 出片 post-processing. References cover filters, codecs, audio, streaming/hwaccel, platform export, and the CATIMATION workflow.
---

# FFmpeg (local CLI preferred · ffmpeg-win Docker MCP fallback)

This skill drives FFmpeg through **two interchangeable backends**. Every recipe
below is written as an `args` token list that works with **either** backend —
decide the backend once (Step 0), then feed the same `args` to it.

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

**Backend A — local CLI (preferred).** Run `ffmpeg` / `ffprobe` directly with the
recipe's `args` and normal Windows paths. The shell is available:

```
ffmpeg -y -i "D:/in/input.mov" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "D:/out/output.mp4"
```

**Backend B — ffmpeg-win MCP tool (fallback).** Pass the SAME `args` array to the
tool with a drive-root `basedir`:

```json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args": ["-y","-i","D:/in/input.mov","-c:v","libx264","-preset","medium","-crf","23","-c:a","aac","-b:a","128k","D:/out/output.mp4"] } }
```

Every recipe section below gives the `args` list once. For **Backend A** prepend
`ffmpeg`; for **Backend B** wrap it as the tool call above.

### Universal rules (both backends)

1. **Always pass `-y` first** — there is no TTY, so an overwrite prompt hangs.
2. **One token per arg.** A filter string is ONE token: `-vf scale=1920:1080` →
   `["-vf","scale=1920:1080"]`; never split `scale=1920:1080`.
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

```json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args":
  ["-y", "-i", "D:/in/input.mov", "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "D:/out/output.mp4"] } }
```

WebM (VP9 + Opus):

```json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args":
  ["-y", "-i", "D:/in/input.mp4", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k", "D:/out/output.webm"] } }
```

## Resize

Exact size:
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "scale=1920:1080", "D:/out.mp4"], "basedir": "D:/" }
```
Keep aspect ratio (letterbox):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2", "D:/out.mp4"], "basedir": "D:/" }
```
Crop to fill (no bars):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080", "D:/out.mp4"], "basedir": "D:/" }
```
Scale to width, auto even height: `"scale=1280:-2"`. Half size: `"scale=iw/2:ih/2"`.

## Trim and Cut

Re-encode (accurate — recommended):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-ss", "00:00:30", "-t", "00:00:15", "-c:v", "libx264", "-c:a", "aac", "D:/clip.mp4"], "basedir": "D:/" }
```
Start→end:
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-ss", "00:00:30", "-to", "00:00:45", "-c:v", "libx264", "-c:a", "aac", "D:/clip.mp4"], "basedir": "D:/" }
```
Fast seek for big files (put `-ss` before `-i`), stream copy:
```json
{ "args": ["-y", "-ss", "00:10:00", "-i", "D:/big.mp4", "-t", "00:05:00", "-c", "copy", "D:/clip.mp4"], "basedir": "D:/" }
```
**Note:** `-c copy` is fast but may drop frames at non-keyframe cut points. Re-encode when accuracy matters.

## Speed Adjustment

2x (video + audio):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-filter_complex", "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]", "-map", "[v]", "-map", "[a]", "D:/fast.mp4"], "basedir": "D:/" }
```
0.5x slow motion: `setpts=2.0*PTS` + `atempo=0.5`. Video only: `["-filter:v", "setpts=0.5*PTS", "-an"]`.

Calculate: to fit X sec into Y sec → speed = X/Y; `setpts` multiplier = 1/speed; `atempo` = speed (chain `atempo` for >2x or <0.5x, e.g. 4x = `atempo=2.0,atempo=2.0`).

## Compress

```json
{ "args": ["-y", "-i", "D:/in.mp4", "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "D:/out.mp4"], "basedir": "D:/" }
```
Target bitrate (~10MB/60s ≈ 1300k): `["-b:v", "1300k"]`. Smaller web preview: `["-crf", "28", "-preset", "fast"]`. Platform targets → [references/platform-export.md](references/platform-export.md).

## Extract / Convert Audio

To MP3:
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vn", "-acodec", "libmp3lame", "-q:a", "2", "D:/out.mp3"], "basedir": "D:/" }
```
To AAC: `["-vn", "-acodec", "aac", "-b:a", "192k", "D:/out.m4a"]`. To WAV: `["-vn", "D:/out.wav"]`. Volume: `["-filter:a", "volume=1.5"]`. More → [references/audio-processing.md](references/audio-processing.md).

## Crop

`crop=w:h:x:y`:
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "crop=640:480:100:50", "D:/out.mp4"], "basedir": "D:/" }
```
Center crop to 16:9: `"crop=ih*16/9:ih"`.

## Concatenate

1. Write a list file with your file-write tool (paths are relative to the file
   or absolute container paths). Example `D:/in/list.txt`:
   ```
   file 'D:/in/clip1.mp4'
   file 'D:/in/clip2.mp4'
   file 'D:/in/clip3.mp4'
   ```
   (`D:/...` becomes `/work/...` automatically — or write `/work/in/clipN.mp4`.)
2. Same codec/resolution (fast):
   ```json
   { "args": ["-y", "-f", "concat", "-safe", "0", "-i", "D:/in/list.txt", "-c", "copy", "D:/out.mp4"], "basedir": "D:/" }
   ```
   Different sources → re-encode: replace `["-c", "copy"]` with `["-c:v", "libx264", "-c:a", "aac"]`.

## Fade

Video fade in (first 1s) + fade out (last 1s — set `st=` to `duration-1`):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "fade=t=in:st=0:d=1,fade=t=out:st=9:d=1", "-c:a", "copy", "D:/out.mp4"], "basedir": "D:/" }
```
Audio fade:
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-af", "afade=t=in:st=0:d=1,afade=t=out:st=9:d=1", "-c:v", "copy", "D:/out.mp4"], "basedir": "D:/" }
```

## Overlay / Composition

Watermark bottom-right:
```json
{ "args": ["-y", "-i", "D:/video.mp4", "-i", "D:/wm.png", "-filter_complex", "overlay=W-w-10:H-h-10", "D:/out.mp4"], "basedir": "D:/" }
```
Text overlay: `["-vf", "drawtext=text='Hello':fontsize=24:fontcolor=white:x=10:y=10"]`.
Picture-in-picture: `["-filter_complex", "[1:v]scale=320:-1[pip];[0:v][pip]overlay=W-w-10:H-h-10"]`.

## Thumbnails / GIF

Single frame at timestamp:
```json
{ "args": ["-y", "-i", "D:/video.mp4", "-ss", "00:00:10", "-vframes", "1", "-q:v", "2", "D:/thumb.jpg"], "basedir": "D:/" }
```
GIF (palette, best quality/size):
```json
{ "args": ["-y", "-i", "D:/in.mp4", "-vf", "fps=10,scale=480:-1,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "D:/out.gif"], "basedir": "D:/" }
```

## Inspect

**Backend A (local) — use the real `ffprobe`** and parse its JSON from stdout:
```
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name,r_frame_rate -of json "D:/video.mp4"
```

**Backend B (Docker MCP) — no `ffprobe`.** Run `ffmpeg -i` with no output file;
details print to the result's `error` (FFmpeg writes info to stderr) — expected:
```json
{ "args": ["-i", "D:/video.mp4"], "basedir": "D:/" }
```
Read duration / resolution / codecs from the returned `error` text. To confirm a
path before processing, use a normal file check (Backend A) or **`file-exists-win`**
(Backend B) with the full Windows path.

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

## Review / 审片 (quality check + release checkpoint)

Before you treat any rendered or edited video as final — **especially anything the
user will publish** — run a lightweight 审片 pass. This mirrors the
inspect → verify → human-review contract from agent video pipelines: never ship
agent-made video on blind faith.

**1) Quality check (ffprobe — Backend A).** Probe the file and judge it against
the brief:
```
ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,channels,sample_rate -of json "D:/out/final.mp4"
```
Flag and fix before shipping:
- **No audio stream** when the brief wanted sound (no `"codec_type":"audio"`).
- **Odd width/height** (not divisible by 2) → re-encode with
  `scale=trunc(iw/2)*2:trunc(ih/2)*2`.
- **Wrong aspect / resolution** for the target platform (e.g. not 9:16 for a Reel).
- **A/V duration mismatch** (video vs audio stream durations differ a lot).
- **Suspiciously low bitrate** for the resolution (blocky output).
On Backend B (no ffprobe) use `ffmpeg -i` and read the stderr report instead.

**2) Visual sanity (3×3 contact sheet).** You cannot "watch" an MP4 — build a
九宫格 of evenly-spaced frames and inspect that ONE montage (e.g. with the app's
`view_image`) to catch melting/teleporting subjects, extra limbs, artifacts, and
prompt drift:
```
ffmpeg -y -i "D:/out/final.mp4" -vf "fps=9/<DURATION>,scale=320:-1,tile=3x3:padding=6:color=black" -frames:v 1 "D:/out/final_grid.png"
```
Set `<DURATION>` to the real clip length (for a 5s clip, `fps=9/5`).

**3) Loudness (when there's audio).** Measure EBU R128 so the mix isn't too hot or
too quiet:
```
ffmpeg -i "D:/out/final.mp4" -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=summary -f null -
```
Target ≈ **-14 LUFS** for web/social. If it's off, bake in normalization by
re-encoding with the same `loudnorm` as an audio filter.

**4) Release checkpoint (artifacts for human review).** For a publish-bound
deliverable, also emit a poster frame and leave it beside the contact sheet so the
user can eyeball before posting:
```
ffmpeg -y -ss <BEST_T> -i "D:/out/final.mp4" -frames:v 1 -q:v 2 "D:/out/final_poster.jpg"
```
Then tell the user it passed QC and point them at `final_grid.png` /
`final_poster.jpg` for a quick human review. **Do not auto-publish** — QC plus
human sign-off comes first.

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

> All reference snippets are plain `ffmpeg ...` CLI. **Backend A (local):** run
> them as-is — prepend `-y`, use native Windows paths. **Backend B (Docker MCP):**
> drop the leading `ffmpeg`, split the rest into the `args` array (one token per
> element, filter strings whole), prepend `-y`, set `basedir` to the drive root,
> and use full Windows paths. Hardware encoders (NVENC/QSV/AMF) work on **Backend
> A** when the host GPU/driver supports them; inside the **Backend B** Linux
> container they're usually unavailable — there prefer `libx264`/`libvpx-vp9`.

---
*Knowledge base adapted from [jakenuts/ffmpeg-toolkit](https://github.com/jakenuts/agent-skills). Rewritten to drive the ffmpeg-win MCP tool (Dockerized FFmpeg, Windows-path aware).*
