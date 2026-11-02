import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { mapProjectRow, type ProjectRow, type RemoteProject } from './types'

function friendlyLibraryError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/offline|network|internet|fetch/i.test(text)) {
    return "You're offline. Check your connection and try again."
  }
  if (/unauthorized|jwt|session/i.test(text)) {
    return 'Your session expired. Please sign in again.'
  }
  return "Couldn't load your projects. Please try again."
}

export function useProjectLibrary(userId: string | null) {
  const [projects, setProjects] = useState<RemoteProject[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!userId) {
      setProjects([])
      setErrorMessage(null)
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setErrorMessage(null)

    try {
      const { data, error } = await supabase
        .from('projects')
        .select(
          'id, user_id, project_name, project_url, photo_api, spz, calibration, measur_factor, move_speed, created_at'
        )
        .eq('user_id', userId.toLowerCase())
        .order('created_at', { ascending: false })

      if (error) throw error

      const rows = (data ?? []) as ProjectRow[]
      const mapped = rows.map(mapProjectRow)
      setProjects(mapped)
      try {
        await window.avgs.projects.removeOrphans(mapped.map((project) => project.id))
      } catch {
        // Local orphan cleanup is best-effort.
      }
    } catch (error) {
      setProjects([])
      setErrorMessage(friendlyLibraryError(error))
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clear = useCallback(() => {
    setProjects([])
    setErrorMessage(null)
    setIsLoading(false)
  }, [])

  return { projects, isLoading, errorMessage, refresh, clear }
}
