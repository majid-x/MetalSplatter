export type PhotoSearchResult = {
  id: number
  filename: string
  score: number
  cameraDistance: number
  imageDataUrl: string | null
  rank: number | null
  is360: boolean
  imageURLPath: string | null
}

export type PhotoSearchResponse = {
  photos: PhotoSearchResult[]
  hasMore: boolean
}

/**
 * Mac PhotoSearchClient.toAPIPoint — expects Mac *display/nav* coords
 * (mediaServer already maps SuperSplat world → that frame via toMacPhotoPoint).
 * When spz && !calibration, apply another 180° Z undo for COLMAP.
 */
function apiPoint(point: [number, number, number], useSPZ: boolean, useServerCalibration: boolean): [number, number, number] {
  const sendRaw = useServerCalibration || !useSPZ
  if (sendRaw) return point
  return [-point[0], -point[1], point[2]]
}

/** Build POST URL for photo search — same as Mac `appendingPathComponent("query")`. */
export function resolvePhotoQueryURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, '')
  if (/\/query$/i.test(trimmed)) return trimmed
  return `${trimmed}/query`
}

function decodeImageDataUrl(item: Record<string, unknown>): string | null {
  const dataUrl = item.data_url
  if (typeof dataUrl === 'string' && dataUrl.includes(',')) return dataUrl

  const b64 = (item.image_b64 ?? item.base64) as string | undefined
  if (typeof b64 === 'string' && b64.length > 0) {
    const contentType = typeof item.content_type === 'string' ? item.content_type : 'image/jpeg'
    return `data:${contentType};base64,${b64}`
  }
  return null
}

export async function searchPhotos(options: {
  baseURL: string
  point: [number, number, number]
  cameraPosition?: [number, number, number] | null
  useSPZCoordinates: boolean
  useServerCalibration: boolean
  maxResults?: number
  offset?: number
}): Promise<PhotoSearchResponse> {
  const {
    baseURL,
    point,
    cameraPosition,
    useSPZCoordinates,
    useServerCalibration,
    maxResults = 6,
    offset = 0
  } = options

  const sendPoint = apiPoint(point, useSPZCoordinates, useServerCalibration)
  // Supabase photo_api is the API root; Mac appends "query". If the DB value
  // already ends with /query, don't double it (that returns 404).
  const url = resolvePhotoQueryURL(baseURL)

  const body: Record<string, unknown> = {
    x: sendPoint[0],
    y: sendPoint[1],
    z: sendPoint[2],
    max_results: maxResults,
    center_threshold: 0.3,
    include_images: true,
    add_marker: false,
    offset
  }

  if (cameraPosition) {
    const cam = apiPoint(cameraPosition, useSPZCoordinates, useServerCalibration)
    const dx = sendPoint[0] - cam[0]
    const dy = sendPoint[1] - cam[1]
    const dz = sendPoint[2] - cam[2]
    const len = Math.hypot(dx, dy, dz)
    if (len > 1e-6) {
      body.view_direction = [dx / len, dy / len, dz / len]
      body.max_view_angle = 55
      body.camera_position = cam
    }
  }

  // Electron renderer hits CORS on ngrok/photo hosts — proxy through main (same as Mac native).
  const response = await window.avgs.http.request({
    url: url.toString(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'Photo API not found (404). Check this project’s photo_api URL in Supabase — the host may be down or the path wrong.'
      )
    }
    throw new Error(`Photo API error (${response.status})`)
  }

  let decoded: {
    has_more?: boolean
    results?: Record<string, unknown>[]
    images?: Record<string, unknown>[]
  }
  try {
    decoded = JSON.parse(response.text) as typeof decoded
  } catch {
    throw new Error('Could not decode photo API response')
  }

  const items = decoded.images ?? decoded.results ?? []
  const photos: PhotoSearchResult[] = items
    .map((item, index) => {
      const imageDataUrl = decodeImageDataUrl(item)
      if (!imageDataUrl && !item.image_url) return null
      const id =
        (typeof item.image_id === 'number' ? item.image_id : null) ??
        (typeof item.rank === 'number' ? item.rank : null) ??
        index
      return {
        id,
        filename:
          (typeof item.filename === 'string' && item.filename) ||
          (typeof item.image_name === 'string' && item.image_name) ||
          `image ${id}`,
        score: typeof item.score === 'number' ? item.score : 0,
        cameraDistance: typeof item.camera_distance === 'number' ? item.camera_distance : 0,
        imageDataUrl,
        rank: typeof item.rank === 'number' ? item.rank : null,
        is360: item.is_360 === true,
        imageURLPath: typeof item.image_url === 'string' ? item.image_url : null
      } satisfies PhotoSearchResult
    })
    .filter((photo): photo is PhotoSearchResult => photo != null)

  if (photos.length === 0) {
    throw new Error('No matching photos')
  }

  return { photos, hasMore: decoded.has_more === true }
}
