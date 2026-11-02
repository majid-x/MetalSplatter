import { AuthProvider, useAuth } from './auth/AuthContext'
import { AuthView } from './auth/AuthView'
import { DashboardView } from './dashboard/DashboardView'
import { DownloadProvider } from './projects/DownloadContext'

function RootGate() {
  const auth = useAuth()

  if (auth.isBootstrapping) {
    return (
      <main className="boot-shell">
        <span className="spinner large" />
      </main>
    )
  }

  if (auth.isAuthenticated) {
    return (
      <DownloadProvider>
        <DashboardView />
      </DownloadProvider>
    )
  }

  return <AuthView />
}

export default function App() {
  return (
    <AuthProvider>
      <RootGate />
    </AuthProvider>
  )
}
