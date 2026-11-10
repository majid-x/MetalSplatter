import type { WallDamageReport } from '../../../shared/wallDamageReport'
import type { DamageOutline } from '../../../shared/damageChannels'
import type { PhotoSearchResult } from './photoSearch'
import { annotateDamageImage } from './annotateDamageImage'

export const DAMAGE_PHOTO_COUNT = 12

export async function analyzeDamageFromPhotos(
  photos: PhotoSearchResult[],
  options?: {
    projectName?: string
    measureFactor?: number
    /** Viewer screenshot with orange marked region — stay-inside guide only. */
    regionGuideImageDataUrl?: string | null
  }
): Promise<{
  report: WallDamageReport
  imageCount: number
  model: string
  annotatedImageDataUrl: string | null
  annotatedImageDataUrls: string[]
}> {
  const imageDataUrls = photos
    .map((photo) => photo.imageDataUrl)
    .filter((url): url is string => Boolean(url && url.startsWith('data:image/')))
    .slice(0, DAMAGE_PHOTO_COUNT)

  if (imageDataUrls.length === 0) {
    throw new Error('No photo images available to analyze. Try another point.')
  }

  const guide =
    options?.regionGuideImageDataUrl &&
    options.regionGuideImageDataUrl.startsWith('data:image/')
      ? options.regionGuideImageDataUrl
      : undefined

  const response = await window.avgs.damage.analyze({
    imageDataUrls,
    projectName: options?.projectName,
    measureFactor: options?.measureFactor,
    maxImages: DAMAGE_PHOTO_COUNT,
    regionGuideImageDataUrl: guide
  })

  const outlineList: DamageOutline[] =
    response.outlines?.length > 0
      ? response.outlines
      : response.outline
        ? [response.outline]
        : []

  const annotatedImageDataUrls: string[] = []
  for (const outline of outlineList) {
    const idx = Math.min(Math.max(outline.imageIndex, 0), imageDataUrls.length - 1)
    const sourceUrl = imageDataUrls[idx] ?? imageDataUrls[0]
    try {
      annotatedImageDataUrls.push(await annotateDamageImage(sourceUrl, outline))
    } catch {
      annotatedImageDataUrls.push(sourceUrl)
    }
  }

  if (annotatedImageDataUrls.length === 0 && imageDataUrls[0]) {
    annotatedImageDataUrls.push(imageDataUrls[0])
  }

  return {
    report: response.report,
    imageCount: response.imageCount,
    model: response.model,
    annotatedImageDataUrl: annotatedImageDataUrls[0] ?? null,
    annotatedImageDataUrls
  }
}
