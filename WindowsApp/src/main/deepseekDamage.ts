import { handle } from './ipc'
import {
  DAMAGE_CHANNELS,
  type DamageAnalyzeRequest,
  type DamageAnalyzeResponse,
  type DamageOutline,
  type DamageOutlineRegion
} from '../shared/damageChannels'
import {
  USA_PRICING_TEMPLATE,
  type WallDamageReport
} from '../shared/wallDamageReport'

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-flash'
const DEFAULT_MAX_IMAGES = 12
const DEEPSEEK_API_KEY = 'sk-b0542943cbc140e6806d17ce131b8649'

function apiKey(): string {
  return DEEPSEEK_API_KEY
}

function toDataUrl(input: string): string | null {
  const s = (input || '').trim()
  if (!s) return null
  if (s.startsWith('data:image/')) return s
  // Assume jpeg base64 payload
  return `data:image/jpeg;base64,${s.replace(/\s+/g, '')}`
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through — model may wrap JSON in markdown fences.
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim())
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('DeepSeek did not return valid JSON for the damage report.')
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function mergeReport(partial: unknown): WallDamageReport {
  const base = structuredClone(USA_PRICING_TEMPLATE)
  if (!partial || typeof partial !== 'object') return base
  const p = partial as Record<string, unknown>

  const meta = (p.report_metadata ?? {}) as Record<string, unknown>
  const loc = (meta.location ?? {}) as Record<string, unknown>
  base.report_metadata = {
    report_id: asString(meta.report_id, `WR-${Date.now()}`),
    inspection_date: asString(
      meta.inspection_date,
      new Date().toISOString().slice(0, 10)
    ),
    inspector_name: asString(meta.inspector_name, 'Vroomk Damage Estimation'),
    location: {
      state: asString(loc.state, base.report_metadata.location.state),
      country: asString(loc.country, 'USA'),
      room: asString(loc.room, base.report_metadata.location.room),
      wall_orientation: asString(
        loc.wall_orientation,
        base.report_metadata.location.wall_orientation
      )
    }
  }

  const da = (p.damage_assessment ?? {}) as Record<string, unknown>
  const area = (da.damaged_area_estimation ?? {}) as Record<string, unknown>
  const symptoms = Array.isArray(da.visible_symptoms) ? da.visible_symptoms : []
  base.damage_assessment = {
    severity_level: asString(da.severity_level, 'Moderate'),
    damaged_area_estimation: {
      unit: asString(area.unit, 'square_feet'),
      estimated_total_area_sqft: asNumber(area.estimated_total_area_sqft, 0),
      affected_zone: asString(area.affected_zone, '')
    },
    visible_symptoms: symptoms
      .map((item) => {
        const s = (item ?? {}) as Record<string, unknown>
        return {
          type: asString(s.type),
          location: asString(s.location),
          description: asString(s.description)
        }
      })
      .filter((s) => s.type || s.description)
  }
  if (base.damage_assessment.visible_symptoms.length === 0) {
    base.damage_assessment.visible_symptoms = [
      { type: 'Unspecified', location: '', description: 'See images for visual context.' }
    ]
  }

  const ca = (p.cause_analysis ?? {}) as Record<string, unknown>
  const sources = Array.isArray(ca.possible_sources) ? ca.possible_sources : []
  base.cause_analysis = {
    primary_cause_suspected: asString(ca.primary_cause_suspected, ''),
    possible_sources: sources
      .map((item) => {
        const s = (item ?? {}) as Record<string, unknown>
        return {
          source: asString(s.source),
          probability: asString(s.probability),
          description: asString(s.description)
        }
      })
      .filter((s) => s.source || s.description),
    requires_professional_detection: asBool(ca.requires_professional_detection, false)
  }

  const rp = (p.repair_plan ?? {}) as Record<string, unknown>
  const steps = Array.isArray(rp.steps) ? rp.steps.map((s) => asString(s)).filter(Boolean) : []
  base.repair_plan = {
    prerequisite_action: asString(rp.prerequisite_action, ''),
    steps
  }

  const cost = (p.cost_breakdown_estimate ?? {}) as Record<string, unknown>
  const lineItems = Array.isArray(cost.line_items) ? cost.line_items : null
  if (lineItems && lineItems.length > 0) {
    base.cost_breakdown_estimate.line_items = lineItems.map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      return {
        item: asString(row.item, 'Item'),
        min_cost: asNumber(row.min_cost, 0),
        max_cost: asNumber(row.max_cost, 0),
        unit: asString(row.unit, ''),
        notes: asString(row.notes, '')
      }
    })
  }
  base.cost_breakdown_estimate.currency = asString(cost.currency, 'USD')
  base.cost_breakdown_estimate.market_region = asString(
    cost.market_region,
    'USA (Approximate)'
  )
  const total = (cost.total_estimated_cost_range ?? {}) as Record<string, unknown>
  const computedMin = base.cost_breakdown_estimate.line_items.reduce(
    (sum, row) => sum + row.min_cost,
    0
  )
  const computedMax = base.cost_breakdown_estimate.line_items.reduce(
    (sum, row) => sum + row.max_cost,
    0
  )
  base.cost_breakdown_estimate.total_estimated_cost_range = {
    min_total: asNumber(total.min_total, computedMin),
    max_total: asNumber(total.max_total, computedMax),
    disclaimer: asString(
      total.disclaimer,
      USA_PRICING_TEMPLATE.cost_breakdown_estimate.total_estimated_cost_range.disclaimer
    )
  }

  const rec = (p.recommendations ?? {}) as Record<string, unknown>
  const actions = Array.isArray(rec.immediate_actions)
    ? rec.immediate_actions.map((a) => asString(a)).filter(Boolean)
    : []
  if (actions.length > 0) {
    base.recommendations.immediate_actions = actions
  }

  return base
}

