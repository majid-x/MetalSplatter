import type { WallDamageReport } from '../../../shared/wallDamageReport'
import type { DamageAnalyzeStage, DamageOutline } from '../../../shared/damageChannels'
import type { PhotoSearchResult } from './photoSearch'
import { annotateDamageImage } from './annotateDamageImage'
import {
  clipOutlineToRoi,
  maskImageOutsideRoi,
  projectBoundaryToImage,
  type NormPoint,
  type ScopeCrop
} from './damageRoi'
import type { Vec3 } from './damagePhotoGather'

export const DAMAGE_PHOTO_COUNT = 12

export type DamageStage = 'mapping' | DamageAnalyzeStage

/** Tiny projections usually mean the camera barely sees the marked area. */
const MIN_ROI_AREA = 0.002

function polygonArea(poly: NormPoint[]): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]
    const [x2, y2] = poly[(i + 1) % poly.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) * 0.5
}

/** Strip Electron's "Error invoking remote method '…': Error: " wrapper. */
export function cleanIpcError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || '')
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/i, '').trim()
  return cleaned || fallback
}

export async function analyzeDamageFromPhotos(
  photos: PhotoSearchResult[],
  options: {
    projectName?: string
    /** Only pass when the project really has a calibration. */
    measureFactor?: number
    /** Real sq ft of the 3D outline (needs measureFactor). */
    measuredAreaSqft?: number
    /** Viewer screenshot with orange marked region — stay-inside guide. */
    regionGuideImageDataUrl?: string | null
    /** Enables mapping the 3D outline onto each photo via the photo API /project. */
    roiProjection?: {
      baseURL: string
      boundary: Vec3[]
      useSPZCoordinates: boolean
      useServerCalibration: boolean
    }
    /** Exact crop of the marked area from the 3D view — defines the scope. */
    scope?: ScopeCrop | null
    onStage?: (stage: DamageStage) => void
  }
): Promise<{
  report: WallDamageReport
  imageCount: number
  model: string
  annotatedImageDataUrl: string | null
  annotatedImageDataUrls: string[]
  /** True when the marked area was mapped onto the photos (outside darkened). */
  photosMasked: boolean
  /** Unannotated close-up photos of the marked area (best first, max 3). */
  referenceImageDataUrls: string[]
  /** How the marked area was enforced. */
  scopeMethod: 'photos-mapped' | 'view-crop' | 'guide-only'
}> {
  let candidates = photos
    .filter((photo) => Boolean(photo.imageDataUrl && photo.imageDataUrl.startsWith('data:image/')))
    .slice(0, DAMAGE_PHOTO_COUNT)

  if (candidates.length === 0) {
    throw new Error('No photos of that area were found. Try marking the area again.')
  }

  // --- Map the user's 3D outline onto each photo -------------------------------
  let rois: Array<NormPoint[] | null> = candidates.map(() => null)
  if (options.roiProjection) {
    options.onStage?.('mapping')
    const proj = options.roiProjection
    rois = await Promise.all(
      candidates.map(async (photo) => {
        if (typeof photo.id !== 'number' || !Number.isFinite(photo.id)) return null
        const poly = await projectBoundaryToImage({
          baseURL: proj.baseURL,
          imageId: photo.id,
          boundary: proj.boundary,
          useSPZCoordinates: proj.useSPZCoordinates,
          useServerCalibration: proj.useServerCalibration
        })
        return poly && poly.length >= 3 && polygonArea(poly) >= MIN_ROI_AREA ? poly : null
      })
    )
    const mapped = rois.filter(Boolean).length
    if (mapped >= Math.min(2, candidates.length)) {
      // Use only photos where we know exactly where the marked area is.
      const keep = candidates.map((_, i) => rois[i] !== null)
      candidates = candidates.filter((_, i) => keep[i])
      rois = rois.filter((r) => r !== null)
    } else {
      // Projection not available (endpoint missing / failed) → fall back to the guide screenshot.
      rois = candidates.map(() => null)
    }
  }
  const photosMasked = rois.some(Boolean)

  const originals = candidates.map((photo) => photo.imageDataUrl as string)
  const sendUrls = await Promise.all(
    originals.map(async (url, i) => {
      const roi = rois[i]
      if (!roi) return url
      try {
        return await maskImageOutsideRoi(url, roi)
      } catch {
        return url
      }
    })
  )

  const guide =
    options.regionGuideImageDataUrl && options.regionGuideImageDataUrl.startsWith('data:image/')
      ? options.regionGuideImageDataUrl
      : undefined

  // --- Analyze (main process), with real progress events ------------------------
  const requestId = `dmg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const unsubscribe = window.avgs.damage.onProgress((event) => {
    if (event.requestId === requestId) options.onStage?.(event.stage)
  })
  let response
  try {
    response = await window.avgs.damage.analyze({
      imageDataUrls: sendUrls,
      projectName: options.projectName,
      measureFactor: options.measureFactor,
      measuredAreaSqft: options.measuredAreaSqft,
      photosMasked,
      maxImages: DAMAGE_PHOTO_COUNT,
      regionGuideImageDataUrl: guide,
      scopeImageDataUrl: options.scope?.maskedDataUrl,
      scopeImageSize: options.scope
        ? { width: options.scope.width, height: options.scope.height }
        : undefined,
      requestId
    })
  } finally {
    unsubscribe()
  }

  const outlineList: DamageOutline[] =
    response.outlines?.length > 0 ? response.outlines : response.outline ? [response.outline] : []

  // --- Draw outlines on the ORIGINAL (unmasked) photos --------------------------
  const annotatedImageDataUrls: string[] = []
  const scope = options.scope ?? null
  const annotatedPhotoIndices = new Set<number>()
  for (const outline of outlineList) {
    if (outline.target === 'scope') {
      if (!scope) continue
      // Exact scope: drop any region that isn't inside the user's polygon.
      const clipped = clipOutlineToRoi(outline, scope.polygon)
      if (clipped.regions.length < outline.regions.length) {
        console.warn(
          `[damage] dropped ${outline.regions.length - clipped.regions.length} outline(s) outside the marked area`
        )
      }
      if (clipped.regions.length === 0) continue
      try {
        annotatedImageDataUrls.push(await annotateDamageImage(scope.cleanDataUrl, clipped, scope.polygon))
      } catch {
        annotatedImageDataUrls.push(scope.cleanDataUrl)
      }
      continue
    }
    const idx = Math.min(Math.max(outline.imageIndex, 0), originals.length - 1)
    const roi = rois[idx]
    // Drop any outline that falls outside the marked area on this photo.
    const clipped = roi ? clipOutlineToRoi(outline, roi) : outline
    if (clipped.regions.length === 0) continue
    const sourceUrl = originals[idx] ?? originals[0]
    annotatedPhotoIndices.add(idx)
    try {
      annotatedImageDataUrls.push(await annotateDamageImage(sourceUrl, clipped, roi))
    } catch {
      annotatedImageDataUrls.push(sourceUrl)
    }
  }

  if (annotatedImageDataUrls.length === 0 && scope && !photosMasked) {
    // No damage outlined — show the marked area itself, never an unrelated photo.
    try {
      annotatedImageDataUrls.push(await annotateDamageImage(scope.cleanDataUrl, null, scope.polygon))
    } catch {
      annotatedImageDataUrls.push(scope.cleanDataUrl)
    }
  }

  if (annotatedImageDataUrls.length === 0 && originals[0]) {
    try {
      annotatedImageDataUrls.push(await annotateDamageImage(originals[0], null, rois[0]))
    } catch {
      annotatedImageDataUrls.push(originals[0])
    }
  }

  // Close-ups the model matched to the marked area (not already shown with outlines).
  const referenceImageDataUrls: string[] = []
  for (const raw of response.referenceImageIndices ?? []) {
    const idx = Math.floor(raw)
    if (!Number.isFinite(idx) || idx < 0 || idx >= originals.length) continue
    if (annotatedPhotoIndices.has(idx)) continue
    const url = originals[idx]
    if (!url || referenceImageDataUrls.includes(url)) continue
    let shown = url
    // When the marked area is mapped onto this photo, show it as an orange dashed line.
    if (rois[idx]) {
      try {
        shown = await annotateDamageImage(url, null, rois[idx])
      } catch {
        shown = url
      }
    }
    referenceImageDataUrls.push(shown)
    if (referenceImageDataUrls.length >= 3) break
  }

  return {
    referenceImageDataUrls,
    report: response.report,
    imageCount: response.imageCount,
    model: response.model,
    annotatedImageDataUrl: annotatedImageDataUrls[0] ?? null,
    annotatedImageDataUrls,
    photosMasked,
    scopeMethod: photosMasked ? 'photos-mapped' : scope ? 'view-crop' : 'guide-only'
  }
}
