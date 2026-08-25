import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIPrefsState {
  imageEditorToolbar: { enabled: boolean }
  setImageEditorToolbar: (enabled: boolean) => void
  /**
   * 用户在登录覆盖层点过「稍后再说」。
   *
   * 登录是**软门**:这个应用本来就靠用户自填 API Key 在跑,账号额度只是另一条付费
   * 通道。所以覆盖层只在首次启动提示一次,跳过后不再拦人 —— 之后从设置页的账号分区
   * 随时可以登录。必须持久化,否则每次启动都要重新被拦一遍。
   */
  authOnboardingDismissed: boolean
  dismissAuthOnboarding: () => void
}

export const useUIPrefsStore = create<UIPrefsState>()(
  persist(
    (set) => ({
      imageEditorToolbar: { enabled: true },
      setImageEditorToolbar: (enabled) =>
        set({ imageEditorToolbar: { enabled } }),
      authOnboardingDismissed: false,
      dismissAuthOnboarding: () => set({ authOnboardingDismissed: true }),
    }),
    {
      name: 'ui-prefs',
      // 不动 version:加字段时持久化的旧状态会与默认值合并,而 version 递增在没有
      // migrate 的情况下会把用户已有的偏好整个丢掉。
      partialize: (state) => ({
        imageEditorToolbar: state.imageEditorToolbar,
        authOnboardingDismissed: state.authOnboardingDismissed,
      }),
      version: 1,
    },
  ),
)
