import type { WallDamageReport } from './wallDamageReport'

export const DAMAGE_CHANNELS = {
  analyze: 'avgs:damage:analyze'
} as const

/** Normalized 0–1 region on the primary (first) analysis image. */
export type DamageOutlineRegion = {
  label: string
  /** Axis-aligned box in normalized image coords (0–1). */
  box: { x: number; y: number; w: number; h: number }
  /** Optional polygon in normalized image coords (0–1). Preferred when present. */
  polygon?: Array<[number, number]>
}

export type DamageOutline = {
  /** Index into the request image list the outline refers to (usually 0). */
  imageIndex: number
  regions: DamageOutlineRegion[]
}

export type DamageAnalyzeRequest = {
  /** data:image/...;base64,... or raw base64 — main normalizes */
  imageDataUrls: string[]
  projectName?: string
  maxImages?: number
  /**
   * Project calibration from DB: scene_units × measureFactor = real meters.
   * Used so area/cost estimates are real-world, not photo guesses.
   */
  measureFactor?: number
}

export type DamageAnalyzeResponse = {
  report: WallDamageReport
  model: string
  imageCount: number
  /** Damaged areas on the primary photo — drawn client-side as an outline. */
  outline: DamageOutline | null
}
