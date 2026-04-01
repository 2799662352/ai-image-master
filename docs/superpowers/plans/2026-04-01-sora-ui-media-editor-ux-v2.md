# Media Editor UX Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the media reference area in JimengStyleEditor to match Jimeng Seedance Agent's UX — slim Popover (add only), expanded stack with delete buttons, pseudo-random card rotation, bottom `+` pill.

**Architecture:** Pure refactor of two existing files. No new dependencies or components. Popover content switches from media grid to vertical add menu. Stack cards gain delete buttons and a trailing `+` card. CSS gets elastic animations and pseudo-random transforms.

**Tech Stack:** React, Ant Design (Popover, Upload), CSS transitions/transforms

**Spec:** `docs/superpowers/specs/2026-04-01-sora-ui-media-editor-ux-design.md`

---

## File Map

| File | Changes |
|------|---------|
| `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx` | Replace `renderMediaPopoverContent` → `renderAddMenu`; restructure stack rendering (delete buttons, + card, Popover rewire); add bottom + pill; close Popover on success; remove `slice(0,6)` |
| `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css` | Pseudo-random rotation/offset CSS vars; elastic transition curves; `.jm-stack-delete` styles; `.jm-stack-add-card` styles; expanded width formula update; `prefers-reduced-motion`; bottom + pill styles |

---

### Task 1: Replace Popover content with slim add menu

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx:511-567`

- [ ] **Step 1: Replace `renderMediaPopoverContent` with `renderAddMenu`**

Replace the entire `renderMediaPopoverContent` function (lines 511-567) with a slim vertical menu. This removes all media thumbnails from the Popover.

```tsx
const renderAddMenu = () => (
  <div className="jm-add-menu">
    <Upload
      accept={['multimodal_ref', 'edit_video'].includes(volcengineArkMode)
        ? 'image/*,video/mp4,video/quicktime,.mp4,.mov,audio/wav,audio/mpeg,audio/mp3,.wav,.mp3'
        : 'image/*'}
      showUploadList={false}
      beforeUpload={handleUnifiedUpload}
      multiple
    >
      <div className="jm-add-menu-item">
        <CloudUploadOutlined />
        <span>上传</span>
      </div>
    </Upload>
    <div className="jm-add-menu-item" onClick={() => { setMediaPopoverOpen(false); setAssetLibraryOpen(true); }}>
      <FolderOpenOutlined />
      <span>素材库</span>
    </div>
    <div className="jm-add-menu-item" onClick={() => { setMediaPopoverOpen(false); setPortraitLibraryOpen(true); }}>
      <UserOutlined />
      <span>人像库</span>
    </div>
  </div>
);
```

- [ ] **Step 2: Update all Popover `content` props to use `renderAddMenu`**

Find the Popover wrapping the media trigger (around line 611) and change:

```tsx
// Before
content={renderMediaPopoverContent()}

// After
content={renderAddMenu()}
```

- [ ] **Step 3: Close Popover on successful add**

Find all `setMediaPopoverOpen(true)` calls after uploads and change to `false`:

- Line 294: `setMediaPopoverOpen(true);` → `setMediaPopoverOpen(false);`
- Line 348: `setMediaPopoverOpen(true);` → `setMediaPopoverOpen(false);`
- Line 380: `setMediaPopoverOpen(true);` → `setMediaPopoverOpen(false);`

> **Note on Popover close mechanism:** After Task 4 detaches the outer controlled Popover, `mediaPopoverOpen` state is repurposed to control the `jm-stack-plus` button's Popover (folded state). The expanded `+` card and bottom `+` pill use uncontrolled Popovers (Ant Design manages open state internally). The `setMediaPopoverOpen(false)` calls in upload handlers will close the folded `+` Popover; uncontrolled Popovers auto-close when focus leaves.

- [ ] **Step 4: Verify — dev server hot reload**

Run: `cd 25/soraui_4.0/sora-ui && npm run dev`
Expected: Clicking the stack/empty box opens Popover with only 3 vertical options (upload, material library, portrait library). No media thumbnails in Popover.

- [ ] **Step 5: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx
git commit -m "refactor: replace media grid Popover with slim add menu"
```

---

### Task 2: Add CSS for the slim add menu

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: Add `.jm-add-menu` and `.jm-add-menu-item` styles**

Append after the existing `.jm-media-add` block (around line 409):

