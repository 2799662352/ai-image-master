# Create Storyboard Workflow Reference

## 1. What To Extract

For every script or idea, extract:

- video type: product ad, short drama, long drama, period drama, sci-fi, animation, music video, explainer
- target duration, platform, audience, and aspect ratio
- protagonist, supporting characters, relationship, emotional arc
- products, props, weapons, vehicles, costumes, brand assets
- locations, time of day, weather, light state, scene geography
- dialogue, narration, ambience, music, SFX, and silence
- intended visual style, tone, references, and taboo references
- output expectation: plan only, full package, or full package plus image generation

If aspect ratio is missing, ask before final prompts or images. If target duration is not inferable, ask before shot planning.

## 2. Script Analysis

Analyze in this order:

1. Scene beats: where the story changes location, time, objective, or emotional state.
2. Dramatic beats: reveal, decision, reaction, reversal, product benefit, joke, impact, memory, confession.
3. Action beats: turn head, reach, pick up, hand off, walk in, exit, chase, fight, embrace, open door, reveal object.
4. Handoff opportunities: where the prior shot can plant the next space, motion direction, visual token, occlusion, or sound cue.
5. Cut opportunities: action punctuation, eyeline, insert, reaction, prop close-up, empty room, occlusion, sound cue.
6. Generation risk: identity drift, hand/prop interaction, multi-person blocking, fast action, axis/eyeline risk, scene change.

Do not turn every sentence into a shot. Design shots around what the edit needs.

## 3. One-Shot-One-Clip Rule

New projects default to `SH### = CLIP###`.

- `SH###` is the film shot.
- `CLIP###` is the SceneDance generation.
- Default: one shot card, one clean start keyframe, one SceneDance prompt, one edit boundary on each side.
- Exception: a `CLIP###` may contain multiple `SH###` only when all shots are low-risk,
  share the same scene/axis/action, and the generation remains within `4–15s`. Explain the
  exception in `clip_plan.md`.
- The deliverable image unit is always `CLIP###`, not the whole film. A full-film
  overview/contact sheet never replaces per-clip storyboard images and is never the primary
  input or `firstFrame`.
- Sequence/multi-panel and cinematic art-direction boards are optional atmosphere/communication
  assets. If either board is referenced by a video prompt, mark it `atmosphere-loose` and prepend
  the mandatory prompt-primary role statement; it never controls story, composition, action,
  order, or duration.
- If a user asks to regenerate storyboard images for an existing project, update the per-`CLIP###`
  images first and update any overview board that project actually includes.
- If two neighboring shots are merged, first make that merge explicit as one `CLIP###`; then generate one clean start keyframe and one single-clip storyboard for that merged clip. Do not use a two-panel storyboard sheet as the primary SceneDance image.
- Even when two neighboring shots are merged, the clip must still define one internal receive/action/handoff design. Do not use the merge to hide two unrelated scenes inside one generation.

Generation/edit duration guidance:

- `1.5-2.5s` final edit: generate at least `4s`, then trim a stable insert or impact beat
- `2-4s` final edit: generate at least `4s`, then trim a prop detail, product macro, reaction, or cutaway
- `3-5s` final edit: use a `4-5s` generation, then trim if needed
- `4-7s`: physical action with clear start and finish
- `6-10s`: performance or dialogue beat with one action chain
- `8-12s`: sustained atmosphere or controlled blocking
- `12-15s`: stable long take only

Always leave `0.5-1s` handles when practical.

## 4. Continuity Bible

The continuity bible is the source of truth for the entire video. Include:

- character identity: face, age, body type, hair, makeup, skin details
- wardrobe: colors, layers, accessories, damage/wetness/dirt state
- props/products: design, size, readable marks, position, hand relationship
- scene geography: entrances, exits, furniture, street direction, room layout
- 180-degree axis: who is screen-left/right, where camera can stand, when axis resets
- eyelines: who looks where, what is seen, off-screen direction
- screen direction: walking/running/vehicle direction, entry/exit side
- handoff geography: which doors, frames, windows, screens, props, UI layers, light sources, or foreground masses can pass the viewer into the next shot
- lighting/weather/time: source direction, color temperature, rain/snow/fog, day/night
- visual style: aspect ratio, lens feel, camera grammar, color palette, texture

