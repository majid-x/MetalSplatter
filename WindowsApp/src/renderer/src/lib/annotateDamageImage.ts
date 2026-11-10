import type { DamageOutline } from '../../../shared/damageChannels'

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load damage photo for outlining.'))
    img.src = dataUrl
  })
}

/**
 * Draw red outlines for damaged regions onto a photo; returns a JPEG data URL.
 * When `markedArea` is given, the user's marked region is drawn as an orange dashed line too.
 */
export async function annotateDamageImage(
  sourceDataUrl: string,
  outline: DamageOutline | null | undefined,
  markedArea?: Array<[number, number]> | null
): Promise<string> {
  const img = await loadImage(sourceDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth || img.width
  canvas.height = img.naturalHeight || img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceDataUrl

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

  if (markedArea && markedArea.length >= 3) {
    ctx.beginPath()
    markedArea.forEach(([nx, ny], i) => {
      const x = clamp01(nx) * canvas.width
      const y = clamp01(ny) * canvas.height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.95)'
    ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.004))
    ctx.setLineDash([10, 6])
    ctx.stroke()
    ctx.setLineDash([])
  }

  const regions = outline?.regions ?? []
  if (regions.length === 0) {
    return canvas.toDataURL('image/jpeg', 0.92)
  }

  const stroke = 'rgba(239, 68, 68, 0.95)'
  const fill = 'rgba(239, 68, 68, 0.22)'
  const lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.006))

  const hasMark = Boolean(markedArea && markedArea.length >= 3)
  const clipToMark = () => {
    if (!hasMark || !markedArea) return
    ctx.beginPath()
    markedArea.forEach(([nx, ny], i) => {
      const x = clamp01(nx) * canvas.width
      const y = clamp01(ny) * canvas.height
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.closePath()
    ctx.clip()
  }

  for (const region of regions) {
    const poly = region.polygon?.filter(
      (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])
    )
    // Never paint damage outside the user's marked area.
    ctx.save()
    clipToMark()
    ctx.beginPath()
    if (poly && poly.length >= 3) {
      poly.forEach(([nx, ny], i) => {
        const x = clamp01(nx) * canvas.width
        const y = clamp01(ny) * canvas.height
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
    } else {
      const x = clamp01(region.box.x) * canvas.width
      const y = clamp01(region.box.y) * canvas.height
      const w = clamp01(region.box.w) * canvas.width
      const h = clamp01(region.box.h) * canvas.height
      ctx.rect(x, y, w, h)
    }

    ctx.fillStyle = fill
    ctx.fill()
    ctx.strokeStyle = stroke
    ctx.lineWidth = lineWidth
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.restore()

    const label = (region.label || '').trim()
    if (label) {
      const lx =
        poly && poly.length >= 3
          ? clamp01(poly[0][0]) * canvas.width
          : clamp01(region.box.x) * canvas.width
      const ly =
        poly && poly.length >= 3
          ? clamp01(poly[0][1]) * canvas.height
          : clamp01(region.box.y) * canvas.height
      const fontSize = Math.max(12, Math.round(Math.min(canvas.width, canvas.height) * 0.028))
      ctx.font = `600 ${fontSize}px system-ui, sans-serif`
      ctx.textBaseline = 'bottom'
      const padX = 6
      const padY = 4
      const metrics = ctx.measureText(label)
      const boxH = fontSize + padY * 2
      const boxW = metrics.width + padX * 2
      const labelY = Math.max(boxH + 2, ly - 6)
      ctx.fillStyle = 'rgba(185, 28, 28, 0.92)'
      ctx.fillRect(lx, labelY - boxH, boxW, boxH)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, lx + padX, labelY - padY)
    }
  }

  return canvas.toDataURL('image/jpeg', 0.92)
}
