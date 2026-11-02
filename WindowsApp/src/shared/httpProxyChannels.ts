export const HTTP_PROXY_CHANNELS = {
  request: 'avgs:http:request'
} as const

export type HttpProxyRequest = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export type HttpProxyResponse = {
  ok: boolean
  status: number
  text: string
}
