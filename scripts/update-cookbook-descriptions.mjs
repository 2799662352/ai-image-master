#!/usr/bin/env node
// Rewrite the `description:` line of every cookbook SKILL.md so that
// Codex agents discover these skills via the real-world trigger words
// users type (提示词 / 视频模型 / 图像模型 / 写剧本 / 脚本 / 分镜) —
// plus current image/video model brand names.
//
// Each description is built from the BODY of its own SKILL.md, not
// invented out of thin air. The specific signal in the first clause
// quotes the body's actual technical vocabulary (HoloCine pattern,
// 180-degree rule, Color Harmony 1.5, score_bpm formula, palette ratio
// ≥ 7:3, Z-axis fg/mg/bg, micro-expression mm, etc.) so future
// Codex queries hit on the same terms the rules themselves use.
//
// Touches ONLY line 3 of every SKILL.md (the `description:` row).
// Writes both skills/<name>/SKILL.md (in-app source — appliesTo /
// priority preserved) and resources/codex-skills/<name>/SKILL.md
// (Codex registry mirror).

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

// Brand / keyword tail — bilingual EN/ZH, image + video models.
const tail = ' — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.'

// Specific signal per skill — each clause is mined from the skill's
// own body so the description teaches what the rules actually enforce.
const specific = {
  'director-anchor-extraction-quality':
    'extracting character anchors from reference images where every anchor must list face / build / outfit / markers, hit the 40-word minimum, differentiate similar builds explicitly ("A is taller by ~10cm"), and mark occluded parts with [inferred]',
  'director-anime-quality-boost':
    'output drifts toward painterly / 厚涂 / oil-painterly texture instead of cel-shaded anime screenshot style, character identity must lock across panels (hair / outfit / accessories), or injecting JSON instruction blocks with Color Harmony 1.5 and No-Painterly 1.8 weights (日式动画截图)',
  'director-character-consistency':
    'the same character must appear identical across panels — anchored by face / build / outfit / markers, with hair / outfit / props unchanged across cuts and relative skin-tone descriptors used instead of absolute color',
  'director-cinematic-composition':
    'framing a shot — placing the subject at a rule-of-thirds intersection, building foreground / midground / background layers, deploying leading lines, varying focal length wide → medium → close-up, and tuning negative space / look-space for tension vs calm',
  'director-lighting-continuity':
    'locking key light direction (left / right / top / back), quality (hard / soft), and color temperature (golden hour 3000-4000K, overcast 5500-6500K, night blue ambient + warm practicals, neon mixed) across every panel in a scene; flag light-direction reversals and color-temperature jumps without time skip',
  'director-narrative-flow':
    'sequencing shots — open with an establishing wide, follow with mediums for interaction, save close-ups for emotional peaks; enforce the 180-degree rule, eye-line matches, action continuity across cuts, and alternate scales to avoid 3-in-a-row of the same shot type',
  'director-prompt-engineering':
    'assembling a prompt in the canonical 7-field order — Subject+Action → Character Ref ([char1] tags) → Scene → Shot+Camera (e.g. 50mm, eye-level) → Lighting (direction, quality, color temperature) → Composition (rule of thirds, DoF) → Style+Mood — within 120 words and paired with negative prompts (blurry, deformed, bad anatomy, extra limbs, watermark)',
  'director-scene-analysis-depth':
    'extracting from a reference image the env field (location + time + atmosphere + weather in one sentence), a subjects array (one entry per visible person/animal/object with spatial relationships), and a style field (art style + color palette + lighting quality + emotional tone), reading time of day from shadow angles and light color',
  'director-shot-sequence-patterns':
    'picking the shot pattern that matches the scene\'s dramatic intent — Establishing (wide → medium → close-up → detail), Dialogue (two-shot → shot-reverse-shot → reaction → re-establish), Action (wide → medium action → close-up impact → wide aftermath), Emotional (medium → close-up → extreme close-up → release) — and labeling every transition ("cut to", "dolly in", "match cut", "time skip")',
  'director-structured-captioning':
    'prompts repeat character appearance across panels and waste tokens — restructure as HoloCine: GLOBAL (scene, time, weather, mood) → CHARACTER DEFINITIONS ([char1]: anchor, [char2]: anchor) → PER-SHOT (references [char1] tag, never re-describes appearance), cutting tokens ~40% and locking one canonical look',
  'director-style-consistency':
    'resolving image-vs-text style conflict (TEXT WINS — reference image supplies only character identity, never rendering medium or color grading), enforcing uniform texture / cel-shading / film-grain density across panels, and reinforcing negative prompts (photoreal target → ban anime/cartoon; anime target → ban photoreal)',
  'director-visual-continuity':
    'verifying that a scene\'s 2-3 dominant colors stay consistent, color temperature does not mix warm and cool, object-to-character scale holds (table at waist height stays at waist height, ≤20% drift), and architecture / environment landmarks keep their spatial relationships across panels',
  'storyboard-audio':
    'each shot needs a three-layer audio field — A1 Score (ref:Composer/Work + 乐器 + 力度 pp-ff + 速度 bpm + 张力值 0-10, derived via score_bpm = motion_freq × 60), A2 SFX (材质 + 动作 + 频率Hz + 衰减s + 空间定位), A3 Voice (基频Hz + 气声比% + 语速字/秒 + 混响 RT60) — banning emotion adjectives in favor of physical parameters (配乐 / 音效 / 配音)',
  'storyboard-dialogue':
    'screenplay or script provides character names and dialogue that MUST be extracted verbatim — never fabricate lines, never guess names from visual style (台词 verbatim)',
  'storyboard-dodge':
    'output text risks tripping content filters with explicit anatomical terms, action verbs (thrust/penetrate), graphic injury, or nudity — rewrite via contour/silhouette, force vectors (impact 200N, compression 3cm), pressure / velocity / amplitude, fabric silhouette, shallow DoF blur, or steam diffusion (规避审查)',
  'storyboard-physics':
    'character body / motion must be described in physical-only language — skin texture, muscle tension, bone structure; motion vectors as angle° / displacement cm / velocity m·s⁻¹; micro-expressions in mm (brow furrowed Xmm, pupil dilation Xmm), never emotion adjectives',
  'storyboard-structure':
    'shaping each shot as a mid-action snapshot frozen at peak tension (never "then / after"), holding to ONE core action within 2-4 seconds, and quantifying micro-expressions in millimeters (brow furrowed Xmm, pupil dilation Xmm) instead of emotion labels',
  'storyboard-style':
    'a scene needs a hard palette decomposition — dominant [hex] + accent [hex] in ratio ≥ 7:3, light source typed as rim / fill / key with angle and intensity %, and shadow depth expressed as percentage of frame in shadow (配色 / 光源 / 阴影)',
  'storyboard-visual':
    'a shot needs physical lighting (shadow 10-40% day / 60-90% night, rim / candle / natural / fill), color hierarchy ([key hex] dominant + faint [accent hex], never equal warm + cool), explicit lens spec [mm] f/[stop] instead of "8k masterpiece", and a mandatory Z-axis (fg occluder / mg subject / bg environment)',
}

