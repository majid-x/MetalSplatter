import { BrowserWindow } from 'electron'
import {
  PROJECT_DOWNLOAD_CHANNELS,
  type ProjectDownloadDescriptor
} from '../shared/projectDownloadChannels'
import { handle } from './ipc'
import { projectDownloader } from './projectDownloader'
import {
  hasCachedPackage,
  removeAllCachedPackages,
  removeCachedPackage,
  removeOrphanedCaches,
  totalCachedBytes
} from './projectStore'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerProjectDownloadIpc(): void {
  projectDownloader.onProgress = (projectId, progress) => {
    broadcast(PROJECT_DOWNLOAD_CHANNELS.progressEvent, { projectId, progress })
  }
  projectDownloader.onStatus = (projectId, status) => {
    broadcast(PROJECT_DOWNLOAD_CHANNELS.statusEvent, { projectId, status })
  }

  handle(
    PROJECT_DOWNLOAD_CHANNELS.hasCached,
    async (_event, projectId: string, remoteURL: string) =>
      hasCachedPackage(projectId, remoteURL)
  )

  handle(PROJECT_DOWNLOAD_CHANNELS.totalBytes, async () => totalCachedBytes())

  handle(PROJECT_DOWNLOAD_CHANNELS.removeCache, async (_event, projectId: string) => {
    projectDownloader.stop(projectId)
    await removeCachedPackage(projectId)
  })

  handle(PROJECT_DOWNLOAD_CHANNELS.removeAll, async () => {
    await removeAllCachedPackages()
  })

  handle(PROJECT_DOWNLOAD_CHANNELS.removeOrphans, async (_event, keepIds: string[]) =>
    removeOrphanedCaches(keepIds)
  )

  handle(PROJECT_DOWNLOAD_CHANNELS.status, async () => projectDownloader.getAllStatuses())

  handle(PROJECT_DOWNLOAD_CHANNELS.start, async (_event, project: ProjectDownloadDescriptor) => {
    await projectDownloader.startDownload(project)
  })

  handle(PROJECT_DOWNLOAD_CHANNELS.stop, async (_event, projectId: string) => {
    projectDownloader.stop(projectId)
  })

  handle(
    PROJECT_DOWNLOAD_CHANNELS.openPackage,
    async (_event, project: ProjectDownloadDescriptor, forceRedownload = false) =>
      projectDownloader.openPackage(project, forceRedownload)
  )

  handle(PROJECT_DOWNLOAD_CHANNELS.openLocal, async (_event, filePath: string) =>
    projectDownloader.openLocalPath(filePath)
  )
}
