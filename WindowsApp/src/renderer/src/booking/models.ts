export type BookingStep =
  | 'location'
  | 'scan'
  | 'schedule'
  | 'contact'
  | 'payment'
  | 'done'

export const BOOKING_PROGRESS_LABELS = ['Location', 'Scan area', 'Time', 'Details'] as const

export function bookingProgressIndex(step: BookingStep): number {
  switch (step) {
    case 'location':
      return 0
    case 'scan':
      return 1
    case 'schedule':
      return 2
    case 'contact':
    case 'payment':
    case 'done':
      return 3
  }
}

export type BookingScanScope =
  | 'entire_house'
  | 'ground_floor'
  | 'single_room'
  | 'custom'

export const SCAN_SCOPES: { id: BookingScanScope; label: string }[] = [
  { id: 'entire_house', label: 'Entire house' },
  { id: 'ground_floor', label: 'Ground floor' },
  { id: 'single_room', label: 'Single room' },
  { id: 'custom', label: 'Custom' }
]

export function scanScopeLabel(scope: BookingScanScope): string {
  return SCAN_SCOPES.find((item) => item.id === scope)?.label ?? scope
}

export type BookingLocationGate =
  | 'idle'
  | 'pickSuggestion'
  | 'ok'
  | 'outOfCountry'
  | 'notFound'
  | 'fake'

export function locationGateMessage(gate: BookingLocationGate): string | null {
  switch (gate) {
    case 'pickSuggestion':
      return 'Select an address from the suggestions.'
    case 'outOfCountry':
      return "We don't provide services outside the United States."
    case 'notFound':
      return "We couldn't verify that location. Try a fuller street address."
    case 'fake':
      return "That location doesn't look valid. Try again or search by address."
    default:
      return null
  }
}

export type BookingPlace = {
  lat: number
  lng: number
  label: string
  countryCode?: string | null
  country?: string | null
  inServiceCountry?: boolean | null
}

export function placeIsUS(place: BookingPlace): boolean {
  if (typeof place.inServiceCountry === 'boolean') return place.inServiceCountry
  return (place.countryCode ?? '').toLowerCase() === 'us'
}

export type BookingCoverage = {
  inCoverage: boolean
  distanceKm: number
  distanceMiles: number
}

export const BookingGeo = {
  baseLat: 34.1869322,
  baseLng: -118.5621216,
  baseLabel: '6414 Corbin Ave, Reseda, CA 91335',
  radiusMiles: 60,
  rateDisplay: '$1.50/sqft',
  advanceDisplay: '$300',

  coverage(place: BookingPlace): BookingCoverage {
    const distanceKm = this.haversineKm(this.baseLat, this.baseLng, place.lat, place.lng)
    const distanceMiles = distanceKm * 0.621371
    const radiusKm = this.radiusMiles / 0.621371
    return {
      inCoverage: distanceKm <= radiusKm,
      distanceKm,
      distanceMiles
    }
  },

  haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLng = ((lng2 - lng1) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2)
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  },

  isFakeCoordinate(lat: number, lng: number): boolean {
    return Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01
  }
} as const

export const BookingSlots = {
  allTimes24h: [
    '09:00',
    '10:00',
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
    '17:00'
  ],

  /** Pacific calendar day as YYYY-MM-DD using Intl. */
  pacificDateString(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
    const m = parts.find((p) => p.type === 'month')?.value ?? '01'
    const d = parts.find((p) => p.type === 'day')?.value ?? '01'
    return `${y}-${m}-${d}`
  },

  minSelectableDateString(inCoverage: boolean, now = new Date()): string {
    const today = this.pacificDateString(now)
    if (inCoverage) return today
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
    return this.pacificDateString(tomorrow)
  },

  display12h(time24: string): string {
    const [hRaw, mRaw] = time24.split(':')
    const hour = Number(hRaw)
    const minute = Number(mRaw)
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return time24
    const period = hour >= 12 ? 'PM' : 'AM'
    const h12 = hour % 12 === 0 ? 12 : hour % 12
    return `${h12}:${String(minute).padStart(2, '0')} ${period}`
  }
}

const LOCAL_ID_KEY = 'vroomk.booking.draft.localId'
const SERVER_ID_KEY = 'vroomk.booking.draft.serverId'

export const BookingDraftSession = {
  localId(): string {
    const existing = localStorage.getItem(LOCAL_ID_KEY)
    if (existing) return existing
    const fresh = crypto.randomUUID().toLowerCase()
    localStorage.setItem(LOCAL_ID_KEY, fresh)
    return fresh
  },
  get serverId(): string | null {
    return localStorage.getItem(SERVER_ID_KEY)
  },
  set serverId(value: string | null) {
    if (value) localStorage.setItem(SERVER_ID_KEY, value)
    else localStorage.removeItem(SERVER_ID_KEY)
  },
  startFresh() {
    localStorage.setItem(LOCAL_ID_KEY, crypto.randomUUID().toLowerCase())
    localStorage.removeItem(SERVER_ID_KEY)
  }
}
