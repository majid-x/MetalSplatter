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

function apiKey(): string {
  const key = (process.env.DEEPSEEK_API_KEY || '').trim()
  if (!key) {
    throw new Error(
      'DeepSeek API key missing. Add DEEPSEEK_API_KEY to WindowsApp/.env (see .env.example).'
    )
  }
  return key
}

function toDataUrl(input: string): string | null {
  const s = (input || '').trim()
  if (!s) return null
  if (s.startsWith('data:image/')) return s
  // Assume jpeg base64 payload
  return `data:image/jpeg;base64,${s.replace(/\s+/g, '')}`
}

/** Parse the first complete JSON object/array, ignoring trailing junk the model may append. */
function extractBalancedJson(text: string): unknown {
  const startObj = text.indexOf('{')
  const startArr = text.indexOf('[')
  let start = -1
  let openCh = '{'
  let closeCh = '}'
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj
  } else if (startArr >= 0) {
    start = startArr
    openCh = '['
    closeCh = ']'
  }
  if (start < 0) {
    throw new Error('DeepSeek did not return valid JSON for the damage report.')
  }

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === openCh) depth++
    else if (ch === closeCh) {
      depth--
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1))
      }
    }
  }
  throw new Error('DeepSeek did not return valid JSON for the damage report.')
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function tryParseJsonText(text: string): unknown | null {
  const candidates = [text, stripTrailingCommas(text)]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // keep trying
    }
  }
  try {
    return extractBalancedJson(text)
  } catch {
    try {
      return extractBalancedJson(stripTrailingCommas(text))
    } catch {
      return null
    }
  }
}

/**
 * Tolerant JSON extraction — models often change shape, wrap markdown,
 * append commentary, or emit multiple objects. Never require an exact schema.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const direct = tryParseJsonText(trimmed)
  if (direct && typeof direct === 'object') return direct

  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenced.exec(trimmed))) {
    const inner = tryParseJsonText(match[1].trim())
    if (inner && typeof inner === 'object') return inner
  }

  // Last resort: scan for every `{...}` and pick the largest object-like blob.
  const blobs: unknown[] = []
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '{') continue
    try {
      const value = extractBalancedJson(trimmed.slice(i))
      if (value && typeof value === 'object') blobs.push(value)
    } catch {
      // skip
    }
  }
  if (blobs.length === 0) {
    throw new Error('DeepSeek did not return valid JSON for the damage report.')
  }
  blobs.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)
  return blobs[0]
}

function asString(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return fallback
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,$]/g, '').trim())
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['true', 'yes', '1', 'y'].includes(s)) return true
    if (['false', 'no', '0', 'n'].includes(s)) return false
  }
  if (typeof v === 'number') return v !== 0
  return fallback
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** First present object among alternate model key names. */
function pickRecord(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const hit = asRecord(obj[key])
    if (Object.keys(hit).length > 0) return hit
  }
  // Case-insensitive fallback for drifting keys.
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const key of keys) {
    const real = lower.get(key.toLowerCase())
    if (!real) continue
    const hit = asRecord(obj[real])
    if (Object.keys(hit).length > 0) return hit
  }
  return {}
}

function pickValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key]
  }
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]))
  for (const key of keys) {
    const real = lower.get(key.toLowerCase())
    if (!real) continue
    if (obj[real] !== undefined && obj[real] !== null && obj[real] !== '') return obj[real]
  }
  return undefined
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (v == null) return []
  if (typeof v === 'string' && v.trim()) return [v]
  if (typeof v === 'object') return [v]
  return []
}

