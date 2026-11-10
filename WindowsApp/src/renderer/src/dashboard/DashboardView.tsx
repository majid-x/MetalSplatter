import { useEffect, useMemo, useState } from 'react'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import { useAuth } from '../auth/AuthContext'
import { BrandMark } from '../components/BrandMark'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { formatBytes } from '../lib/formatBytes'
import { useDownloads } from '../projects/DownloadContext'
import { useProjectLibrary } from '../projects/useProjectLibrary'
import type { RemoteProject } from '../projects/types'
import { BookingPane } from './BookingPane'
import { ProjectsPane } from './ProjectsPane'
import { ProjectViewerView } from './ProjectViewerView'
import { SettingsPane } from './SettingsPane'

type DashboardTab = 'projects' | 'booking' | 'settings'

const TABS: { id: DashboardTab; label: string; icon: string }[] = [
  { id: 'projects', label: 'Projects', icon: '◎' },
  { id: 'booking', label: 'Booking', icon: '﹢' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export function DashboardView() {
  const auth = useAuth()
  const downloads = useDownloads()
  const library = useProjectLibrary(auth.userId)
  const [selectedTab, setSelectedTab] = useState<DashboardTab>('projects')
  const [searchText, setSearchText] = useState('')
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [openedProject, setOpenedProject] = useState<RemoteProject | null>(null)
  const [openedPackage, setOpenedPackage] = useState<OpenedPackage | null>(null)
  const [openingLocal, setOpeningLocal] = useState(false)
  const [localOpenError, setLocalOpenError] = useState<string | null>(null)

  const firstName = useMemo(() => {
    const parts = auth.displayName.trim().split(/\s+/)
    return parts[0] || auth.displayName
  }, [auth.displayName])

  useEffect(() => {
    void downloads.refreshTotals()
    // Refresh storage chip when the library set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.projects])

  async function openLocalFile(filePath: string, fileName: string): Promise<void> {
    setLocalOpenError(null)
    setOpeningLocal(true)
    try {
      const opened = await downloads.openLocal(filePath)
      const project: RemoteProject = {
        id: opened.projectId,
        userId: auth.userId ?? 'local',
        name: fileName,
        remoteURL: filePath,
        photoAPIBaseURL: null,
        isSPZ: fileName.toLowerCase().endsWith('.spz'),
        useServerCalibration: false,
        measureFactor: 1,
        hasMeasureFactor: false,
        moveSpeed: null,
        createdAt: null
      }
      setOpenedPackage(opened)
      setOpenedProject(project)
    } catch (error) {
      setLocalOpenError(error instanceof Error ? error.message : "Couldn't open that file.")
    } finally {
      setOpeningLocal(false)
    }
  }

  if (openedProject) {
    return (
      <ProjectViewerView
        project={openedProject}
        initialPackage={openedPackage}
        onBack={() => {
          setOpenedProject(null)
          setOpenedPackage(null)
          downloads.bumpCacheRevision()
          void downloads.refreshTotals()
        }}
      />
    )
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark size={28} />
          <span>Vroomk</span>
        </div>

        <nav className="sidebar-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`sidebar-item ${selectedTab === tab.id ? 'active' : ''}`}
              onClick={() => setSelectedTab(tab.id)}
            >
              <span className="sidebar-icon" aria-hidden>
                {tab.icon}
              </span>
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-user">
          <div className="avatar" aria-hidden>
            👤
          </div>
          <div>
            <div className="sidebar-user-name">{firstName}</div>
            <button
              type="button"
              className="text-button"
              onClick={() => setSelectedTab('settings')}
            >
              View Profile
            </button>
          </div>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-toolbar">
          <div className="toolbar-spacer" />
          <span className="storage-chip" title="Local storage used by downloaded projects">
            {formatBytes(downloads.totalBytes)}
          </span>
          <button
            type="button"
            className="pill-button compact"
            onClick={() => setSelectedTab('booking')}
          >
            Book a scan
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Search projects"
            onClick={() => setIsSearchOpen(true)}
          >
            ⌕
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh projects"
            disabled={library.isLoading}
            onClick={() => void library.refresh()}
          >
            ↻
          </button>
          <div className="account-menu">
            <button type="button" className="icon-button" aria-label="Account menu">
              ◯
            </button>
            <div className="account-menu-panel">
              <button type="button" onClick={() => setSelectedTab('booking')}>
                Book a scan
              </button>
              <button type="button" onClick={() => setSelectedTab('settings')}>
                Settings
              </button>
              <button type="button" className="danger" onClick={() => void auth.signOut()}>
                Sign Out
              </button>
            </div>
          </div>
        </header>

        {selectedTab === 'projects' && (
          <ProjectsPane
            projects={library.projects}
            isLoading={library.isLoading || openingLocal}
            errorMessage={localOpenError ?? library.errorMessage}
            searchText={searchText}
            onRetry={() => {
              setLocalOpenError(null)
              void library.refresh()
            }}
            onOpenProject={(project) => {
              setOpenedPackage(null)
              setOpenedProject(project)
            }}
            onOpenLocalFile={(path, name) => void openLocalFile(path, name)}
          />
        )}
        {selectedTab === 'booking' && (
          <ErrorBoundary label="Booking" key="booking">
            <BookingPane />
          </ErrorBoundary>
        )}
        {selectedTab === 'settings' && <SettingsPane />}
      </div>

      <nav className="compact-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={selectedTab === tab.id ? 'active' : ''}
            onClick={() => setSelectedTab(tab.id)}
          >
            <span aria-hidden>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </nav>

      {isSearchOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setIsSearchOpen(false)}>
          <div
            className="modal-card slim"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2>Search projects</h2>
              <button type="button" className="text-button" onClick={() => setIsSearchOpen(false)}>
                Done
              </button>
            </header>
            <div className="modal-body">
              <label className="field">
                <span>Search</span>
                <input
                  autoFocus
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Project name"
                />
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
