/** Structured wall-damage report — drives Damage Estimation UI. */

export type SeverityLevel = 'Low' | 'Moderate' | 'High' | string

/** Where the damaged area number came from. */
export type AreaSource = 'measured' | 'estimated'

export type CostLineItem = {
  item: string
  /** Flat cost, or rate per sq ft when unit === 'per_sqft'. */
  min_cost: number
  max_cost: number
  /** '' = flat amount, 'per_sqft' = rate × damaged area. Other strings are shown as-is and treated as flat. */
  unit?: string
  notes?: string
  /** Sq ft the per_sqft rate was multiplied by (computed in code, never by the model). */
  quantity_sqft?: number
  /** Final line amounts that go into the total (computed in code). */
  extended_min?: number
  extended_max?: number
  /** True when a per_sqft item could not be priced (no area) and is left out of the total. */
  excluded_from_total?: boolean
}

export type WallDamageReport = {
  report_metadata: {
    report_id: string
    inspection_date: string
    inspector_name: string
    location: {
      state: string
      country: string
      room: string
      wall_orientation: string
    }
  }
  damage_assessment: {
    severity_level: SeverityLevel
    damaged_area_estimation: {
      unit: string
      estimated_total_area_sqft: number
      affected_zone: string
      /** measured = from the 3D outline × measure factor; estimated = model guess from photos. */
      area_source?: AreaSource
      /** What the model guessed, kept for reference when the measured value overrides it. */
      model_estimated_area_sqft?: number
    }
    visible_symptoms: Array<{
      type: string
      location: string
      description: string
    }>
  }
  cause_analysis: {
    primary_cause_suspected: string
    possible_sources: Array<{
      source: string
      probability: string
      description: string
    }>
    requires_professional_detection: boolean
  }
  repair_plan: {
    prerequisite_action: string
    steps: string[]
  }
  cost_breakdown_estimate: {
    currency: string
    market_region: string
    line_items: CostLineItem[]
    total_estimated_cost_range: {
      min_total: number
      max_total: number
      disclaimer: string
    }
  }
  recommendations: {
    immediate_actions: string[]
  }
}

export const DEFAULT_COST_DISCLAIMER =
  'Estimates based on average USA contractor rates. Final cost depends on hidden damage, materials, access, and local labor rates.'

/**
 * Empty report — the base the model output is merged onto.
 * Deliberately has NO default line items / severity / symptoms, so a weak or
 * failed model response can never show up as a made-up "real" estimate.
 */
export function emptyReport(): WallDamageReport {
  return {
    report_metadata: {
      report_id: '',
      inspection_date: '',
      inspector_name: '',
      location: { state: '', country: '', room: '', wall_orientation: '' }
    },
    damage_assessment: {
      severity_level: '',
      damaged_area_estimation: {
        unit: 'square_feet',
        estimated_total_area_sqft: 0,
        affected_zone: ''
      },
      visible_symptoms: []
    },
    cause_analysis: {
      primary_cause_suspected: '',
      possible_sources: [],
      requires_professional_detection: false
    },
    repair_plan: { prerequisite_action: '', steps: [] },
    cost_breakdown_estimate: {
      currency: 'USD',
      market_region: 'USA (Approximate)',
      line_items: [],
      total_estimated_cost_range: {
        min_total: 0,
        max_total: 0,
        disclaimer: DEFAULT_COST_DISCLAIMER
      }
    },
    recommendations: { immediate_actions: [] }
  }
}

/**
 * Schema example shown to the model. Values are placeholders only — the model
 * must choose line items that match the damage it actually sees.
 */
