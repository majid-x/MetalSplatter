import { app, BrowserWindow, dialog, shell } from 'electron'
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { handle } from './ipc'
import {
  DAMAGE_CHANNELS,
  type SavedDamageReport,
  type SavedDamageReportInput,
  type SavedDamageReportSummary
} from '../shared/damageChannels'
import {
  formatSqft,
  formatUsd,
  type WallDamageReport
} from '../shared/wallDamageReport'

/**
 * Saved damage reports live OUTSIDE PrivateProjects so deleting a project's
 * local download (or re-downloading it) never deletes its reports.
 *   userData/DamageReports/<projectId>/<reportId>/report.json + image-N.jpg
 */
const ROOT_FOLDER = 'DamageReports'

function reportsRoot(): string {
  return join(app.getPath('userData'), ROOT_FOLDER)
}

function safeSegment(value: string): string {
  const s = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (!s) throw new Error('Invalid report id.')
  return s
}

function projectFolder(projectId: string): string {
  return join(reportsRoot(), safeSegment(projectId))
}

function reportFolder(projectId: string, reportId: string): string {
  return join(projectFolder(projectId), safeSegment(reportId))
}

type StoredReport = SavedDamageReportSummary & {
  report: WallDamageReport
  imageFiles: string[]
  /** Unannotated close-up photos (older reports don't have this). */
  referenceFiles?: string[]
  measureFactor?: number
}

function summarize(stored: StoredReport): SavedDamageReportSummary {
  return {
    id: stored.id,
    projectId: stored.projectId,
    projectName: stored.projectName,
    createdAt: stored.createdAt,
    severity: stored.severity,
    areaSqft: stored.areaSqft,
    minTotal: stored.minTotal,
    maxTotal: stored.maxTotal,
    imageCount: stored.imageCount
  }
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; ext: string } | null {
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(dataUrl || '')
  if (!match) return null
  const ext = match[1].toLowerCase() === 'png' ? 'png' : match[1].toLowerCase() === 'webp' ? 'webp' : 'jpg'
  return { buffer: Buffer.from(match[2], 'base64'), ext }
}

async function readStored(folder: string): Promise<StoredReport | null> {
  try {
    const text = await readFile(join(folder, 'report.json'), 'utf8')
    return JSON.parse(text) as StoredReport
  } catch {
    return null
  }
}

export async function saveDamageReport(input: SavedDamageReportInput): Promise<SavedDamageReportSummary> {
  const createdAt = new Date().toISOString()
  const id = `${createdAt.replace(/[^0-9]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`
  const folder = reportFolder(input.projectId, id)
  await mkdir(folder, { recursive: true })

  async function writeImages(urls: string[] | undefined, prefix: string): Promise<string[]> {
    const names: string[] = []
    for (const [index, url] of (urls || []).entries()) {
      const decoded = dataUrlToBuffer(url)
      if (!decoded) continue
      const name = `${prefix}-${index + 1}.${decoded.ext}`
      await writeFile(join(folder, name), decoded.buffer)
      names.push(name)
    }
    return names
  }
  const imageFiles = await writeImages(input.annotatedImageDataUrls, 'image')
  const referenceFiles = await writeImages(input.referenceImageDataUrls, 'photo')

  const report = input.report
  const total = report.cost_breakdown_estimate.total_estimated_cost_range
  const stored: StoredReport = {
    id,
    projectId: safeSegment(input.projectId),
    projectName: input.projectName || 'Project',
    createdAt,
    severity: report.damage_assessment.severity_level || 'Unknown',
    areaSqft: report.damage_assessment.damaged_area_estimation.estimated_total_area_sqft || 0,
    minTotal: total.min_total,
    maxTotal: total.max_total,
    imageCount: imageFiles.length + referenceFiles.length,
    report,
    imageFiles,
    referenceFiles,
    measureFactor: input.measureFactor
  }
  await writeFile(join(folder, 'report.json'), JSON.stringify(stored, null, 2), 'utf8')
  return summarize(stored)
}

