# Streaming and Hardware Acceleration

> Plain `ffmpeg ...` CLI below. Run via the **ffmpeg-win** tool: drop `ffmpeg`,
> split into the `args` array (filter strings stay whole), prepend `-y`, set
> `basedir` to the drive root, use full Windows paths. HLS/DASH produce many
> segment files on the mounted drive.
>
> ⚠️ Hardware acceleration (NVENC/NVDEC, VideoToolbox, QuickSync) requires GPU
> passthrough to the container and is normally **unavailable** in this image.
> Treat the hwaccel section as reference; use software encoders (`libx264`,
> `libvpx-vp9`) in practice.

## HLS (HTTP Live Streaming)

```bash
# Basic HLS (segments + playlist land next to the output path)
ffmpeg -y -i input.mp4 -c:v libx264 -c:a aac \
       -hls_time 10 -hls_playlist_type vod \
       -hls_segment_filename "segment_%03d.ts" \
       playlist.m3u8
```

## DASH (Dynamic Adaptive Streaming)

```bash
ffmpeg -y -i input.mp4 -c:v libx264 -c:a aac \
       -f dash -seg_duration 10 \
       -use_template 1 -use_timeline 1 \
       manifest.mpd
```

## Hardware Acceleration (reference — usually unavailable in container)

### NVIDIA (NVENC/NVDEC)

```bash
ffmpeg -y -i input.mp4 -c:v h264_nvenc -preset fast output.mp4
ffmpeg -y -hwaccel cuda -i input.mp4 -c:v h264_nvenc output.mp4
```

### macOS VideoToolbox

```bash
ffmpeg -y -i input.mp4 -c:v h264_videotoolbox -b:v 5M output.mp4
```

### Intel QuickSync

```bash
ffmpeg -y -i input.mp4 -c:v h264_qsv output.mp4
```

### Detect Available Hardware

```bash
# List encoders that exist in THIS image (look for _nvenc/_qsv/_videotoolbox)
ffmpeg -encoders

# List hardware acceleration methods
ffmpeg -hwaccels
```

Run `ffmpeg -encoders` / `ffmpeg -hwaccels` via the tool (no output file needed)
and read the result's `output`/`error` to see what the image actually supports
before relying on a hardware encoder.
