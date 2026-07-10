---
name: catimation-portrait-library
description: >-
  Autonomously manage the CATIMATION portrait library (人像库 / 素材库) — the
  persistent, deduplicated pool of image / video / audio reference assets that
  keeps characters & scenes consistent. Use when the user mentions 人像库 / 素材库 /
  参考素材 / 角色库, wants to save / 收藏 / 搜索 / 整理 / 重命名 / 分组 / 删除 / 下载 a reference
  asset, or when a reference asset is needed for 视频生成 / video generation. Add,
  search, organize, rename, group, hide, download proactively.
---

# Autonomously manage the CATIMATION portrait library (人像库)

<!-- skill-budget: fast -->

The portrait library is a persistent, content-deduplicated pool of image /
video / audio assets. It feeds `generate_video` (reference images, first/last
frames) and keeps the SAME character or scene consistent across clips. Four
`catimation` MCP tools let you manage it — use them proactively; you do not
need permission to add, search, organize, or download on the user's behalf.

## When to Use

- 用户提到 人像库 / 素材库 / 参考素材 / 角色库,要 收藏 / 搜索 / 整理 / 重命名 / 分组 / 删除 / 下载 素材。
- 视频生成需要参考素材(角色 / 场景一致性)→ 先入库拿 `asset://assetId` 再喂 `generate_video`(**视频/音频类素材先用 `ffmpeg-win` 抽静帧/抽音轨再入库当参考,不直传原始视频**)。
- 用户要复用「上次那个人 / 同一个角色 / 同一个场景」→ 先 `list_portrait_library` 找回锚点。
- 用户喜欢刚生成的图、之后可能复用 → 主动入库。

## Tools

- **`add_to_portrait_library`** — upload ONE asset. `source` may be a local
  file path, `data:` URL, `https` URL, or an existing `asset://assetId`. Kind
  (image/video/audio) is auto-detected (override with `kind`); for people use
  `imageCategory: image_people` (default). Identical content dedupes to the same
  `assetId`. Returns `{ assetId, assetUrl, name, duplicated }`. **图像** asset 的
  `assetUrl` (`asset://…`) 可直传 `generate_video`;但**视频/音频 asset 不直接当视觉参考**
  ——先用 `ffmpeg-win` 抽干净关键帧 / 拼宫格图(或抽音轨),把**静帧 / 音频**入库再喂,原始
  视频仅留底(尤其是 Seedance 自产片段,整段回喂会二次编码、画质打折)。
- **`list_portrait_library`** — search / browse. Optional `query` (name text),
  `kind` (`all`/`image_people`/`image_environment`/`video`/`audio`),
  `group`, `page`, `pageSize`, `includeHidden`. Returns items with
  `assetId`, display name, kind, custom `group`, and `asset://assetId`. This
  is how you FIND material and look up assetIds before editing/downloading.
- **`edit_portrait_library`** — organize via `action`:
  `rename` (`assetId` + `name`), `move_group` (`assetIds` + `group`; omit
  `group` to ungroup), `hide` / `unhide` (`assetIds`; hide = soft-delete,
  recoverable), `new_group` / `delete_group` (`group`). Edits appear live on
  the user's 人像库 page.
- **`download_portrait_asset`** — save an asset locally; pass the `sourceUrl`
  from `list_portrait_library`. Returns the saved local path.

## 审核闸门(上传后别立刻拿去生成 ⚠️)

`add_to_portrait_library` 上传**新**素材后,上游会先做**内容审核(审核)**。审核
未通过 / 仍在审核中的素材,直接把它的 `asset://assetId` 喂给 `generate_video`
**会让生成任务直接失败**(如 `内容审核未通过` / 素材不可用)。所以:

- ✅ **复用库里已存在的素材最稳**——它们早已审核通过。
- ✅ `add_to_portrait_library` 返回 `duplicated: true` = 命中去重 = 已在库 =
  已审核,**可以立刻用**。
- ⛔ 全新上传(`duplicated: false`)**不要审核没过就抢着生成**:先确认审核通过
  ——用 `list_portrait_library` 能正常查到、人像库页面对该素材无「审核中 / 待审核」
  标记后再 `generate_video`;或直接告诉用户「素材正在审核,通过后再生成」并停下,
  **不要赌它已通过**。
- 一句话:**先入库 → 等审核过 → 再生成**,顺序不能颠倒。

## Proactive workflows

1. **User mentions video generation with material** → `add_to_portrait_library`
   each provided image/video/audio FIRST. Then — only after it clears review
   (see 审核闸门 above; a `duplicated:true` result is already reviewed) —
   reference the returned `asset://assetId` in `generate_video`. (Images passed
   directly to `generate_video` are auto-imported; videos/audio and any "save
   for later" material are on you.)
2. **Reuse a character/scene** ("还是上次那个人 / 同一个角色 / 同一个场景") →
   `list_portrait_library` to find the matching `asset://assetId`, then
   reference it — this is what keeps identity consistent.
3. **User likes a generated image and may reuse it** → proactively
   `add_to_portrait_library` it (`imageCategory: image_people` for people).
4. **Tidy up** → give new assets clear names (`rename`) and group related
   material (`new_group` + `move_group`) when it helps the user find things.
5. **Save/export** → `list_portrait_library` to get the `sourceUrl`, then
   `download_portrait_asset`.

## Notes

- The library can be LARGE. `list_portrait_library` is paginated — narrow first
  with `query`/`kind`/`group`, read the returned `page`/`totalPages`/`hasMore`,
  and when `hasMore` is true page through with `page:N+1`. Do NOT crank up
  `pageSize` to dump everything (large results get truncated and waste context).
- Always `list_portrait_library` to obtain `assetId` / `sourceUrl` before any
  `edit_portrait_library` or `download_portrait_asset` call — do not guess ids.
- All four tools need the Seedance **API Key AND API Secret** configured
  (Settings → Seedance; the library interface is HMAC-signed). If missing, the
  tool tells you to ask the user to set them — relay that and stop.
- Renaming / grouping / hiding is a local organizing layer shared with the UI;
  it never deletes upstream data (hide is reversible via `unhide`).

## Common Mistakes

- **新上传的素材审核没过就抢着 `generate_video`**(任务必失败):见上「审核闸门」,
  先等审核通过(或复用 `duplicated:true` 的已审核素材)再生成。
- 凭空猜 `assetId` / `sourceUrl`;必须先 `list_portrait_library` 查到再用。
- 漏 `list` 直接 `edit_portrait_library` / `download_portrait_asset`。
- 调高 `pageSize` 一次性 dump 整库(结果会被截断、浪费上下文),应先用 `query`/`kind`/`group` 收窄再翻页。
- 缺 API Key/Secret 仍硬调;缺失时转告用户去设置并停下。