export const REPORT_SCHEMA_EXAMPLE = {
  report_metadata: {
    report_id: '',
    inspection_date: 'YYYY-MM-DD',
    inspector_name: '',
    location: { state: '', country: 'USA', room: '<room if visible, e.g. Kitchen>', wall_orientation: '' }
  },
  damage_assessment: {
    severity_level: 'Low | Moderate | High',
    damaged_area_estimation: {
      unit: 'square_feet',
      estimated_total_area_sqft: 0,
      affected_zone: '<where on the wall>'
    },
    visible_symptoms: [{ type: '<short name, e.g. crack>', location: '', description: '' }]
  },
  cause_analysis: {
    primary_cause_suspected: '',
    possible_sources: [{ source: '', probability: 'Low | Medium | High', description: '' }],
    requires_professional_detection: false
  },
  repair_plan: { prerequisite_action: '', steps: ['<step>'] },
  cost_breakdown_estimate: {
    currency: 'USD',
    market_region: 'USA (Approximate)',
    line_items: [
      { item: '<flat-priced repair item>', min_cost: 0, max_cost: 0, unit: '', notes: '' },
      { item: '<area-priced item>', min_cost: 0, max_cost: 0, unit: 'per_sqft', notes: '' }
    ],
    total_estimated_cost_range: { min_total: 0, max_total: 0, disclaimer: '' }
  },
  recommendations: { immediate_actions: ['<action>'] }
}

/** Normalize the many ways a model writes "per square foot". */
export function normalizeCostUnit(unit: string | undefined): string {
  const u = (unit || '').trim().toLowerCase()
  if (!u || u === 'flat' || u === 'each' || u === 'lump_sum' || u === 'lump sum' || u === 'total') return ''
  if (/(sq\.?\s*_?f|sqft|square[\s_-]*f|ft²|ft2)/.test(u)) return 'per_sqft'
  return unit!.trim()
}

/**
 * Totals are always computed here — never trusted from the model.
 * Flat items count once; per_sqft items are rate × area. A per_sqft item with
 * no known area is excluded from the total (and flagged) rather than counted as $1–3.
 */
export function computeCostTotals(report: WallDamageReport): WallDamageReport {
  const area = report.damage_assessment.damaged_area_estimation.estimated_total_area_sqft
  const hasArea = Number.isFinite(area) && area > 0
  let minTotal = 0
  let maxTotal = 0
  const items = report.cost_breakdown_estimate.line_items.map((raw) => {
    const row: CostLineItem = { ...raw, unit: normalizeCostUnit(raw.unit) }
    let lo = Math.max(0, Number.isFinite(row.min_cost) ? row.min_cost : 0)
    let hi = Math.max(0, Number.isFinite(row.max_cost) ? row.max_cost : 0)
    if (hi < lo) [lo, hi] = [hi, lo]
    if (hi === 0 && lo > 0) hi = lo
    row.min_cost = lo
    row.max_cost = hi
    row.quantity_sqft = undefined
    row.excluded_from_total = false
    if (row.unit === 'per_sqft') {
      if (hasArea) {
        row.quantity_sqft = area
        row.extended_min = lo * area
        row.extended_max = hi * area
      } else {
        row.extended_min = 0
        row.extended_max = 0
        row.excluded_from_total = true
      }
    } else {
      row.extended_min = lo
      row.extended_max = hi
    }
    minTotal += row.extended_min ?? 0
    maxTotal += row.extended_max ?? 0
    return row
  })
  return {
    ...report,
    cost_breakdown_estimate: {
      ...report.cost_breakdown_estimate,
      line_items: items,
      total_estimated_cost_range: {
        ...report.cost_breakdown_estimate.total_estimated_cost_range,
        min_total: Math.round(minTotal),
        max_total: Math.round(maxTotal)
      }
    }
  }
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '$0'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2
  }).format(amount)
}

export function formatSqft(area: number): string {
  if (!Number.isFinite(area) || area <= 0) return '—'
  return area >= 100 ? area.toFixed(0) : String(Math.round(area * 10) / 10)
}

export function severityTone(level: string): 'low' | 'moderate' | 'high' | 'unknown' {
  const n = level.trim().toLowerCase()
  if (n.startsWith('low') || n.includes('minor')) return 'low'
  if (n.startsWith('mod') || n.includes('medium')) return 'moderate'
  if (n.startsWith('high') || n.includes('severe') || n.includes('critical')) return 'high'
  return 'unknown'
}

/** Map free-text severity to Low / Moderate / High when it clearly matches one. */
export function normalizeSeverity(level: string): string {
  const tone = severityTone(level)
  if (tone === 'low') return 'Low'
  if (tone === 'moderate') return 'Moderate'
  if (tone === 'high') return 'High'
  return level.trim()
}
