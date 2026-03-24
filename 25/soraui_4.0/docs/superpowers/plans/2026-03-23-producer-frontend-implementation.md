# Producer 前端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在前端新增制作人（Producer）功能入口，用户可通过邀请码加入制作人、切换制作人上下文、查看余额和项目标签，与旧 PROJECT 体系共存。

**Architecture:** 新增独立 `producerStore`（Zustand），不修改 `orgStore`。在导航栏 `ProjectSwitcher` 旁新增 `ProducerSwitcher`。新增 Producer API 函数。所有改动为纯加法。

**Tech Stack:** React 18 / Zustand / Ant Design + Tailwind CSS / axios / React Router

**Spec:** `docs/superpowers/specs/2026-03-23-producer-org-restructure-design.md`

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `src/api/backend-api.ts` | 新增 4 个 Producer API 函数 + 类型定义 |
| 新建 | `src/stores/producerStore.ts` | 制作人状态管理（独立于 orgStore） |
| 修改 | `src/components/miau-home/MiauNavBarFunctional.tsx` | 在 ProjectSwitcher 旁渲染 ProducerSwitcher |
| 新建 | `src/components/miau-home/ProducerSwitcher.tsx` | 制作人切换器 + 邀请码加入 + 余额显示 |

---

## Task 1: backend-api.ts 新增 Producer API 函数

**Files:**
- Modify: `sora-ui/src/api/backend-api.ts`

- [ ] **Step 1: 新增类型定义**

在 `UserBalance` interface 附近（约第 1270 行后），追加：

```typescript
export interface ProducerInfo {
  producer_id: number;
  producer_name: string;
  producer_type: string;
  studio_id: number;
  studio_name: string;
  balance_yuan: number;
  role: string;
}

export interface ProducerProjectTag {
  id: number;
  name: string;
  producer_id: number;
}

export interface ProducerListResponse {
  producers: ProducerInfo[] | null;
  project_tags: ProducerProjectTag[] | null;
}
```

- [ ] **Step 2: 新增 4 个 API 函数**

在 `joinProject` 函数（约第 1364 行）后追加：

```typescript
export const getUserProducers = async (token: string): Promise<ProducerListResponse> => {
  try {
    const response = await axios.get<BackendResponse>(
      `${BACKEND_BASE_URL}/api/user/producers`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!response.data.success) {
      throw new Error(response.data.message || '获取制作人列表失败');
    }
    return response.data.data ?? { producers: null, project_tags: null };
  } catch (error: any) {
    console.warn('[BackendAPI] 获取制作人列表失败:', error.message);
    return { producers: null, project_tags: null };
  }
};

export const getProducerBalance = async (token: string, producerId: number): Promise<UserBalance | null> => {
  try {
    const response = await axios.get<BackendResponse>(
      `${BACKEND_BASE_URL}/api/user/producer-balance`,
      { headers: { 'Authorization': `Bearer ${token}` }, params: { producerId } }
    );
    if (!response.data.success) {
      throw new Error(response.data.message || '获取制作人余额失败');
    }
    return response.data.data ?? null;
  } catch (error: any) {
    console.warn('[BackendAPI] 获取制作人余额失败:', error.message);
    return null;
  }
};

export const joinProducer = async (token: string, producerId: number): Promise<{ message: string }> => {
  try {
    const response = await axios.post<BackendResponse>(
      `${BACKEND_BASE_URL}/api/user/join-producer`,
      { producerId },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.success) {
      throw new Error(response.data.message || '加入制作人失败');
    }
    return { message: response.data.message || '加入成功' };
  } catch (error: any) {
    throw new Error(error.response?.data?.message || error.message || '加入制作人失败');
  }
};

export const joinProducerProject = async (token: string, producerProjectId: number): Promise<{ message: string }> => {
  try {
    const response = await axios.post<BackendResponse>(
      `${BACKEND_BASE_URL}/api/user/join-producer-project`,
      { producerProjectId },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!response.data.success) {
      throw new Error(response.data.message || '加入项目标签失败');
    }
    return { message: response.data.message || '加入成功' };
  } catch (error: any) {
    throw new Error(error.response?.data?.message || error.message || '加入项目标签失败');
  }
};
```

