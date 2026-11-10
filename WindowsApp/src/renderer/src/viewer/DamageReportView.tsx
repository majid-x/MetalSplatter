import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  formatSqft,
  formatUsd,
  severityTone,
  type WallDamageReport
} from '../../../shared/wallDamageReport'

export function DamageReportView({
  report,
  annotatedImageDataUrl,
  annotatedImageDataUrls,
  referenceImageDataUrls,
  measureFactor
}: {
  report: WallDamageReport
  annotatedImageDataUrl?: string | null
  annotatedImageDataUrls?: string[] | null
  /** Unannotated close-up photos of the marked area. */
  referenceImageDataUrls?: string[] | null
  /** Only set when the project really has a calibration. */
  measureFactor?: number
}) {
  const tone = severityTone(report.damage_assessment.severity_level)
  const cost = report.cost_breakdown_estimate
  const total = cost.total_estimated_cost_range
  const meta = report.report_metadata
  const areaInfo = report.damage_assessment.damaged_area_estimation
  const areaSqft = areaInfo.estimated_total_area_sqft || 0
  const measured = areaInfo.area_source === 'measured'
  const hasCosts = cost.line_items.length > 0
  const excludedCount = cost.line_items.filter((row) => row.excluded_from_total).length
  const symptoms = report.damage_assessment.visible_symptoms
  const location = [meta.location.room, meta.location.wall_orientation, meta.location.state]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' · ')
  const outlineImages =
    annotatedImageDataUrls && annotatedImageDataUrls.length > 0
      ? annotatedImageDataUrls
      : annotatedImageDataUrl
        ? [annotatedImageDataUrl]
        : []

  const gallery: GalleryImage[] = [
    ...outlineImages.map((url, i) => ({
      url,
      caption: outlineImages.length > 1 ? `Marked area (${i + 1})` : 'Marked area'
    })),
    ...(referenceImageDataUrls ?? []).map((url, i) => ({
      url,
      caption: `Close-up photo ${i + 1}`
    }))
  ]
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const modelGuess = areaInfo.model_estimated_area_sqft
  const showGuess =
    measured && modelGuess && Math.abs(modelGuess - areaSqft) / Math.max(areaSqft, 1) > 0.05

  const scaleNote = measured
    ? `Area measured from your 3D outline${measureFactor ? ` (measure factor ${measureFactor})` : ''}.`
    : 'Area estimated from photos — this project has no scan calibration, so size and per-sq-ft costs are approximate.'

  return (
    <div className="damage-report">
      {gallery.length > 0 ? (
        <section className="damage-gallery">
          <button
            type="button"
            className="damage-gallery-main"
            onClick={() => setViewerIndex(0)}
            title="View full screen"
          >
            <img src={gallery[0].url} alt={gallery[0].caption} />
            <span className="damage-gallery-caption">{gallery[0].caption}</span>
            <span className="damage-gallery-expand" aria-hidden>
              ⤢
            </span>
          </button>
          {gallery.length > 1 ? (
            <div className="damage-gallery-thumbs">
              {gallery.slice(1).map((image, k) => (
                <button
                  type="button"
                  key={`${k}-${image.url.slice(-32)}`}
                  className="damage-gallery-thumb"
                  onClick={() => setViewerIndex(k + 1)}
                  title={`${image.caption} — view full screen`}
                >
                  <img src={image.url} alt={image.caption} />
                </button>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="damage-hero-stats">
        <div className="damage-stat">
          <span className="damage-stat-label">Severity</span>
          <span className={`damage-severity tone-${tone}`}>
            {report.damage_assessment.severity_level || 'Unknown'}
          </span>
        </div>
        <div className="damage-stat">
          <span className="damage-stat-label">{measured ? 'Area · measured' : 'Area · est.'}</span>
          <span className="damage-stat-value">
            {formatSqft(areaSqft)}
            <small> sq ft</small>
          </span>
        </div>
        <div className="damage-stat damage-stat-wide">
          <span className="damage-stat-label">Total</span>
          <span className="damage-stat-value damage-stat-money">
            {hasCosts ? `${formatUsd(total.min_total)} – ${formatUsd(total.max_total)}` : '—'}
          </span>
        </div>
        <p className="damage-scale-note">
          {scaleNote}
          {showGuess ? ` Photo-based guess was ${formatSqft(modelGuess)} sq ft.` : ''}
        </p>
      </section>

      <section className="damage-block">
        <h3>Cost</h3>
        {hasCosts ? (
          <>
            <ul className="damage-cost-list">
              {cost.line_items.map((row, index) => {
                const perSqft = row.unit === 'per_sqft'
                return (
                  <li key={`${row.item}-${index}`}>
                    <div className="damage-cost-main">
                      <span className="damage-cost-name">{row.item}</span>
                      <span className="damage-cost-price">
                        {row.excluded_from_total
                          ? 'Not priced'
                          : `${formatUsd(row.extended_min ?? row.min_cost)}–${formatUsd(
                              row.extended_max ?? row.max_cost
                            )}`}
                      </span>
                    </div>
                    {perSqft ? (
                      <p className="damage-cost-basis">
                        {formatUsd(row.min_cost)}–{formatUsd(row.max_cost)}/sq ft
                        {row.quantity_sqft
                          ? ` × ${formatSqft(row.quantity_sqft)} sq ft`
                          : ' · area unknown, left out of total'}
                      </p>
                    ) : row.unit ? (
                      <p className="damage-cost-basis">{row.unit}</p>
                    ) : null}
                    {row.notes ? <p>{row.notes}</p> : null}
                  </li>
                )
              })}
            </ul>
            {excludedCount > 0 ? (
              <p className="damage-scale-note">
                {excludedCount} per-sq-ft item{excludedCount > 1 ? 's are' : ' is'} not in the total
                because the damaged area is unknown.
              </p>
            ) : null}
            {total.disclaimer ? <p className="damage-scale-note">{total.disclaimer}</p> : null}
          </>
        ) : (
          <p className="damage-lead">
            {symptoms.length > 0
              ? 'Cost could not be estimated for this area. Try marking it again.'
              : 'No cost breakdown — no repairable damage was identified.'}
          </p>
        )}
      </section>

      {(report.cause_analysis.primary_cause_suspected ||
        report.cause_analysis.possible_sources.length > 0) && (
        <section className="damage-block">
          <h3>Cause</h3>
          {report.cause_analysis.requires_professional_detection ? (
            <div className="damage-warning">Pro inspection recommended</div>
          ) : null}
          {report.cause_analysis.primary_cause_suspected ? (
            <p className="damage-lead">{report.cause_analysis.primary_cause_suspected}</p>
          ) : null}
          <ul className="damage-bullets">
            {report.cause_analysis.possible_sources.map((source, index) => (
              <li key={`${source.source}-${index}`}>
                <strong>{source.source || 'Source'}</strong>
                {source.probability ? ` · ${source.probability}` : ''}
                {source.description ? <span>{source.description}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(report.repair_plan.prerequisite_action || report.repair_plan.steps.length > 0) && (
        <section className="damage-block">
          <h3>Repair</h3>
          {report.repair_plan.prerequisite_action ? (
            <p className="damage-lead">
              <strong>First · </strong>
              {report.repair_plan.prerequisite_action}
            </p>
          ) : null}
          <ol className="damage-numbered">
            {report.repair_plan.steps.map((step, index) => (
              <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
            ))}
          </ol>
        </section>
      )}

      {report.recommendations.immediate_actions.length > 0 ? (
        <section className="damage-block">
          <h3>Do now</h3>
          <ul className="damage-bullets">
            {report.recommendations.immediate_actions.map((action, index) => (
              <li key={`${index}-${action.slice(0, 24)}`}>{action}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="damage-block">
        <h3>What we see</h3>
        {areaInfo.affected_zone ? (
          <p className="damage-lead">Zone · {areaInfo.affected_zone}</p>
        ) : null}
        {symptoms.length > 0 ? (
          <ul className="damage-bullets">
            {symptoms.map((symptom, index) => (
              <li key={`${symptom.type}-${index}`}>
                <strong>{symptom.type || 'Symptom'}</strong>
                {symptom.location ? ` · ${symptom.location}` : ''}
                {symptom.description ? <span>{symptom.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="damage-lead">No damage was identified inside the marked area.</p>
        )}
      </section>

      <footer className="damage-footer">
        {meta.report_id ? <span>{meta.report_id}</span> : null}
        {meta.inspection_date ? <span>{meta.inspection_date}</span> : null}
        {location ? <span>{location}</span> : null}
      </footer>

      {viewerIndex !== null && gallery[viewerIndex] ? (
        <ImageLightbox
          images={gallery}
          index={viewerIndex}
          onIndex={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
    </div>
  )
}

type GalleryImage = { url: string; caption: string }

/** Full-screen image viewer: click outside / Esc to close, ← → to browse. */
function ImageLightbox({
  images,
  index,
  onIndex,
  onClose
}: {
  images: GalleryImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const count = images.length
  const go = (delta: number) => onIndex((index + delta + count) % count)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight' && count > 1) onIndex((index + 1) % count)
      else if (event.key === 'ArrowLeft' && count > 1) onIndex((index - 1 + count) % count)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [index, count, onIndex, onClose])

  const image = images[index]
  // Portal to <body> so the viewer covers the whole window, not just the side panel.
  return createPortal(
    <div className="damage-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <img
        className="damage-lightbox-image"
        src={image.url}
        alt={image.caption}
        onClick={(event) => event.stopPropagation()}
      />
      <div className="damage-lightbox-bar" onClick={(event) => event.stopPropagation()}>
        <span>{image.caption}</span>
        {count > 1 ? (
          <span className="damage-lightbox-count">
            {index + 1} / {count}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="damage-lightbox-close"
        aria-label="Close"
        onClick={onClose}
      >
        ×
      </button>
      {count > 1 ? (
        <>
          <button
            type="button"
            className="damage-lightbox-nav prev"
            aria-label="Previous image"
            onClick={(event) => {
              event.stopPropagation()
              go(-1)
            }}
          >
            ‹
          </button>
          <button
            type="button"
            className="damage-lightbox-nav next"
            aria-label="Next image"
            onClick={(event) => {
              event.stopPropagation()
              go(1)
            }}
          >
            ›
          </button>
        </>
      ) : null}
    </div>,
    document.body
  )
}
