/** Structured wall-damage report — drives Damage Estimation UI. */

export type SeverityLevel = 'Low' | 'Moderate' | 'High' | string

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
    line_items: Array<{
      item: string
      min_cost: number
      max_cost: number
      unit?: string
      notes?: string
    }>
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

/** USA pricing defaults — used when the model omits cost rows. */
export const USA_PRICING_TEMPLATE: WallDamageReport = {
  report_metadata: {
    report_id: '',
    inspection_date: '',
    inspector_name: '',
    location: {
      state: '',
      country: 'USA',
      room: '',
      wall_orientation: ''
    }
  },
  damage_assessment: {
    severity_level: '',
    damaged_area_estimation: {
      unit: 'square_feet',
      estimated_total_area_sqft: 0,
      affected_zone: ''
    },
    visible_symptoms: [
      {
        type: '',
        location: '',
        description: ''
      }
    ]
  },
  cause_analysis: {
    primary_cause_suspected: '',
    possible_sources: [
      {
        source: '',
        probability: '',
        description: ''
      }
    ],
    requires_professional_detection: false
  },
  repair_plan: {
    prerequisite_action: '',
    steps: []
  },
  cost_breakdown_estimate: {
    currency: 'USD',
    market_region: 'USA (Approximate)',
    line_items: [
      {
        item: 'Leak Detection & Repair',
        min_cost: 250,
        max_cost: 800,
        unit: '',
        notes: 'Licensed plumber; varies by pipe complexity and wall access.'
      },
      {
        item: 'Drying & Mold Treatment',
        min_cost: 500,
        max_cost: 1500,
        unit: '',
        notes: 'Restoration company dry-out and anti-fungal treatment.'
      },
      {
        item: 'Damp Sealer Coat',
        min_cost: 1,
        max_cost: 3,
        unit: 'per_sqft',
        notes: 'Moisture-blocking sealer applied after leak is fixed.'
      },
      {
        item: 'Drywall / Plaster Repair',
        min_cost: 300,
        max_cost: 800,
        unit: '',
        notes: 'Patching, leveling, and texturing to match existing wall.'
      },
      {
        item: 'Repaint & Finishing',
        min_cost: 3,
        max_cost: 7,
        unit: 'per_sqft',
        notes: 'Primer and paint to match existing wall color.'
      }
    ],
    total_estimated_cost_range: {
      min_total: 1050,
      max_total: 3100,
      disclaimer:
        'Estimates based on average USA contractor rates. Final cost depends on hidden structural damage, mold remediation, and local labor rates.'
    }
  },
  recommendations: {
    immediate_actions: [
      'Do not paint over the damaged area.',
      'Keep the area dry and ventilated.',
      'Contact a licensed plumber or water damage restoration specialist.'
    ]
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

export function severityTone(level: string): 'low' | 'moderate' | 'high' | 'unknown' {
  const n = level.trim().toLowerCase()
  if (n.startsWith('low') || n.includes('minor')) return 'low'
  if (n.startsWith('mod') || n.includes('medium')) return 'moderate'
  if (n.startsWith('high') || n.includes('severe') || n.includes('critical')) return 'high'
  return 'unknown'
}
