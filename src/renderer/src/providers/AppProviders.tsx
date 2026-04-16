import type { ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'

interface AppProvidersProps {
  children: ReactNode
}

export function AppProviders({ children }: AppProvidersProps) {
  return <ErrorBoundary>{children}</ErrorBoundary>
}