export async function listDamageReports(projectId: string): Promise<SavedDamageReportSummary[]> {
  const folder = projectFolder(projectId)
  if (!existsSync(folder)) return []
  const entries = await readdir(folder, { withFileTypes: true })
  const out: SavedDamageReportSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const stored = await readStored(join(folder, entry.name))
    if (stored) out.push(summarize(stored))
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function loadDamageReport(projectId: string, reportId: string): Promise<SavedDamageReport> {
  const folder = reportFolder(projectId, reportId)
  const stored = await readStored(folder)
  if (!stored) throw new Error('That saved report could not be found.')
  async function readImages(names: string[] | undefined): Promise<string[]> {
    const out: string[] = []
    for (const name of names || []) {
      try {
        const buffer = await readFile(join(folder, name))
        const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
        out.push(`data:${mime};base64,${buffer.toString('base64')}`)
      } catch {
        // missing image — show the report without it
      }
    }
    return out
  }
  return {
    ...summarize(stored),
    report: stored.report,
    annotatedImageDataUrls: await readImages(stored.imageFiles),
    referenceImageDataUrls: await readImages(stored.referenceFiles),
    measureFactor: stored.measureFactor
  }
}

export async function deleteDamageReport(projectId: string, reportId: string): Promise<void> {
  await rm(reportFolder(projectId, reportId), { recursive: true, force: true })
}

export async function removeAllDamageReports(): Promise<void> {
  await rm(reportsRoot(), { recursive: true, force: true })
}

// ---------------------------------------------------------------- PDF export

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function list(items: string[], ordered = false): string {
  if (items.length === 0) return ''
  const tag = ordered ? 'ol' : 'ul'
  return `<${tag}>${items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`
}

function buildReportHtml(stored: StoredReport): string {
  const r = stored.report
  const da = r.damage_assessment
  const area = da.damaged_area_estimation
  const cost = r.cost_breakdown_estimate
  const total = cost.total_estimated_cost_range
  const loc = r.report_metadata.location
  const created = new Date(stored.createdAt)
  const dateText = Number.isNaN(created.getTime())
    ? stored.createdAt
    : created.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })

  const areaNote =
    area.area_source === 'measured'
      ? `Measured from the 3D scan outline${stored.measureFactor ? ` (measure factor ${stored.measureFactor})` : ''}.`
      : 'Estimated from photos — this project has no scan calibration.'

  const costRows = cost.line_items
    .map((row) => {
      const perSqft = row.unit === 'per_sqft'
      const rate = perSqft
        ? `${formatUsd(row.min_cost)}–${formatUsd(row.max_cost)} / sq ft${
            row.quantity_sqft ? ` × ${formatSqft(row.quantity_sqft)} sq ft` : ''
          }`
        : row.unit
          ? `${esc(row.unit)}`
          : 'Flat'
      const amount = row.excluded_from_total
        ? '<em>Not priced (area unknown)</em>'
        : `${formatUsd(row.extended_min ?? row.min_cost)} – ${formatUsd(row.extended_max ?? row.max_cost)}`
      return `<tr><td><strong>${esc(row.item)}</strong>${row.notes ? `<div class="note">${esc(row.notes)}</div>` : ''}</td><td>${rate}</td><td class="num">${amount}</td></tr>`
    })
    .join('')

  const images = (stored.imageFiles || [])
    .map((name, i) => `<img src="${esc(name)}" alt="Damaged area ${i + 1}" />`)
    .join('')
  const photos = (stored.referenceFiles || [])
    .map((name, i) => `<img src="${esc(name)}" alt="Close-up photo ${i + 1}" />`)
    .join('')

  const locationParts = [loc.room, loc.wall_orientation, loc.state, loc.country].filter(Boolean)

  return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Damage Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #1c1c1e; margin: 0; font-size: 11pt; line-height: 1.45; }
  header { border-bottom: 2px solid #1c1c1e; padding-bottom: 10px; margin-bottom: 16px; }
  h1 { font-size: 20pt; margin: 0 0 4px; }
  .sub { color: #555; font-size: 10pt; }
  h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: .08em; color: #555; margin: 20px 0 8px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .stats { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 10px; margin-bottom: 6px; }
  .stat { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; }
  .stat .k { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: #777; }
  .stat .v { font-size: 15pt; font-weight: 600; }
  .sev-low { color: #2f7d4f; } .sev-moderate { color: #b26a00; } .sev-high { color: #b3261e; }
  .muted { color: #666; font-size: 9.5pt; }
  .images { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .images img { width: 100%; border-radius: 4px; border: 1px solid #ddd; page-break-inside: avoid; }
  .images img:only-child { grid-column: 1 / -1; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  td, th { border-bottom: 1px solid #e5e5e5; padding: 6px 4px; vertical-align: top; text-align: left; }
  th { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #777; }
  .num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-top: 2px solid #1c1c1e; border-bottom: none; }
  .note { color: #666; font-size: 9pt; }
  .warn { display: inline-block; background: #fff1e6; color: #a04a00; border-radius: 4px; padding: 2px 8px; font-size: 9.5pt; font-weight: 600; margin-bottom: 6px; }
  ul, ol { margin: 0; padding-left: 18px; }
  li { margin: 2px 0; }
  footer { margin-top: 24px; border-top: 1px solid #ddd; padding-top: 8px; color: #777; font-size: 8.5pt; }
</style></head><body>
<header>
  <h1>Wall Damage Report</h1>
  <div class="sub">${esc(stored.projectName)} · ${esc(dateText)}${locationParts.length ? ` · ${esc(locationParts.join(' · '))}` : ''}</div>
</header>

<div class="stats">
  <div class="stat"><div class="k">Severity</div><div class="v sev-${esc((da.severity_level || 'unknown').toLowerCase())}">${esc(da.severity_level || 'Unknown')}</div></div>
  <div class="stat"><div class="k">Damaged area</div><div class="v">${formatSqft(area.estimated_total_area_sqft)} <span style="font-size:10pt">sq ft</span></div></div>
  <div class="stat"><div class="k">Estimated cost</div><div class="v">${cost.line_items.length ? `${formatUsd(total.min_total)} – ${formatUsd(total.max_total)}` : '—'}</div></div>
</div>
<div class="muted">${esc(areaNote)}${area.affected_zone ? ` Zone: ${esc(area.affected_zone)}.` : ''}</div>

${images ? `<h2>Damaged area</h2><div class="images">${images}</div>` : ''}
${photos ? `<h2>Close-up photos</h2><div class="images">${photos}</div>` : ''}

<h2>What we see</h2>
${da.visible_symptoms.length
    ? list(da.visible_symptoms.map((s) => `<strong>${esc(s.type || 'Symptom')}</strong>${s.location ? ` · ${esc(s.location)}` : ''}${s.description ? ` — ${esc(s.description)}` : ''}`))
    : '<p class="muted">No damage was identified inside the marked area.</p>'}

${r.cause_analysis.primary_cause_suspected || r.cause_analysis.possible_sources.length
    ? `<h2>Likely cause</h2>
${r.cause_analysis.requires_professional_detection ? '<div class="warn">Professional inspection recommended</div>' : ''}
${r.cause_analysis.primary_cause_suspected ? `<p>${esc(r.cause_analysis.primary_cause_suspected)}</p>` : ''}
${list(r.cause_analysis.possible_sources.map((s) => `<strong>${esc(s.source || 'Source')}</strong>${s.probability ? ` · ${esc(s.probability)}` : ''}${s.description ? ` — ${esc(s.description)}` : ''}`))}`
    : ''}

<h2>Cost estimate (${esc(cost.market_region || 'USA')})</h2>
${cost.line_items.length
    ? `<table><thead><tr><th>Item</th><th>Basis</th><th class="num">Amount</th></tr></thead><tbody>${costRows}</tbody>
<tfoot><tr><td colspan="2">Total</td><td class="num">${formatUsd(total.min_total)} – ${formatUsd(total.max_total)}</td></tr></tfoot></table>
<p class="note">${esc(total.disclaimer)}</p>`
    : '<p class="muted">No cost breakdown was produced.</p>'}

${r.repair_plan.prerequisite_action || r.repair_plan.steps.length
    ? `<h2>Repair plan</h2>
${r.repair_plan.prerequisite_action ? `<p><strong>First:</strong> ${esc(r.repair_plan.prerequisite_action)}</p>` : ''}
${list(r.repair_plan.steps.map(esc), true)}`
    : ''}

${r.recommendations.immediate_actions.length
    ? `<h2>Do now</h2>${list(r.recommendations.immediate_actions.map(esc))}`
    : ''}

<footer>Report ${esc(r.report_metadata.report_id || stored.id)} · Generated by Vroomk. AI-assisted estimate from 3D scan imagery — not a substitute for an on-site professional inspection.</footer>
</body></html>`
}

export async function exportDamageReportPdf(
  parent: BrowserWindow | null,
  projectId: string,
  reportId: string
): Promise<string | null> {
  const folder = reportFolder(projectId, reportId)
  const stored = await readStored(folder)
  if (!stored) throw new Error('That saved report could not be found.')

  const htmlPath = join(folder, 'report.html')
  await writeFile(htmlPath, buildReportHtml(stored), 'utf8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true }
  })
  let pdf: Buffer
  try {
    await win.loadFile(htmlPath)
    pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
  } finally {
    win.destroy()
  }

  const date = stored.createdAt.slice(0, 10)
  const safeName = stored.projectName.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'Project'
  const options = {
    title: 'Export Damage Report',
    defaultPath: join(app.getPath('documents'), `Vroomk-Damage-Report-${safeName}-${date}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, pdf)
  shell.showItemInFolder(result.filePath)
  return result.filePath
}

export function registerDamageReportsIpc(): void {
  handle(DAMAGE_CHANNELS.saveReport, async (_e, input: SavedDamageReportInput) => saveDamageReport(input))
  handle(DAMAGE_CHANNELS.listReports, async (_e, projectId: string) => listDamageReports(projectId))
  handle(DAMAGE_CHANNELS.loadReport, async (_e, projectId: string, reportId: string) =>
    loadDamageReport(projectId, reportId)
  )
  handle(DAMAGE_CHANNELS.deleteReport, async (_e, projectId: string, reportId: string) =>
    deleteDamageReport(projectId, reportId)
  )
  handle(DAMAGE_CHANNELS.exportPdf, async (event, projectId: string, reportId: string) =>
    exportDamageReportPdf(BrowserWindow.fromWebContents(event.sender), projectId, reportId)
  )
  handle(DAMAGE_CHANNELS.removeAllReports, async () => removeAllDamageReports())
}