- [ ] **Step 3: Commit**

```bash
git add src/api/backend-api.ts
git commit -m "feat(api): add producer API functions"
```

---

## Task 2: 新建 producerStore.ts

**Files:**
- Create: `sora-ui/src/stores/producerStore.ts`

- [ ] **Step 1: 创建 store 文件**

```typescript
import { create } from 'zustand';
import { getUserProducers, getProducerBalance } from '@/api/backend-api';
import type { ProducerInfo, ProducerProjectTag, UserBalance } from '@/api/backend-api';
import { useAuthStore } from './authStore';

const STORAGE_KEY = 'miau_current_producer_id';

function loadPersistedProducerId(): number | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function persistProducerId(id: number | null) {
  try {
    if (id !== null) localStorage.setItem(STORAGE_KEY, String(id));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
}

interface ProducerState {
  producers: ProducerInfo[];
  projectTags: ProducerProjectTag[];
  currentProducerId: number | null;
  balance: UserBalance | null;
  loading: boolean;

  loadProducers: () => Promise<void>;
  setCurrentProducer: (producerId: number) => void;
  loadBalance: () => Promise<void>;
  reset: () => void;
}

export const useProducerStore = create<ProducerState>()((set, get) => ({
  producers: [],
  projectTags: [],
  currentProducerId: loadPersistedProducerId(),
  balance: null,
  loading: false,

  loadProducers: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    set({ loading: true });
    try {
      const data = await getUserProducers(token);
      const producers = data.producers ?? [];
      const projectTags = data.project_tags ?? [];
      const updates: Partial<ProducerState> = { producers, projectTags, loading: false };

      const persisted = get().currentProducerId;
      const valid = persisted !== null && producers.some(p => p.producer_id === persisted);
      if (!valid) {
        updates.currentProducerId = null;
        persistProducerId(null);
      }

      set(updates);

      if (get().currentProducerId != null) {
        get().loadBalance();
      }
    } catch {
      set({ loading: false });
    }
  },

  setCurrentProducer: (producerId: number) => {
    persistProducerId(producerId);
    set({ currentProducerId: producerId, balance: null });
    get().loadBalance();
  },

  loadBalance: async () => {
    const token = useAuthStore.getState().token;
    const producerId = get().currentProducerId;
    if (!token || producerId === null) return;

    try {
      const balance = await getProducerBalance(token, producerId);
      if (!balance) return;
      set({ balance });
    } catch { /* silently ignore */ }
  },

  reset: () => {
    persistProducerId(null);
    set({ producers: [], projectTags: [], currentProducerId: null, balance: null, loading: false });
  },
}));

export default useProducerStore;
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/producerStore.ts
git commit -m "feat(store): add producerStore for producer state management"
```

---

## Task 3: 新建 ProducerSwitcher 组件

**Files:**
- Create: `sora-ui/src/components/miau-home/ProducerSwitcher.tsx`

- [ ] **Step 1: 创建组件**

复用 `ProjectSwitcher` 的 UI 模式（下拉菜单 + 邀请码输入），但数据来源为 `producerStore`：

