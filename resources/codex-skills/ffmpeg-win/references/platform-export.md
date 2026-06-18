# Platform Export Optimization

> Plain `ffmpeg ...` CLI below. Run via the **ffmpeg-win** tool: drop `ffmpeg`,
> split into the `args` array (filter strings stay whole), prepend `-y`, set
> `basedir` to the drive root, use full Windows paths. The batch shell script at
> the bottom is reference only — issue one ffmpeg-win call per output instead.

Optimize video output for specific distribution platforms.

## Platform Requirements

| Platform | Max Resolution | Max Size | Max Duration | Audio |
|----------|---------------|----------|--------------|-------|
| YouTube | 8K | 256GB | 12 hours | AAC 48kHz |
| Twitter/X | 1920x1200 | 512MB | 140s | AAC 44.1kHz |
| LinkedIn | 4096x2304 | 5GB | 10 min | AAC 48kHz |
| Instagram Feed | 1080x1350 | 4GB | 60s | AAC 48kHz |
| Instagram Reels | 1080x1920 | 4GB | 90s | AAC 48kHz |
| TikTok | 1080x1920 | 287MB | 10 min | AAC |

## YouTube

```bash
# YouTube optimized (1080p, high quality - YouTube re-encodes everything)
ffmpeg -y -i input.mp4 \
  -c:v libx264 -preset slow -crf 18 \
  -profile:v high -level 4.0 \
  -bf 2 -g 30 \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart \
  video-youtube.mp4

# YouTube Shorts (vertical 1080x1920)
ffmpeg -y -i input.mp4 \
  -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" \
  -c:v libx264 -crf 18 -c:a aac -b:a 192k \
  video-shorts.mp4
```

## Twitter/X

Twitter has strict limits: max 140s, 512MB, 1920x1200.

```bash
# Twitter optimized (under 15MB target for fast upload)
ffmpeg -y -i input.mp4 \
  -c:v libx264 -preset medium -crf 24 \
  -profile:v main -level 3.1 \
  -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease" \
  -c:a aac -b:a 128k -ar 44100 \
  -movflags +faststart \
  -fs 15M \
  video-twitter.mp4
```

## LinkedIn

```bash
ffmpeg -y -i input.mp4 \
  -c:v libx264 -preset medium -crf 22 \
  -profile:v main \
  -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" \
  -c:a aac -b:a 192k -ar 48000 \
  -movflags +faststart \
  video-linkedin.mp4
```

## Website / Embed

```bash
# Web-optimized MP4 (small file, progressive loading)
ffmpeg -y -i input.mp4 \
  -c:v libx264 -preset medium -crf 26 \
  -profile:v baseline -level 3.0 \
  -vf "scale=1280:720" \
  -c:a aac -b:a 128k \
  -movflags +faststart \
  video-web.mp4

# WebM alternative (better compression)
ffmpeg -y -i input.mp4 \
  -c:v libvpx-vp9 -crf 30 -b:v 0 \
  -vf "scale=1280:720" \
  -c:a libopus -b:a 128k \
  -deadline good \
  video-web.webm
```

## GIF Previews

```bash
# High-quality GIF (first 5 seconds, palette-optimized)
ffmpeg -y -i input.mp4 -t 5 \
  -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  preview.gif
```

## Batch Export (reference only — issue one ffmpeg-win call per output)

```bash
#!/bin/bash
INPUT="${1:-input.mp4}"
ffmpeg -y -i "$INPUT" -c:v libx264 -preset slow -crf 18 -c:a aac -b:a 192k -movflags +faststart "${INPUT%.mp4}-youtube.mp4"
ffmpeg -y -i "$INPUT" -c:v libx264 -crf 24 -vf "scale='min(1280,iw)':'-2'" -c:a aac -b:a 128k -movflags +faststart "${INPUT%.mp4}-twitter.mp4"
ffmpeg -y -i "$INPUT" -c:v libx264 -crf 22 -c:a aac -b:a 192k -movflags +faststart "${INPUT%.mp4}-linkedin.mp4"
ffmpeg -y -i "$INPUT" -c:v libx264 -crf 26 -vf "scale=1280:720" -c:a aac -b:a 128k -movflags +faststart "${INPUT%.mp4}-web.mp4"
```
