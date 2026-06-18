# CATIMATION 出片速查 (ffmpeg-win)

针对 CATIMATION AI 出片流程的常用配方。全部走 **ffmpeg-win** 工具:`args` 一词一元素、滤镜串保持完整、首位 `-y`、`basedir` 用盘符根、路径用完整 Windows 路径。Seedance 默认产物 **720p**(横屏 `1280x720` / 竖屏 `720x1280`),单段 **4–15s**。

## 1. 竖屏 9:16 适配 (1080x1920)

**Letterbox(保全画面,上下留黑边)** — 安全,不裁内容:
```json
{ "name": "ffmpeg-win", "arguments": { "basedir": "D:/", "args":
  ["-y", "-i", "D:/clips/in.mp4",
   "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
   "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-pix_fmt", "yuv420p",
   "-c:a", "aac", "-b:a", "192k", "-movflags", "faststart",
   "D:/clips/out_vertical.mp4"] } }
```

**Crop fill(铺满竖屏,裁掉左右)** — 横屏转竖屏满屏:
```json
{ "args": ["-y", "-i", "D:/clips/in.mp4",
  "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
  "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "faststart",
  "D:/clips/out_vertical_fill.mp4"], "basedir": "D:/" }
```

**模糊背景填充(横屏放竖屏中央 + 同画面虚化铺底)** — 短视频常见观感:
```json
{ "args": ["-y", "-i", "D:/clips/in.mp4",
  "-filter_complex", "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2",
  "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "faststart",
  "D:/clips/out_vertical_blur.mp4"], "basedir": "D:/" }
```

> 720p→1080 宽是放大,清晰度受源限制;要更锐可在 scale 后加 `,unsharp=5:5:0.8`。
> 横屏 16:9 (1920x1080) 同理:把上面 `1080:1920` 换成 `1920:1080`。

## 2. 拼接 Seedance 片段

同模型产出的多段通常编码/分辨率一致,可**无损快拼**。

**步骤 A** — 用文件写入工具创建清单 `D:/clips/list.txt`(注意单引号、正斜杠):
```
file 'D:/clips/seg1.mp4'
file 'D:/clips/seg2.mp4'
file 'D:/clips/seg3.mp4'
```

**步骤 B(同规格,最快,无重编码)**:
```json
{ "args": ["-y", "-f", "concat", "-safe", "0", "-i", "D:/clips/list.txt", "-c", "copy", "D:/clips/joined.mp4"], "basedir": "D:/" }
```

**分辨率/编码不一致时**(混了不同尺寸的片段)→ 先统一再拼,改成重编码并归一到 720p:
```json
{ "args": ["-y", "-f", "concat", "-safe", "0", "-i", "D:/clips/list.txt",
  "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
  "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "D:/clips/joined.mp4"], "basedir": "D:/" }
```

> 拼竖屏成片:先按 §1 把每段转 9:16 再拼,保证规格一致 `-c copy` 即可。

## 3. 加 BGM(背景音乐)

**给无声视频配 BGM**(音乐长则随视频结束):
```json
{ "args": ["-y", "-i", "D:/clips/joined.mp4", "-i", "D:/audio/bgm.mp3",
  "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-map", "0:v:0", "-map", "1:a:0", "-shortest",
  "D:/clips/with_bgm.mp4"], "basedir": "D:/" }
```

**视频已有配音 + 叠加 BGM(自动压低音乐,突出人声)** — sidechain 闪避:
```json
{ "args": ["-y", "-i", "D:/clips/joined.mp4", "-i", "D:/audio/bgm.mp3",
  "-filter_complex", "[1:a]volume=0.25[bg];[0:a][bg]sidechaincompress=threshold=0.05:ratio=8:release=300[duck];[0:a][duck]amix=inputs=2:duration=first:dropout_transition=0[a]",
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "D:/clips/with_bgm.mp4"], "basedir": "D:/" }
```

**简单版**(只把音乐固定压低后混入,不做闪避):
```json
{ "args": ["-y", "-i", "D:/clips/joined.mp4", "-i", "D:/audio/bgm.mp3",
  "-filter_complex", "[1:a]volume=0.3[bg];[0:a][bg]amix=inputs=2:duration=first[a]",
  "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "D:/clips/with_bgm.mp4"], "basedir": "D:/" }
```

**BGM 淡入淡出**(开头 1s 进、结尾 2s 出,按成片时长改 `st=`):
```json
{ "args": ["-y", "-i", "D:/audio/bgm.mp3", "-af", "afade=t=in:st=0:d=1,afade=t=out:st=13:d=2", "D:/audio/bgm_faded.mp3"], "basedir": "D:/" }
```

## 4. 收尾常用

**封面/首帧**(取第 1s 高清帧):
```json
{ "args": ["-y", "-i", "D:/clips/with_bgm.mp4", "-ss", "00:00:01", "-vframes", "1", "-q:v", "2", "D:/clips/cover.jpg"], "basedir": "D:/" }
```

**分享压缩**(更小体积、Web 可秒播):
```json
{ "args": ["-y", "-i", "D:/clips/with_bgm.mp4", "-c:v", "libx264", "-crf", "26", "-preset", "fast", "-c:a", "aac", "-b:a", "128k", "-movflags", "faststart", "D:/clips/share.mp4"], "basedir": "D:/" }
```

**预览 GIF**(前 3s,调色板优化):
```json
{ "args": ["-y", "-i", "D:/clips/with_bgm.mp4", "-t", "3", "-vf", "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", "D:/clips/preview.gif"], "basedir": "D:/" }
```

## 典型链路

```
Seedance 片段 ×N (720p, 4–15s)
   → §1 每段转 9:16 (可选,竖屏成片时)
   → §2 拼接成整片
   → §3 加 BGM (+人声闪避)
   → §4 出封面 / 压缩分享 / GIF 预览
```

> 单次调用超时 5 分钟:整片较长或重编码慢时,优先 `-preset fast`,或分段处理后再 `-c copy` 拼接。