Every shot prompt should inherit these locks instead of redefining them differently.

## 5. Shot Design

Each shot card must answer:

- Why does this shot exist?
- What must the audience understand or feel?
- What exact action starts the shot?
- What exact action or pause ends the shot?
- What emotion starts and ends the shot?
- What does this shot receive from the previous shot?
- What does this shot hand off to the next shot?
- What motion vector, spatial bridge, occlusion carrier, or visual bridge makes the handoff legible?
- Which reference images stabilize identity, space, prop, and action?
- How does the previous shot cut into this one?
- How does this shot cut to the next one?
- What will fail in SceneDance, and what is the fallback?

Shot types to use deliberately:

- establishing shot: lock space before close coverage
- over-the-shoulder: keep dialogue/eyeline readable
- POV/subjective shot: connect gaze to seen object
- reaction shot: absorb discontinuity and emotional turns
- insert/prop close-up: hide handoff or object-position mismatch
- empty-room/atmosphere shot: bridge time, space, or mood
- occlusion shot: use passing object, door, body, darkness, flash, smoke, rain, or motion blur
- close-up: anchor emotion when body continuity is unstable

Camera methods to vary deliberately:

- locked-off: product clarity, exact insert, quiet observation
- slow push-in: emotional pressure or reveal, not as a default for every shot
- pull-back reveal: expose hidden space, consequence, object, or UI state
- lateral track: maintain screen direction and pass through foreground
- following track: enter corridors, rooms, crowds, or product-use spaces with a character
- foreground occlusion push: let a frame, body, package, smoke, vehicle, UI, or darkness wipe the cut
- POV/subjective: receive eyeline and show what is seen
- over-shoulder: preserve dialogue axis and character relation
- low/high angle: power, vulnerability, product hero scale
- handheld micro-move: tension while keeping SceneDance motion stable
- prop-led/light-led: let an object, screen glow, flashlight, reflection, or color field guide the next shot

Avoid packing multiple major camera moves into one SceneDance clip. If the shot needs a push, a pan, and a reveal, split or simplify.

## 6. Handoff Design Matrix

Create handoff rows before final prompts or images. Required fields:

- handoff ID
- boundary
- prior clip handoff
- next clip receiver
- spatial entrance/exit
- motion vector
- occlusion carrier
- visual bridge
- sound bridge
- how it hides AI discontinuity
- fallback if failed

The prior clip must not only complete itself. Its last usable moment should expose the next clip's foreground, doorway, object, light, direction, UI, or sound. The next clip should begin by receiving that element. This is more reliable than asking AI to interpolate between unrelated images.

Useful handoff patterns:

- wipe by foreground: body crosses lens, vehicle passes, package fills frame, door frame wipes to black
- space inheritance: doorway becomes next room entrance, window reflection becomes exterior view, UI panel becomes next screen
- motion inheritance: same left-right movement, same push-in direction, same object moving toward camera
- shape/color inheritance: circular prop to circular UI, amber light to amber eye reflection, blue screen glow to blue doorway
- sound inheritance: J-cut next ambience, L-cut prior dialogue, click/impact/footstep carrying the cut

If a boundary is a deliberate hard cut, state the contrast logic: joke, shock, emotional rupture, time jump, or information reveal.

## 7. Edit Boundary Matrix

Create boundary rows from the handoff matrix before final prompts or images. Required fields:

- boundary ID
- handoff ID
- prior out point
- next in point
- cut type
- matching logic
- audio bridge
- frame matching required
- CapCut/Jianying handling
- risk
- fallback cut

Cut types:

- action match: motion starts in one shot and resolves in another
- eyeline match: look off-screen, cut to seen subject/object
- screen-direction match: movement direction stays logical
- composition match: shape, color, position, or motion matches
- shot-size progression: wide -> medium -> close-up or close-up -> insert
- reverse cut: dialogue or confrontation coverage
- reaction cut: emotion absorbs jump
- insert: hand, prop, sign, product, door, phone, weapon, food, logo
- cutaway/empty shot: mood or time bridge
- occlusion cut: foreground object hides discontinuity
- J-cut: next audio starts before next image
- L-cut: prior audio continues over next image
- continuous action: strictest option, only when unavoidable

