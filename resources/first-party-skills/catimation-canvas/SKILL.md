---
name: catimation-canvas
description: >-
  Interactive AI image canvas (tldraw) in the CATIMATION desktop app. Trigger when
  the user wants to work on the 画布 / canvas, place a generated image there, or
  iterate on an image by drawing annotations (arrows+notes, circles, boxes).
  Especially trigger on 打开画布 / 开启自动修图 / 自动修图模式 / 按标注修图 / 在画布上改图 / canvas edit.
  The canvas AUTO-SUBMITS an edit request when the user finishes annotating (no
  button); keep watching for and applying those. Uses the canvas_* + generate_image tools.
---

# CATIMATION Canvas — generate on canvas + auto-edit from annotations

The canvas is an infinite tldraw surface embedded in the Codex page. You drive it
through MCP tools; the user draws on it. There is **no manual submit button** — when
the user finishes annotating, the canvas auto-enqueues an edit request and you pick
it up via the watch loop below.

## Open the canvas

Call `canvas_open` first (idempotent). If the canvas is not visible the tool opens
it as the active center tab.

## See what's on the canvas

You CAN inspect the canvas — do not tell the user you cannot see it. Call
`canvas_snapshot`: it returns a structured list of every shape (images, dashed
holders, arrows/circles/text annotations with their positions/bounds, plus each
image's `assetId`/`assetPath`/intrinsic size) AND an `imagePath` — a real on-disk
PNG render (`screenshotScope` tells you if it shows the whole canvas or just the
viewport). Open/view that `imagePath` to actually see the pixels (layout, what the
user drew, current image). Use `canvas_snapshot` whenever the user asks "what's on
the canvas / 看一下画布", or before editing so you know the exact target and where
the marks are. Pass `screenshot: false` when you only need the structured data.

On LARGE canvases (>40 shapes) the snapshot is TIERED: viewport shapes come as a
reduced overview, off-viewport shapes are grouped into `peripheralClusters`
(bounds + count + type histogram), and the PNG is cropped to the viewport. To
explore: call `canvas_focus_region` with a cluster's `bounds` (or `shapeIds`) —
by default this sets YOUR OWN virtual viewport (the user's camera does NOT
move), then re-call `canvas_snapshot` to see that region in detail. Pass
`mode: 'camera'` ONLY when the user asks to be shown/taken somewhere (it moves
the shared camera), and `clear: true` to follow the user's camera again.
`focusShapeIds: […]` gets full detail for specific shapes; `full: true`
forces the complete dump (large).

### Picking and fetching one image (list → fetch)

When you need to act on a specific image (not the whole layout), prefer the
focused pair instead of eyeballing the full snapshot:

1. `list_canvas_images` (cheap, read-only) → a flat index of image shapes:
   `shapeId`, `assetId`, on-canvas `w`/`h`, `role`, `version`, `assetPath`, and
   `hasFile`. Use it to choose the right `shapeId`.
2. `get_canvas_image { shapeId }` → that one image's focused metadata plus an
   `imagePath` — an on-disk PNG of just that image, **annotations excluded**. This
   is the clean edit source: pass its `imagePath` to `generate_image` as a
   `referenceImages` entry. Never claim you can't find the image's file — fetch it
   here. (If `hasFile` was already true in the list, `assetPath` is also usable.)

## Open-canvas hook

When the user opens the canvas themselves, the next turn arrives with a leading
`[canvas]` note telling you the canvas is now the active surface. Treat it as a
signal to stay in canvas mode: the canvas is already open (no need to call
`canvas_open`), and if you need to know what's on it, call `canvas_snapshot`
before acting. Do not echo the `[canvas]` note back to the user.

## Generate an image onto the canvas

1. `prepare_image_generation` with the user's request + aspect ratio → returns a
   holder shape id, bounds, and a suggested prompt.
2. `generate_image` with that prompt (and any `referenceImages` the user gave).
3. `insert_image_into_holder` with the returned `holderShapeId` + the generated
   image path. The image now lives on the canvas.

## Put a video on the canvas

After you generate a video (e.g. a Seedance/Sora clip), call `insert_video` with
`videoPath` (the local file path) to drop it onto the canvas as a real video shape
that plays inline. Optional `x`/`y` to position it (e.g. next to its source image)
and `w`/`h` to size it — omit them to use the clip's intrinsic size (capped to
640px on the longest edge). Use this for "把视频也放到画布上 / 出个视频放上去" requests.
(The user can also drag a file straight from the workspace file tree — or the OS —
onto the canvas; images and videos land as real shapes. `insert_video` /
`insert_image_into_holder` are the programmatic paths so YOU can place media
precisely.) For text/labels, use
`canvas_exec` to create a `text`/`note` shape (`toRichText` is injected).

