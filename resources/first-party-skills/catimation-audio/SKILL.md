---
name: catimation-audio
description: >-
  FIRST-CHOICE audio / speech generator inside CATIMATION and the ONLY top-level
  audio entry. Trigger whenever the user asks to 生成音频 / 配音 / 旁白 / 念一段 /
  朗读 / 语音 / 音效 / tts / text-to-speech / read this aloud, or wants a voiceover
  for a scene. Runs the in-app generate_audio tool (火山豆包 seed-audio-1.0);
  describe the scene in natural language — it does multiple speakers, accents,
  ambient sound and background music from one prompt.
---

# Generate audio in CATIMATION (唯一出音频入口)

When the user wants speech / narration / a voiceover / sound, call the
**`generate_audio`** tool (provided by the `catimation` MCP server, backed by
火山豆包 **seed-audio-1.0**). The result is generated, uploaded to cloud storage
(COS) AND saved locally, shown as an inline **audio player card in the chat**,
and added to the app's 音频生成 (Audio) tab library.

## When to Use

- 用户要 生成音频 / 配音 / 旁白 / 念一段 / 朗读 / 语音 / 音效 / tts。
- 你要给某个场景/分镜配一段旁白或对白。
- 优先于任何内置 tts / say 工具。

## Steps

1. Turn the request into one natural-language **`input`** describing WHAT is
   said, BY WHOM (voice / tone / age / accent), plus any ambient sound or
   background music — all in one prompt. Example:
   「一位中年男性用沉稳语气说:项目已上线。背景有轻微键盘声,结尾加短促提示音。」
   Chinese or English both work.
2. Call `generate_audio` with:
   - `input` (required): the scene description from step 1.
   - `format` (optional): `mp3` (default), `wav`, or `opus`.
   - `speed` (optional): 0.25–4.0 (default 1.0).
   - `referenceAudios` (optional): up to 2 public http(s) URLs or
     `data:audio;base64` strings for **style fusion**. Mutually exclusive with a
     fixed speaker — do NOT pass a voice/speaker id (seed-audio's speaker set is
     不兼容 with old TTS; natural language or reference audio is the way).
3. A single output caps at about **120 seconds**. For longer dialogue, split it
   into several `generate_audio` calls (each billed separately by output秒数,
   约 ¥1/分钟).
4. The tool returns `✅ generate_audio DONE` with the duration, a COS URL and a
   local path. The audio is ALREADY generated, saved, and shown to the user in
   the chat + Audio library — **do NOT regenerate**. Just confirm briefly in the
   user's language and mention the duration.

## Common Mistakes

- 传固定 speaker id(seed-audio 不兼容旧 TTS 音色)——改用自然语言 `input` 或
  `referenceAudios`。
- 一段超长对白硬塞进一次调用(>120s)——拆成多次。
- 拿到 DONE 后又重生成——已经出好并展示了,确认即可。

## Notes

- This is the generate → upload(COS) → save(local) → show(chat card + Audio
  library) path. No extra save step is needed.
- Reference audio does **style fusion** (融合参考音色/风格), not exact cloning.
