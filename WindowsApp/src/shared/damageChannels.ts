import type { WallDamageReport } from './wallDamageReport'

export const DAMAGE_CHANNELS = {
  analyze: 'avgs:damage:analyze',
  /** main → renderer: real progress of an analyze call. */
  progressEvent: 'avgs:damage:progress',
  saveReport: 'avgs:damage:save',
  listReports: 'avgs:damage:list',
  loadReport: 'avgs:damage:load',
  deleteReport: 'avgs:damage:delete',
  exportPdf: 'avgs:damage:export-pdf',
  removeAllReports: 'avgs:damage:remove-all'
} as const

/** Normalized 0–1 region on an analysis image. */
export type DamageOutlineRegion = {
  label: string
  /** Axis-aligned box in normalized image coords (0–1). */
  box: { x: number; y: number; w: number; h: number }
  /** Optional polygon in normalized image coords (0–1). Preferred when present. */
  polygon?: Array<[number, number]>
  /** Indices into report.damage_assessment.visible_symptoms this region shows. */
  symptomIndices?: number[]
}

export type DamageOutline = {
  /** Index into the request image list the outline refers to (ignored when target is 'scope'). */
  imageIndex: number
  /** 'scope' = drawn on the SCOPE crop of the 3D view; 'photo' (default) = on imageDataUrls[imageIndex]. */
  target?: 'photo' | 'scope'
  regions: DamageOutlineRegion[]
}

export type DamageAnalyzeRequest = {
  /** data:image/...;base64,... or raw base64 — main normalizes */
  imageDataUrls: string[]
  projectName?: string
  maxImages?: number
  /**
   * Project calibration from DB: scene_units × measureFactor = real meters.
   * Omitted when the project has no measure factor.
   */
  measureFactor?: number
  /**
   * Area of the user's 3D outline in real sq ft (needs measureFactor).
   * When present it overrides the model's area guess and drives per-sqft costs.
   */
  measuredAreaSqft?: number
  /**
   * True when the photos were already masked to the marked region
   * (outside darkened, orange dashed border drawn on each photo).
   */
  photosMasked?: boolean
  /**
   * Exact crop of the user-marked area from a clean 3D-view capture, with everything
   * outside the mark darkened. When present this DEFINES the scope: only damage
   * visible inside it is reported, and outlines are drawn on it unless photosMasked.
   */
  scopeImageDataUrl?: string
  /** Pixel size of the scope image — lets main convert pixel coordinates the model may return. */
  scopeImageSize?: { width: number; height: number }
  /**
   * Screenshot of the 3D view with the user-marked orange region.
   * Sent as a visual guide: stay inside this area. Does not replace photo analysis.
   */
  regionGuideImageDataUrl?: string
  /** Echoed on progress events so the renderer can ignore stale runs. */
  requestId?: string
}

export type DamageAnalyzeStage = 'assessing' | 'outlining'

export type DamageProgressEvent = {
  requestId?: string
  stage: DamageAnalyzeStage
}

export type DamageAnalyzeResponse = {
  report: WallDamageReport
  model: string
  imageCount: number
  /** Primary outline (first / best photo) — kept for back-compat. */
  outline: DamageOutline | null
  /**
   * All outlines used for annotation. Usually 1 photo; extra photos only when
   * issues are not all visible on the primary frame.
   */
  outlines: DamageOutline[]
  /** Photos (indices into imageDataUrls) that best show the marked area — best first. */
  referenceImageIndices?: number[]
}

/** A finished report as stored on disk (images as data URLs on the wire). */
export type SavedDamageReportInput = {
  projectId: string
  projectName: string
  report: WallDamageReport
  annotatedImageDataUrls: string[]
  /** Unannotated close-up photos of the marked area. */
  referenceImageDataUrls?: string[]
  measureFactor?: number
}

export type SavedDamageReportSummary = {
  id: string
  projectId: string
  projectName: string
  createdAt: string
  severity: string
  areaSqft: number
  minTotal: number
  maxTotal: number
  imageCount: number
}

export type SavedDamageReport = SavedDamageReportSummary & {
  report: WallDamageReport
  annotatedImageDataUrls: string[]
  referenceImageDataUrls: string[]
  measureFactor?: number
}
