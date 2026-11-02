import type { BookingPlace, BookingScanScope } from './models'
import type { BookingHttpRequest, BookingHttpResponse } from '../../../shared/bookingChannels'

export const bookingApiConfig = {
  baseURL: 'https://www.vroomk.com',
  stripePublishableKey:
    'pk_live_51S1DjTGsyIZa17guzzEEhG1Pievnwgfz3BFT4qnh6ldLcjFzpVu7gS9Jvu8F5cd5u3ud5WCoZfYGqEv43Vinf3qC00ZWU8IjGo'
} as const

export class BookingApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BookingApiError'
  }
}

type PlaceDTO = {
  lat: number
  lng: number
  label: string
  countryCode?: string | null
  country?: string | null
  inServiceCountry?: boolean | null
}

function asPlace(dto: PlaceDTO): BookingPlace {
  return {
    lat: dto.lat,
    lng: dto.lng,
    label: dto.label,
    countryCode: dto.countryCode,
    country: dto.country,
    inServiceCountry: dto.inServiceCountry
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const root = data as Record<string, unknown>
    for (const key of ['message', 'error', 'title', 'detail']) {
      if (typeof root[key] === 'string' && root[key]) return root[key] as string
    }
  }
  if (status === 409) return 'That time slot is no longer available. Pick another.'
  if (status === 402) return 'Payment was not completed. Please try again.'
  if (status === 401 || status === 403) return 'Booking calendar is temporarily unavailable.'
  if (status === 0) return 'Could not reach the booking service. Check your connection.'
  return `Request failed (${status}).`
}

async function bookingFetch(request: BookingHttpRequest): Promise<unknown> {
  let response: BookingHttpResponse
  try {
    response = await window.avgs.booking.request(request)
  } catch (error) {
    throw new BookingApiError(
      error instanceof Error ? error.message : 'Could not reach the booking service.'
    )
  }
  if (!response.ok) {
    throw new BookingApiError(extractErrorMessage(response.data, response.status))
  }
  return response.data
}

export type GeocodeResponse = {
  status: string
  message?: string
  results?: PlaceDTO[]
  place?: PlaceDTO
}

export const bookingApi = {
  geocode(query: string) {
    return bookingFetch({
      method: 'GET',
      path: 'api/booking/geocode',
      query: { q: query }
    }) as Promise<GeocodeResponse>
  },

  reverseGeocode(lat: number, lng: number) {
    return bookingFetch({
      method: 'GET',
      path: 'api/booking/reverse-geocode',
      query: { lat: String(lat), lng: String(lng) }
    }) as Promise<GeocodeResponse>
  },

  bookedTimes(date: string) {
    return bookingFetch({
      method: 'GET',
      path: 'api/booked-times',
      query: { date }
    }) as Promise<{ date: string; bookedTimes: string[] }>
  },

  createPaymentIntent(name: string, email: string, phone: string) {
    return bookingFetch({
      method: 'POST',
      path: 'api/booking/create-payment-intent',
      body: { name, email, phone }
    }) as Promise<{
      clientSecret: string
      paymentIntentId: string
      amountDisplay?: string
    }>
  },

  confirmPayment(paymentIntentId: string) {
    return bookingFetch({
      method: 'POST',
      path: 'api/booking/confirm-payment',
      body: { paymentIntentId }
    }) as Promise<{ success?: boolean }>
  },

  scheduleMeeting(body: {
    name: string
    email: string
    phone: string
    date: string
    time: string
    address: string
    lat: number
    lng: number
    scanScope: BookingScanScope
    scanScopeLabel: string
    inCoverage: boolean
    inServiceCountry: boolean
    distanceKm: number
    paymentIntentId?: string | null
    advancePaid: boolean
    advanceAmount?: string | null
  }) {
    return bookingFetch({
      method: 'POST',
      path: 'api/schedule-meeting',
      body
    }) as Promise<{ link?: string; meetLink?: string }>
  },

  saveBookingDraft(body: Record<string, unknown>) {
    return bookingFetch({
      method: 'POST',
      path: 'api/save-booking-draft',
      body
    }) as Promise<{
      message?: string
      data?: Array<{ id: string }>
    }>
  },

  mapPlaces(response: GeocodeResponse): BookingPlace[] {
    return (response.results ?? []).map(asPlace)
  },

  mapPlace(dto: PlaceDTO | undefined): BookingPlace | null {
    return dto ? asPlace(dto) : null
  }
}
