import { PasswordResetPanel } from './PasswordResetPanel'

export function PasswordResetModal({
  initialEmail,
  onClose
}: {
  initialEmail: string
  onClose: () => void
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="reset-title">Reset Password</h2>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="modal-body">
          <PasswordResetPanel initialEmail={initialEmail} onFinished={onClose} />
        </div>
      </div>
    </div>
  )
}
