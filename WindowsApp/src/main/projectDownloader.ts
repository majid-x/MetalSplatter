import { createWriteStream } from 'fs'
import { rm, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { basename, extname, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import type {
  DownloadProgress,
  DownloadStatus,
  OpenedPackage,
  ProjectDownloadDescriptor
} from '../shared/projectDownloadChannels'
import {
  clearDownloadArtifacts,
  downloadErrorMessage,
  findExtractedModel,
  friendlyDownloadError,
  installDownloadedPackage,
  loadPendingProject,
  loadSavedProgress,
  packageFilePath,
  preferredExtension,
  projectDirectory,
  removeCachedPackage,
  savePendingDownload,
  saveProgress,
  ensureProjectDirectory
} from './projectStore'
import { existsSync, statSync } from 'fs'
import { loadScenePackage } from './scenePackage'

type ProgressListener = (projectId: string, progress: DownloadProgress) => void
type StatusListener = (projectId: string, status: DownloadStatus) => void

type ActiveDownload = {
  controller: AbortController
  project: ProjectDownloadDescriptor
}

export class ProjectDownloader {
  private active = new Map<string, ActiveDownload>()
  private statuses = new Map<string, DownloadStatus>()
  private known = new Map<string, ProjectDownloadDescriptor>()
  private waiters = new Map<
    string,
    Array<{
      resolve: (path: string) => void
      reject: (error: Error) => void
    }>
  >()

  onProgress: ProgressListener | null = null
  onStatus: StatusListener | null = null

  getStatus(projectId: string): DownloadStatus {
    return this.statuses.get(projectId.toLowerCase()) ?? { state: 'idle' }
  }

  getAllStatuses(): Record<string, DownloadStatus> {
    const out: Record<string, DownloadStatus> = {}
    this.statuses.forEach((status, id) => {
      out[id] = status
    })
    return out
  }

  private setStatus(projectId: string, status: DownloadStatus): void {
    const id = projectId.toLowerCase()
    if (status.state === 'idle') {
      this.statuses.delete(id)
    } else {
      this.statuses.set(id, status)
    }
    this.onStatus?.(id, status)
  }

  async startDownload(project: ProjectDownloadDescriptor): Promise<void> {
    const id = project.id.toLowerCase()
    this.known.set(id, { ...project, id })

    const existingPackage = packageFilePath(id, project.remoteURL)
    try {
      if (
        existsSync(existingPackage) &&
        statSync(existingPackage).isFile() &&
        statSync(existingPackage).size > 0
      ) {
        this.setStatus(id, { state: 'idle' })
        this.succeedWaiters(id, existingPackage)
        return
      }
    } catch {
      // fall through
    }
    const extracted = await findExtractedModel(id)
    if (extracted) {
      this.setStatus(id, { state: 'idle' })
      this.succeedWaiters(id, extracted)
      return
    }
    // Already downloading — waiters stay queued for the in-flight job.
    if (this.active.has(id)) return

    const seed =
      (await loadSavedProgress(id)) ?? ({ receivedBytes: 0, totalBytes: null } as DownloadProgress)
    this.setStatus(id, { state: 'downloading', progress: seed })
    await savePendingDownload({ ...project, id })
    void this.runDownload({ ...project, id })
  }

  stop(projectId: string): void {
    const id = projectId.toLowerCase()
    const active = this.active.get(id)
    active?.controller.abort()
    this.active.delete(id)
    void clearDownloadArtifacts(id)
    this.setStatus(id, { state: 'idle' })
    this.failWaiters(id, new Error('Download stopped.'))
  }

  async localPackage(
    project: ProjectDownloadDescriptor,
    forceRedownload = false
  ): Promise<string> {
    const id = project.id.toLowerCase()
    const descriptor = { ...project, id }
    this.known.set(id, descriptor)

    if (forceRedownload) {
      this.stop(id)
      await removeCachedPackage(id)
    }

    const packagePath = packageFilePath(id, project.remoteURL)
    try {
      if (existsSync(packagePath) && statSync(packagePath).isFile() && statSync(packagePath).size > 0) {
        this.setStatus(id, { state: 'idle' })
        return packagePath
      }
    } catch {
      // fall through
    }

    // Zip may be gone but scene/ already unpacked from a previous open — reuse it.
    const extracted = await findExtractedModel(id)
    if (extracted) {
      this.setStatus(id, { state: 'idle' })
      return extracted
    }

    const waitPromise = new Promise<string>((resolve, reject) => {
      const list = this.waiters.get(id) ?? []
      list.push({ resolve, reject })
      this.waiters.set(id, list)
    })

    await this.startDownload(descriptor)
    return waitPromise
  }

  async openPackage(
    project: ProjectDownloadDescriptor,
    forceRedownload = false
  ): Promise<OpenedPackage> {
    const id = project.id.toLowerCase()
    const packagePath = await this.localPackage(project, forceRedownload)
    // Already-unpacked .ply/.spz — no zip extract; skip sticky "unpacking" status.
    const ext = extname(packagePath).toLowerCase()
    const alreadyExtracted = ['.ply', '.splat', '.spz'].includes(ext)
    if (!alreadyExtracted) {
      this.setStatus(id, { state: 'unpacking' })
    }
    try {
      const contents = await loadScenePackage(packagePath, id)
      return {
        projectId: id,
        packagePath,
        modelPath: contents.modelPath,
        extractDir: contents.extractDir,
        navigationPath: contents.navigationPath,
        collisionPath: contents.collisionPath,
        camera: contents.camera,
        moveSpeed: contents.startPose?.moveSpeed ?? null,
        measureScale: contents.startPose?.measureScale ?? null,
        navSummary: contents.navSummary
      }
    } catch (error) {
      const message = friendlyDownloadError(error)
      this.setStatus(id, { state: 'failed', message })
      throw new Error(message)
    } finally {
      // Always clear unpacking so the UI can't stick on "Preparing…" after success/fail.
      if (this.getStatus(id).state === 'unpacking') {
        this.setStatus(id, { state: 'idle' })
      }
    }
  }

  /** Open a local .ply / .splat / .spz / .zip from disk (drag-drop). */
  async openLocalPath(filePath: string): Promise<OpenedPackage> {
    const ext = extname(filePath).toLowerCase()
    if (!['.ply', '.splat', '.spz', '.zip'].includes(ext)) {
      throw new Error('Drop a .ply, .splat, .spz, or .zip project file.')
    }
    const id = `local-${createHash('sha1').update(filePath.toLowerCase()).digest('hex').slice(0, 16)}`
    this.setStatus(id, { state: 'unpacking' })
    try {
      const contents = await loadScenePackage(filePath, id)
      this.setStatus(id, { state: 'idle' })
      return {
        projectId: id,
        packagePath: filePath,
        modelPath: contents.modelPath,
        extractDir: contents.extractDir,
        navigationPath: contents.navigationPath,
        collisionPath: contents.collisionPath,
        camera: contents.camera,
        moveSpeed: contents.startPose?.moveSpeed ?? null,
        measureScale: contents.startPose?.measureScale ?? null,
        navSummary: contents.navSummary
      }
    } catch (error) {
      const message = friendlyDownloadError(error)
      this.setStatus(id, { state: 'failed', message })
      throw new Error(message)
    }
  }

  static localProjectName(filePath: string): string {
    return basename(filePath)
  }

  private async runDownload(project: ProjectDownloadDescriptor): Promise<void> {
    const id = project.id
    const controller = new AbortController()
    this.active.set(id, { controller, project })

    const partialPath = join(
      projectDirectory(id),
      `package.partial.${preferredExtension(project.remoteURL)}`
    )

    try {
      await ensureProjectDirectory(id)
      await rm(partialPath, { force: true })

      const response = await fetch(project.remoteURL, {
        signal: controller.signal,
        headers: {
          Accept: '*/*',
          'User-Agent': 'VroomkWindows/0.1'
        },
        redirect: 'follow'
      })
      if (!response.ok) {
        throw new Error(downloadErrorMessage(response.status))
      }
      if (!response.body) {
        throw new Error("Couldn't reach the project server. Check your connection and try again.")
      }

      const totalHeader = response.headers.get('content-length')
      const totalBytes = totalHeader ? Number(totalHeader) : null
      let receivedBytes = 0
      let lastEmit = 0

      const emitProgress = (force = false): void => {
        const now = Date.now()
        if (!force && now - lastEmit < 120) return
        lastEmit = now
        const progress = {
          receivedBytes,
          totalBytes: totalBytes && totalBytes > 0 ? totalBytes : null
        }
        this.setStatus(id, { state: 'downloading', progress })
        this.onProgress?.(id, progress)
        void saveProgress(id, progress)
      }

      // Prefer a full buffer for smaller packages (more reliable on Windows/Electron).
      // Stream large packages to avoid memory spikes.
      const useBuffer = !totalBytes || totalBytes <= 32 * 1024 * 1024

      if (useBuffer) {
        const buffer = Buffer.from(await response.arrayBuffer())
        if (controller.signal.aborted) throw new Error('Download stopped.')
        receivedBytes = buffer.length
        emitProgress(true)
        await writeFile(partialPath, buffer)
      } else {
        const progressTap = new Transform({
          transform: (chunk, _encoding, callback) => {
            receivedBytes += chunk.length
            emitProgress()
            callback(null, chunk)
          }
        })
        await pipeline(
          Readable.fromWeb(response.body as import('stream/web').ReadableStream),
          progressTap,
          createWriteStream(partialPath)
        )
        emitProgress(true)
      }

      const finalProgress = {
        receivedBytes,
        totalBytes: totalBytes && totalBytes > 0 ? totalBytes : receivedBytes
      }
      this.setStatus(id, { state: 'downloading', progress: finalProgress })
      this.onProgress?.(id, finalProgress)

      const known = this.known.get(id) ?? (await loadPendingProject(id)) ?? project
      const localPath = await installDownloadedPackage(partialPath, known)
      await clearDownloadArtifacts(id)
      this.active.delete(id)
      this.setStatus(id, { state: 'idle' })
      this.succeedWaiters(id, localPath)
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined)
      this.active.delete(id)
      if (controller.signal.aborted) {
        this.setStatus(id, { state: 'idle' })
        this.failWaiters(id, new Error('Download stopped.'))
        return
      }
      const message = friendlyDownloadError(error)
      this.setStatus(id, { state: 'failed', message })
      this.failWaiters(id, new Error(message))
    }
  }

  private succeedWaiters(projectId: string, path: string): void {
    const pending = this.waiters.get(projectId) ?? []
    this.waiters.delete(projectId)
    for (const waiter of pending) waiter.resolve(path)
  }

  private failWaiters(projectId: string, error: Error): void {
    const pending = this.waiters.get(projectId) ?? []
    this.waiters.delete(projectId)
    for (const waiter of pending) waiter.reject(error)
  }
}

export const projectDownloader = new ProjectDownloader()
