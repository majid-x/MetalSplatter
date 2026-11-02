import { accountApiConfig } from './config'

export class AccountApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountApiError'
  }
}

function endpoint(path: string): string {
  const trimmed = path.replace(/^\/+/, '')
  return `${accountApiConfig.baseURL.replace(/\/+$/, '')}/${trimmed}`
}

function extractErrorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const root = data as Record<string, unknown>
    for (const key of ['message', 'error', 'title', 'detail']) {
      const value = root[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    if (Array.isArray(root.errors) && typeof root.errors[0] === 'string') {
      return root.errors[0]
    }
  }
  if (typeof data === 'string' && data.trim()) return data
  return `Request failed (${status}).`
}

function extractSecret(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const root = data as Record<string, unknown>
  if (typeof root.secret === 'string' && root.secret) return root.secret
  if (typeof root.token === 'string' && root.token) return root.token
  if (root.data && typeof root.data === 'object') {
    const nested = root.data as Record<string, unknown>
    if (typeof nested.secret === 'string' && nested.secret) return nested.secret
    if (typeof nested.token === 'string' && nested.token) return nested.token
  }
  return null
}

async function postJSON(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  let data: unknown = null
  const text = await response.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    throw new AccountApiError(extractErrorMessage(data, response.status))
  }

  return data
}

export const accountApi = {
  sendPasswordResetOTP(email: string) {
    return postJSON('/api/password-reset/send-otp', { email })
  },

  async verifyPasswordResetOTP(email: string, otp: string): Promise<string> {
    const data = await postJSON('/api/password-reset/verify-otp', { email, otp })
    const secret = extractSecret(data)
    if (!secret) {
      throw new AccountApiError('Verification succeeded but no secret was returned.')
    }
    return secret
  },

  setPassword(email: string, secret: string, newPassword: string) {
    return postJSON('/api/password-reset/set-password', { email, secret, newPassword })
  },

  async deleteAccount(accessToken: string): Promise<void> {
    const response = await fetch(endpoint('api/account/delete'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    })

    let data: unknown = null
    const text = await response.text()
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }

    if (!response.ok) {
      throw new AccountApiError(extractErrorMessage(data, response.status))
    }
  }
}
