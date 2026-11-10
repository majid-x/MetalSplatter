import { searchPhotos, type PhotoSearchResult } from './photoSearch'
import { DAMAGE_PHOTO_COUNT } from './damageEstimation'

export type Vec3 = [number, number, number]

/** Rough planar area in m² from a closed polygon (scene units × measureFactor). */
export function estimateBoundaryAreaM2(points: Vec3[], measureFactor: number): number {
  if (points.length < 3) return 0
  const factor =
    typeof measureFactor === 'number' && Number.isFinite(measureFactor) && measureFactor > 0
      ? measureFactor
      : 1

  const c: Vec3 = [0, 0, 0]
  for (const p of points) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  c[0] /= points.length
  c[1] /= points.length
  c[2] /= points.length

  // Build a local tangent basis from the largest cross product of edges.
  let bestN: Vec3 = [0, 0, 1]
  let bestLen = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const u: Vec3 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]]
    const v: Vec3 = [b[0] - c[0], b[1] - c[1], b[2] - c[2]]
    const n: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0]
    ]
    const len = Math.hypot(n[0], n[1], n[2])
    if (len > bestLen) {
      bestLen = len
      bestN = n
    }
  }
  const nLen = Math.hypot(bestN[0], bestN[1], bestN[2]) || 1
  const normal: Vec3 = [bestN[0] / nLen, bestN[1] / nLen, bestN[2] / nLen]
  const tmp: Vec3 =
    Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  let t1: Vec3 = [
    normal[1] * tmp[2] - normal[2] * tmp[1],
    normal[2] * tmp[0] - normal[0] * tmp[2],
    normal[0] * tmp[1] - normal[1] * tmp[0]
  ]
  const t1Len = Math.hypot(t1[0], t1[1], t1[2]) || 1
  t1 = [t1[0] / t1Len, t1[1] / t1Len, t1[2] / t1Len]
  const t2: Vec3 = [
    normal[1] * t1[2] - normal[2] * t1[1],
    normal[2] * t1[0] - normal[0] * t1[2],
    normal[0] * t1[1] - normal[1] * t1[0]
  ]

  const uv = points.map((p) => {
    const d: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
    return [
      d[0] * t1[0] + d[1] * t1[1] + d[2] * t1[2],
      d[0] * t2[0] + d[1] * t2[1] + d[2] * t2[2]
    ] as [number, number]
  })

  let area = 0
  for (let i = 0; i < uv.length; i++) {
    const a = uv[i]
    const b = uv[(i + 1) % uv.length]
    area += a[0] * b[1] - b[0] * a[1]
  }
  const sceneArea = Math.abs(area) * 0.5
  return sceneArea * factor * factor
}

function centroid(points: Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0]
  for (const p of points) {
    c[0] += p[0]
    c[1] += p[1]
    c[2] += p[2]
  }
  const n = Math.max(1, points.length)
  return [c[0] / n, c[1] / n, c[2] / n]
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5]
}

/**
 * Choose query points for photo search.
 * Small regions → centroid only.
 * Large regions → centroid + edge midpoints (+ optional interior) so one
 * image-search can't miss coverage of the marked area.
 */
export function sampleDamageQueryPoints(
  boundary: Vec3[],
  measureFactor: number
): Vec3[] {
  if (boundary.length === 0) return []
  if (boundary.length === 1) return [boundary[0]]
  if (boundary.length === 2) return [boundary[0], boundary[1], midpoint(boundary[0], boundary[1])]

  const areaM2 = estimateBoundaryAreaM2(boundary, measureFactor)
  const center = centroid(boundary)
  const samples: Vec3[] = [center]

  // ~0.25 m² or larger → multiple searches across the marked region.
  const large = areaM2 >= 0.25 || boundary.length >= 5
  if (!large) return samples

  const edgeCount = boundary.length
  const step = edgeCount <= 4 ? 1 : Math.max(1, Math.floor(edgeCount / 4))
  for (let i = 0; i < edgeCount; i += step) {
    const a = boundary[i]
    const b = boundary[(i + 1) % edgeCount]
    samples.push(midpoint(a, b))
    if (samples.length >= 5) break
  }

  // One more interior sample pulled toward the longest edge midpoint.
  if (samples.length < 6 && edgeCount >= 3) {
    let bestI = 0
    let bestD = -1
    for (let i = 0; i < edgeCount; i++) {
      const a = boundary[i]
      const b = boundary[(i + 1) % edgeCount]
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      if (d > bestD) {
        bestD = d
        bestI = i
      }
    }
    const mid = midpoint(boundary[bestI], boundary[(bestI + 1) % edgeCount])
    samples.push([
      (center[0] + mid[0]) * 0.5,
      (center[1] + mid[1]) * 0.5,
      (center[2] + mid[2]) * 0.5
    ])
  }

  return samples.slice(0, 6)
}

export function mergeDamagePhotos(lists: PhotoSearchResult[][]): PhotoSearchResult[] {
  const byKey = new Map<string, PhotoSearchResult>()
  for (const list of lists) {
    for (const photo of list) {
      const key =
        photo.filename ||
        (photo.id != null ? String(photo.id) : '') ||
        photo.imageDataUrl?.slice(0, 64) ||
        `${photo.score}-${photo.cameraDistance}`
      const prev = byKey.get(key)
      if (!prev || photo.score > prev.score) byKey.set(key, photo)
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, DAMAGE_PHOTO_COUNT)
}

/** Run photo search at one or more boundary samples and merge results. */
export async function gatherPhotosForDamageBoundary(options: {
  baseURL: string
  boundary: Vec3[]
  cameraPosition: Vec3
  measureFactor: number
  useSPZCoordinates: boolean
  useServerCalibration: boolean
}): Promise<{ photos: PhotoSearchResult[]; sampleCount: number; areaM2: number }> {
  const samples = sampleDamageQueryPoints(options.boundary, options.measureFactor)
  const areaM2 = estimateBoundaryAreaM2(options.boundary, options.measureFactor)
  if (samples.length === 0) {
    return { photos: [], sampleCount: 0, areaM2 }
  }

  const perQuery = Math.max(
    3,
    Math.ceil(DAMAGE_PHOTO_COUNT / Math.max(1, samples.length))
  )

  const responses = await Promise.all(
    samples.map((point) =>
      searchPhotos({
        baseURL: options.baseURL,
        point,
        cameraPosition: options.cameraPosition,
        useSPZCoordinates: options.useSPZCoordinates,
        useServerCalibration: options.useServerCalibration,
        maxResults: perQuery,
        offset: 0
      })
    )
  )

  return {
    photos: mergeDamagePhotos(responses.map((r) => r.photos)),
    sampleCount: samples.length,
    areaM2
  }
}
