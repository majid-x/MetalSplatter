import {
  formatUsd,
  severityTone,
  type WallDamageReport
} from '../../../shared/wallDamageReport'

export function DamageReportView({
  report,
  annotatedImageDataUrl,
  measureFactor
}: {
  report: WallDamageReport
  annotatedImageDataUrl?: string | null
  measureFactor?: number
}) {
  const tone = severityTone(report.damage_assessment.severity_level)
  const total = report.cost_breakdown_estimate.total_estimated_cost_range
  const meta = report.report_metadata
  const areaSqft =
    report.damage_assessment.damaged_area_estimation.estimated_total_area_sqft || 0
  const hasScale =
    typeof measureFactor === 'number' && Number.isFinite(measureFactor) && measureFactor > 0
  const location = [meta.location.room, meta.location.state, meta.location.country]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="damage-report">
      {annotatedImageDataUrl ? (
        <section className="damage-hero">
          <img
            src={annotatedImageDataUrl}
            alt="Damaged area outlined"
            className="damage-outline-image"
          />
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
          <span className="damage-stat-label">Area</span>
          <span className="damage-stat-value">
            {areaSqft.toFixed(areaSqft >= 10 ? 0 : 1)}
            <small> sq ft</small>
          </span>
        </div>
        <div className="damage-stat damage-stat-wide">
          <span className="damage-stat-label">Total</span>
          <span className="damage-stat-value damage-stat-money">
            {formatUsd(total.min_total)} – {formatUsd(total.max_total)}
          </span>
        </div>
        <p className="damage-scale-note">
          {hasScale
            ? `Lengths use measure factor ${measureFactor} (scene × factor = meters)`
            : 'No measure factor — sizes are photo estimates only'}
        </p>
      </section>

      <section className="damage-block">
        <h3>Cost</h3>
        <ul className="damage-cost-list">
          {report.cost_breakdown_estimate.line_items.map((row, index) => (
            <li key={`${row.item}-${index}`}>
              <div className="damage-cost-main">
                <span className="damage-cost-name">{row.item}</span>
                <span className="damage-cost-price">
                  {formatUsd(row.min_cost)}–{formatUsd(row.max_cost)}
                  {row.unit === 'per_sqft' ? <em>/sqft</em> : null}
                </span>
              </div>
              {row.notes ? <p>{row.notes}</p> : null}
            </li>
          ))}
        </ul>
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
        {report.damage_assessment.damaged_area_estimation.affected_zone ? (
          <p className="damage-lead">
            Zone · {report.damage_assessment.damaged_area_estimation.affected_zone}
          </p>
        ) : null}
        <ul className="damage-bullets">
          {report.damage_assessment.visible_symptoms.map((symptom, index) => (
            <li key={`${symptom.type}-${index}`}>
              <strong>{symptom.type || 'Symptom'}</strong>
              {symptom.location ? ` · ${symptom.location}` : ''}
              {symptom.description ? <span>{symptom.description}</span> : null}
            </li>
          ))}
        </ul>
      </section>

      <footer className="damage-footer">
        <span>{meta.report_id || 'Report'}</span>
        <span>{meta.inspection_date || ''}</span>
        <span>{location || 'USA'}</span>
        {meta.location.wall_orientation ? <span>{meta.location.wall_orientation}</span> : null}
      </footer>
    </div>
  )
}