To go the OTHER way — get a canvas video's file back so you can ffmpeg / contact-sheet
it — call `get_canvas_video` (no args; acts on the selected, or only, video). It
returns `videoPath`: an absolute on-disk mp4/webm/mov (the clip's recorded path, or a
materialized copy if it had none) plus `shapeId`/`assetUrl`/`title`. This is the video
analog of `list_canvas_images`→`get_canvas_image`: never hunt the disk by filename for
a canvas clip. (For semantic 理解/分析 of the clip instead, use `understand_canvas_video`.)

## Auto-edit mode (Codex 直接监听) — the main loop

When the user says 开启自动修图 / 自动修图模式 (or asks you to keep applying canvas edits),
enter this loop and DO NOT stop until the user tells you to:

1. Call `watch_edit_requests` (it long-polls ~25s and claims the next request). If
   it returns nothing, call it again — keep looping.
2. When a request arrives, set it to processing if useful, then call
   `generate_image` with the request's `editPrompt` and pass its `targetImagePath`
   as a `referenceImages` entry (image-to-image edit). `targetImagePath` is ALWAYS a
   real, on-disk PNG that the canvas exported for you — use it directly; never claim
   the file is missing.
3. **Geometry-only marks** (`needsClarification: true`, e.g. the user drew an arrow,
   circle, or box but no text label): the marks tell you WHERE to change; take WHAT
   to change from the user's most recent chat instruction (e.g. "人物换成真人"). Combine
   them into the edit and proceed — do NOT dead-end. Only stop and ask one short
   question if neither the annotations nor the recent conversation give any intent.
4. Call `create_image_version` with `sourceShapeId` = the request's
   `targetShapeId` and the new image path. This places the new version **to the
   right of the original and preserves the old image** — never overwrite it.
5. Call `update_edit_request` with `status: 'completed'` (or `needs_clarification`
   only when there is genuinely no intent anywhere).
6. Go back to step 1.

If the watch loop has been idle for a long time and stops, the canvas shows the
user that you've paused; when they ask you to continue, just re-enter the loop.

## Reading annotations directly (one-off, no loop)

To apply the current marks once without the loop: `prepare_annotation_edit`
(optionally with a `targetShapeId`) returns the parsed annotation plan + a ready
`editPrompt`. Then do generate_image → create_image_version exactly as above.

## Tidy layout in one call (canvas_arrange)

To line up multiple shapes (storyboard grids, image rows, comparison columns),
call `canvas_arrange { shapeIds, operation, gap? }` instead of nudging x/y one
shape at a time. Operations: `align-left/right/top/bottom`,
`align-center-horizontal/vertical`, `distribute-horizontal/vertical` (≥3 shapes),
`stack-horizontal/vertical` (row/column with a gap), `pack` (grid),
`bring-to-front`/`send-to-back` (z-order, ≥1 shape — e.g. a note hidden behind
an image). One atomic transaction, and the camera frames the result (z-order
ops leave the camera alone).

## Draw native shapes (canvas_create_shape)

To draw boxes, sticky notes, labels, lines and connector arrows, call
`canvas_create_shape` instead of writing canvas_exec code:

- `{ kind:'geo', geoType:'rectangle|ellipse|star|cloud|…', x, y, w?, h?, text?, color?, fill? }` — labeled boxes/shapes.
- `{ kind:'note', x, y, text?, color? }` — sticky note.
- `{ kind:'text', x, y, text, maxWidth?, color? }` — free text (maxWidth wraps).
- `{ kind:'line', x1, y1, x2, y2, color? }` — plain line.
- `{ kind:'arrow', fromId, toId, text?, bend?, color? }` — connector BOUND to two
  shapes: it follows them when they move. Prefer bindings over raw x1/y1/x2/y2
  for storyboard shot-flow arrows and diagram edges.

## Edit / delete single shapes (canvas_update_shape / canvas_delete_shapes)

- `canvas_update_shape { shapeId, x?, y?, w?, h?, rotation?, text?, color? }`:
  change ONE shape's position, size, rotation (degrees), text/label or color in
  a single structured call — no canvas_exec code needed for simple edits.
- `canvas_delete_shapes { shapeIds }`: batch-delete shapes (single undo step).
  Destructive — only delete what the user clearly wants gone.

## Relative placement — never do coordinate math yourself