const OUTLINE_SCHEMA = {
  damage_outline: {
    image_index: 0,
    regions: [
      {
        label: 'water stain',
        box: { x: 0.2, y: 0.25, w: 0.35, h: 0.4 },
        polygon: [
          [0.22, 0.28],
          [0.52, 0.27],
          [0.55, 0.62],
          [0.24, 0.6]
        ]
      }
    ]
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function parseOutline(partial: unknown, imageCount: number): DamageOutline | null {
  if (!partial || typeof partial !== 'object') return null
  const root = partial as Record<string, unknown>
  const raw = (root.damage_outline ?? root.outline ?? null) as Record<string, unknown> | null
  if (!raw || typeof raw !== 'object') return null

  const imageIndex = Math.max(
    0,
    Math.min(asNumber(raw.image_index, 0), Math.max(0, imageCount - 1))
  )
  const list = Array.isArray(raw.regions) ? raw.regions : []
  const regions: DamageOutlineRegion[] = []

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const boxRaw = (r.box ?? r.bbox ?? {}) as Record<string, unknown>
    let x = asNumber(boxRaw.x, Number.NaN)
    let y = asNumber(boxRaw.y, Number.NaN)
    let w = asNumber(boxRaw.w ?? boxRaw.width, Number.NaN)
    let h = asNumber(boxRaw.h ?? boxRaw.height, Number.NaN)

    // Also accept [x, y, w, h] arrays.
    if (Array.isArray(r.box) && r.box.length >= 4) {
      x = asNumber(r.box[0], x)
      y = asNumber(r.box[1], y)
      w = asNumber(r.box[2], w)
      h = asNumber(r.box[3], h)
    }

    const polyRaw = Array.isArray(r.polygon) ? r.polygon : null
    const polygon: Array<[number, number]> | undefined = polyRaw
      ? polyRaw
          .map((pt) => {
            if (!Array.isArray(pt) || pt.length < 2) return null
            return [clamp01(asNumber(pt[0])), clamp01(asNumber(pt[1]))] as [number, number]
          })
          .filter((pt): pt is [number, number] => Boolean(pt))
      : undefined

    if ((!Number.isFinite(x) || !Number.isFinite(w)) && polygon && polygon.length >= 3) {
      const xs = polygon.map((p) => p[0])
      const ys = polygon.map((p) => p[1])
      x = Math.min(...xs)
      y = Math.min(...ys)
      w = Math.max(...xs) - x
      h = Math.max(...ys) - y
    }

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      continue
    }
    if (w <= 0.01 || h <= 0.01) continue

    regions.push({
      label: asString(r.label || r.type, 'Damage'),
      box: {
        x: clamp01(x),
        y: clamp01(y),
        w: clamp01(w),
        h: clamp01(h)
      },
      polygon: polygon && polygon.length >= 3 ? polygon : undefined
    })
  }

  if (regions.length === 0) return null
  return { imageIndex, regions }
}

