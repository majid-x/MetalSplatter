import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeDamageFromPhotos, cleanIpcError, type DamageStage } from '../lib/damageEstimation'
import { gatherPhotosForDamageBoundary } from '../lib/damagePhotoGather'
import { buildScopeCrop, type ScopeCrop } from '../lib/damageRoi'
import { searchPhotos, type PhotoSearchResult } from '../lib/photoSearch'
import { searchProductsFromImage, type ProductSearchMatch } from '../lib/productSearch'
import { formatMeasureDistance } from '../lib/formatMeasureDistance'
import { measurementPrefs } from '../lib/measurementPrefs'
import type { RemoteProject } from '../projects/types'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import { formatSqft, formatUsd, type WallDamageReport } from '../../../shared/wallDamageReport'
import type { SavedDamageReportSummary } from '../../../shared/damageChannels'
import { DamageReportView } from './DamageReportView'
import type {
  DamageBoundaryCompleteEvent,
  ViewerPickEvent,
  ViewerPickMode
} from './SuperSplatViewer'

type Tool = 'photos' | 'products' | 'measure' | 'damage'

const DAMAGE_PROGRESS_STEPS = [
  'Finding photos of the area',
  'Mapping your outline onto photos',
  'Assessing damage',
  'Outlining damage'
] as const

/** Real pipeline stage → progress step (no timers). */
const DAMAGE_STAGE_STEP: Record<DamageStage, number> = {
  mapping: 1,
  assessing: 2,
  outlining: 3
}

const SQFT_PER_M2 = 10.7639

function formatReportDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function VecFields({
  label,
  value,
  onChange
}: {
  label: string
  value: [number, number, number]
  onChange: (next: [number, number, number]) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="vec-fields">
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <input
            key={axis}
            type="number"
            step="0.01"
            value={Number.isFinite(value[index]) ? value[index] : 0}
            aria-label={`${label} ${axis}`}
            onChange={(e) => {
              const next = [...value] as [number, number, number]
              next[index] = Number(e.target.value)
              onChange(next)
            }}
          />
        ))}
      </div>
    </label>
  )
}

