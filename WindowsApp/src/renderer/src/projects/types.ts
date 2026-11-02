export type RemoteProject = {
  id: string
  userId: string
  name: string
  remoteURL: string
  photoAPIBaseURL: string | null
  isSPZ: boolean
  useServerCalibration: boolean
  measureFactor: number
  moveSpeed: number | null
  createdAt: string | null
}

export type ProjectRow = {
  id?: string
  uuid?: string
  user_id: string
  project_name: string
  project_url: string
  photo_api?: string | null
  spz?: boolean | null
  calibration?: boolean | null
  measur_factor?: number | null
  move_speed?: number | null
  created_at?: string | null
}

export function mapProjectRow(row: ProjectRow): RemoteProject {
  const id = row.id ?? row.uuid
  if (!id) throw new Error('Missing project id')

  const url = row.project_url.trim()
  if (!url) throw new Error('Missing project_url')

  let photoAPIBaseURL: string | null = null
  const rawPhoto = row.photo_api?.trim()
  if (rawPhoto) {
    try {
      const parsed = new URL(rawPhoto)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        photoAPIBaseURL = parsed.toString()
      }
    } catch {
      photoAPIBaseURL = null
    }
  }

  const measureFactor =
    typeof row.measur_factor === 'number' && row.measur_factor > 0 ? row.measur_factor : 1
  const moveSpeed =
    typeof row.move_speed === 'number' && row.move_speed > 0 ? row.move_speed : null

  return {
    id: id.toLowerCase(),
    userId: row.user_id.toLowerCase(),
    name: row.project_name,
    remoteURL: url,
    photoAPIBaseURL,
    isSPZ: row.spz === true,
    useServerCalibration: row.calibration === true,
    measureFactor,
    moveSpeed,
    createdAt: row.created_at ?? null
  }
}

export function projectCategoryLabel(project: RemoteProject): string {
  if (!project.createdAt) return 'Project'
  const date = new Date(project.createdAt)
  if (Number.isNaN(date.getTime())) return 'Project'
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

const ACCENTS: [string, string][] = [
  ['#475c57', '#1a1f1c'],
  ['#384d6b', '#141a29'],
  ['#5c473d', '#1f1714'],
  ['#3d524d', '#121c1f']
]

export function projectAccent(id: string): [string, string] {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0
  }
  return ACCENTS[Math.abs(hash) % ACCENTS.length]
}
