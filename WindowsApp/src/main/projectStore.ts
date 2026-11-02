import { app } from 'electron'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'fs/promises'
import { join, extname } from 'path'
import type { DownloadProgress, ProjectDownloadDescriptor } from '../shared/projectDownloadChannels'

const STORE_FOLDER = 'PrivateProjects'
const PROGRESS_FILE = 'download-progress.json'
const PENDING_FILE = 'download-pending.json'

export function preferredExtension(remoteURL: string): string {
  try {
    const pathPart = new URL(remoteURL).pathname
    const ext = extname(pathPart).replace('.', '').toLowerCase()
    if (['zip', 'ply', 'splat', 'spz'].includes(ext)) return ext
  } catch {
    // fall through
  }
  return 'zip'
}

export function projectsRoot(): string {
  return join(app.getPath('userData'), STORE_FOLDER)
}

export function projectDirectory(projectId: string): string {
  return join(projectsRoot(), projectId.toLowerCase())
}

export async function ensureProjectDirectory(projectId: string): Promise<string> {
  const dir = projectDirectory(projectId)
  await mkdir(dir, { recursive: true })
  return dir
}

export function packageFilePath(projectId: string, remoteURL: string): string {
  return join(projectDirectory(projectId), `package.${preferredExtension(remoteURL)}`)
}

export function extractDirectory(projectId: string): string {
  return join(projectDirectory(projectId), 'scene')
}

const MODEL_EXTS = new Set(['.ply', '.splat', '.spz'])

/** Largest model file already unpacked under scene/, if any. */
export async function findExtractedModel(projectId: string): Promise<string | null> {
  const root = extractDirectory(projectId)
  const stack = [root]
  const models: string[] = []
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__MACOSX') stack.push(full)
      } else if (entry.isFile() && MODEL_EXTS.has(extname(entry.name).toLowerCase())) {
        models.push(full)
      }
    }
  }
  if (models.length === 0) return null
  let best = models[0]
  let bestSize = -1
  for (const model of models) {
    try {
      const size = (await stat(model)).size
      if (size > bestSize) {
        best = model
        bestSize = size
      }
    } catch {
      // ignore
    }
  }
  return bestSize > 0 ? best : null
}

export async function hasCachedPackage(
  projectId: string,
  remoteURL: string
): Promise<boolean> {
  try {
    const info = await stat(packageFilePath(projectId, remoteURL))
    if (info.isFile() && info.size > 0) return true
  } catch {
    // fall through — extracted scene still counts as cached
  }
  return (await findExtractedModel(projectId)) != null
}

export async function installDownloadedPackage(
  tempPath: string,
  project: ProjectDownloadDescriptor
): Promise<string> {
  await ensureProjectDirectory(project.id)
  const localPath = packageFilePath(project.id, project.remoteURL)
  await rm(localPath, { force: true })
  try {
    await rename(tempPath, localPath)
  } catch (error) {
    // Cross-device rename can fail on Windows; fall back to copy+delete.
    const { copyFile } = await import('fs/promises')
    await copyFile(tempPath, localPath)
    await rm(tempPath, { force: true })
    void error
  }
  const info = await stat(localPath)
  if (info.size <= 0) {
    await rm(localPath, { force: true })
    throw new Error('The downloaded project was empty. Please try again.')
  }
  return localPath
}

export async function removeCachedPackage(projectId: string): Promise<void> {
  await rm(projectDirectory(projectId), { recursive: true, force: true })
}

export async function cachedProjectIds(): Promise<string[]> {
  try {
    const names = await readdir(projectsRoot(), { withFileTypes: true })
    return names.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase())
  } catch {
    return []
  }
}

export async function removeOrphanedCaches(keepIds: string[]): Promise<number> {
  const keep = new Set(keepIds.map((id) => id.toLowerCase()))
  let removed = 0
  for (const id of await cachedProjectIds()) {
    if (!keep.has(id)) {
      await removeCachedPackage(id)
      removed += 1
    }
  }
  return removed
}

export async function removeAllCachedPackages(): Promise<void> {
  await rm(projectsRoot(), { recursive: true, force: true })
}

async function directoryByteSize(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryByteSize(full)
    } else if (entry.isFile()) {
      try {
        total += (await stat(full)).size
      } catch {
        // ignore
      }
    }
  }
  return total
}

export async function totalCachedBytes(): Promise<number> {
  return directoryByteSize(projectsRoot())
}

export async function saveProgress(
  projectId: string,
  progress: DownloadProgress
): Promise<void> {
  const dir = await ensureProjectDirectory(projectId)
  await writeFile(join(dir, PROGRESS_FILE), JSON.stringify(progress), 'utf8')
}

export async function loadSavedProgress(projectId: string): Promise<DownloadProgress | null> {
  try {
    const raw = await readFile(join(projectDirectory(projectId), PROGRESS_FILE), 'utf8')
    const parsed = JSON.parse(raw) as DownloadProgress
    if (typeof parsed.receivedBytes !== 'number') return null
    return {
      receivedBytes: parsed.receivedBytes,
      totalBytes: typeof parsed.totalBytes === 'number' ? parsed.totalBytes : null
    }
  } catch {
    return null
  }
}

export async function savePendingDownload(project: ProjectDownloadDescriptor): Promise<void> {
  const dir = await ensureProjectDirectory(project.id)
  await writeFile(
    join(dir, PENDING_FILE),
    JSON.stringify({
      id: project.id,
      name: project.name,
      remoteURL: project.remoteURL,
      fileExtension: preferredExtension(project.remoteURL)
    }),
    'utf8'
  )
}

export async function loadPendingProject(
  projectId: string
): Promise<ProjectDownloadDescriptor | null> {
  try {
    const raw = await readFile(join(projectDirectory(projectId), PENDING_FILE), 'utf8')
    const parsed = JSON.parse(raw) as ProjectDownloadDescriptor
    if (!parsed.id || !parsed.remoteURL) return null
    return {
      id: parsed.id,
      name: parsed.name || 'Project',
      remoteURL: parsed.remoteURL
    }
  } catch {
    return null
  }
}

export async function clearDownloadArtifacts(projectId: string): Promise<void> {
  const dir = projectDirectory(projectId)
  await rm(join(dir, PROGRESS_FILE), { force: true })
  await rm(join(dir, PENDING_FILE), { force: true })
}

export function downloadErrorMessage(statusCode: number): string {
  if (statusCode === 404) return "This project isn't available anymore."
  if (statusCode >= 500 && statusCode < 600) {
    return 'The project server had a problem. Please try again in a moment.'
  }
  return "Couldn't download the project. Check your connection and try again."
}

export function friendlyDownloadError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/network|internet|offline|timed out|ENOTFOUND|ECONN/i.test(text)) {
    return 'Check your connection and try again.'
  }
  return text || 'Something went wrong while downloading. Please try again.'
}
