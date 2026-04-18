# Settings React Mount Design

Mount the existing React `SettingsPage` into the vanilla `index.html` settings modal, following the proven Director page pattern.

## Context

- Entry point is `index.html` (vanilla JS). The old UI is active and visually correct.
- `SettingsPage.tsx` is a complete React implementation with `useSettingsStore` + `useApi()`.
- `DirectorPage` already demonstrates the mount/unmount pattern via `react-app/main.tsx`.
- The settings modal (`#settingsModal`) is managed by `SiteManager.ts` (open/close via CSS class toggle).

## Approach: Inner Replacement (Director Pattern)

Replace the settings modal's **content area and footer buttons** with a single React root. Keep the modal shell (overlay, header, close button) in vanilla HTML.

## Changes

### 1. `index.html` — Replace modal body with React root

**Before** (lines 2178-2268): ~90 lines of static form HTML (site cards container, API key inputs, how-to-get section, test/save buttons).

**After**: Replace lines 2178-2268 with:

```html
<!-- Settings content rendered by React -->
<div id="settings-react-root" class="flex-1 overflow-y-auto"></div>
```

The modal structure becomes:

```
#settingsModal (overlay, z-50000, hidden by default)
  └─ div (modal frame: border, max-w-lg, max-h-90vh, flex-col)
      ├─ div (header: title "API设置", close button #closeSettingsX)
      ├─ div#settings-react-root (React takes over)
      └─ (footer removed — React includes its own buttons)
```

### 2. `react-app/main.tsx` — Add mount/unmount functions

Add `mountSettingsReact()` and `unmountSettingsReact()` alongside the existing Director functions.

```typescript
let settingsRoot: Root | null = null

export function mountSettingsReact(): void {
  const container = document.getElementById('settings-react-root')
  if (!container) return
  if (!settingsRoot) {
    settingsRoot = createRoot(container)
  }
  settingsRoot.render(<SettingsPage />)
}

export function unmountSettingsReact(): void {
  if (settingsRoot) {
    settingsRoot.unmount()
    settingsRoot = null
  }
}
```

### 3. `SettingsPage.tsx` — Adapt for modal embedding

- Remove the `<h1>` title (modal header already has one).
- Add padding `p-6` and `overflow-y-auto` wrapper for scroll.
- On successful save, dispatch a custom event to notify vanilla side:
  ```typescript
  window.dispatchEvent(new CustomEvent('settings-saved'))
  ```
- On successful save, also sync vanilla API status:
  ```typescript
  const api = (window as any).aiImageAPI
  api?.updateApiStatus?.()
  ```

### 4. `SiteManager.ts` — Hook mount/unmount into open/close

**`openSettingsModal()`**: After `modal.classList.remove('hidden')`, call `mountSettingsReact()`. Remove all vanilla DOM manipulation (renderSiteCards, apiKeyInput value setting, updateModalI18n) since React handles this.

**`closeSettingsModal()`**: Call `unmountSettingsReact()` before `modal.classList.add('hidden')`.

Add a `settings-saved` event listener that calls `closeSettingsModal()`:

```typescript
window.addEventListener('settings-saved', () => this.closeSettingsModal())
```

### 5. `ServiceBridge.ts` — Import new mount functions

Add import:
```typescript
import { mountSettingsReact, unmountSettingsReact } from '../react-app/main'
```

The import is needed because `SiteManager.ts` calls `mountSettingsReact()` / `unmountSettingsReact()` directly. If `SiteManager` doesn't already import from `react-app/main.tsx`, add the import there. If the import chain goes through `ServiceBridge.ts`, add it there and pass references to `SiteManager` via its constructor config.

### 6. Dead code cleanup

After React takes over, the following vanilla code in `SiteManager.ts` becomes dead:
- `renderSiteCards()` — React `SiteGrid` replaces this
- `saveApiKeyPublic()` — React `handleSave` replaces this
- `setupEventListeners()` bindings for `#testConnection`, `#saveApiConfig`, `#toggleApiKeyVisibility`, `#toggleHowToGet`

Do NOT delete these yet. Mark with `// @deprecated: replaced by React SettingsPage` for future cleanup.

## What stays unchanged

- Modal overlay and header HTML in `index.html`
- `#closeSettingsX` button and its vanilla event binding
- `EventManager` open/close-settings click handlers
- `DialogManager.openSettings()` / `closeSettings()` (they delegate to SiteManager)
- All other pages, tabs, and vanilla JS functionality
- Custom site modal (`#customSiteModal`) — remains vanilla for now

## Success criteria

1. Click "设置" button → modal opens with React SettingsPage rendered inside
2. Site selection, API key input, test connection, save all work through React
3. Save success → modal closes, vanilla header API status updates
4. Close button (X) → React unmounts cleanly, no memory leaks
5. Re-open modal → fresh React mount, state loads from service
6. No console errors related to missing DOM elements (`#apiKeyInput`, `#siteCardsContainer`, etc.)
7. Visual appearance matches the original modal (same colors, spacing, cyberpunk theme)

## Rollback

If React mounting causes issues, revert `index.html` to restore the static HTML content and remove the `mountSettingsReact()` calls from `SiteManager.ts`. The vanilla `SiteManager` code is preserved (deprecated, not deleted).

## Future work

- Mount remaining pages (Generate, Batch, Compare, History, Understand, Templates) into their respective `#xxxPanel` containers using the same pattern.
- Once all pages are React, remove the deprecated vanilla code.
- Migrate `#customSiteModal` to React.
