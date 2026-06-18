---
name: catimation-portrait-library
description: >-
  Autonomously manage the CATIMATION portrait library (人像库 / 素材库) — the
  persistent, deduplicated pool of image / video / audio assets that powers video
  generation and keeps characters & scenes consistent. Use whenever the user
  mentions 人像库 / 素材库 / 参考素材 / 角色库, wants to save / 收藏 / 搜索 / 整理 / 重命名 / 分组 /
  删除 / 下载 a reference asset, or whenever you need an asset for 视频生成 / video
  generation. Add, search, organize, rename, group, hide, download proactively.
---

# Autonomously manage the CATIMATION portrait library (人像库)

The portrait library is a persistent, content-deduplicated pool of image /
video / audio assets. It feeds `generate_video` (reference images, first/last
frames) and keeps the SAME character or scene consistent across clips. Four
`catimation` MCP tools let you manage it — use them proactively; you do not
need permission to add, search, organize, or download on the user's behalf.

## Tools

- **`add_to_portrait_library`** — upload ONE asset. `source` may be a local
  file path, `data:` URL, `https` URL, or an existing `asset://assetId`. Kind
  (image/video/audio) is auto-detected (override with `kind`); for people use
  `imageCategory: image_people` (default). Identical content dedupes to the same
  `assetId`. Returns `{ assetId, assetUrl, name, duplicated }` — pass
  `assetUrl` (`asset://…`) straight into `generate_video`.
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

## Proactive workflows

1. **User mentions video generation with material** → `add_to_portrait_library`
   each provided image/video/audio FIRST, then reference the returned
   `asset://assetId` in `generate_video`. (Images passed directly to
   `generate_video` are auto-imported; videos/audio and any "save for later"
   material are on you.)
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
