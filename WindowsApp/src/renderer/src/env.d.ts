/// <reference types="vite/client" />

declare module '*.png' {
  const src: string
  export default src
}

declare module 'leaflet/dist/images/*.png' {
  const src: string
  export default src
}

import type {
  DownloadProgress,
  DownloadStatus,
  OpenedPackage,
  ProjectDownloadDescriptor
} from '../../shared/projectDownloadChannels'
import type {
  BookingHttpRequest,
  BookingHttpResponse
} from '../../shared/bookingChannels'
import type { CaptureRegionRequest } from '../../shared/captureChannels'
import type {
  DamageAnalyzeRequest,
  DamageAnalyzeResponse,
  DamageProgressEvent,
  SavedDamageReport,
  SavedDamageReportInput,
  SavedDamageReportSummary
} from '../../shared/damageChannels'
import type { HttpProxyRequest, HttpProxyResponse } from '../../shared/httpProxyChannels'
import type { PaymentSessionRequest } from '../../shared/paymentChannels'
import type { ViewerLaunchOptions } from '../../shared/viewerChannels'

export interface AvgsAuthStorage {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
  remove: (key: string) => Promise<void>
}

export interface AvgsProjectsBridge {
  hasCached: (projectId: string, remoteURL: string) => Promise<boolean>
  totalBytes: () => Promise<number>
  removeCache: (projectId: string) => Promise<void>
  removeAll: () => Promise<void>
  removeOrphans: (keepIds: string[]) => Promise<number>
  statuses: () => Promise<Record<string, DownloadStatus>>
  start: (project: ProjectDownloadDescriptor) => Promise<void>
  stop: (projectId: string) => Promise<void>
  openPackage: (
    project: ProjectDownloadDescriptor,
    forceRedownload?: boolean
  ) => Promise<OpenedPackage>
  openLocal: (filePath: string) => Promise<OpenedPackage>
  onProgress: (
    listener: (payload: { projectId: string; progress: DownloadProgress }) => void
  ) => () => void
  onStatus: (
    listener: (payload: { projectId: string; status: DownloadStatus }) => void
  ) => () => void
}

export interface AvgsFilesBridge {
  pathFor: (file: File) => string
}

export interface AvgsViewerBridge {
  getOrigin: () => Promise<string>
  buildUrl: (options: ViewerLaunchOptions | string) => Promise<string>
}

export interface AvgsPaymentsBridge {
  createSession: (payload: PaymentSessionRequest) => Promise<string>
}

export interface AvgsCaptureBridge {
  region: (region: CaptureRegionRequest) => Promise<string>
  save: (dataUrl: string) => Promise<boolean>
}

export interface AvgsBookingBridge {
  request: (payload: BookingHttpRequest) => Promise<BookingHttpResponse>
}

export interface AvgsHttpBridge {
  request: (payload: HttpProxyRequest) => Promise<HttpProxyResponse>
}

export interface AvgsDamageBridge {
  analyze: (payload: DamageAnalyzeRequest) => Promise<DamageAnalyzeResponse>
  onProgress: (listener: (payload: DamageProgressEvent) => void) => () => void
  save: (input: SavedDamageReportInput) => Promise<SavedDamageReportSummary>
  list: (projectId: string) => Promise<SavedDamageReportSummary[]>
  load: (projectId: string, reportId: string) => Promise<SavedDamageReport>
  remove: (projectId: string, reportId: string) => Promise<void>
  exportPdf: (projectId: string, reportId: string) => Promise<string | null>
  removeAll: () => Promise<void>
}

export interface AvgsBridge {
  platform: NodeJS.Platform
  versions: {
    electron: string
    chrome: string
    node: string
  }
  authStorage: AvgsAuthStorage
  projects: AvgsProjectsBridge
  viewer: AvgsViewerBridge
  payments: AvgsPaymentsBridge
  capture: AvgsCaptureBridge
  booking: AvgsBookingBridge
  http: AvgsHttpBridge
  damage: AvgsDamageBridge
  files: AvgsFilesBridge
}

declare global {
  interface Window {
    avgs: AvgsBridge
  }
}

export {}
