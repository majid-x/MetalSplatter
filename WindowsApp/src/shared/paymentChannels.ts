export const PAYMENT_CHANNELS = {
  createSession: 'vroomk:payment:create-session'
} as const

export type PaymentSessionRequest = {
  publishableKey: string
  clientSecret: string
  amountDisplay: string
}