```css
/* Slim Add Menu (Popover content) */
.jm-add-menu {
  display: flex;
  flex-direction: column;
  padding: 4px;
  min-width: 120px;
}

.jm-add-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: #374151;
  transition: background 0.15s ease;
}

.jm-add-menu-item:hover {
  background: #f3f4f6;
  color: #0ea5e9;
}

.jm-add-menu-item .anticon {
  font-size: 15px;
}
```

- [ ] **Step 2: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css
git commit -m "style: add slim add menu styles for Popover"
```

---

### Task 3: Restructure stack — delete buttons, `+` card, detach outer Popover

This is the biggest task. It replaces the entire media stack rendering block (lines 611-654) as one atomic change to avoid intermediate broken JSX states.

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx:611-654`
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: Replace the entire media stack block (lines 611-654)**

Replace from the outer `<Popover` (line 611) through its closing `</Popover>` (line 654) with the following complete JSX. This:
- Removes the outer controlled Popover wrapper
- Wraps empty state in its own Popover
- Adds delete buttons (top-left X) to each stack card
- Adds `+` card at end of expanded row
- Keeps the folded `jm-stack-plus` with its own controlled Popover
- Uses pseudo-random rotation formulas from the spec
- Shows up to 20 cards in stack, all cards expand on hover

```tsx
<div className={`jm-media-trigger ${allMedia.length > 0 ? 'has-media' : ''}`}>
  {allMedia.length === 0 ? (
    <Popover
      content={renderAddMenu()}
      trigger="click"
      placement="bottomLeft"
      arrow={false}
      destroyTooltipOnHide
      overlayInnerStyle={{ padding: 0, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
    >
      <div className="jm-empty-box">
        <PlusOutlined style={{ fontSize: 18, color: '#9ca3af' }} />
        <span style={{ fontSize: 11, color: '#9ca3af' }}>参考内容</span>
      </div>
    </Popover>
  ) : (
    <div className="jm-stack-container" style={{ '--media-count': Math.min(allMedia.length, 20) } as any}>
      {allMedia.slice(0, 20).map((m, idx) => {
        const rot = ((idx * 7 + 3) % 11 - 5) * 1.5;
        const tx = ((idx * 5 + 2) % 7 - 3) * 1.5;
        const ty = ((idx * 3 + 1) % 5 - 2) * 1.5;
        return (
          <div key={m.id} className="jm-stack-layer" style={{
            zIndex: allMedia.length - idx,
            '--stack-rotate': `${rot}deg`,
            '--stack-tx': `${tx}px`,
            '--stack-ty': `${ty}px`,
            '--expand-left': `${idx * 54}px`,
          } as any} onClick={(e) => {
            if (m.type === 'image') { e.stopPropagation(); setPreviewSrc(m.displayUrl || m.url); setPreviewVisible(true); }
            else if (m.type === 'video' && m.thumbnail) { e.stopPropagation(); setPreviewSrc(m.thumbnail); setPreviewVisible(true); }
          }}>
            {m.type === 'image' && <img src={m.displayUrl || m.url} alt="stack" draggable={false} />}
            {m.type === 'video' && (
              m.thumbnail ? <img src={m.thumbnail} alt="视频封面" draggable={false} /> : <VideoCameraOutlined style={{ fontSize: 24, color: '#9ca3af' }} />
            )}
            {m.type === 'audio' && <AudioOutlined style={{ fontSize: 24, color: '#9ca3af' }} />}
            <button
              className="jm-stack-delete"
              onClick={(e) => { e.stopPropagation(); removeMedia(m.type, m.originalIndex); }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <CloseOutlined />
            </button>
          </div>
        );
      })}
      {allMedia.length > 20 && (
        <div className="jm-stack-badge">+{allMedia.length - 20}</div>
      )}
      <Popover
        content={renderAddMenu()}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        destroyTooltipOnHide
        overlayInnerStyle={{ padding: 0, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
      >
        <div
          className="jm-stack-add-card"
          style={{ '--expand-left': `${Math.min(allMedia.length, 20) * 54}px` } as any}
          onClick={(e) => e.stopPropagation()}
        >
          <PlusOutlined style={{ fontSize: 20, color: '#9ca3af' }} />
        </div>
      </Popover>
      <Popover
        content={renderAddMenu()}
        trigger="click"
        placement="bottomLeft"
        open={mediaPopoverOpen}
        onOpenChange={setMediaPopoverOpen}
        arrow={false}
        destroyTooltipOnHide
        overlayInnerStyle={{ padding: 0, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
      >
        <div className="jm-stack-plus" onClick={(e) => e.stopPropagation()}>
          <PlusOutlined />
        </div>
      </Popover>
    </div>
  )}
</div>
```

