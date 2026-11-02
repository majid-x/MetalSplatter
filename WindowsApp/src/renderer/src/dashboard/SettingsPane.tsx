import { useEffect, useState } from 'react'
import { PasswordResetPanel } from '../auth/PasswordResetPanel'
import { useAuth } from '../auth/AuthContext'
import { friendlyAuthMessage } from '../auth/errors'
import { PrivacyPolicyModal } from '../components/PrivacyPolicyModal'
import { appLegal } from '../lib/legal'
import { measurementPrefs } from '../lib/measurementPrefs'

type Banner = { kind: 'success' | 'error'; text: string }

export function SettingsPane() {
  const auth = useAuth()
  const [fullName, setFullName] = useState(auth.fullName ?? '')
  const [email, setEmail] = useState(auth.email ?? '')
  const [isSavingProfile, setIsSavingProfile] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [showExact, setShowExact] = useState(measurementPrefs.showExactMeasurements)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)

  useEffect(() => {
    if (!isSavingProfile) {
      setFullName(auth.fullName ?? '')
      setEmail(auth.email ?? '')
    }
  }, [auth.fullName, auth.email, isSavingProfile])

  const profileDirty =
    fullName.trim() !== (auth.fullName ?? '') ||
    email.trim().toLowerCase() !== (auth.email ?? '').toLowerCase()

  async function saveProfile() {
    setBanner(null)
    setIsSavingProfile(true)
    try {
      const trimmedName = fullName.trim()
      const trimmedEmail = email.trim()
      let success = 'Profile updated.'
      if (trimmedName !== (auth.fullName ?? '')) {
        await auth.updateFullName(trimmedName)
        success = 'Name updated.'
      }
      if (trimmedEmail.toLowerCase() !== (auth.email ?? '').toLowerCase()) {
        await auth.updateEmail(trimmedEmail)
        success = `Check ${trimmedEmail.toLowerCase()} to confirm your new email.`
      }
      setBanner({ kind: 'success', text: success })
      auth.clearStatus()
    } catch (error) {
      setBanner({ kind: 'error', text: friendlyAuthMessage(error) })
    } finally {
      setIsSavingProfile(false)
    }
  }

  async function deleteAccount() {
    setBanner(null)
    setIsDeleting(true)
    try {
      await auth.deleteAccount()
    } catch (error) {
      setBanner({ kind: 'error', text: friendlyAuthMessage(error) })
      setIsDeleting(false)
      setShowDeleteConfirm(false)
    }
  }

  return (
    <section className="pane settings-pane">
      <header className="pane-header">
        <div>
          <h1>Settings</h1>
          <p className="pane-subtitle">Manage your profile, privacy, and account.</p>
        </div>
      </header>

      {banner && (
        <p className={banner.kind === 'success' ? 'form-info' : 'form-error'}>{banner.text}</p>
      )}

      <div className="settings-stack">
        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Profile</h2>
            <p>Your name and email for this Vroomk account.</p>
          </div>
          <label className="field">
            <span>Full name</span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Your name"
            />
          </label>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <button
            type="button"
            className="pill-button compact"
            disabled={isSavingProfile || !profileDirty}
            onClick={() => void saveProfile()}
          >
            {isSavingProfile ? <span className="spinner" /> : 'Save Profile'}
          </button>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Measurements</h2>
            <p>Distances default to feet and inches rounded to the nearest quarter inch.</p>
          </div>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={showExact}
              onChange={(e) => {
                const next = e.target.checked
                setShowExact(next)
                measurementPrefs.showExactMeasurements = next
              }}
            />
            <span>
              <strong>Show exact measurements</strong>
              <small>
                {showExact
                  ? 'Showing finer fractions (1/32″).'
                  : 'Rounded to the nearest 1/4″ (e.g. 5′ 3 1/4″).'}
              </small>
            </span>
          </label>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Password</h2>
            <p>Reset via email code (OTP), then set a new password.</p>
          </div>
          <PasswordResetPanel
            initialEmail={auth.email ?? email}
            onFinished={() => setBanner({ kind: 'success', text: 'Password updated.' })}
          />
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Privacy & Legal</h2>
            <p>How Vroomk handles your data.</p>
          </div>
          <button type="button" className="settings-link buttonish" onClick={() => setShowPrivacy(true)}>
            Privacy Policy
          </button>
          <a
            className="settings-link"
            href={`mailto:${appLegal.supportEmail}`}
            target="_blank"
            rel="noreferrer"
          >
            Contact support ({appLegal.supportEmail})
          </a>
        </section>

        <section className="settings-card">
          <div className="settings-card-head">
            <h2>Account</h2>
            <p>Sign out or permanently delete your account.</p>
          </div>
          <button type="button" className="settings-link buttonish" onClick={() => void auth.signOut()}>
            Sign Out
          </button>
          <button
            type="button"
            className="settings-link buttonish danger"
            disabled={isDeleting}
            onClick={() => setShowDeleteConfirm(true)}
          >
            {isDeleting ? 'Deleting…' : 'Delete Account'}
          </button>
          <p className="settings-note">
            Deleting your account removes your login and project data we control. This cannot be
            undone.
          </p>
        </section>
      </div>

      {showDeleteConfirm && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowDeleteConfirm(false)}>
          <div
            className="modal-card slim"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2>Delete your account?</h2>
              <button type="button" className="text-button" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
            </header>
            <div className="modal-body">
              <p className="muted tight">
                This permanently deletes your Vroomk account, project data we store, and local
                downloads. This cannot be undone.
              </p>
              <button
                type="button"
                className="pill-button compact danger"
                disabled={isDeleting}
                onClick={() => void deleteAccount()}
              >
                {isDeleting ? <span className="spinner" /> : 'Delete Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPrivacy && <PrivacyPolicyModal onClose={() => setShowPrivacy(false)} />}
    </section>
  )
}
