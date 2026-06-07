/**
 * 导演台「可重映射快捷键」的单一事实来源。
 *
 * - 动作(action)与按键(token)解耦:UI 改键只改 token,场景按 token 匹配动作。
 * - token 形如 'w' / 'f' / 'ctrl+d' / 'ctrl+shift+z' / 'Delete';修饰键统一小写,
 *   命名键(Delete/Escape…)保留原样,字母键转小写。Mac 的 ⌘ 归一到 'ctrl'。
 * - DirectorEditor 用 usePersistentState 持久化用户改键,传给 DirectorStageScene。
 */

/** 可重映射的动作 id(鼠标/吸附/Esc 等固定交互不在此列,仅做说明展示). */
export type ShortcutAction =
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'focus'
  | 'toggleSpace'
  | 'boxSelect'
  | 'delete'
  | 'duplicate'
  | 'undo'
  | 'redo';

export interface ShortcutDef {
  action: ShortcutAction;
  /** 面板上的中文说明. */
  label: string;
  /** 默认按键 token. */
  defaultKey: string;
}

/** 动作定义 + 默认键(也决定面板展示顺序). */
export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { action: 'translate', label: '移动 (Translate)', defaultKey: 'w' },
  { action: 'rotate', label: '旋转 (Rotate)', defaultKey: 'e' },
  { action: 'scale', label: '缩放 (Scale)', defaultKey: 'r' },
  { action: 'focus', label: '聚焦选中', defaultKey: 'f' },
  { action: 'toggleSpace', label: '世界 / 本地坐标系', defaultKey: 'q' },
  { action: 'boxSelect', label: '框选工具开关', defaultKey: 'b' },
  { action: 'delete', label: '删除选中', defaultKey: 'Delete' },
  { action: 'duplicate', label: '复制选中', defaultKey: 'ctrl+d' },
  { action: 'undo', label: '撤销', defaultKey: 'ctrl+z' },
  { action: 'redo', label: '重做', defaultKey: 'ctrl+shift+z' },
];

export type Keymap = Record<ShortcutAction, string>;

export const DEFAULT_KEYMAP: Keymap = SHORTCUT_DEFS.reduce((m, d) => {
  m[d.action] = d.defaultKey;
  return m;
}, {} as Keymap);

/** 合并持久化值与默认值,补齐缺失动作(改版新增动作时不至于无绑定). */
export function normalizeKeymap(stored: Partial<Keymap> | null | undefined): Keymap {
  return { ...DEFAULT_KEYMAP, ...(stored ?? {}) };
}

/**
 * 把一次 keydown 事件编码成 token;若按下的是纯修饰键(Ctrl/Shift/Alt/Meta)
 * 返回 null(等待真正的主键)。
 */
export function eventToToken(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(k.length === 1 ? k.toLowerCase() : k);
  return parts.join('+');
}

/** 反查:token → 动作(用户绑定优先;无匹配返回 null). */
export function tokenToAction(keymap: Keymap, token: string): ShortcutAction | null {
  for (const a of Object.keys(keymap) as ShortcutAction[]) {
    if (keymap[a] && keymap[a] === token) return a;
  }
  return null;
}

/** token → 适合展示的人类可读文本('ctrl+shift+z' → 'Ctrl + Shift + Z'). */
export function tokenLabel(token: string): string {
  if (!token) return '未设置';
  return token
    .split('+')
    .map((p) => {
      switch (p) {
        case 'ctrl':
          return 'Ctrl';
        case 'shift':
          return 'Shift';
        case 'alt':
          return 'Alt';
        case ' ':
          return 'Space';
        case 'ArrowUp':
          return '↑';
        case 'ArrowDown':
          return '↓';
        case 'ArrowLeft':
          return '←';
        case 'ArrowRight':
          return '→';
        default:
          return p.length === 1 ? p.toUpperCase() : p;
      }
    })
    .join(' + ');
}
