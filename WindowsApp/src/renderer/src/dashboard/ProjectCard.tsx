import { useEffect, useState } from 'react'
import { formatBytes } from '../lib/formatBytes'
import { useDownloads } from '../projects/DownloadContext'
import { projectAccent, projectCategoryLabel, type RemoteProject } from '../projects/types'

export function ProjectCard({
  project,
  onOpen
}: {
  project: RemoteProject
  onOpen: () => void
}) {
  const downloads = useDownloads()
  const [from, to] = projectAccent(project.id)
  const status = downloads.statusFor(project.id)
  const [cached, setCached] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    let alive = true
    void downloads.isCached(project.id, project.remoteURL).then((value) => {
      if (alive) setCached(value)
    })
    return () => {
      alive = false
    }
  }, [downloads, project.id, project.remoteURL, downloads.cacheRevision])

  const progress = status.state === 'downloading' ? status.progress : null

  let statusLabel = 'Cloud project'
  if (cached) statusLabel = 'Ready offline'
  else if (status.state === 'downloading') {
    statusLabel = progress?.totalBytes
      ? `Downloading ${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%`
      : 'Downloading…'
  } else if (status.state === 'unpacking') statusLabel = 'Preparing…'
  else if (status.state === 'failed') statusLabel = status.message

  return (
    <article className="project-card">
      <div className="project-thumb-wrap">
        <button type="button" className="project-thumb" onClick={onOpen}>
          <span
            className="project-thumb-fill"
            style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
          />
          <span className="project-thumb-status">
            <span className="project-thumb-icon" aria-hidden>
              {cached ? '✓' : status.state === 'failed' ? '!' : '↓'}
            </span>
            {statusLabel}
            {progress && (
              <span className="card-progress">
                <span className="progress-track">
                  <span
                    className="progress-fill"
                    style={{
                      width: progress.totalBytes
                        ? `${Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)}%`
                        : '40%'
                    }}
                  />
                </span>
                <span className="progress-label">
                  {formatBytes(progress.receivedBytes)}
                  {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                </span>
              </span>
            )}
          </span>
        </button>

        <div className="project-card-actions">
          {status.state === 'downloading' && (
            <button
              type="button"
              className="card-action"
              title="Stop download"
              onClick={() => void downloads.stopDownload(project.id)}
            >
              ■
            </button>
          )}
          <div className="card-menu">
            <button
              type="button"
              className="card-action"
              aria-label="Project actions"
              onClick={() => setMenuOpen((open) => !open)}
            >
              ▾
            </button>
            {menuOpen && (
              <div className="card-menu-panel">
                {status.state === 'downloading' && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false)
                      void downloads.stopDownload(project.id)
                    }}
                  >
                    Stop Download
                  </button>
                )}
                <button
                  type="button"
                  className="danger"
                  disabled={!cached && status.state !== 'downloading'}
                  onClick={() => {
                    setMenuOpen(false)
                    void downloads.removeCache(project.id)
                  }}
                >
                  Delete local copy
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <button type="button" className="project-meta" onClick={onOpen}>
        <span className="project-name">{project.name}</span>
        <span className="project-category">{projectCategoryLabel(project)}</span>
        <span className="project-open" aria-hidden>
          ↗
        </span>
      </button>
    </article>
  )
}
