import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type {
  DownloadStatus,
  OpenedPackage,
  ProjectDownloadDescriptor
} from '../../../shared/projectDownloadChannels'

type DownloadContextValue = {
  statuses: Record<string, DownloadStatus>
  cacheRevision: number
  totalBytes: number
  refreshTotals: () => Promise<void>
  statusFor: (projectId: string) => DownloadStatus
  isCached: (projectId: string, remoteURL: string) => Promise<boolean>
  startDownload: (project: ProjectDownloadDescriptor) => Promise<void>
  stopDownload: (projectId: string) => Promise<void>
  removeCache: (projectId: string) => Promise<void>
  removeOrphans: (keepIds: string[]) => Promise<void>
  removeAll: () => Promise<void>
  openPackage: (
    project: ProjectDownloadDescriptor,
    forceRedownload?: boolean
  ) => Promise<OpenedPackage>
  openLocal: (filePath: string) => Promise<OpenedPackage>
  bumpCacheRevision: () => void
}

const DownloadContext = createContext<DownloadContextValue | null>(null)

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<Record<string, DownloadStatus>>({})
  const [cacheRevision, setCacheRevision] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)

  const bumpCacheRevision = useCallback(() => {
    setCacheRevision((value) => value + 1)
  }, [])

  const refreshTotals = useCallback(async () => {
    setTotalBytes(await window.avgs.projects.totalBytes())
  }, [])

  useEffect(() => {
    void window.avgs.projects.statuses().then(setStatuses)
    void refreshTotals()

    const offProgress = window.avgs.projects.onProgress(({ projectId, progress }) => {
      setStatuses((prev) => ({
        ...prev,
        [projectId]: { state: 'downloading', progress }
      }))
    })

    const offStatus = window.avgs.projects.onStatus(({ projectId, status }) => {
      setStatuses((prev) => {
        const next = { ...prev }
        if (status.state === 'idle') delete next[projectId]
        else next[projectId] = status
        return next
      })
      if (status.state === 'idle' || status.state === 'failed') {
        void refreshTotals()
        setCacheRevision((value) => value + 1)
      }
    })

    return () => {
      offProgress()
      offStatus()
    }
  }, [refreshTotals])

  const value = useMemo<DownloadContextValue>(
    () => ({
      statuses,
      cacheRevision,
      totalBytes,
      refreshTotals,
      bumpCacheRevision,
      statusFor: (projectId) =>
        statuses[projectId.toLowerCase()] ?? statuses[projectId] ?? { state: 'idle' },
      isCached: (projectId, remoteURL) =>
        window.avgs.projects.hasCached(projectId, remoteURL),
      startDownload: (project) => window.avgs.projects.start(project),
      stopDownload: async (projectId) => {
        await window.avgs.projects.stop(projectId)
        bumpCacheRevision()
        await refreshTotals()
      },
      removeCache: async (projectId) => {
        await window.avgs.projects.removeCache(projectId)
        bumpCacheRevision()
        await refreshTotals()
      },
      removeOrphans: async (keepIds) => {
        await window.avgs.projects.removeOrphans(keepIds)
        bumpCacheRevision()
        await refreshTotals()
      },
      removeAll: async () => {
        await window.avgs.projects.removeAll()
        bumpCacheRevision()
        await refreshTotals()
      },
      openPackage: (project, forceRedownload) =>
        window.avgs.projects.openPackage(project, forceRedownload),
      openLocal: (filePath) => window.avgs.projects.openLocal(filePath)
    }),
    [statuses, cacheRevision, totalBytes, refreshTotals, bumpCacheRevision]
  )

  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>
}

export function useDownloads(): DownloadContextValue {
  const value = useContext(DownloadContext)
  if (!value) throw new Error('useDownloads must be used within DownloadProvider')
  return value
}
