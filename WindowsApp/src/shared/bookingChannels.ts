export const BOOKING_CHANNELS = {
  request: 'avgs:booking:request'
} as const

export type BookingHttpRequest = {
  method: 'GET' | 'POST'
  path: string
  query?: Record<string, string>
  body?: unknown
}

export type BookingHttpResponse = {
  ok: boolean
  status: number
  data: unknown
}
