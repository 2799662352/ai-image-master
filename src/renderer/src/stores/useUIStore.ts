import { create } from 'zustand'

interface UIState {
  sidebarOpen: boolean
  mobileMenuOpen: boolean
  theme: 'dark' | 'light'
  toggleSidebar: () => void
  toggleMobileMenu: () => void
  setTheme: (theme: 'dark' | 'light') => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  mobileMenuOpen: false,
  theme: 'dark',
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleMobileMenu: () => set((s) => ({ mobileMenuOpen: !s.mobileMenuOpen })),
  setTheme: (theme) => set({ theme }),
}))
