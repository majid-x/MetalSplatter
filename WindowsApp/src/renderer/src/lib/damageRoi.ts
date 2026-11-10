import type { DamageOutline, DamageOutlineRegion } from '../../../shared/damageChannels'
import type { Vec3 } from './damagePhotoGather'
import { resolvePhotoQueryURL } from './photoSearch'

export type NormPoint = [number, number]

export type ImageRoi = {
  /** Index into the analysis image list */
  imageIndex: number
  /** COLMAP / photo API image id when known */
  imageId?: number
  /** Normalized 0–1 polygon on the photo (user marked area mapped via COLMAP). */
  polygon: NormPoint[]
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/** Sample points along polygon edges so perspective projection stays faithful. */
export function densifyBoundary3D(points: Vec3[], samplesPerEdge = 4): Vec3[] {
  if (points.length < 2) return points.slice()
  const out: Vec3[] = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    out.push(a)
    for (let s = 1; s < samplesPerEdge; s++) {
      const t = s / samplesPerEdge
      out.push([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t
      ])
    }
  }
  return out
}

function apiPoint(
  point: Vec3,
  useSPZ: boolean,
  useServerCalibration: boolean
): Vec3 {
  const sendRaw = useServerCalibration || !useSPZ
  if (sendRaw) return point
  return [-point[0], -point[1], point[2]]
}

function photoApiRoot(baseURL: string): string {
  return resolvePhotoQueryURL(baseURL).replace(/\/query$/i, '')
}

/** Project a 3D marked boundary onto one photo via photo API /project. */
export async function projectBoundaryToImage(options: {
  baseURL: string
  imageId: number
  boundary: Vec3[]
  useSPZCoordinates: boolean
  useServerCalibration: boolean
}): Promise<NormPoint[] | null> {
  const dense = densifyBoundary3D(options.boundary, 5).map((p) =>
    apiPoint(p, options.useSPZCoordinates, options.useServerCalibration)
  )
  const url = `${photoApiRoot(options.baseURL)}/project`
  try {
    const response = await window.avgs.http.request({
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        image_id: options.imageId,
        points: dense
      })
    })
    if (!response.ok) return null
    const decoded = JSON.parse(response.text) as {
      ok?: boolean
      points?: Array<{ ok?: boolean; x?: number; y?: number }>
    }
    const pts = (decoded.points || [])
      .filter((p) => p && p.ok !== false && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => [clamp01(p.x as number), clamp01(p.y as number)] as NormPoint)
    if (pts.length < 3) return null
    return convexHull(pts)
  } catch {
    return null
  }
}

/** Expand polygon from centroid so edge damage inside the mark isn’t clipped away. */
export function inflatePolygon(poly: NormPoint[], factor = 1.1): NormPoint[] {
  if (poly.length < 3) return poly
  let cx = 0
  let cy = 0
  for (const [x, y] of poly) {
    cx += x
    cy += y
  }
  cx /= poly.length
  cy /= poly.length
  return poly.map(([x, y]) => {
    const nx = cx + (x - cx) * factor
    const ny = cy + (y - cy) * factor
    return [clamp01(nx), clamp01(ny)] as NormPoint
  })
}

function cross(o: NormPoint, a: NormPoint, b: NormPoint): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

function convexHull(points: NormPoint[]): NormPoint[] {
  const pts = points
    .slice()
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))
  if (pts.length <= 3) return pts
  const lower: NormPoint[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }
  const upper: NormPoint[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

export function pointInPolygon(x: number, y: number, poly: NormPoint[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function regionSamplePoints(region: DamageOutlineRegion): NormPoint[] {
  const poly = region.polygon?.filter(
    (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])
  )
  if (poly && poly.length >= 3) {
    const pts = poly.map((p) => [clamp01(p[0]), clamp01(p[1])] as NormPoint)
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
    return [[cx, cy], ...pts]
  }
  const x0 = clamp01(region.box.x)
  const y0 = clamp01(region.box.y)
  const x1 = clamp01(region.box.x + region.box.w)
  const y1 = clamp01(region.box.y + region.box.h)
  const cx = (x0 + x1) * 0.5
  const cy = (y0 + y1) * 0.5
  return [
    [cx, cy],
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1]
  ]
}

/**
 * Keep damage boxes that meaningfully intersect the marked ROI.
 * Uses inflated ROI + center/vertex tests so in-region damage is not dropped.
 */
export function filterRegionsToRoi(
  regions: DamageOutlineRegion[],
  roi: NormPoint[] | null | undefined
): DamageOutlineRegion[] {
  if (!roi || roi.length < 3) return regions
  const soft = inflatePolygon(roi, 1.12)
  return regions.filter((region) => {
    const samples = regionSamplePoints(region)
    const hits = samples.filter(([x, y]) => pointInPolygon(x, y, soft)).length
    // Keep if center is inside OR enough of the region samples fall in the mark.
    return hits >= Math.max(1, Math.ceil(samples.length * 0.35))
  })
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image for ROI mask.'))
    img.src = dataUrl
  })
}

/**
 * Darken outside the marked ROI so the model focuses on the user-mapped area,
 * while keeping the interior fully visible (no crop that would drop edge damage).
 */
export async function maskImageOutsideRoi(
  sourceDataUrl: string,
  roi: NormPoint[],
  options?: { outsideAlpha?: number; drawGuide?: boolean }
): Promise<string> {
  if (roi.length < 3) return sourceDataUrl
  const img = await loadImage(sourceDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceDataUrl

  const soft = inflatePolygon(roi, 1.08)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.fillStyle = `rgba(0,0,0,${options?.outsideAlpha ?? 0.62})`
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  ctx.save()
  ctx.beginPath()
  soft.forEach(([nx, ny], i) => {
    const x = clamp01(nx) * canvas.width
    const y = clamp01(ny) * canvas.height
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.restore()

  if (options?.drawGuide !== false) {
    ctx.beginPath()
    soft.forEach(([nx, ny], i) => {
      const x = clamp01(nx) * canvas.width
      const y = clamp01(ny) * canvas.height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.95)'
    ctx.lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.005))
    ctx.setLineDash([10, 6])
    ctx.stroke()
    ctx.setLineDash([])
  }

  return canvas.toDataURL('image/jpeg', 0.92)
}

export function clipOutlineToRoi(
  outline: DamageOutline,
  roi: NormPoint[] | null | undefined
): DamageOutline {
  return {
    ...outline,
    regions: filterRegionsToRoi(outline.regions, roi)
  }
}
