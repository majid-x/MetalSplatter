import { useMemo, useState, type FormEvent } from 'react'
import { BrandMark } from '../components/BrandMark'
import { useAuth } from './AuthContext'
import { AuthFlowError, friendlyAuthMessage } from './errors'
import { PasswordResetModal } from './PasswordResetModal'
import { isValidEmail } from './validation'

type Mode = 'signIn' | 'signUp'

function GlassField({
  placeholder,
  value,
  onChange,
  type = 'text',
  isValid,
  autoComplete,
  onEnter
}: {
  placeholder: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'email' | 'password'
  isValid: boolean
  autoComplete?: string
  onEnter?: () => void
}) {
  const [reveal, setReveal] = useState(false)
  const isSecure = type === 'password'

  return (
    <div className={`glass-field ${isValid ? '' : 'invalid'}`}>
      <input
        type={isSecure && !reveal ? 'password' : type === 'password' ? 'text' : type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter?.()
        }}
      />
      {isSecure && (
        <button
          type="button"
          className="reveal-button"
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? 'Hide password' : 'Show password'}
        >
          {reveal ? 'Hide' : 'Show'}
        </button>
      )}
    </div>
  )
}

export function AuthView() {
  const auth = useAuth()
  const [mode, setMode] = useState<Mode>('signIn')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [attemptedSubmit, setAttemptedSubmit] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [showPasswordReset, setShowPasswordReset] = useState(false)

  const trimmedName = fullName.trim()
  const trimmedEmail = email.trim()
  const emailValid = isValidEmail(trimmedEmail)
  const nameValid = trimmedName.length >= 2
  const passwordValid = mode === 'signIn' ? password.length > 0 : password.length >= 8
  const confirmValid = confirmPassword.length > 0 && confirmPassword === password

  const canSubmit = useMemo(() => {
    if (!emailValid || !passwordValid) return false
    if (mode === 'signUp') return nameValid && confirmValid
    return true
  }, [emailValid, passwordValid, mode, nameValid, confirmValid])

  const validationMessage = (() => {
    if (mode === 'signUp' && !nameValid) return 'Enter your full name'
    if (!emailValid) return 'Enter a valid email address'
    if (!passwordValid) {
      return mode === 'signUp'
        ? 'Password must be at least 8 characters'
        : 'Password is required'
    }
    if (mode === 'signUp' && !confirmValid) return 'Passwords must match'
    return 'Please check your details'
  })()

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    setAttemptedSubmit(true)
    setFormError(null)
    setInfoMessage(null)

    if (!canSubmit) {
      setFormError(validationMessage)
      return
    }

    setIsSubmitting(true)
    try {
      if (mode === 'signIn') {
        await auth.signIn(trimmedEmail, password)
      } else {
        await auth.signUp(trimmedName, trimmedEmail, password)
      }
    } catch (error) {
      if (error instanceof AuthFlowError && error.code === 'emailConfirmationRequired') {
        setInfoMessage(error.message)
        setMode('signIn')
      } else {
        setFormError(friendlyAuthMessage(error))
      }
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-atmosphere" aria-hidden />
      <div className="auth-brand">
        <BrandMark size={44} />
      </div>

      <form className="auth-card" onSubmit={submit}>
        <h1>{mode === 'signIn' ? 'Welcome Back' : 'Create Account'}</h1>

        <div className="auth-fields">
          {mode === 'signUp' && (
            <GlassField
              placeholder="Enter your full name"
              value={fullName}
              onChange={setFullName}
              isValid={!attemptedSubmit || nameValid}
              autoComplete="name"
            />
          )}

          <GlassField
            placeholder="Enter your email address"
            value={email}
            onChange={setEmail}
            type="email"
            isValid={!attemptedSubmit || emailValid}
            autoComplete="username"
          />

          <GlassField
            placeholder="Enter your password"
            value={password}
            onChange={setPassword}
            type="password"
            isValid={!attemptedSubmit || passwordValid}
            autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
            onEnter={() => {
              if (mode === 'signIn') void submit()
            }}
          />

          {mode === 'signUp' && (
            <GlassField
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              type="password"
              isValid={!attemptedSubmit || confirmValid}
              autoComplete="new-password"
              onEnter={() => void submit()}
            />
          )}

          {formError && <p className="form-error">{formError}</p>}
          {!formError && infoMessage && <p className="form-info">{infoMessage}</p>}
        </div>

        <button type="submit" className="pill-button auth-submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <span className="spinner" />
          ) : mode === 'signIn' ? (
            'Login'
          ) : (
            'Signup'
          )}
        </button>

        {mode === 'signIn' && (
          <button
            type="button"
            className="text-button forgot"
            onClick={() => setShowPasswordReset(true)}
          >
            Forgot password?
          </button>
        )}

        <p className="auth-footer">
          <span>
            {mode === 'signIn' ? "Don't have an account?" : 'Already have an account?'}
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setMode(mode === 'signIn' ? 'signUp' : 'signIn')
              setAttemptedSubmit(false)
              setFormError(null)
              setInfoMessage(null)
              setConfirmPassword('')
            }}
          >
            {mode === 'signIn' ? 'Signup' : 'Login'}
          </button>
        </p>
      </form>

      {showPasswordReset && (
        <PasswordResetModal
          initialEmail={trimmedEmail}
          onClose={() => setShowPasswordReset(false)}
        />
      )}
    </main>
  )
}
