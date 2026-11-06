import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { AUTH_STORAGE_CHANNELS } from '../shared/authStorageChannels'
import {
  PROJECT_DOWNLOAD_CHANNELS,
  type DownloadProgress,
  type DownloadStatus,
  type OpenedPackage,
  type ProjectDownloadDescriptor
} from '../shared/projectDownloadChannels'
import {
  BOOKING_CHANNELS,
  type BookingHttpRequest,
  type BookingHttpResponse
} from '../shared/bookingChannels'
import { CAPTURE_CHANNELS, type CaptureRegionRequest } from '../shared/captureChannels'
import {
  DAMAGE_CHANNELS,
  type DamageAnalyzeRequest,
  type DamageAnalyzeResponse
} from '../shared/damageChannels'
import { HTTP_PROXY_CHANNELS, type HttpProxyRequest, type HttpProxyResponse } from '../shared/httpProxyChannels'
import { PAYMENT_CHANNELS, type PaymentSessionRequest } from '../shared/paymentChannels'
import { VIEWER_CHANNELS, type ViewerLaunchOptions } from '../shared/viewerChannels'

const authStorage = {
  get: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(AUTH_STORAGE_CHANNELS.get, key),
  set: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke(AUTH_STORAGE_CHANNELS.set, key, value),
  remove: (key: string): Promise<void> =>
    ipcRenderer.invoke(AUTH_STORAGE_CHANNELS.remove, key)
}

const projects = {
  hasCached: (projectId: string, remoteURL: string): Promise<boolean> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.hasCached, projectId, remoteURL),
  totalBytes: (): Promise<number> => ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.totalBytes),
  removeCache: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.removeCache, projectId),
  removeAll: (): Promise<void> => ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.removeAll),
  removeOrphans: (keepIds: string[]): Promise<number> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.removeOrphans, keepIds),
  statuses: (): Promise<Record<string, DownloadStatus>> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.status),
  start: (project: ProjectDownloadDescriptor): Promise<void> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.start, project),
  stop: (projectId: string): Promise<void> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.stop, projectId),
  openPackage: (
    project: ProjectDownloadDescriptor,
    forceRedownload = false
  ): Promise<OpenedPackage> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.openPackage, project, forceRedownload),
  openLocal: (filePath: string): Promise<OpenedPackage> =>
    ipcRenderer.invoke(PROJECT_DOWNLOAD_CHANNELS.openLocal, filePath),
  onProgress: (
    listener: (payload: { projectId: string; progress: DownloadProgress }) => void
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { projectId: string; progress: DownloadProgress }
    ): void => listener(payload)
    ipcRenderer.on(PROJECT_DOWNLOAD_CHANNELS.progressEvent, handler)
    return () => ipcRenderer.removeListener(PROJECT_DOWNLOAD_CHANNELS.progressEvent, handler)
  },
  onStatus: (
    listener: (payload: { projectId: string; status: DownloadStatus }) => void
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: { projectId: string; status: DownloadStatus }
    ): void => listener(payload)
    ipcRenderer.on(PROJECT_DOWNLOAD_CHANNELS.statusEvent, handler)
    return () => ipcRenderer.removeListener(PROJECT_DOWNLOAD_CHANNELS.statusEvent, handler)
  }
}

const viewer = {
  getOrigin: (): Promise<string> => ipcRenderer.invoke(VIEWER_CHANNELS.origin),
  buildUrl: (options: ViewerLaunchOptions | string): Promise<string> =>
    ipcRenderer.invoke(VIEWER_CHANNELS.buildUrl, options)
}

const payments = {
  createSession: (payload: PaymentSessionRequest): Promise<string> =>
    ipcRenderer.invoke(PAYMENT_CHANNELS.createSession, payload)
}

const capture = {
  region: (region: CaptureRegionRequest): Promise<string> =>
    ipcRenderer.invoke(CAPTURE_CHANNELS.region, region),
  save: (dataUrl: string): Promise<boolean> => ipcRenderer.invoke(CAPTURE_CHANNELS.save, dataUrl)
}

const booking = {
  request: (payload: BookingHttpRequest): Promise<BookingHttpResponse> =>
    ipcRenderer.invoke(BOOKING_CHANNELS.request, payload)
}

const http = {
  request: (payload: HttpProxyRequest): Promise<HttpProxyResponse> =>
    ipcRenderer.invoke(HTTP_PROXY_CHANNELS.request, payload)
}

const files = {
  pathFor: (file: File): string => webUtils.getPathForFile(file)
}

const damage = {
  analyze: (payload: DamageAnalyzeRequest): Promise<DamageAnalyzeResponse> =>
    ipcRenderer.invoke(DAMAGE_CHANNELS.analyze, payload)
}

contextBridge.exposeInMainWorld('avgs', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  authStorage,
  projects,
  viewer,
  payments,
  capture,
  booking,
  http,
  damage,
  files
})