```tsx
import React from 'react';
import { createPortal } from 'react-dom';
import { useProducerStore } from '@/stores/producerStore';
import { useAuth } from '@/hooks/useAuth';
import { joinStudio } from '@/api/backend-api';

export function ProducerSwitcher({ light = false }: { light?: boolean } = {}) {
  const { producers, currentProducerId, loading, setCurrentProducer, loadProducers, balance } = useProducerStore();
  const { isAuthenticated, token } = useAuth();
  const [open, setOpen] = React.useState(false);
  const [inviteCode, setInviteCode] = React.useState('');
  const [inviteLoading, setInviteLoading] = React.useState(false);
  const [inviteMsg, setInviteMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = React.useState<{ top: number; right: number } | null>(null);

  const colors = light ? {
    btnText: 'rgba(0,0,0,0.88)', btnBorder: '#d9d9d9', btnBg: '#ffffff', btnHover: '#f5f5f5',
    balanceColor: '#52c41a', balanceBg: 'transparent', balanceHover: 'rgba(82,196,26,0.06)',
    ddBg: '#ffffff', ddBorder: '#e8e8e8', ddShadow: '0 6px 16px rgba(0,0,0,0.08)',
    itemActive: '#e6f4ff', itemText: 'rgba(0,0,0,0.88)', itemTextSub: 'rgba(0,0,0,0.65)',
    itemHover: '#f5f5f5', accent: '#7c3aed',
  } : {
    btnText: 'rgba(255,255,255,0.85)', btnBorder: 'rgba(255,255,255,0.12)', btnBg: 'rgba(255,255,255,0.06)', btnHover: 'rgba(255,255,255,0.10)',
    balanceColor: '#b6fa0c', balanceBg: 'rgba(182,250,12,0.08)', balanceHover: 'rgba(182,250,12,0.16)',
    ddBg: '#1a1a1a', ddBorder: 'rgba(255,255,255,0.08)', ddShadow: '0 12px 36px rgba(0,0,0,0.6)',
    itemActive: 'rgba(255,255,255,0.08)', itemText: '#fff', itemTextSub: 'rgba(255,255,255,0.7)',
    itemHover: 'rgba(255,255,255,0.05)', accent: '#a78bfa',
  };

  React.useEffect(() => {
    if (isAuthenticated) loadProducers();
  }, [isAuthenticated, loadProducers]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  React.useEffect(() => {
    if (open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
  }, [open]);

  const handleInviteSubmit = async () => {
    const code = inviteCode.trim();
    if (!code || !token || inviteLoading) return;
    setInviteLoading(true);
    setInviteMsg(null);
    try {
      await joinStudio(token, code);
      setInviteMsg({ type: 'ok', text: '加入成功' });
      setInviteCode('');
      await loadProducers();
    } catch (err: any) {
      setInviteMsg({ type: 'err', text: err.message || '加入失败' });
    } finally {
      setInviteLoading(false);
    }
  };

  if (!isAuthenticated || producers.length === 0) return null;

  const current = currentProducerId !== null
    ? (producers.find(p => p.producer_id === currentProducerId) ?? null)
    : null;

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 h-8 px-3 text-[13px] font-medium cursor-pointer transition-all duration-200 ${light ? 'rounded-md' : 'rounded-lg'}`}
        style={{
          color: colors.btnText,
          border: `1px solid ${colors.btnBorder}`,
          background: colors.btnBg,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = colors.btnHover; }}
        onMouseLeave={e => { e.currentTarget.style.background = colors.btnBg; }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        {loading ? '...' : current?.producer_name ?? '制作人'}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6" /></svg>
      </button>

      {current && balance?.balance_yuan != null && (
        <span
          className="text-[13px] font-semibold px-2.5 py-1 rounded-md whitespace-nowrap"
          style={{ color: colors.balanceColor, background: colors.balanceBg }}
        >
          ¥{(balance.balance_yuan ?? 0).toFixed(2)}
        </span>
      )}

      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: 'fixed', top: dropdownPos.top, right: dropdownPos.right,
            zIndex: 10005, minWidth: 280, borderRadius: light ? 8 : 12,
            overflow: 'hidden', padding: '6px 0',
            background: colors.ddBg, border: `1px solid ${colors.ddBorder}`,
            boxShadow: colors.ddShadow,
          }}
        >
          <div style={{ padding: '6px 12px 4px', fontSize: 11, fontWeight: 600, color: colors.itemTextSub, letterSpacing: 0.5 }}>
            制作人
          </div>
          {producers.map(p => (
            <button
              key={p.producer_id}
              type="button"
              onClick={() => { setCurrentProducer(p.producer_id); setOpen(false); }}
              className="flex items-center gap-2.5 w-full px-4 py-2.5 text-[13px] transition-colors duration-150 border-none cursor-pointer text-left"
              style={{
                background: p.producer_id === currentProducerId ? colors.itemActive : 'transparent',
                color: p.producer_id === currentProducerId ? colors.itemText : colors.itemTextSub,
                fontWeight: p.producer_id === currentProducerId ? 600 : 400,
                fontFamily: 'inherit',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = colors.itemHover; }}
              onMouseLeave={e => { e.currentTarget.style.background = p.producer_id === currentProducerId ? colors.itemActive : 'transparent'; }}
            >
              <span className="flex-1">{p.producer_name}</span>
              {p.producer_type && (
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(124,58,237,0.15)', color: colors.accent }}>
                  {p.producer_type === 'INTERNAL' ? '内部' : '外包'}
                </span>
              )}
              {p.studio_name && (
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(139,92,246,0.12)', color: colors.accent, opacity: 0.7 }}>
                  {p.studio_name}
                </span>
              )}
            </button>
          ))}

          <div style={{ borderTop: `1px solid ${colors.ddBorder}`, margin: '4px 0', padding: '8px 12px 6px' }}>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inviteCode}
                onChange={e => setInviteCode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleInviteSubmit()}
                placeholder="输入制作人邀请码"
                className="flex-1 h-7 px-2.5 rounded text-[12px] border-none outline-none"
                style={{ background: colors.itemHover, color: colors.itemText }}
              />
              <button
                type="button"
                onClick={handleInviteSubmit}
                disabled={inviteLoading}
                className="h-7 px-3 rounded text-[12px] font-medium border-none cursor-pointer"
                style={{ background: colors.accent, color: '#fff' }}
              >
                {inviteLoading ? '...' : '加入'}
              </button>
            </div>
            {inviteMsg && (
              <div className="text-[11px] mt-1" style={{ color: inviteMsg.type === 'ok' ? '#52c41a' : '#ff4d4f' }}>
                {inviteMsg.text}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/miau-home/ProducerSwitcher.tsx
git commit -m "feat(ui): add ProducerSwitcher component"
```

---

## Task 4: 在导航栏中渲染 ProducerSwitcher

**Files:**
- Modify: `sora-ui/src/components/miau-home/MiauNavBarFunctional.tsx`

- [ ] **Step 1: 添加 import**

在文件顶部的 import 区域追加：

```typescript
import { ProducerSwitcher } from './ProducerSwitcher';
```

- [ ] **Step 2: 在 ProjectSwitcher 后渲染 ProducerSwitcher**

找到渲染 `<ProjectSwitcher />` 的位置（约第 547 行），在其后追加：

```tsx
<ProducerSwitcher />
```

使最终效果为：
```tsx
<ProjectSwitcher />
<ProducerSwitcher />
```

- [ ] **Step 3: Commit**

```bash
git add src/components/miau-home/MiauNavBarFunctional.tsx
git commit -m "feat(nav): render ProducerSwitcher in navigation bar"
```

---

## 实施顺序

```
Task 1 → API 函数（backend-api.ts）
Task 2 → Store（producerStore.ts）
Task 3 → UI 组件（ProducerSwitcher.tsx）
Task 4 → 导航栏集成（MiauNavBarFunctional.tsx）
```

每个 Task 完成后立即 commit。

## 延迟实施项（后续迭代）

| 功能 | 说明 |
|------|------|
| 制作人管理页面 | 成员列表、项目标签 CRUD、余额分配 — 需要 admin 权限逻辑 |
| 统计仪表板 | 公司→制作人→项目→个人层级钻取 — 依赖统计 API |
| ProducerProject 标签切换 | 在选中制作人后展示并切换项目标签 — 依赖 `X-Producer-Project-Id` header 注入 |
