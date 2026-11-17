import type { RemoteProject } from '../projects/types'

/** Public web viewer base on the vroomk.com domain. */
export const VROOMK_WEB_VIEWER_BASE = 'https://www.vroomk.com/view'

/**
 * Public HTTPS URL for a project’s browser / Quest walkthrough.
 * Deploy WindowsApp/web-viewer/ to https://www.vroomk.com/view/ (rewrite /view/* → index.html).
 * The page reads `content` (splat URL) + `name`; WebGL is forced for Quest/mobile.
 */
export function buildProjectWebUrl(project: Pick<RemoteProject, 'id' | 'name' | 'remoteURL'>): string {
  // Use /view/?… (not /view/<id>) so a static folder deploy works without SPA rewrites.
  const url = new URL(`${VROOMK_WEB_VIEWER_BASE}/`)
  url.searchParams.set('id', project.id)
  url.searchParams.set('content', project.remoteURL)
  url.searchParams.set('name', project.name)
  // Required for Meta Quest browser / WebXR-capable path (see supersplat-viewer `webgl` flag).
  url.searchParams.set('webgl', '1')
  return url.toString()
}
