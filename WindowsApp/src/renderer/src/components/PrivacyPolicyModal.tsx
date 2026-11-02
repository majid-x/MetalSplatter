import { appLegal } from '../lib/legal'

export function PrivacyPolicyModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card privacy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h2 id="privacy-title">{appLegal.privacyPolicyTitle}</h2>
          <button type="button" className="text-button" onClick={onClose}>
            Done
          </button>
        </header>
        <div className="modal-body privacy-body">
          <p className="muted tight">Last updated {appLegal.privacyPolicyLastUpdated}</p>
          <pre className="privacy-text">{appLegal.privacyPolicyBody}</pre>
          <a
            className="settings-link"
            href={appLegal.privacyPolicyURL}
            target="_blank"
            rel="noreferrer"
          >
            Open web version
          </a>
        </div>
      </div>
    </div>
  )
}
