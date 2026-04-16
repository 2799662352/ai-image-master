import { AppProviders } from './providers/AppProviders'
import { AppLayout } from './layouts/AppLayout'

export default function App() {
  return (
    <AppProviders>
      <AppLayout />
    </AppProviders>
  )
}
