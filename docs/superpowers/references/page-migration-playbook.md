# Page Migration Playbook

> Patterns extracted from SettingsPage migration (2026-04-18). Use this as a template for migrating remaining React pages to full feature parity.

## 1. Store Creation Template

Each page gets its own Zustand store in `src/renderer/src/stores/use<Page>Store.ts`.

**Interface pattern:**

```typescript
import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'

interface <Page>State {
  // UI state fields
  loading: boolean

  // Actions — receive api as parameter for testability
  loadFromService: (api: ApiActions) => Promise<void>
  // ... page-specific actions
}

export const use<Page>Store = create<<Page>State>((set, get) => ({
  // ... state + actions
}))
```

**Key rules:**
- Actions receive `ApiActions` as a parameter — never call React hooks inside actions
- Use atomic selectors in components: `const field = useStore(s => s.field)`
- Async actions must handle loading/error states explicitly
- No `persist` middleware unless the page has data not already in Electron Store

## 2. Service Hook Usage

- Use `useApi()` as the single entry point for all API calls
- Import from `../hooks/useService`
- Never use `(window as any).aiImageAPI` — this is a hard rule
- For non-API services (storage, i18n), use the existing typed hooks

## 3. Component Split Standards

- Page file ≤ 200 lines
- Extract sub-components into `pages-react/<page-name>/` directory
- Sub-components receive data via props, not direct store access
- Shared UI components go in `components/`

## 4. Testing Three-Piece Set

Every migrated page needs:

1. **Store unit test** (`stores/__tests__/use<Page>Store.test.ts`)
   - Mock `ApiActions` interface
   - Test all actions including error paths
   - Use `store.getState()` and `store.setState()` for setup/assertion

2. **Component test** (`pages-react/__tests__/<Page>Page.test.tsx`)
   - Use `@testing-library/react` + `@testing-library/user-event`
   - Test rendering, interactions, disabled states

3. **Integration test** (within component test file)
   - Full user flow: action → store update → UI update

## 5. Completion Checklist

Before declaring a page migration complete:

- [ ] Zero `(window as any)` usage in page and sub-components
- [ ] Page store created with full TypeScript interfaces
- [ ] All store actions have unit tests
- [ ] Component renders with test data
- [ ] Feature parity table verified against old code
- [ ] TypeScript compiles with no errors
- [ ] Old code NOT deleted (rollback safety)
