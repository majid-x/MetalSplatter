import type { WallDamageReport } from '../../../shared/wallDamageReport'
import type { PhotoSearchResult } from './photoSearch'
import { annotateDamageImage } from './annotateDamageImage'

export const DAMAGE_PHOTO_COUNT = 12

export async function analyzeDamageFromPhotos(
  photos: PhotoSearchResult[],
  projectName?: string
): Promise<{
  report: WallDamageReport
  imageCount: number
  model: string
  annotatedImageDataUrl: string | null
}> {
  const imageDataUrls = photos
    .map((photo) => photo.imageDataUrl)
    .filter((url): url is string => Boolean(url && url.startsWith('data:image/')))
    .slice(0, DAMAGE_PHOTO_COUNT)

  if (imageDataUrls.length === 0) {
    throw new Error('No photo images available to analyze. Try another point.')
  }

  const response = await window.avgs.damage.analyze({
    imageDataUrls,
    projectName,
    maxImages: DAMAGE_PHOTO_COUNT
  })

  const outlineIndex = response.outline?.imageIndex ?? 0
  const sourceUrl =
    imageDataUrls[Math.min(Math.max(outlineIndex, 0), imageDataUrls.length - 1)] ??
    imageDataUrls[0]

  let annotatedImageDataUrl: string | null = null
  try {
    annotatedImageDataUrl = await annotateDamageImage(sourceUrl, response.outline)
  } catch {
    // Fall back to the raw primary photo if canvas annotation fails.
    annotatedImageDataUrl = sourceUrl
  }

  return {
    report: response.report,
    imageCount: response.imageCount,
    model: response.model,
    annotatedImageDataUrl
  }
}
