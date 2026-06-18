# Audio Processing

> Plain `ffmpeg ...` CLI below. Run via the **ffmpeg-win** tool: drop `ffmpeg`,
> split into the `args` array (filter strings stay whole), prepend `-y`, set
> `basedir` to the drive root, use full Windows paths. See SKILL.md.

Advanced audio operations beyond basic extraction and volume adjustment.

## Volume and Normalization

```bash
# Adjust volume (multiplier)
ffmpeg -y -i input.mp4 -af "volume=1.5" output.mp4

# Normalize audio levels (EBU R128 broadcast standard)
ffmpeg -y -i input.mp4 -af "loudnorm=I=-16:TP=-1.5:LRA=11" output.mp4
```

**loudnorm parameters:**
- `I` - Integrated loudness target (dB LUFS, default -24)
- `TP` - True peak limit (dB, default -2)
- `LRA` - Loudness range target (LU, default 7)

```bash
# Detect silence (useful for finding trim points; info prints to stderr)
ffmpeg -i input.mp4 -af "silencedetect=noise=-30dB:d=0.5" -f null -
```

## Noise and Frequency Filters

```bash
# Remove background noise
ffmpeg -y -i input.mp4 -af "afftdn=nf=-25" output.mp4

# High-pass filter (remove low rumble below 200Hz)
ffmpeg -y -i input.mp4 -af "highpass=f=200" output.mp4

# Low-pass filter (remove high hiss above 3kHz)
ffmpeg -y -i input.mp4 -af "lowpass=f=3000" output.mp4

# Combined cleanup: noise reduction + high-pass + low-pass
ffmpeg -y -i input.mp4 -af "afftdn=nf=-25,highpass=f=200,lowpass=f=3000" output.mp4

# Add echo effect
ffmpeg -y -i input.mp4 -af "aecho=0.8:0.88:60:0.4" output.mp4
```

## Merging Audio

```bash
# Replace audio track in video
ffmpeg -y -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 output.mp4

# Mix/overlay two audio tracks (e.g., voice + background music)
ffmpeg -y -i video.mp4 -i background.mp3 \
       -filter_complex "[0:a][1:a]amerge=inputs=2[a]" \
       -map 0:v -map "[a]" -c:v copy -ac 2 output.mp4

# Add audio to silent video
ffmpeg -y -i silent_video.mp4 -i audio.mp3 -c:v copy -c:a aac -shortest output.mp4
```
