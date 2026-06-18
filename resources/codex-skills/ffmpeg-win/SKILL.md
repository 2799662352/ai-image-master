---
name: ffmpeg-win
description: Process video/audio through the ffmpeg-win MCP tool (Dockerized FFmpeg 8.1 with automatic Windows-path conversion) instead of a local ffmpeg binary. Use for transcoding, resizing, trimming, speed change, compression, audio extraction, concat, cropping, fades, overlays, thumbnails, GIFs, and inspection — every command is one ffmpeg-win call with an args array plus a drive-root basedir. Triggers on "用 ffmpeg", "处理视频", "转码/压缩/裁剪/拼接视频", "提取音频", "竖屏适配", "加 BGM", "ffmpeg-win", or any CATIMATION 出片 post-processing. References cover filters, codecs, audio, streaming/hwaccel, platform export, and the CATIMATION workflow.
---

# FFmpeg (ffmpeg-win MCP tool)

This skill drives FFmpeg through the **`ffmpeg-win`** MCP tool, which runs the
`zuozuoliang999/ffmpeg:8.1-cli` Docker image and auto-converts Windows paths.
You do **not** invoke a local `ffmpeg` binary or a shell.

## The Call Contract

Every command is one `ffmpeg-win` tool call:

```json
{
  "name": "ffmpeg-win",
  "arguments": {
    "basedir": "D:/",
    "args": ["-y", "-i", "D:/videos/input.mov", "-c:v", "libx264", "-crf", "23", "D:/videos/output.mp4"]
  }
}
```

- `basedir` — **MUST be a drive root** (`D:/`, `E:/`, `C:/`). Subdirs are
  auto-corrected to the root with a warning. Pick the root of the drive that
  holds your files.
- `args` — an **array of strings, one token per element**. Use full Windows
  paths (`D:/folder/file.mp4`); they auto-convert to `/work/folder/file.mp4`
  inside the container. The whole drive is mounted at `/work`, so any path on
  that drive is reachable.

### Hard rules (read before every command)

1. **Always pass `-y`** as the first arg. There is no TTY, so an overwrite
   prompt would hang until the 5-min timeout.
2. **One token per array element.** A filter string is a single element:
   `["-vf", "scale=1920:1080", ...]` — never split `scale=1920:1080`.
3. **No shell.** No `for` loops, no `|` pipes, no `>` redirects, no `&&`, no
   `*.mp4` globs. Batch = call the tool once per file.
4. **5-minute timeout.** Long/slow encodes can hit it. Prefer `-preset fast`,
   trim first, or split the work for big jobs.
5. **No standalone `ffprobe`.** To inspect a file, run `ffmpeg -i` (see
   [Inspect](#inspect)). For images use `imagemagick-win`; to check a file
   exists use `file-exists-win`.
6. **concat list files** can't be made with `echo`. Write the list file with
   your normal file-write tool first (it lands on the mounted drive), then point
   `-f concat` at it.

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

No `ffprobe`. Run `ffmpeg -i` with no output file; details print to the result's
`error` (FFmpeg writes info to stderr) — this is expected:
```json
{ "args": ["-i", "D:/video.mp4"], "basedir": "D:/" }
```
Read duration / resolution / codecs from the returned `error` text. To confirm a
path before processing, use **`file-exists-win`** with the full Windows path.

## Batch Processing

No shell loops. Enumerate files yourself and issue **one `ffmpeg-win` call per
file**. Verify each input first with `file-exists-win` if unsure.

## Reading the Result

The tool returns JSON: `success` (exit 0), `output` (stdout), `error` (stderr —
where FFmpeg logs progress AND info), and `command` (the docker line run).
`success: true` with text in `error` is normal — FFmpeg logs to stderr.

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

> All reference snippets are written as plain `ffmpeg ...` CLI. To run them here,
> drop `ffmpeg`, split the rest into the `args` array (one token per element,
> filter strings stay whole), prepend `-y`, set `basedir` to the drive root, and
> use full Windows paths. Hardware encoders (NVENC/QSV/VideoToolbox) are host/
> image dependent and usually unavailable inside this Linux container — prefer
> `libx264`/`libvpx-vp9`.

---
*Knowledge base adapted from [jakenuts/ffmpeg-toolkit](https://github.com/jakenuts/agent-skills). Rewritten to drive the ffmpeg-win MCP tool (Dockerized FFmpeg, Windows-path aware).*
