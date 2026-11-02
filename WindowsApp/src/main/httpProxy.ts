import { HTTP_PROXY_CHANNELS, type HttpProxyRequest, type HttpProxyResponse } from '../shared/httpProxyChannels'
import { handle } from './ipc'

async function proxyRequest(request: HttpProxyRequest): Promise<HttpProxyResponse> {
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    throw new Error('Invalid request URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed.')
  }

  const response = await fetch(parsed, {
    method: request.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'ngrok-skip-browser-warning': 'true',
      ...(request.headers ?? {})
    },
    body: request.method === 'POST' ? (request.body ?? undefined) : undefined
  })

  return {
    ok: response.ok,
    status: response.status,
    text: await response.text()
  }
}

export function registerHttpProxyIpc(): void {
  handle(HTTP_PROXY_CHANNELS.request, async (_event, request: HttpProxyRequest) =>
    proxyRequest(request)
  )
}
