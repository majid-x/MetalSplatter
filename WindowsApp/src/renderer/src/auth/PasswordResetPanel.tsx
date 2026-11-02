import { useMemo, useState, type FormEvent } from 'react'
import { useAuth } from './AuthContext'
import { friendlyAuthMessage } from './errors'
import { isValidEmail } from './validation'

type Step = 'email' | 'otp' | 'password'

export function PasswordResetPanel({
  initialEmail,
  onFinished
}: {
  initialEmail: string
  onFinished?: () => void
}) {
  const auth = useAuth()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState(initialEmail)
  const [otp, setOtp] = useState('')
  const [secret, setSecret] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [infoText, setInfoText] = useState<string | null>(null)

  const emailValid = isValidEmail(email)
  const passwordValid = newPassword.length >= 6 && newPassword === confirmPassword

  const canAdvance = useMemo(() => {
    if (step === 'email') return emailValid
    if (step === 'otp') return emailValid && otp.trim().length > 0
    return passwordValid
  }, [step, emailValid, otp, passwordValid])

  const subtitle =
    step === 'email'
      ? "We'll email a one-time code (valid 10 minutes)."
      : step === 'otp'
        ? 'Enter the code from your email.'
        : 'Choose a new password (at least 6 characters).'

  const primaryLabel =
    step === 'email' ? 'Send Code' : step === 'otp' ? 'Verify Code' : 'Set Password'

  async function advance(event: FormEvent) {
    event.preventDefault()
    setErrorText(null)
    setInfoText(null)
    if (!canAdvance) return

    setIsBusy(true)
    try {
      if (step === 'email') {
        await auth.sendPasswordResetOTP(email)
        setInfoText(`Check ${email.trim().toLowerCase()} for a one-time code.`)
        auth.clearStatus()
        setStep('otp')
      } else if (step === 'otp') {
        const nextSecret = await auth.verifyPasswordResetOTP(email, otp)
        setSecret(nextSecret)
        setInfoText('Code verified. Set your new password.')
        setStep('password')
      } else {
        await auth.setPasswordWithResetSecret(email, secret, newPassword)
        auth.clearStatus()
        setInfoText('Password updated. You can sign in with the new password.')
        onFinished?.()
      }
    } catch (error) {
      setErrorText(friendlyAuthMessage(error))
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <form className="reset-panel" onSubmit={advance}>
      <p className="muted tight">{subtitle}</p>

      {(step === 'email' || step === 'otp') && (
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            disabled={step === 'otp' || isBusy}
            autoComplete="username"
          />
        </label>
      )}

      {step === 'otp' && (
        <label className="field">
          <span>One-time code</span>
          <input
            type="text"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="123456"
            disabled={isBusy}
            autoComplete="one-time-code"
          />
        </label>
      )}

      {step === 'password' && (
        <>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isBusy}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              disabled={isBusy}
              autoComplete="new-password"
            />
          </label>
        </>
      )}

      {errorText && <p className="form-error">{errorText}</p>}
      {!errorText && infoText && <p className="form-info">{infoText}</p>}

      <div className="modal-actions">
        <button type="submit" className="pill-button compact" disabled={isBusy || !canAdvance}>
          {isBusy ? <span className="spinner" /> : primaryLabel}
        </button>
        {step !== 'email' && (
          <button
            type="button"
            className="text-button"
            disabled={isBusy}
            onClick={() => {
              setErrorText(null)
              setInfoText(null)
              setStep(step === 'password' ? 'otp' : 'email')
            }}
          >
            Back
          </button>
        )}
      </div>
    </form>
  )
}
