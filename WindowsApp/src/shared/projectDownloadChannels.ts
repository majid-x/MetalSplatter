export const PROJECT_DOWNLOAD_CHANNELS = {
  hasCached: 'avgs:projects:has-cached',
  totalBytes: 'avgs:projects:total-bytes',
  removeCache: 'avgs:projects:remove-cache',
  removeAll: 'avgs:projects:remove-all',
  removeOrphans: 'avgs:projects:remove-orphans',
  status: 'avgs:projects:status',
  start: 'avgs:projects:start',
  stop: 'avgs:projects:stop',
  openPackage: 'avgs:projects:open-package',
  openLocal: 'avgs:projects:open-local',
  progressEvent: 'avgs:projects:progress',
  statusEvent: 'avgs:projects:status-event'
} as const

export type DownloadProgress = {
  receivedBytes: number
  totalBytes: number | null
}

export type DownloadStatus =
  | { state: 'idle' }
  | { state: 'downloading'; progress: DownloadProgress }
  | { state: 'unpacking' }
  | { state: 'failed'; message: string }

export type ProjectDownloadDescriptor = {
  id: string
  name: string
  remoteURL: string
}

export type SceneCameraPose = {
  position: [number, number, number]
  target: [number, number, number]
  fov: number
}

export type NavSummary = {
  collisionLayerCount: number
  collisionPointCount: number
  stairPolygonCount: number
  blockCount: number
  hasTopDownCut: boolean
  hasCustomOrientation: boolean
}

export type OpenedPackage = {
  projectId: string
  packagePath: string
  modelPath: string
  extractDir: string | null
  navigationPath: string | null
  collisionPath: string | null
  camera: SceneCameraPose | null
  moveSpeed: number | null
  measureScale: number | null
  navSummary: NavSummary | null
}