**Key details:**
- `jm-stack-plus` (folded `+` button) uses the **controlled** Popover with `mediaPopoverOpen` state — so `setMediaPopoverOpen(false)` in upload handlers will close it.
- Expanded `+` card uses **uncontrolled** Popover (Ant Design manages its own state).
- Delete button uses `stopPropagation` on both `onClick` and `onPointerDown` to avoid triggering preview or Popover.
- `draggable={false}` on images prevents native drag interfering with future @dnd-kit work.

- [ ] **Step 2: Verify JSX structure**

Expected: No syntax errors after replacement. The JSX is complete and self-contained with all opening/closing tags balanced.

- [ ] **Step 3: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx
git commit -m "feat: restructure stack — delete buttons, + card, detach outer Popover"
```

> **Note:** All CSS for this task (`.jm-stack-delete`, `.jm-stack-add-card`, expanded width) is added in Task 4. This commit will have unstyled elements until Task 4 is applied.

---

### Task 4: Add CSS for stack restructure (delete button, + card, expanded width)

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: Add `.jm-stack-delete` styles**

Add after the `.jm-stack-plus` block:

```css
/* Delete button on expanded stack cards — top-left */
.jm-stack-delete {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: rgba(0, 0, 0, 0.55);
  border-radius: 50%;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  cursor: pointer;
  border: none;
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 2;
  pointer-events: none;
}

