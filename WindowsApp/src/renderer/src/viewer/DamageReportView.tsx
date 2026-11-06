import {
  formatUsd,
  severityTone,
  type WallDamageReport
} from '../../../shared/wallDamageReport'

export function DamageReportView({
  report,
  annotatedImageDataUrl
}: {
  report: WallDamageReport
  annotatedImageDataUrl?: string | null
}) {
  const tone = severityTone(report.damage_assessment.severity_level)
  const total = report.cost_breakdown_estimate.total_estimated_cost_range
  const meta = report.report_metadata

  return (
    <div className="damage-report">
      {annotatedImageDataUrl ? (
        <section className="damage-section">
          <h3>Damaged area</h3>
          <div className="damage-outline-frame">
            <img
              src={annotatedImageDataUrl}
              alt="Damaged area outlined"
              className="damage-outline-image"
            />
          </div>
        </section>
      ) : null}

      <section className="damage-section">
        <div className="damage-meta-row">
          <div>
            <div className="damage-label">Report</div>
            <strong>{meta.report_id || '—'}</strong>
          </div>
          <div>
            <div className="damage-label">Date</div>
            <strong>{meta.inspection_date || '—'}</strong>
          </div>
        </div>
        <div className="damage-meta-row">
          <div>
            <div className="damage-label">Location</div>
            <strong>
              {[meta.location.room, meta.location.state, meta.location.country]
                .filter(Boolean)
                .join(' · ') || 'USA'}
            </strong>
          </div>
          {meta.location.wall_orientation ? (
            <div>
              <div className="damage-label">Wall</div>
              <strong>{meta.location.wall_orientation}</strong>
            </div>
          ) : null}
        </div>
      </section>

      <section className="damage-section">
        <h3>Cost estimate (USD)</h3>
        <p className="damage-market">{report.cost_breakdown_estimate.market_region}</p>
        <div className="damage-cost-table">
          {report.cost_breakdown_estimate.line_items.map((row, index) => (
            <div className="damage-cost-row" key={`${row.item}-${index}`}>
              <div>
                <strong>{row.item}</strong>
                {row.notes ? <p>{row.notes}</p> : null}
              </div>
              <div className="damage-cost-values">
                {formatUsd(row.min_cost)} – {formatUsd(row.max_cost)}
                {row.unit === 'per_sqft' ? <span className="damage-unit"> / sq ft</span> : null}
              </div>
            </div>
          ))}
        </div>
        <div className="damage-total-box">
          <div className="damage-label">Total estimated range</div>
          <strong>
            {formatUsd(total.min_total)} – {formatUsd(total.max_total)}
          </strong>
          <p>{total.disclaimer}</p>
        </div>
      </section>

      <section className="damage-section">
        <h3>Cause analysis</h3>
        {report.cause_analysis.requires_professional_detection && (
          <div className="damage-warning">
            Professional detection recommended (possible hidden moisture, mold, or structural
            risk).
          </div>
        )}
        <p className="damage-primary-cause">
          <span className="damage-label">Primary cause</span>
          <strong>{report.cause_analysis.primary_cause_suspected || '—'}</strong>
        </p>
        <ul className="damage-list">
          {report.cause_analysis.possible_sources.map((source, index) => (
            <li key={`${source.source}-${index}`}>
              <strong>{source.source || 'Source'}</strong>
              {source.probability ? <span> · {source.probability}</span> : null}
              {source.description ? <p>{source.description}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="damage-section">
        <h3>Repair plan</h3>
        {report.repair_plan.prerequisite_action ? (
          <p className="damage-prereq">
            <strong>First:</strong> {report.repair_plan.prerequisite_action}
          </p>
        ) : null}
        <ol className="damage-steps">
          {report.repair_plan.steps.map((step, index) => (
            <li key={`${index}-${step.slice(0, 24)}`}>{step}</li>
          ))}
        </ol>
      </section>

      <section className="damage-section">
        <h3>Recommendations</h3>
        <ul className="damage-list">
          {report.recommendations.immediate_actions.map((action, index) => (
            <li key={`${index}-${action.slice(0, 24)}`}>{action}</li>
          ))}
        </ul>
      </section>

      <section className="damage-section">
        <div className="damage-section-head">
          <h3>Description</h3>
          <span className={`damage-severity tone-${tone}`}>
            {report.damage_assessment.severity_level || 'Unknown'}
          </span>
        </div>
        <p className="damage-area">
          Est. area:{' '}
          <strong>
            {report.damage_assessment.damaged_area_estimation.estimated_total_area_sqft || 0}{' '}
            sq ft
          </strong>
          {report.damage_assessment.damaged_area_estimation.affected_zone
            ? ` · ${report.damage_assessment.damaged_area_estimation.affected_zone}`
            : ''}
        </p>
        <ul className="damage-list">
          {report.damage_assessment.visible_symptoms.map((symptom, index) => (
            <li key={`${symptom.type}-${index}`}>
              <strong>{symptom.type || 'Symptom'}</strong>
              {symptom.location ? <span> · {symptom.location}</span> : null}
              {symptom.description ? <p>{symptom.description}</p> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
