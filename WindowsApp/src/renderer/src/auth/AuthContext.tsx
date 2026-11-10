import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { accountApi } from '../lib/accountApi'
import { supabase } from '../lib/supabase'
import { AuthFlowError } from './errors'

type AuthContextValue = {
  session: Session | null
  isBootstrapping: boolean
  isAuthenticated: boolean
  userId: string | null
  displayName: string
  fullName: string | null
  email: string | null
  statusMessage: string | null
  clearStatus: () => void
  signIn: (email: string, password: string) => Promise<void>
  signUp: (fullName: string, email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  updateFullName: (name: string) => Promise<void>
  updateEmail: (newEmail: string) => Promise<void>
  deleteAccount: () => Promise<void>
  sendPasswordResetOTP: (email: string) => Promise<void>
  verifyPasswordResetOTP: (email: string, otp: string) => Promise<string>
  setPasswordWithResetSecret: (
    email: string,
    secret: string,
    newPassword: string
  ) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function metadataFullName(session: Session | null): string | null {
  const value = session?.user.user_metadata?.full_name
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const userInitiatedSignOut = useRef(false)

  useEffect(() => {
    let cancelled = false

    const { data } = supabase.auth.onAuthStateChange(async (event, nextSession) => {
      if (cancelled) return

      if (event === 'INITIAL_SESSION') {
        if (nextSession) {
          setSession(nextSession)
          const expiresAt = nextSession.expires_at ?? 0
          if (expiresAt * 1000 < Date.now()) {
            try {
              const { data: refreshed, error } = await supabase.auth.refreshSession()
              if (!cancelled && !error && refreshed.session) {
                setSession(refreshed.session)
              }
            } catch {
              // Keep restored session; do not bounce to login.
            }
          }
        } else {
          setSession(null)
        }
        setIsBootstrapping(false)
        return
      }

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (nextSession) setSession(nextSession)
        return
      }

      if (event === 'SIGNED_OUT') {
        if (userInitiatedSignOut.current) {
          setSession(null)
          userInitiatedSignOut.current = false
        }
      }
    })

    return () => {
      cancelled = true
      data.subscription.unsubscribe()
    }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setStatusMessage(null)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    if (data.session) setSession(data.session)
  }, [])

  const signUp = useCallback(async (fullName: string, email: string, password: string) => {
    setStatusMessage(null)
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
    if (error) throw error
    if (data.session) {
      setSession(data.session)
      return
    }
    throw AuthFlowError.emailConfirmationRequired()
  }, [])

  const signOut = useCallback(async () => {
    setStatusMessage(null)
    userInitiatedSignOut.current = true
    const { error } = await supabase.auth.signOut()
    if (error) {
      userInitiatedSignOut.current = false
      setStatusMessage(error.message)
      return
    }
    setSession(null)
  }, [])

  const updateFullName = useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (trimmed.length < 2) {
      throw AuthFlowError.message('Name must be at least 2 characters.')
    }
    const { data, error } = await supabase.auth.updateUser({
      data: { full_name: trimmed }
    })
    if (error) throw error
    setSession((prev) =>
      prev && data.user
        ? {
            ...prev,
            user: data.user
          }
        : prev
    )
    setStatusMessage('Name updated.')
  }, [])

  const updateEmail = useCallback(
    async (newEmail: string) => {
      const trimmed = newEmail.trim().toLowerCase()
      if (!trimmed.includes('@') || !trimmed.includes('.')) {
        throw AuthFlowError.message('Enter a valid email address.')
      }
      if (trimmed === (session?.user.email ?? '').toLowerCase()) {
        throw AuthFlowError.message("That's already your email.")
      }
      const { data, error } = await supabase.auth.updateUser({ email: trimmed })
      if (error) throw error
      setSession((prev) =>
        prev && data.user
          ? {
              ...prev,
              user: data.user
            }
          : prev
      )
      setStatusMessage(`Check ${trimmed} to confirm your new email.`)
    },
    [session?.user.email]
  )

  const deleteAccount = useCallback(async () => {
    if (!session) throw AuthFlowError.notSignedIn()
    setStatusMessage(null)
    try {
      await window.avgs.projects.removeAll()
    } catch {
      // Best-effort local wipe before server delete.
    }
    try {
      await window.avgs.damage.removeAll()
    } catch {
      // Saved damage reports — best-effort wipe too.
    }
    try {
      await accountApi.deleteAccount(session.access_token)
    } catch (error) {
      throw AuthFlowError.message(
        `Couldn't delete account: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
    userInitiatedSignOut.current = true
    setSession(null)
    try {
      await supabase.auth.signOut()
    } catch {
      // Local session already cleared.
    }
  }, [session])

  const sendPasswordResetOTP = useCallback(async (email: string) => {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed.includes('@')) {
      throw AuthFlowError.message('Enter a valid email address.')
    }
    try {
      await accountApi.sendPasswordResetOTP(trimmed)
      setStatusMessage(`Check ${trimmed} for a one-time code.`)
    } catch (error) {
      throw AuthFlowError.message(
        error instanceof Error ? error.message : 'Could not send reset code.'
      )
    }
  }, [])

  const verifyPasswordResetOTP = useCallback(async (email: string, otp: string) => {
    const trimmedEmail = email.trim().toLowerCase()
    const trimmedOTP = otp.trim()
    if (!trimmedOTP) {
      throw AuthFlowError.message('Enter the code from your email.')
    }
    try {
      return await accountApi.verifyPasswordResetOTP(trimmedEmail, trimmedOTP)
    } catch (error) {
      throw AuthFlowError.message(
        error instanceof Error ? error.message : 'Could not verify code.'
      )
    }
  }, [])

  const setPasswordWithResetSecret = useCallback(
    async (email: string, secret: string, newPassword: string) => {
      const trimmedEmail = email.trim().toLowerCase()
      if (newPassword.length < 6) {
        throw AuthFlowError.message('Password must be at least 6 characters.')
      }
      try {
        await accountApi.setPassword(trimmedEmail, secret, newPassword)
        setStatusMessage('Password updated.')
      } catch (error) {
        throw AuthFlowError.message(
          error instanceof Error ? error.message : 'Could not update password.'
        )
      }
    },
    []
  )

  const fullName = metadataFullName(session)
  const email = session?.user.email ?? null
  const userId = session?.user.id ?? null

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isBootstrapping,
      isAuthenticated: session != null,
      userId,
      displayName: fullName || email || 'Account',
      fullName,
      email,
      statusMessage,
      clearStatus: () => setStatusMessage(null),
      signIn,
      signUp,
      signOut,
      updateFullName,
      updateEmail,
      deleteAccount,
      sendPasswordResetOTP,
      verifyPasswordResetOTP,
      setPasswordWithResetSecret
    }),
    [
      session,
      isBootstrapping,
      userId,
      fullName,
      email,
      statusMessage,
      signIn,
      signUp,
      signOut,
      updateFullName,
      updateEmail,
      deleteAccount,
      sendPasswordResetOTP,
      verifyPasswordResetOTP,
      setPasswordWithResetSecret
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return value
}