const roots = [
  join(repoRoot, 'skills'),
  join(repoRoot, 'resources', 'codex-skills'),
]

const report = []
const FM_LIMIT = 1024

for (const name of Object.keys(specific).sort()) {
  const newDescLine = `description: Use when ${specific[name]}${tail}`

  for (const root of roots) {
    const path = join(root, name, 'SKILL.md')
    const rootLabel = root.endsWith('codex-skills') ? 'codex-skills' : 'skills'

    if (!existsSync(path)) {
      report.push({ skill: name, root: rootLabel, status: 'MISSING' })
      continue
    }

    const text = readFileSync(path, 'utf8')
    const lines = text.split(/\r?\n/)

    if (lines.length < 4 || lines[0] !== '---' || !lines[1].startsWith('name:') || !lines[2].startsWith('description:')) {
      report.push({ skill: name, root: rootLabel, status: 'FRONTMATTER_UNEXPECTED' })
      continue
    }

    lines[2] = newDescLine

    // Find closing `---` and compute frontmatter byte length.
    let fmEnd = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') { fmEnd = i; break }
    }
    const fmBytes = Buffer.byteLength(lines.slice(0, fmEnd + 1).join('\n'), 'utf8')
    const overflow = fmBytes > FM_LIMIT

    writeFileSync(path, lines.join('\n'), 'utf8')

    report.push({
      skill: name,
      root: rootLabel,
      status: overflow ? 'OVERFLOW' : 'OK',
      descLen: newDescLine.length,
      fmBytes,
    })
  }
}

console.table(report)

const okCount = report.filter(r => r.status === 'OK').length
const overflowCount = report.filter(r => r.status === 'OVERFLOW').length
const maxFm = Math.max(...report.filter(r => r.fmBytes).map(r => r.fmBytes))

console.log(`\nRewrites: ${okCount} / expected 38`)
console.log(`Overflow (>1024 bytes): ${overflowCount}`)
console.log(`Max frontmatter byte length: ${maxFm} / ${FM_LIMIT}`)

if (overflowCount > 0) {
  console.error('\n[FATAL] frontmatter overflow — descriptions exceed the 1024-byte limit. Reverting changes by hand is required.')
  process.exit(1)
}
