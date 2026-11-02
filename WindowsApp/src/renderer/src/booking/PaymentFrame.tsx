import { useEffect, useState } from 'react'
import { bookingApiConfig } from './api'

export function PaymentFrame({
  clientSecret,
  amountDisplay,
  onSuccess,
  onError
}: {
  clientSecret: string
  amountDisplay: string
  onSuccess: (paymentIntentId: string) => void
  onError: (message: string) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.avgs.payments
      .createSession({
        publishableKey: bookingApiConfig.stripePublishableKey,
        clientSecret,
        amountDisplay
      })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : 'Could not start payment.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [clientSecret, amountDisplay])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data
      if (!data || typeof data !== 'object' || data.source !== 'vroomk-booking') return
      if (data.type === 'success' && typeof data.paymentIntentId === 'string') {
        onSuccess(data.paymentIntentId)
      } else if (data.type === 'error') {
        onError(typeof data.message === 'string' ? data.message : 'Payment failed.')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [onSuccess, onError])

  if (bootError) {
    return <p className="form-error">{bootError}</p>
  }

  if (!src) {
    return (
      <div className="payment-loading">
        <span className="spinner" />
        <span>Preparing payment…</span>
      </div>
    )
  }

  return (
    <iframe
      className="payment-frame"
      title="Vroomk deposit payment"
      src={src}
      allow="payment *"
    />
  )
}