function dataUrlToFile(dataUrl: string, name: string): File {
  const [header, data] = dataUrl.split(',')
  const mime = /data:(.*?);/.exec(header)?.[1] ?? 'image/png'
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

export function ViewerToolsPanel({
  project,
  packageInfo,
  active,
  onClose,
  pickMode,
  onPickModeChange,
  lastPick,
  damageBoundaryComplete = null,
  onDamageBoundaryConsumed,
  onRequestScreenshot,
  pendingProductDataUrl = null,
  onPendingProductConsumed
}: {
  project: RemoteProject
  packageInfo: OpenedPackage
  active: Tool
  onClose: () => void
  pickMode: ViewerPickMode
  onPickModeChange: (mode: ViewerPickMode) => void
  lastPick: (ViewerPickEvent & { id: number }) | null
  damageBoundaryComplete?: DamageBoundaryCompleteEvent | null
  onDamageBoundaryConsumed?: () => void
  onRequestScreenshot: () => void
  /** Stable data URL of the crop from Select from view (Mac-style query image). */
  pendingProductDataUrl?: string | null
  onPendingProductConsumed?: () => void
}) {
  const start = packageInfo.camera?.position ?? ([0, 1.6, 0] as [number, number, number])
  const [point, setPoint] = useState<[number, number, number]>(start)
  const [camera, setCamera] = useState<[number, number, number]>(start)
  const [photos, setPhotos] = useState<PhotoSearchResult[]>([])
  const [photoStatus, setPhotoStatus] = useState('Click a surface to find photos.')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [photoHasMore, setPhotoHasMore] = useState(false)
  /** SplatClickQuery: grows max_results on Fetch More (6 → 12 → 18 …), offset stays 0. */
  const [photoMaxResults, setPhotoMaxResults] = useState(6)
  const PHOTO_PAGE_SIZE = 6
  const photoSearchGenRef = useRef(0)

  const [products, setProducts] = useState<ProductSearchMatch[]>([])
  const [productStatus, setProductStatus] = useState('Drag a rectangle over the view to search')
  const [productBusy, setProductBusy] = useState(false)
  const [productPreviewUrl, setProductPreviewUrl] = useState<string | null>(null)

  const [a, setA] = useState<[number, number, number]>([0, 0, 0])
  const [b, setB] = useState<[number, number, number]>([1, 0, 0])
  const [exact, setExact] = useState(measurementPrefs.showExactMeasurements)

  const [damageReport, setDamageReport] = useState<WallDamageReport | null>(null)
  const [damageAnnotatedImage, setDamageAnnotatedImage] = useState<string | null>(null)
  const [damageAnnotatedImages, setDamageAnnotatedImages] = useState<string[]>([])
  const [damageReferenceImages, setDamageReferenceImages] = useState<string[]>([])
  const [damageStatus, setDamageStatus] = useState(
    'Mark the damaged area with 3+ corner points, then Finish.'
  )
  const [damageBusy, setDamageBusy] = useState(false)
  /** 0–3 while estimating; -1 when idle. Driven by real pipeline stages. */
  const [damageStepIndex, setDamageStepIndex] = useState(-1)
  /** Measure factor that applies to the report on screen (saved reports keep their own). */
  const [damageMeasureFactor, setDamageMeasureFactor] = useState<number | undefined>(undefined)
  /** Id of the on-disk copy of the report on screen — needed for PDF export. */
  const [damageSavedId, setDamageSavedId] = useState<string | null>(null)
  const [damageExporting, setDamageExporting] = useState(false)
  const [savedReports, setSavedReports] = useState<SavedDamageReportSummary[]>([])
  const damageGenRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active

  async function refreshSavedReports() {
    try {
      setSavedReports(await window.avgs.damage.list(project.id))
    } catch {
      setSavedReports([])
    }
  }

  useEffect(() => {
    void refreshSavedReports()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  function showDamageReport(
    report: WallDamageReport,
    images: string[],
    referenceImages: string[],
    measureFactor: number | undefined,
    savedId: string | null
  ) {
    setDamageReferenceImages(referenceImages)
    setDamageReport(report)
    setDamageAnnotatedImage(images[0] ?? null)
    setDamageAnnotatedImages(images)
    setDamageMeasureFactor(measureFactor)
    setDamageSavedId(savedId)
  }

  function closeDamageReport() {
    damageGenRef.current += 1
    setDamageReport(null)
    setDamageAnnotatedImage(null)
    setDamageAnnotatedImages([])
    setDamageReferenceImages([])
    setDamageSavedId(null)
    setDamageStatus('Mark the damaged area with 3+ corner points, then Finish.')
    void refreshSavedReports()
  }

  async function openSavedReport(reportId: string) {
    const gen = ++damageGenRef.current
    try {
      const saved = await window.avgs.damage.load(project.id, reportId)
      if (gen !== damageGenRef.current) return
      showDamageReport(
        saved.report,
        saved.annotatedImageDataUrls,
        saved.referenceImageDataUrls ?? [],
        saved.measureFactor,
        saved.id
      )
      setDamageStatus(`Saved report · ${formatReportDate(saved.createdAt)}`)
    } catch (error) {
      setDamageStatus(cleanIpcError(error, 'Could not open that report.'))
    }
  }

  async function deleteSavedReport(reportId: string) {
    if (!window.confirm('Delete this saved damage report?')) return
    try {
      await window.avgs.damage.remove(project.id, reportId)
    } finally {
      void refreshSavedReports()
    }
  }

  async function exportDamagePdf() {
    if (!damageSavedId) return
    setDamageExporting(true)
    try {
      const path = await window.avgs.damage.exportPdf(project.id, damageSavedId)
      if (path) setDamageStatus('PDF exported')
    } catch (error) {
      setDamageStatus(cleanIpcError(error, 'Could not export the PDF.'))
    } finally {
      setDamageExporting(false)
    }
  }

  useEffect(() => {
    if (!lastPick) return
    if (lastPick.mode === 'photos') {
      setPoint(lastPick.point)
      setCamera(lastPick.camera)
      void runPhotoSearch(lastPick.point, lastPick.camera, false)
      // Keep pick mode on so more clicks keep searching (Mac behavior).
    } else if (lastPick.mode === 'measure-a') {
      setA(lastPick.point)
      onPickModeChange('measure-b')
    } else if (lastPick.mode === 'measure-b') {
      setB(lastPick.point)
      onPickModeChange(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPick?.id])

  useEffect(() => {
    if (!damageBoundaryComplete) return
    const event = damageBoundaryComplete
    onDamageBoundaryConsumed?.()
    setCamera(event.camera)
    if (event.points[0]) setPoint(event.points[0])
    void runDamageEstimationForBoundary(
      event.points,
      event.camera,
      event.regionScreenshot ?? null,
      event.cleanViewDataUrl && event.regionPolygon
        ? { frame: event.cleanViewDataUrl, polygon: event.regionPolygon }
        : null
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [damageBoundaryComplete?.id])

  const distanceLabel = useMemo(() => {
    const dx = (b[0] - a[0]) * project.measureFactor
    const dy = (b[1] - a[1]) * project.measureFactor
    const dz = (b[2] - a[2]) * project.measureFactor
    const meters = Math.hypot(dx, dy, dz)
    return {
      meters,
      imperial: formatMeasureDistance(meters, exact)
    }
  }, [a, b, project.measureFactor, exact])

  async function runDamageEstimationForBoundary(
    boundary: Array<[number, number, number]>,
    cam: [number, number, number],
    regionGuideImageDataUrl?: string | null,
    scopeSource?: { frame: string; polygon: Array<[number, number]> } | null
  ) {
    if (!project.photoAPIBaseURL) return
    const gen = ++damageGenRef.current
    const setStep = (index: number) => {
      if (gen !== damageGenRef.current) return
      setDamageStepIndex(index)
      setDamageStatus(DAMAGE_PROGRESS_STEPS[index])
    }
    setDamageBusy(true)
    setDamageReport(null)
    setDamageAnnotatedImage(null)
    setDamageAnnotatedImages([])
    setDamageReferenceImages([])
    setDamageSavedId(null)
    setStep(0)
    const measureFactor = project.hasMeasureFactor ? project.measureFactor : undefined
    try {
      // Exact crop of what the user marked — this is what defines the scope.
      let scope: ScopeCrop | null = null
      if (scopeSource) {
        try {
          scope = await buildScopeCrop(scopeSource.frame, scopeSource.polygon)
        } catch {
          scope = null
        }
      }
      const gathered = await gatherPhotosForDamageBoundary({
        baseURL: project.photoAPIBaseURL,
        boundary,
        cameraPosition: cam,
        measureFactor: project.measureFactor,
        useSPZCoordinates: project.isSPZ,
        useServerCalibration: project.useServerCalibration
      })
      if (gen !== damageGenRef.current) return
      if (gathered.photos.length === 0) {
        setDamageStepIndex(-1)
        setDamageStatus('No photos of that area were found. Try marking it again.')
        return
      }
      // Real area of the 3D outline — only meaningful when the scan is calibrated.
      const measuredAreaSqft =
        measureFactor && gathered.areaM2 > 0 ? gathered.areaM2 * SQFT_PER_M2 : undefined
      const analysis = await analyzeDamageFromPhotos(gathered.photos, {
        projectName: project.name,
        measureFactor,
        measuredAreaSqft,
        regionGuideImageDataUrl,
        roiProjection: {
          baseURL: project.photoAPIBaseURL,
          boundary,
          useSPZCoordinates: project.isSPZ,
          useServerCalibration: project.useServerCalibration
        },
        scope,
        onStage: (stage) => setStep(DAMAGE_STAGE_STEP[stage])
      })
      if (analysis.scopeMethod === 'guide-only') {
        console.warn('[damage] marked area could not be enforced exactly (no photo mapping, no view crop)')
      }
      if (gen !== damageGenRef.current) return

      // Save automatically so the report survives closing the panel and can be exported.
      let savedId: string | null = null
      try {
        const saved = await window.avgs.damage.save({
          projectId: project.id,
          projectName: project.name,
          report: analysis.report,
          annotatedImageDataUrls: analysis.annotatedImageDataUrls,
          referenceImageDataUrls: analysis.referenceImageDataUrls,
          measureFactor
        })
        savedId = saved.id
        void refreshSavedReports()
      } catch {
        // Report still shows; it just can't be exported until saved.
      }
      if (gen !== damageGenRef.current) return
      showDamageReport(
        analysis.report,
        analysis.annotatedImageDataUrls,
        analysis.referenceImageDataUrls,
        measureFactor,
        savedId
      )
      setDamageStatus(savedId ? 'Report ready · saved' : 'Report ready · could not save a copy')
    } catch (error) {
      if (gen !== damageGenRef.current) return
      setDamageReport(null)
      setDamageAnnotatedImage(null)
      setDamageAnnotatedImages([])
      setDamageReferenceImages([])
      const message = cleanIpcError(error, 'Damage estimation failed.')
      // Never surface the photo-search backend wording to the user.
      setDamageStatus(
        /photo api|search api|404|syntaxerror|unexpected token/i.test(message)
          ? 'Could not load photos of that area. Try marking it again.'
          : message
      )
    } finally {
      if (gen === damageGenRef.current) {
        setDamageBusy(false)
        setDamageStepIndex(-1)
      }
    }
  }

  async function runPhotoSearch(
    queryPoint = point,
    cam = camera,
    append = false
  ) {
    if (!project.photoAPIBaseURL) return
    const gen = ++photoSearchGenRef.current
    setPhotoBusy(true)
    setPhotoStatus(append ? 'Loading more…' : 'Searching…')
    // Clear old results immediately on a new pick so they don't linger while the API runs.
    if (!append) {
      setPhotos([])
      setPhotoHasMore(false)
      setPhotoMaxResults(PHOTO_PAGE_SIZE)
    }
    const maxResults = append
      ? photoMaxResults + PHOTO_PAGE_SIZE
      : PHOTO_PAGE_SIZE
    try {
      const response = await searchPhotos({
        baseURL: project.photoAPIBaseURL,
        point: queryPoint,
        cameraPosition: cam,
        useSPZCoordinates: project.isSPZ,
        useServerCalibration: project.useServerCalibration,
        maxResults,
        offset: 0
      })
      // Ignore stale responses from an earlier click.
      if (gen !== photoSearchGenRef.current) return
      // Replace the list with the larger result set (SplatClickQuery _showResults).
      setPhotos(response.photos)
      setPhotoMaxResults(maxResults)
      setPhotoHasMore(response.hasMore)
      setPhotoStatus(
        response.photos.length === 0 && !append
          ? 'No matching photos'
          : `${append ? 'Loaded' : 'Found'} nearby photos`
      )
    } catch (error) {
      if (gen !== photoSearchGenRef.current) return
      if (!append) {
        setPhotos([])
        setPhotoMaxResults(PHOTO_PAGE_SIZE)
      }
      setPhotoHasMore(false)
      setPhotoStatus(error instanceof Error ? error.message : 'Photo search failed.')
    } finally {
      if (gen === photoSearchGenRef.current) setPhotoBusy(false)
    }
  }

  async function runProductSearchFromDataUrl(dataUrl: string) {
    setProductPreviewUrl(dataUrl)
    setProductBusy(true)
    setProductStatus('Searching similar products…')
    setProducts([])
    try {
      const file = dataUrlToFile(dataUrl, 'selection.png')
      const matches = await searchProductsFromImage(file)
      setProducts(matches)
      setProductStatus(
        matches.length === 0 ? 'No similar products found. Try another region.' : 'Similar results from screenshot'
      )
    } catch (error) {
      setProducts([])
      setProductStatus(error instanceof Error ? error.message : 'Product search failed.')
    } finally {
      setProductBusy(false)
    }
  }

  useEffect(() => {
    if (!pendingProductDataUrl) return
    const dataUrl = pendingProductDataUrl
    // Keep a local copy before parent clears the pending prop.
    setProductPreviewUrl(dataUrl)
    onPendingProductConsumed?.()
    void runProductSearchFromDataUrl(dataUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProductDataUrl])

  const title =
    active === 'photos'
      ? 'Nearby Photos'
      : active === 'products'
        ? 'Visual Matches'
        : active === 'damage'
          ? 'Damage Estimation'
          : 'Measure'

  return (
    <aside className="viewer-tools">
      <header
        className={`viewer-tools-header ${
          active === 'products' || active === 'photos' || active === 'damage'
            ? 'mac-products'
            : ''
        }`}
      >
        <div>
          <h2>{title}</h2>
          {active === 'products' && (
            <p className="viewer-tools-kicker">Similar results from screenshot</p>
          )}
          {active === 'photos' && <p className="viewer-tools-kicker">{photoStatus}</p>}
          {active === 'damage' && <p className="viewer-tools-kicker">{damageStatus}</p>}
        </div>
        <button type="button" className="viewer-tools-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div
        className={`viewer-tools-body ${
          active === 'products' || active === 'photos' || active === 'damage'
            ? 'products-mac'
            : ''
        }`}
      >
        {active === 'damage' && (
          <div className="damage-panel">
            {!project.photoAPIBaseURL ? (
              <div className="product-mac-empty">
                <p>Damage estimation is not available for this project.</p>
              </div>
            ) : damageBusy ? (
              <div className="damage-progress">
                <div className="damage-progress-head">
                  <p className="damage-progress-title">{damageStatus}</p>
                  <span className="damage-progress-pct">
                    {Math.round(
                      ((Math.max(0, damageStepIndex) + 1) / DAMAGE_PROGRESS_STEPS.length) * 100
                    )}
                    %
                  </span>
                </div>
                <div className="progress-track damage-progress-track">
                  <span
                    className="progress-fill damage-progress-fill"
                    style={{
                      width: `${
                        ((Math.max(0, damageStepIndex) + 1) / DAMAGE_PROGRESS_STEPS.length) * 100
                      }%`
                    }}
                  />
                </div>
                <ol className="damage-progress-steps">
                  {DAMAGE_PROGRESS_STEPS.map((label, index) => {
                    const done = index < damageStepIndex
                    const current = index === damageStepIndex
                    return (
                      <li
                        key={label}
                        className={`damage-progress-step${done ? ' done' : ''}${
                          current ? ' current' : ''
                        }`}
                      >
                        <span className="damage-progress-dot" aria-hidden />
                        <span>{label}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ) : damageReport ? (
              <>
                <div className="damage-actions">
                  <button
                    type="button"
                    className="damage-action-btn"
                    onClick={() => void exportDamagePdf()}
                    disabled={!damageSavedId || damageExporting}
                  >
                    {damageExporting ? 'Exporting…' : 'Export PDF'}
                  </button>
                  <button
                    type="button"
                    className="damage-action-btn ghost"
                    onClick={closeDamageReport}
                  >
                    Saved reports{savedReports.length ? ` (${savedReports.length})` : ''}
                  </button>
                </div>
                <DamageReportView
                  report={damageReport}
                  annotatedImageDataUrl={damageAnnotatedImage}
                  annotatedImageDataUrls={damageAnnotatedImages}
                  referenceImageDataUrls={damageReferenceImages}
                  measureFactor={damageMeasureFactor}
                />
              </>
            ) : (
              <>
                <div className="product-mac-empty">
                  <p>{damageStatus || 'Mark the damaged area with 3+ corner points, then Finish.'}</p>
                </div>
                {savedReports.length > 0 ? (
                  <section className="damage-saved">
                    <h3>Saved reports</h3>
                    <ul>
                      {savedReports.map((saved) => (
                        <li key={saved.id}>
                          <button
                            type="button"
                            className="damage-saved-open"
                            onClick={() => void openSavedReport(saved.id)}
                          >
                            <span className="damage-saved-date">
                              {formatReportDate(saved.createdAt)}
                            </span>
                            <span className="damage-saved-meta">
                              {saved.severity} · {formatSqft(saved.areaSqft)} sq ft ·{' '}
                              {saved.maxTotal > 0
                                ? `${formatUsd(saved.minTotal)}–${formatUsd(saved.maxTotal)}`
                                : 'no cost'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="damage-saved-delete"
                            aria-label="Delete saved report"
                            onClick={() => void deleteSavedReport(saved.id)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </>
            )}
          </div>
        )}
        {active === 'photos' && (
          <div className="photo-mac-panel">
            {!project.photoAPIBaseURL ? (
              <div className="product-mac-empty">
                <p>This project has no photo search API.</p>
              </div>
            ) : photoBusy && photos.length === 0 ? (
              <div className="product-mac-empty">
                <span className="spinner" />
                <p>Searching…</p>
              </div>
            ) : photos.length === 0 ? (
              <div className="product-mac-empty">
                <p>{photoStatus || 'Click a surface to find photos.'}</p>
              </div>
            ) : (
              <>
                <div className="photo-mac-list">
                  {photos.map((photo) => (
                    <figure key={`${photo.id}-${photo.filename}`} className="photo-mac-card">
                      {photo.imageDataUrl ? (
                        <img src={photo.imageDataUrl} alt={photo.filename} />
                      ) : (
                        <div className="photo-fallback">{photo.filename}</div>
                      )}
                      <figcaption>
                        <strong>{photo.filename}</strong>
                        <span>
                          score {photo.score.toFixed(2)} · {photo.cameraDistance.toFixed(1)} m
                          {photo.is360 ? ' · 360°' : ''}
                        </span>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                {photoHasMore && (
                  <button
                    type="button"
                    className="pill-button compact"
                    disabled={photoBusy}
                    onClick={() => void runPhotoSearch(point, camera, true)}
                  >
                    {photoBusy ? (
                      <span className="spinner" />
                    ) : (
                      `Fetch More (+${PHOTO_PAGE_SIZE})`
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {active === 'products' && (
          <div className="product-mac-panel">
            {productPreviewUrl && (
              <figure className="product-query-preview">
                <img src={productPreviewUrl} alt="Your selection" />
              </figure>
            )}

            <button
              type="button"
              className="pill-button compact"
              disabled={productBusy}
              onClick={onRequestScreenshot}
            >
              {productPreviewUrl ? 'Select again' : 'Select from view'}
            </button>

            {productBusy && (
              <div className="product-mac-empty">
                <span className="spinner" />
                <p>{productStatus}</p>
              </div>
            )}

            {!productBusy && products.length === 0 && (
              <div className="product-mac-empty">
                <p>{productStatus}</p>
              </div>
            )}

            {!productBusy && products.length > 0 && (
              <div className="product-mac-grid">
                {products.map((product) => (
                  <a
                    key={product.id}
                    className="product-mac-card"
                    href={product.link ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {product.thumbnailURL ? (
                      <img src={product.thumbnailURL} alt="" />
                    ) : (
                      <div className="photo-fallback" />
                    )}
                    <strong>{product.title}</strong>
                    {product.price ? (
                      <span className="product-mac-price">{product.price}</span>
                    ) : product.source ? (
                      <span className="product-mac-source">{product.source}</span>
                    ) : null}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}

        {active === 'measure' && (
          <>
            <p className="muted tight">
              Click two points in the scene, or enter world coordinates. Distance uses measure
              factor {project.measureFactor}.
            </p>
            <button
              type="button"
              className={`pill-button compact ${pickMode?.startsWith('measure') ? 'active' : ''}`}
              onClick={() =>
                onPickModeChange(pickMode?.startsWith('measure') ? null : 'measure-a')
              }
            >
              {pickMode === 'measure-a'
                ? 'Click point A…'
                : pickMode === 'measure-b'
                  ? 'Click point B…'
                  : 'Pick two points in scene'}
            </button>
            <VecFields label="Point A" value={a} onChange={setA} />
            <VecFields label="Point B" value={b} onChange={setB} />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={exact}
                onChange={(e) => {
                  const next = e.target.checked
                  setExact(next)
                  measurementPrefs.showExactMeasurements = next
                }}
              />
              <span>
                <strong>Show exact measurements</strong>
                <small>{exact ? 'Nearest 1/32″' : 'Nearest 1/4″'}</small>
              </span>
            </label>
            <div className="measure-result">
              <div className="measure-imperial">{distanceLabel.imperial}</div>
              <div className="measure-meters">{distanceLabel.meters.toFixed(3)} m</div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

export type ViewerToolId = Tool

export { dataUrlToFile }