function buildPrompt(projectName?: string): string {
  return [
    'You are a wall damage assessment expert for USA residential / light commercial properties.',
    'Analyze the provided photo(s) of a wall (or nearby surface) for visible damage.',
    'Image 1 is the primary photo — localize damage on THAT image.',
    projectName ? `Project context name: ${projectName}` : '',
    'Return ONLY a single JSON object matching this schema exactly (no markdown, no commentary).',
    'Include the full report fields PLUS damage_outline as shown:',
    JSON.stringify({ ...USA_PRICING_TEMPLATE, ...OUTLINE_SCHEMA }, null, 2),
    'Rules:',
    '- Fill severity_level as Low, Moderate, or High.',
    '- Estimate damaged area in square feet when possible; otherwise use your best visual estimate.',
    '- Adjust line_items costs to match the observed damage; keep currency USD and USA market rates.',
    '- Set requires_professional_detection true if mold, active leak, electrical, or structural risk is suspected.',
    '- Prefer concrete, actionable repair steps.',
    '- damage_outline.image_index must be 0 (primary image).',
    '- damage_outline.regions: outline EVERY visibly damaged area on image 1.',
    '- Coordinates are NORMALIZED 0–1 relative to image width/height (x right, y down).',
    '- Prefer a tight polygon around the damage; always also include box {x,y,w,h}.',
    '- If no damage is visible, return regions: [].',
    '- If images are unclear, still produce a complete report and note uncertainty in descriptions.'
  ]
    .filter(Boolean)
    .join('\n')
}

export async function analyzeWallDamage(
  request: DamageAnalyzeRequest
): Promise<DamageAnalyzeResponse> {
  const key = apiKey()
  const maxImages = Math.max(
    1,
    Math.min(request.maxImages ?? DEFAULT_MAX_IMAGES, DEFAULT_MAX_IMAGES)
  )
  const images = (request.imageDataUrls || [])
    .map(toDataUrl)
    .filter((url): url is string => Boolean(url))
    .slice(0, maxImages)

  if (images.length === 0) {
    throw new Error('No images available for damage analysis.')
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: buildPrompt(request.projectName) }
  ]
  images.forEach((url, index) => {
    content.push({
      type: 'image_url',
      // High detail on the primary photo so damage outlines localize better.
      image_url: { url, detail: index === 0 ? 'high' : 'low' }
    })
  })

  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content }],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`DeepSeek error (${response.status}): ${text.slice(0, 240)}`)
  }

  let decoded: { choices?: Array<{ message?: { content?: string } }> }
  try {
    decoded = JSON.parse(text) as typeof decoded
  } catch {
    throw new Error('Could not decode DeepSeek response.')
  }

  const message = decoded.choices?.[0]?.message?.content
  if (!message) throw new Error('DeepSeek returned an empty analysis.')

  const parsed = extractJsonObject(message)
  const report = mergeReport(parsed)
  const outline = parseOutline(parsed, images.length)
  return {
    report,
    model: DEEPSEEK_MODEL,
    imageCount: images.length,
    outline
  }
}

export function registerDamageIpc(): void {
  handle(
    DAMAGE_CHANNELS.analyze,
    async (_event, payload: DamageAnalyzeRequest): Promise<DamageAnalyzeResponse> => {
      return analyzeWallDamage(payload)
    }
  )
}
