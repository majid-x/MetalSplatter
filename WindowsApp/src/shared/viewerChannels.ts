import type { SceneCameraPose } from './projectDownloadChannels'

export const VIEWER_CHANNELS = {
  origin: 'vroomk:viewer:origin',
  buildUrl: 'vroomk:viewer:build-url'
} as const

export type ViewerLaunchOptions = {
  modelPath: string
  collisionPath?: string | null
  camera?: SceneCameraPose | null
  /** Full nav.txt path — walkable polygons / wall boxes for FPS clamp + slide. */
  navigationPath?: string | null
  /** Walk speed m/s — Supabase move_speed when set; Mac default 3.5. */
  moveSpeed?: number | null
  projectName?: string
}
