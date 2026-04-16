import type { ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ToastContainer } from '../components/Toast'
import { DialogModal } from '../components/Dialog'

interface AppProvidersProps {
  children: ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  return (
    <ErrorBoundary>
      {children}
      <ToastContainer />
      <DialogModal />
    </ErrorBoundary>
  )
}
