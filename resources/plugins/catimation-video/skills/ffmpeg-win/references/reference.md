# FFmpeg Reference

> These snippets are plain `ffmpeg ...` CLI. To run them via the **ffmpeg-win**
> tool: drop `ffmpeg`, split the rest into the `args` array (one token per
> element, keep each filter string whole), prepend `-y`, set `basedir` to the
> drive root (`D:/`), and use full Windows paths. See SKILL.md → "The Call Contract".

## Filter Syntax

```bash
# Simple filter chain (-vf / -af)
-vf "scale=1920:1080,fps=30,crop=1280:720"

# Complex filter with labels (-filter_complex)
-filter_complex "[0:v]scale=1920:1080[scaled];[scaled]fps=30[out]" -map "[out]"
```

## Video Filters

| Filter | Syntax | Example |
|--------|--------|---------|
| scale | `scale=w:h` | `scale=1920:1080` or `scale=1280:-1` (auto height) |
| crop | `crop=w:h:x:y` | `crop=1280:720:320:180` |
| fps | `fps=N` | `fps=30` |
| pad | `pad=w:h:x:y:color` | `pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black` |
| fade | `fade=t=in/out:st=N:d=N` | `fade=t=in:st=0:d=1` |
| setpts | `setpts=N*PTS` | `setpts=0.5*PTS` (2x speed) |
| drawtext | `drawtext=text='Hi':fontsize=24` | Add text overlay |
| overlay | `overlay=x:y` | Combine videos/images |
| eq | `eq=brightness=B:contrast=C:saturation=S` | `eq=brightness=0.1:contrast=1.2:saturation=1.3` |
| colorchannelmixer | `colorchannelmixer=.3:.4:.3:0:...` | Convert to grayscale |
| boxblur | `boxblur=luma_r:luma_p` | `boxblur=5:1` (blur) |

## Audio Filters

| Filter | Syntax | Example |
|--------|--------|---------|
| volume | `volume=N` | `volume=1.5` or `volume=0.5` |
| afade | `afade=t=in/out:st=N:d=N` | `afade=t=in:st=0:d=1` |
| atempo | `atempo=N` | `atempo=2.0` (range 0.5-2.0, chain for extremes) |
| loudnorm | `loudnorm=I=N:TP=N:LRA=N` | `loudnorm=I=-16:TP=-1.5:LRA=11` |
| silencedetect | `silencedetect=noise=N:d=N` | `silencedetect=noise=-30dB:d=0.5` |
| afftdn | `afftdn=nf=N` | `afftdn=nf=-25` (noise reduction) |
| aecho | `aecho=in:out:delay:decay` | `aecho=0.8:0.88:60:0.4` |
| highpass | `highpass=f=N` | `highpass=f=200` |
| lowpass | `lowpass=f=N` | `lowpass=f=3000` |

## Video Codecs (-c:v)

| Codec | Use Case | Notes |
|-------|----------|-------|
| libx264 | Universal H.264 | Best compatibility (preferred in this container) |
| libx265 | H.265/HEVC | Better compression, less compatible |
| libvpx-vp9 | WebM | Good for web |
| prores | ProRes | Professional editing |
| copy | Stream copy | No re-encoding, fastest |

> Hardware encoders (`h264_nvenc`, `h264_videotoolbox`, `h264_qsv`) depend on the
> host GPU and are normally **unavailable** inside this Linux Docker image. Use
> the software encoders above.

## Audio Codecs (-c:a)

| Codec | Use Case | Notes |
|-------|----------|-------|
| aac | MP4 container | Most compatible |
| libmp3lame | MP3 | Universal |
| libvorbis | WebM/OGG | Open source |
| libopus | WebM/OGG | Modern, better quality than Vorbis |
| pcm_s16le | WAV | Uncompressed |
| copy | Stream copy | No re-encoding |

## CRF Reference (x264/x265)

| CRF | Quality | Use Case |
|-----|---------|----------|
| 0 | Lossless | Archive |
| 17-18 | Visually lossless | Master |
| 19-22 | High quality | Production |
| 23 | Default | General use |
| 24-27 | Medium | Web delivery |
| 28+ | Low | Preview/draft |

## Preset Spectrum

Faster presets = larger files, quicker encoding:

`ultrafast` > `superfast` > `veryfast` > `faster` > `fast` > `medium` > `slow` > `slower` > `veryslow`

## Container Formats

| Format | Extension | Best For |
|--------|-----------|----------|
| MP4 | .mp4 | Universal, web, mobile |
| MOV | .mov | Apple ecosystem, ProRes |
| WebM | .webm | Web (VP9/Opus) |
| MKV | .mkv | Archive, multiple streams |
| GIF | .gif | Short animations (no audio) |

## Input Options (before -i)

| Option | Purpose | Example |
|--------|---------|---------|
| -ss | Seek to time | `-ss 00:01:30` |
| -t | Duration limit | `-t 00:00:30` |
| -r | Input framerate | `-r 30` |
| -f | Force format | `-f gif` |

## Output Options (after -i)

| Option | Purpose | Example |
|--------|---------|---------|
| -y | Overwrite output (ALWAYS use here) | `-y` |
| -movflags faststart | Web streaming | `-movflags faststart` |
| -pix_fmt | Pixel format | `-pix_fmt yuv420p` |
| -an | No audio | `-an` |
| -vn | No video | `-vn` |