Both `canvas_update_shape` and `canvas_create_shape` accept
`{ referenceId, side, align?, sideOffset?, alignOffset? }`: the shape lands on
`side` (top/bottom/left/right) of the reference shape, aligned `start/center/end`
(default center), with optional px offsets. The math runs in code against REAL
measured bounds. Use it for captions under images, shot numbers pinned to a
corner (`side:'top', align:'start'`), labels beside file cards. Example — a
caption 16px below an image, centered:
`canvas_create_shape { kind:'text', text:'Shot 3 — dawn alley', referenceId: IMG_ID, side:'bottom', sideOffset:16, maxWidth:360 }`.
Placement wins over x/y in the same call.

## Noticing user changes between looks

`canvas_snapshot` returns `changedSinceLastSnapshot` ({created/updated/deleted}
shape ids) whenever the canvas changed since your previous snapshot in this
thread; its `byAgent` field lists the subset YOU wrote via the structured tools
— treat ids NOT in `byAgent` as the user's edits and respect them (don't "fix"
them back). Check it first — if the user moved/edited/deleted shapes while you
were working, re-read those shapes before acting on stale positions. Canvas
`lints` are surfaced ONCE per thread — react when you see one; absence later
doesn't mean it was fixed. The snapshot
also carries `userViewportBounds` — the region the USER is looking at right now
(it may differ from your virtual viewport): when the user says "the images on
my screen", match shapes against THAT box, not yours.

## Free-form canvas control (canvas_exec + canvas_search)

For layout/edits the structured tools above don't cover — group, complex
reorder, multi-step transforms, exotic shape props — use the escape
hatch:

1. `canvas_search { code }` (read-only): write JS that gets `spec` and returns a
   result, to discover the Editor API. e.g.
   `return spec.members.filter(m => m.category === 'layout').map(m => m.signature)`
   or `return spec.types.shapes.find(s => s.shapeType === 'arrow')`.
2. `canvas_exec { code }`: write JS that runs on the live tldraw `editor`. In scope:
   `editor` (real tldraw Editor API) + helpers `createShapeId`, `createBindingId`,
   `createArrowBetweenShapes(fromId,toId,{text?,bend?})`, `boxShapes(ids,{text?,color?})`,
   `zoomToFit(ids)`, `Box`, `Vec`, `Mat`, `clamp`, `getArrowBindings`, `toRichText`.
   Use `return` to read data back. Examples:
   - `return editor.getCurrentPageShapes().map(s => ({ id: s.id, type: s.type }))`
   - `editor.createShape({ type:'geo', x:200, y:120, props:{ geo:'rectangle', w:320, h:180 } })`
   - `createArrowBetweenShapes('shape:a','shape:b',{ text:'next' })`
   - `editor.distributeShapes(editor.getSelectedShapeIds(), 'horizontal')`

`canvas_exec` returns `{ success, result?, error? }`. On `success:false` the code did
NOT apply — read `error`, fix the snippet, and retry. Prefer the dedicated image
tools (insert_image_into_holder / create_image_version) for the image-version flow;
use exec for everything else. Don't delete the user's images unless asked.

## Saving / exposing the canvas as a file

`save_snapshot` persists the canvas and returns `imagePath` — an on-disk PNG of the
whole canvas you can open or share, like an uploaded attachment. Use it when the
user wants to "save / 导出 / 存一下画布".

## Restorable checkpoints (save / load / list)

Beyond the flat PNG, you can save the **full editable canvas state** and restore it
later — useful as a "fork"/branch point before risky edits, or to keep named
versions:

- `save_checkpoint { name? }` → saves the whole canvas (tldraw snapshot JSON) to
  disk; returns `{ checkpointId, path, shapeCount }`. Call this BEFORE a big/risky
  change so you can return to it.
- `list_checkpoints` → newest-first `{ checkpointId, name, createdAt, shapeCount, path }`.
- `load_checkpoint { checkpointId }` → **replaces** the current canvas with that
  checkpoint (switches to that branch). Save the current state first if you might
  want it back. Returns `{ ok:false, error }` on an incompatible snapshot instead
  of crashing the canvas.

Use checkpoints for "存个版本 / 回到之前那版 / 试一个分支" type requests. Use
`save_snapshot` (PNG) only when the user just wants a flat image to share.

## Notes

- Arrows with a text label = "change the thing this arrow points at, per the note".
  Circles / boxes scope a region. Bare short notes (改一下 / 不好看) are too vague —
  ask one crisp clarifying question rather than guessing.
- Keep every prior version on the canvas; iterations go left → right.
- generate_image is the in-app path that actually displays + saves the result; use
  it rather than any built-in image tool.