.jm-media-trigger:hover .jm-stack-layer:hover .jm-stack-delete {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

.jm-stack-delete:hover {
  background: rgba(220, 38, 38, 0.8);
}
```

- [ ] **Step 2: Add `.jm-stack-add-card` styles**

```css
/* + card at end of expanded stack */
.jm-stack-add-card {
  position: absolute;
  top: 0;
  left: 0;
  width: 60px;
  height: 80px;
  border-radius: 6px;
  border: 1.5px dashed #d1d5db;
  background: #fafafa;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.9);
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 1;
}

.jm-media-trigger:hover .jm-stack-add-card {
  opacity: 1;
  transform: scale(1) rotate(0deg) translate(0, 0);
  left: var(--expand-left);
}

.jm-stack-add-card:hover {
  border-color: #36b5f0;
  background: #f0f9ff;
  color: #36b5f0;
}
```

- [ ] **Step 3: Update `.jm-stack-container` hover width + overflow**

```css
/* Before */
.jm-media-trigger:hover .jm-stack-container {
  width: calc(50px * min(var(--media-count), 6) + 20px);
  max-width: 340px;
}

/* After */
.jm-media-trigger:hover .jm-stack-container {
  width: calc(54px * var(--media-count) + 70px);
  max-width: none;
  overflow-x: auto;
  overflow-y: visible;
}
```

The `overflow-x: auto` ensures horizontal scroll when card count exceeds available space (per spec §2).

> **CSS note:** Setting `overflow-x: auto` causes `overflow-y: visible` to be computed as `overflow-y: auto` per CSS spec. This is safe because: (1) delete buttons are positioned *within* card bounds (top: 2px, left: 2px), so they won't be clipped; (2) Ant Design Popovers render via portal to `<body>`, so they're outside the overflow context entirely.

- [ ] **Step 4: Hide folded `jm-stack-plus` when expanded, show `+` card instead**

```css
/* In expanded state, hide the small corner + (the expanded + card takes over) */
.jm-media-trigger:hover .jm-stack-plus {
  opacity: 0;
  pointer-events: none;
}
```

- [ ] **Step 5: Verify**

Expected: Hover stack → cards expand with delete buttons on hover. `+` card visible at end. Folded small `+` hidden during expansion.

- [ ] **Step 6: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css
git commit -m "style: stack delete buttons, + card, expanded width with overflow"
```

---

### Task 5: Pseudo-random rotation & elastic animations

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: Update collapse/expand transition curves**

Replace existing `.jm-stack-layer` transition:

```css
/* Before */
.jm-stack-layer {
  /* ... */
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  transform-origin: bottom left;
  transform: rotate(var(--stack-rotate)) translate(var(--stack-tx), var(--stack-ty));
}

/* After */
.jm-stack-layer {
  /* ... */
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  transform-origin: bottom center;
  transform: rotate(var(--stack-rotate)) translate(var(--stack-tx), var(--stack-ty));
}
```

The `cubic-bezier(0.34, 1.56, 0.64, 1)` produces a slight overshoot/bounce when expanding. The spec specifies different easing for expand vs collapse, but CSS transitions use a single timing function per property. We apply the elastic curve for both directions — the bounce is subtle enough that it works well in reverse too. If needed, asymmetric easing can be achieved with JavaScript class toggling in Phase 2.

- [ ] **Step 2: Update `.jm-stack-container` transition**

```css
.jm-stack-container {
  /* ... */
  transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

- [ ] **Step 3: Add hover shadow enhancement to expanded cards**

```css
.jm-media-trigger:hover .jm-stack-layer:hover {
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
  z-index: 30 !important;
}
```

- [ ] **Step 4: Add `prefers-reduced-motion` support**

```css
@media (prefers-reduced-motion: reduce) {
  .jm-stack-layer,
  .jm-stack-container,
  .jm-stack-add-card,
  .jm-stack-delete {
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 5: Verify**

Expected: Cards fold/unfold with a slight bounce. Each card has a unique rotation angle in collapsed state. Users with `prefers-reduced-motion` see instant transitions.

- [ ] **Step 6: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css
git commit -m "style: elastic animations, pseudo-random rotation, reduced-motion support"
```

---

### Task 6: Bottom `+` pill button

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx:817-823`
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css`

- [ ] **Step 1: Add `+` pill after `@` button**

Insert right after the `jm-at-btn` div (line 823), conditionally rendered:

```tsx
{/* + add media button — only in modes that support media reference */}
{!['text2video', 'first_frame', 'first_last_frame'].includes(volcengineArkMode) && (
  <Popover
    content={renderAddMenu()}
    trigger="click"
    placement="topLeft"
    arrow={false}
    destroyTooltipOnHide
    overlayInnerStyle={{ padding: 0, borderRadius: 12, boxShadow: '0 8px 30px rgba(0,0,0,0.12)' }}
  >
    <div className="jm-add-pill">
      <PlusOutlined />
    </div>
  </Popover>
)}
```

- [ ] **Step 2: Add CSS for `.jm-add-pill`**

```css
/* Bottom toolbar + pill */
.jm-add-pill {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid #e5e7eb;
  background: #fff;
  color: #6b7280;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
}

.jm-add-pill:hover {
  border-color: #36b5f0;
  color: #36b5f0;
  background: #f0f9ff;
}
```

- [ ] **Step 3: Verify**

Expected: In `multimodal_ref` / `reference_images` / `edit_video` / `extend_video` modes, a `+` button appears in the bottom toolbar after `@`. In `text2video` / `first_frame` / `first_last_frame` modes, it's hidden.

- [ ] **Step 4: Commit**

```bash
git add 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx 25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.css
git commit -m "feat: add bottom toolbar + pill for quick media add"
```

---

### Task 7: Cleanup and final verification

**Files:**
- Modify: `25/soraui_4.0/sora-ui/src/components/JimengStyleEditor.tsx`

- [ ] **Step 1: Remove unused `renderMediaPopoverContent` if still present**

The old function should have been replaced in Task 1. Verify it's gone.

**Keep `mediaPopoverOpen` state** — it's still used by the folded `jm-stack-plus` Popover (controlled, with `open={mediaPopoverOpen}`). The `setMediaPopoverOpen(false)` calls in `handleAssetSelect` (line 203) and `handlePortraitSelect` (line 226) correctly close it after adding media from libraries.

- [ ] **Step 2: Remove drag-replace handlers from old Popover items**

The `onDragOver`, `onDragLeave`, `onDrop` handlers that were on each `.jm-media-item` in `renderMediaPopoverContent` are no longer needed since that function is gone. Verify they don't exist elsewhere. The `replaceMedia` function can stay (it's still used and may be needed in Phase 2).

- [ ] **Step 3: Run linter**

```bash
cd 25/soraui_4.0/sora-ui && npx tsc --noEmit
```

Expected: No new type errors.

- [ ] **Step 4: Full visual verification**

Test these scenarios:
1. **Empty state**: Click empty box → Popover with 3 options
2. **Upload an image**: Popover closes after upload
3. **3+ images**: Hover stack → cards expand with unique rotations. Hover a card → X at top-left. Click X → card removed.
4. **+ card**: Visible at end of expanded row. Click → Popover with 3 options.
5. **Bottom + pill**: Visible in `multimodal_ref` mode. Hidden in `text2video`. Click → same Popover.
6. **Switch to first_frame mode**: Stack disappears, `jm-fl-panel` shows. Bottom + hidden.
7. **Bounce animation**: Cards fan out with slight overshoot on hover, fold back smoothly.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "refactor: cleanup unused Popover state and drag-replace handlers"
```