Default rule: if the cut has a strong handoff and visual/audio reason, strict frame matching is not required.

## 8. Reference Input Matrix

For every SceneDance shot, list:

- primary clean input keyframe
- character references
- scene references
- prop/product references
- pose/expression references
- clip storyboard board reference, if useful
- sequence/multi-panel or cinematic art-direction boards, if the project includes them
- optional handoff frame, if the boundary needs a clear occlusion/light/object token
- why each reference is needed
- which images should not be used as primary input

Assign every item one role:

- `identity-hard`: user-selected character anchors (headshot+full-body, three/four/multi-view
  character board, or another approved clean asset) or product hero art. If multiple candidate
  anchor sets exist and identity is important, ask the user which set is authoritative.
- `keyframe-strong`: clean start/key/out frame for the current clip
- `atmosphere-loose`: storyboard/grid/art-direction board for color/light/material/era/spatial mood/visual motifs only
- `director-free`: transitions, micro-motion, camera interpolation, pacing, particles, and effects

For every `atmosphere-loose` item, record `prompt=primary` and `must_not_copy`: grid borders,
panel numbers, captions, tables, and collage layout. The video prompt must include the mandatory
prompt-primary / atmosphere-board-low-constraint preamble. Do not treat the board as primary input
or `firstFrame`. Exact panel following requires cropping and cleaning the relevant panel into a new
`keyframe-strong` image.

## 9. Prompt Writing Priorities

Use this priority order:

1. Continuity locks
2. Receiver-in and handoff-out states
3. Action start and action end
4. Emotion start and emotion end
5. Scene geography, axis, eyeline, screen direction
6. Composition and camera movement
7. Sound/edit bridge
8. Style, texture, color
9. Negative constraints

Chinese and English Image 2 prompts must preserve the same IDs and facts. The English version must not invent new story details.

## 10. Failure And Fallback Design

Every shot must define fallback before generation:

- If identity drifts: strengthen character reference, shorten shot, switch to over-shoulder/insert/reaction, or regenerate start keyframe.
- If hand/prop action fails: use prop close-up, pose sheet, simpler start/end state, or split into reach + object close-up.
- If action feels rushed: extend shot duration if under 15s, simplify action, or split into two clips.
- If space jumps: insert establishing/empty shot, rebuild scene keyframe, or avoid direct continuity cut.
- If emotion jumps: add reaction shot or L-cut prior dialogue/music.
- If axis/eyeline flips: regenerate with explicit screen-left/screen-right locks or insert neutral shot to reset axis.
- If product/logo deforms: use product hero/macro references and reduce body interaction.
- If handoff fails: move the edit to the strongest occlusion, add an insert/reaction/empty shot, rebuild only the out keyframe or receiver keyframe, or change to a deliberate hard cut with sound bridge.

Fallbacks should prefer edit solutions before expensive regeneration when the generated clip is otherwise usable.

## 11. Delivery Checklist

Deliver these files for a complete package:

- `01_script_brief/script.md`
- `01_script_brief/script_analysis.md`
- `01_script_brief/project_brief.md`
- `02_bibles/character_bible.md`
- `02_bibles/product_prop_bible.md`
- `02_bibles/scene_bible.md`
- `02_bibles/style_bible.md`
- `02_bibles/continuity_bible.md`
- `03_storyboard/master_storyboard.md`
- `03_storyboard/shot_cards.md`
- `03_storyboard/clip_plan.md`
- `03_storyboard/shot_motion_budget.md`
- `03_storyboard/reference_input_matrix.md`
- `03_storyboard/handoff_design_matrix.md`
- `03_storyboard/edit_boundary_matrix.md`
- `04_prompts/img2_zh.md`
- `04_prompts/img2_en.md`
- `04_prompts/scenedance_shot_prompts.md`
- `04_prompts/negative_prompts.md`
- `06_delivery/scenedance_usage_list.md`
- `06_delivery/edit_continuity_notes.md`
- `06_delivery/post_edit_plan.md`
- `06_delivery/risk_fallback_plan.md`
- `06_delivery/jianying_edit_list.md`
- `final_image_package/image_manifest.md`

Before final response, count expected images and compare them to files on disk. If any required image is missing, generate it or clearly state the blocker.
