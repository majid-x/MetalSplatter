import { BOOKING_CHANNELS, type BookingHttpRequest, type BookingHttpResponse } from '../shared/bookingChannels'
import { handle } from './ipc'

const BASE = 'https://www.vroomk.com'

function buildUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(path.replace(/^\/+/, ''), `${BASE}/`)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

async function bookingRequest(request: BookingHttpRequest): Promise<BookingHttpResponse> {
  const url = buildUrl(request.path, request.query)
  const response = await fetch(url, {
    method: request.method,
    headers: {
      Accept: 'application/json',
      ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {})
    },
    body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined
  })

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  }
}

export function registerBookingProxyIpc(): void {
  handle(BOOKING_CHANNELS.request, async (_event, request: BookingHttpRequest) =>
    bookingRequest(request)
  )
}
