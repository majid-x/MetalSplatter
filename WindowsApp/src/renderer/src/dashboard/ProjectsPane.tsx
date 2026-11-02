import { useMemo, useState, type DragEvent } from 'react'
import type { RemoteProject } from '../projects/types'
import { ProjectCard } from './ProjectCard'

const DROP_EXTENSIONS = ['.ply', '.splat', '.spz', '.zip']

function isDroppableFile(name: string): boolean {
  const lower = name.toLowerCase()
  return DROP_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function ProjectsPane({
  projects,
  isLoading,
  errorMessage,
  searchText,
  onRetry,
  onOpenProject,
  onOpenLocalFile
}: {
  projects: RemoteProject[]
  isLoading: boolean
  errorMessage: string | null
  searchText: string
  onRetry: () => void
  onOpenProject: (project: RemoteProject) => void
  onOpenLocalFile: (filePath: string, fileName: string) => void
}) {
  const [dragging, setDragging] = useState(false)
  const [dropError, setDropError] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase()
    if (!q) return projects
    return projects.filter((p) => p.name.toLowerCase().includes(q))
  }, [projects, searchText])

  function handleDragOver(event: DragEvent): void {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  function handleDragLeave(event: DragEvent): void {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setDragging(false)
  }

  function handleDrop(event: DragEvent): void {
    event.preventDefault()
    setDragging(false)
    setDropError(null)
    const file = event.dataTransfer.files?.[0]
    if (!file) {
      setDropError('No file dropped.')
      return
    }
    if (!isDroppableFile(file.name)) {
      setDropError('Drop a .ply, .splat, .spz, or .zip file.')
      return
    }
    try {
      const path = window.avgs.files.pathFor(file)
      if (!path) {
        setDropError("Couldn't read that file path.")
        return
      }
      onOpenLocalFile(path, file.name)
    } catch (error) {
      setDropError(error instanceof Error ? error.message : "Couldn't open that file.")
    }
  }

  return (
    <section
      className={`pane projects-pane ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="pane-header">
        <div>
          <h1>Projects</h1>
          <p className="pane-subtitle">
            Designing spaces, creating better living · drop a .ply / .splat / .zip to open
          </p>
        </div>
      </header>

      {(dropError || errorMessage) && (
        <p className="form-error projects-drop-error">{dropError ?? errorMessage}</p>
      )}

      {dragging && (
        <div className="projects-drop-overlay" aria-hidden>
          <strong>Drop to open</strong>
          <span>.ply · .splat · .spz · .zip</span>
        </div>
      )}

      {isLoading && projects.length === 0 ? (
        <div className="pane-state">
          <span className="spinner large" />
          <p>Loading your projects…</p>
        </div>
      ) : errorMessage && projects.length === 0 ? (
        <div className="pane-state">
          <h2>Couldn&apos;t load projects</h2>
          <p>{errorMessage}</p>
          <button type="button" className="pill-button compact" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="pane-state">
          <h2>{searchText.trim() ? 'No matching projects' : 'No projects yet'}</h2>
          <p>
            {searchText.trim()
              ? 'Try a different search.'
              : 'Drag and drop a .ply file here, or wait for cloud projects to sync.'}
          </p>
          {!searchText.trim() && (
            <button type="button" className="pill-button compact" onClick={onRetry}>
              Refresh
            </button>
          )}
        </div>
      ) : (
        <div className="project-grid">
          {filtered.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onOpen={() => onOpenProject(project)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
