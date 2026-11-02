import { productSearchConfig } from './productSearchConfig'

export type ProductSearchMatch = {
  id: string
  title: string
  link: string | null
  thumbnailURL: string | null
  price: string | null
  source: string | null
}

async function uploadToCloudinary(file: Blob): Promise<string> {
  const cloud = productSearchConfig.cloudinaryCloudName
  const preset = productSearchConfig.cloudinaryUploadPreset
  const form = new FormData()
  form.append('upload_preset', preset)
  form.append('file', file, 'screenshot.png')

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, {
    method: 'POST',
    body: form
  })
  const json = (await response.json()) as { secure_url?: string; error?: { message?: string } }
  if (!response.ok || !json.secure_url) {
    throw new Error(json.error?.message ?? `Upload failed (HTTP ${response.status})`)
  }
  return json.secure_url
}

export async function searchProductsFromImage(file: Blob): Promise<ProductSearchMatch[]> {
  if (!productSearchConfig.isConfigured) {
    throw new Error('Product search is not configured.')
  }
  if (file.size <= 0) {
    throw new Error('Screenshot was empty')
  }

  const imageURL = await uploadToCloudinary(file)
  const url = new URL('https://www.searchapi.io/api/v1/search')
  url.searchParams.set('engine', 'google_lens')
  url.searchParams.set('url', imageURL)
  url.searchParams.set('search_type', 'visual_matches')

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${productSearchConfig.searchApiKey}`,
      'Content-Type': 'application/json'
    }
  })
  const json = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(`Search failed (HTTP ${response.status})`)
  }

  const rawMatches =
    (json.visual_matches as Record<string, unknown>[] | undefined) ??
    (json.product_results as Record<string, unknown>[] | undefined) ??
    []

  const matches: ProductSearchMatch[] = rawMatches.map((item, index) => {
    const title =
      (typeof item.title === 'string' && item.title) ||
      (typeof item.name === 'string' && item.name) ||
      'Untitled result'
    const link =
      (typeof item.link === 'string' && item.link) ||
      (typeof item.source_link === 'string' && item.source_link) ||
      (typeof item.url === 'string' && item.url) ||
      null
    const thumb =
      (typeof item.thumbnail === 'string' && item.thumbnail) ||
      (typeof item.thumbnail_url === 'string' && item.thumbnail_url) ||
      (typeof item.image === 'string' && item.image) ||
      null
    const price =
      typeof item.price === 'string'
        ? item.price
        : typeof (item.price as { value?: string } | undefined)?.value === 'string'
          ? (item.price as { value: string }).value
          : null

    return {
      id: `${index}-${title}`,
      title,
      link,
      thumbnailURL: thumb,
      price,
      source: typeof item.source === 'string' ? item.source : null
    }
  })

  if (matches.length === 0) {
    throw new Error('No visual matches found. Try a clearer object.')
  }
  return matches
}