/** Map whatever JSON shape the model returns onto our stable report type. */
function mergeReport(partial: unknown): WallDamageReport {
  const base = structuredClone(USA_PRICING_TEMPLATE)
  if (!partial || typeof partial !== 'object') return base
  const p = asRecord(partial)

  try {
    const meta = pickRecord(p, [
      'report_metadata',
      'reportMetadata',
      'metadata',
      'meta',
      'report'
    ])
    const loc = pickRecord(meta, ['location', 'site', 'address'])
    base.report_metadata = {
      report_id: asString(
        pickValue(meta, ['report_id', 'reportId', 'id']),
        `WR-${Date.now()}`
      ),
      inspection_date: asString(
        pickValue(meta, ['inspection_date', 'inspectionDate', 'date']),
        new Date().toISOString().slice(0, 10)
      ),
      inspector_name: asString(
        pickValue(meta, ['inspector_name', 'inspectorName', 'inspector']),
        'Vroomk Damage Estimation'
      ),
      location: {
        state: asString(pickValue(loc, ['state', 'region']), base.report_metadata.location.state),
        country: asString(pickValue(loc, ['country']), 'USA'),
        room: asString(pickValue(loc, ['room', 'area', 'space']), base.report_metadata.location.room),
        wall_orientation: asString(
          pickValue(loc, ['wall_orientation', 'wallOrientation', 'wall', 'orientation']),
          base.report_metadata.location.wall_orientation
        )
      }
    }

    const da = pickRecord(p, [
      'damage_assessment',
      'damageAssessment',
      'assessment',
      'damage'
    ])
    const area = pickRecord(da, [
      'damaged_area_estimation',
      'damagedAreaEstimation',
      'area',
      'area_estimation',
      'areaEstimation'
    ])
    const symptoms = asArray(
      pickValue(da, ['visible_symptoms', 'visibleSymptoms', 'symptoms', 'findings'])
    )
    base.damage_assessment = {
      severity_level: asString(
        pickValue(da, ['severity_level', 'severityLevel', 'severity']),
        'Moderate'
      ),
      damaged_area_estimation: {
        unit: asString(pickValue(area, ['unit']), 'square_feet'),
        estimated_total_area_sqft: asNumber(
          pickValue(area, [
            'estimated_total_area_sqft',
            'estimatedTotalAreaSqft',
            'area_sqft',
            'areaSqft',
            'sqft',
            'square_feet',
            'total_area'
          ]),
          0
        ),
        affected_zone: asString(
          pickValue(area, ['affected_zone', 'affectedZone', 'zone', 'location']),
          ''
        )
      },
      visible_symptoms: symptoms
        .map((item) => {
          if (typeof item === 'string') {
            return { type: item, location: '', description: '' }
          }
          const s = asRecord(item)
          return {
            type: asString(pickValue(s, ['type', 'name', 'symptom', 'title'])),
            location: asString(pickValue(s, ['location', 'where', 'position'])),
            description: asString(pickValue(s, ['description', 'details', 'note', 'text']))
          }
        })
        .filter((s) => s.type || s.description)
    }
    if (base.damage_assessment.visible_symptoms.length === 0) {
      const summary = asString(pickValue(da, ['summary', 'overview', 'notes']))
      base.damage_assessment.visible_symptoms = [
        {
          type: 'Observed damage',
          location: '',
          description: summary || 'See images for visual context.'
        }
      ]
    }

    const ca = pickRecord(p, ['cause_analysis', 'causeAnalysis', 'cause', 'causes'])
    const sources = asArray(
      pickValue(ca, ['possible_sources', 'possibleSources', 'sources', 'likely_causes'])
    )
    base.cause_analysis = {
      primary_cause_suspected: asString(
        pickValue(ca, [
          'primary_cause_suspected',
          'primaryCauseSuspected',
          'primary_cause',
          'primaryCause',
          'cause'
        ]),
        ''
      ),
      possible_sources: sources
        .map((item) => {
          if (typeof item === 'string') {
            return { source: item, probability: '', description: '' }
          }
          const s = asRecord(item)
          return {
            source: asString(pickValue(s, ['source', 'name', 'cause', 'title'])),
            probability: asString(pickValue(s, ['probability', 'likelihood', 'confidence'])),
            description: asString(pickValue(s, ['description', 'details', 'note', 'text']))
          }
        })
        .filter((s) => s.source || s.description),
      requires_professional_detection: asBool(
        pickValue(ca, [
          'requires_professional_detection',
          'requiresProfessionalDetection',
          'professional_detection',
          'needs_pro'
        ]),
        false
      )
    }

    const rp = pickRecord(p, ['repair_plan', 'repairPlan', 'repairs', 'repair'])
    const steps = asArray(pickValue(rp, ['steps', 'actions', 'plan']))
      .map((s) => asString(s))
      .filter(Boolean)
    base.repair_plan = {
      prerequisite_action: asString(
        pickValue(rp, ['prerequisite_action', 'prerequisiteAction', 'first', 'prerequisite']),
        ''
      ),
      steps
    }

    const cost = pickRecord(p, [
      'cost_breakdown_estimate',
      'costBreakdownEstimate',
      'cost_estimate',
      'costEstimate',
      'costs',
      'pricing'
    ])
    const lineItems = asArray(pickValue(cost, ['line_items', 'lineItems', 'items', 'breakdown']))
    if (lineItems.length > 0) {
      base.cost_breakdown_estimate.line_items = lineItems.map((item) => {
        const row = asRecord(item)
        return {
          item: asString(pickValue(row, ['item', 'name', 'title', 'label']), 'Item'),
          min_cost: asNumber(
            pickValue(row, ['min_cost', 'minCost', 'min', 'low', 'cost_min']),
            0
          ),
          max_cost: asNumber(
            pickValue(row, ['max_cost', 'maxCost', 'max', 'high', 'cost_max', 'cost']),
            0
          ),
          unit: asString(pickValue(row, ['unit']), ''),
          notes: asString(pickValue(row, ['notes', 'note', 'details', 'description']), '')
        }
      })
    }
    base.cost_breakdown_estimate.currency = asString(
      pickValue(cost, ['currency']),
      'USD'
    )
    base.cost_breakdown_estimate.market_region = asString(
      pickValue(cost, ['market_region', 'marketRegion', 'market', 'region']),
      'USA (Approximate)'
    )
    const total = pickRecord(cost, [
      'total_estimated_cost_range',
      'totalEstimatedCostRange',
      'total',
      'total_range',
      'totalRange'
    ])
    const computedMin = base.cost_breakdown_estimate.line_items.reduce(
      (sum, row) => sum + row.min_cost,
      0
    )
    const computedMax = base.cost_breakdown_estimate.line_items.reduce(
      (sum, row) => sum + row.max_cost,
      0
    )
    base.cost_breakdown_estimate.total_estimated_cost_range = {
      min_total: asNumber(
        pickValue(total, ['min_total', 'minTotal', 'min', 'low']),
        computedMin
      ),
      max_total: asNumber(
        pickValue(total, ['max_total', 'maxTotal', 'max', 'high']),
        computedMax
      ),
      disclaimer: asString(
        pickValue(total, ['disclaimer', 'note', 'notes']),
        USA_PRICING_TEMPLATE.cost_breakdown_estimate.total_estimated_cost_range.disclaimer
      )
    }

    const rec = pickRecord(p, ['recommendations', 'recommendation', 'next_steps', 'nextSteps'])
    const actions = asArray(
      pickValue(rec, ['immediate_actions', 'immediateActions', 'actions', 'items'])
    )
      .map((a) => asString(a))
      .filter(Boolean)
    if (actions.length > 0) {
      base.recommendations.immediate_actions = actions
    }
  } catch {
    // Dynamic JSON drifted hard — keep template defaults rather than failing the tool.
  }

  return base
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

function parseOutline(partial: unknown, imageCount: number): DamageOutline | null {
  if (!partial || typeof partial !== 'object') return null
  const root = asRecord(partial)
  const raw = pickRecord(root, [
    'damage_outline',
    'damageOutline',
    'outline',
    'outlines',
    'regions_outline'
  ])
  // Some models return regions at the top level.
  const list = asArray(
    pickValue(Object.keys(raw).length ? raw : root, [
      'regions',
      'boxes',
      'polygons',
      'damage_regions',
      'damageRegions'
    ])
  )
  if (list.length === 0) return null

  const imageIndex = Math.max(
    0,
    Math.min(
      asNumber(
        pickValue(raw, ['image_index', 'imageIndex', 'index']) ??
          pickValue(root, ['best_image_index', 'bestImageIndex']),
        0
      ),
      Math.max(0, imageCount - 1)
    )
  )
  const regions: DamageOutlineRegion[] = []

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = asRecord(item)
    const boxRaw = pickRecord(r, ['box', 'bbox', 'bounds', 'rect'])
    let x = asNumber(pickValue(boxRaw, ['x', 'left']), Number.NaN)
    let y = asNumber(pickValue(boxRaw, ['y', 'top']), Number.NaN)
    let w = asNumber(pickValue(boxRaw, ['w', 'width']), Number.NaN)
    let h = asNumber(pickValue(boxRaw, ['h', 'height']), Number.NaN)

    // Also accept [x, y, w, h] arrays.
    const boxArr = pickValue(r, ['box', 'bbox'])
    if (Array.isArray(boxArr) && boxArr.length >= 4) {
      x = asNumber(boxArr[0], x)
      y = asNumber(boxArr[1], y)
      w = asNumber(boxArr[2], w)
      h = asNumber(boxArr[3], h)
    }

    const polyRaw = asArray(pickValue(r, ['polygon', 'points', 'path', 'coords']))
    const polygon: Array<[number, number]> | undefined =
      polyRaw.length >= 3
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
      label: asString(pickValue(r, ['label', 'type', 'name', 'title']), 'Damage'),
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

function parseBestImageIndex(partial: unknown, imageCount: number): number {
  if (!partial || typeof partial !== 'object') return 0
  const root = partial as Record<string, unknown>
  const direct = asNumber(
    root.best_image_index ?? root.bestImageIndex ?? root.outline_image_index,
    Number.NaN
  )
  if (Number.isFinite(direct)) {
    return Math.max(0, Math.min(Math.floor(direct), imageCount - 1))
  }
  const outline = (root.damage_outline ?? {}) as Record<string, unknown>
  const fromOutline = asNumber(outline.image_index, Number.NaN)
  if (Number.isFinite(fromOutline)) {
    return Math.max(0, Math.min(Math.floor(fromOutline), imageCount - 1))
  }
  return 0
}

function scalePromptBlock(measureFactor?: number): string {
  const factor =
    typeof measureFactor === 'number' && Number.isFinite(measureFactor) && measureFactor > 0
      ? measureFactor
      : null
  if (!factor) {
    return [
      'Scale: no project measure_factor was provided.',
      'Estimate area cautiously from visual cues and note uncertainty.'
    ].join('\n')
  }
  const meters = factor
  const feet = factor * 3.280839895
  return [
    'Project scale calibration (from database — REQUIRED for area & cost):',
    `- measure_factor = ${factor}`,
    '- Formula: scene_units × measure_factor = real meters',
    `- 1 scene unit ≈ ${meters.toFixed(6)} m ≈ ${feet.toFixed(4)} ft`,
    '- Convert area to square feet (1 m² = 10.7639 sq ft).',
    '- Use this scale for estimated_total_area_sqft and for sizing per_sqft / material line items.',
    '- Do NOT invent absolute size from photos alone — ground estimates in this calibration.',
    '- If relative damage spans roughly L scene-units by H scene-units on the wall plane, area_m2 ≈ (L×factor)×(H×factor).'
  ].join('\n')
}

function buildPassAPrompt(
  projectName: string | undefined,
  imageCount: number,
  measureFactor?: number
): string {
  return [
    'You are a wall damage assessment expert for USA residential / light commercial properties.',
    `You will receive ${imageCount} photo(s) of a wall / nearby surface (Image 1 … Image ${imageCount}).`,
    'PASS A — classify damage and pick the best photo for outlining. Do NOT return tight polygons.',
    projectName ? `Project context name: ${projectName}` : '',
    scalePromptBlock(measureFactor),
    'Return ONLY a single JSON object (no markdown, no commentary) with:',
    '1) The full report schema below',
    '2) best_image_index: 0-based index of the photo that shows the damage MOST CLEARLY for outlining',
    '3) damage_outline may be omitted or regions: [] (outlining happens in a later pass)',
    JSON.stringify(
      {
        ...USA_PRICING_TEMPLATE,
        best_image_index: 0,
        damage_outline: { image_index: 0, regions: [] as unknown[] }
      },
      null,
      2
    ),
    'Rules:',
    '- Fill severity_level as Low, Moderate, or High.',
    '- estimated_total_area_sqft MUST be in real square feet using measure_factor when provided.',
    '- Adjust line_items costs for observed damage and scaled area; currency USD; USA rates.',
    '- Set requires_professional_detection true if mold, active leak, electrical, or structural risk is suspected.',
    '- Prefer concrete repair steps.',
    `- best_image_index MUST be an integer from 0 to ${imageCount - 1}.`,
    '- Prefer a photo where damage is large, sharp, frontal, and not heavily occluded.',
    '- If no damage is visible, still fill the report and set best_image_index to 0.',
    '- Do NOT invent precise outline coordinates in this pass.'
  ]
    .filter(Boolean)
    .join('\n')
}

function buildPassBPrompt(hints?: {
  severity?: string
  symptoms?: string
}): string {
  return [
    'You are a wall damage localization expert.',
    'PASS B — You receive ONE photo only. Draw TIGHT outlines around every visibly damaged area.',
    hints?.severity ? `Prior severity assessment: ${hints.severity}.` : '',
    hints?.symptoms ? `Visible symptoms context: ${hints.symptoms}.` : '',
    'Return ONLY a single JSON object (no markdown, no commentary):',
    JSON.stringify(
      {
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
      },
      null,
      2
    ),
    'Rules:',
    '- damage_outline.image_index must be 0 (this single image).',
    '- Outline EVERY visibly damaged region; separate regions if disconnected.',
    '- Coordinates are NORMALIZED 0–1 (x right, y down) relative to THIS image.',
    '- Prefer a tight polygon hugging the damage edge (6–20 points). Also include box {x,y,w,h}.',
    '- Boxes/polygons must be TIGHT — minimize empty wall inside the outline.',
    '- Do not outline plastic sheeting, tape, furniture, or undamaged wall.',
    '- If no damage is visible, return regions: [].'
  ]
    .filter(Boolean)
    .join('\n')
}

async function callDeepSeekJson(
  key: string,
  content: Array<Record<string, unknown>>,
  temperature = 0.2
): Promise<unknown> {
  const response = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content }],
      temperature,
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
  try {
    return extractJsonObject(message)
  } catch {
    // Dynamic / malformed model JSON — keep going with an empty object so
    // mergeReport can still produce a usable template-backed report.
    return {}
  }
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

  // --- Pass A: assess damage across nearby photos + pick best frame for outline ---
  const passAContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: buildPassAPrompt(request.projectName, images.length, request.measureFactor)
    }
  ]
  images.forEach((url) => {
    passAContent.push({
      type: 'image_url',
      image_url: { url, detail: 'low' }
    })
  })

  const passA = await callDeepSeekJson(key, passAContent, 0.2)
  const report = mergeReport(passA)
  const bestIndex = parseBestImageIndex(passA, images.length)
  const winnerUrl = images[bestIndex] ?? images[0]

  // --- Pass B: high-detail outline on the winner photo only ---
  const symptomHint = report.damage_assessment.visible_symptoms
    .map((s) => [s.type, s.description].filter(Boolean).join(': '))
    .filter(Boolean)
    .slice(0, 4)
    .join('; ')

  const passBContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: buildPassBPrompt({
        severity: report.damage_assessment.severity_level,
        symptoms: symptomHint
      })
    },
    {
      type: 'image_url',
      image_url: { url: winnerUrl, detail: 'high' }
    }
  ]

  let outline: DamageOutline | null = null
  try {
    const passB = await callDeepSeekJson(key, passBContent, 0.1)
    const local = parseOutline(passB, 1)
    if (local && local.regions.length > 0) {
      outline = { imageIndex: bestIndex, regions: local.regions }
    }
  } catch {
    // Fall back to any rough outline Pass A may have included.
    const fallback = parseOutline(passA, images.length)
    if (fallback) {
      outline = { imageIndex: bestIndex, regions: fallback.regions }
    }
  }

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
      try {
        return await analyzeWallDamage(payload)
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error)
        // Keep IPC errors user-facing and free of vendor/API internals.
        throw new Error(
          /json|syntax|deepseek|decode|empty analysis/i.test(raw)
            ? 'Could not complete damage estimation. Try another point.'
            : raw
        )
      }
    }
  )
}
