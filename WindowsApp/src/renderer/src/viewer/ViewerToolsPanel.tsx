import { useEffect, useMemo, useRef, useState } from 'react'
import { analyzeDamageFromPhotos } from '../lib/damageEstimation'
import { gatherPhotosForDamageBoundary } from '../lib/damagePhotoGather'
import { searchPhotos, type PhotoSearchResult } from '../lib/photoSearch'
import { searchProductsFromImage, type ProductSearchMatch } from '../lib/productSearch'
import { formatMeasureDistance } from '../lib/formatMeasureDistance'
import { measurementPrefs } from '../lib/measurementPrefs'
import type { RemoteProject } from '../projects/types'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import type { WallDamageReport } from '../../../shared/wallDamageReport'
import { DamageReportView } from './DamageReportView'
import type {
  DamageBoundaryCompleteEvent,
  ViewerPickEvent,
  ViewerPickMode
} from './SuperSplatViewer'

type Tool = 'photos' | 'products' | 'measure' | 'damage'

const DAMAGE_PROGRESS_STEPS = [
  'Analyzing surface',
  'Loading images',
  'Estimating damage',
  'Doing final checks'
] as const

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
  const [damageStatus, setDamageStatus] = useState(
    'Mark the damaged area with 3+ corner points, then Finish.'
  )
  const [damageBusy, setDamageBusy] = useState(false)
  /** 0–3 while estimating; -1 when idle. */
  const [damageStepIndex, setDamageStepIndex] = useState(-1)
  const damageGenRef = useRef(0)
  const damageStepTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const activeRef = useRef(active)
  activeRef.current = active

  function clearDamageStepTimers() {
    for (const t of damageStepTimersRef.current) clearTimeout(t)
    damageStepTimersRef.current = []
  }

  function advanceDamageStepsDuringAnalyze(gen: number) {
    clearDamageStepTimers()
    // Photos ready → estimating. Final checks while DeepSeek finishes.
    setDamageStepIndex(2)
    setDamageStatus(DAMAGE_PROGRESS_STEPS[2])
    damageStepTimersRef.current = [
      setTimeout(() => {
        if (gen !== damageGenRef.current) return
        setDamageStepIndex(3)
        setDamageStatus(DAMAGE_PROGRESS_STEPS[3])
      }, 4200)
    ]
  }

  useEffect(() => () => clearDamageStepTimers(), [])

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
      event.regionScreenshot ?? null
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
    regionGuideImageDataUrl?: string | null
  ) {
    if (!project.photoAPIBaseURL) return
    const gen = ++damageGenRef.current
    clearDamageStepTimers()
    setDamageBusy(true)
    setDamageReport(null)
    setDamageAnnotatedImage(null)
    setDamageAnnotatedImages([])
    setDamageStepIndex(0)
    setDamageStatus(DAMAGE_PROGRESS_STEPS[0])
    try {
      // Brief surface pass, then keep that step lit while loading images.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 650)
        damageStepTimersRef.current.push(t)
      })
      if (gen !== damageGenRef.current) return
      setDamageStepIndex(1)
      setDamageStatus(DAMAGE_PROGRESS_STEPS[1])
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
        clearDamageStepTimers()
        setDamageStepIndex(-1)
        setDamageStatus('Could not inspect that area. Try marking again.')
        return
      }
      advanceDamageStepsDuringAnalyze(gen)
      const analysis = await analyzeDamageFromPhotos(gathered.photos, {
        projectName: project.name,
        measureFactor: project.measureFactor,
        regionGuideImageDataUrl
      })
      if (gen !== damageGenRef.current) return
      clearDamageStepTimers()
      setDamageStepIndex(DAMAGE_PROGRESS_STEPS.length - 1)
      setDamageReport(analysis.report)
      setDamageAnnotatedImage(analysis.annotatedImageDataUrl)
      setDamageAnnotatedImages(analysis.annotatedImageDataUrls)
      setDamageStatus('Report ready')
    } catch (error) {
      if (gen !== damageGenRef.current) return
      clearDamageStepTimers()
      setDamageStepIndex(-1)
      setDamageReport(null)
      setDamageAnnotatedImage(null)
      setDamageAnnotatedImages([])
      const raw =
        error instanceof Error ? error.message : 'Damage estimation failed.'
      // Never surface the photo-search backend wording to the user.
      setDamageStatus(
        /photo|search api|deepseek|syntaxerror|json|invoking remote|avgs:damage/i.test(
          raw
        )
          ? 'Could not complete damage estimation. Try marking the area again.'
          : raw
      )
    } finally {
      if (gen === damageGenRef.current) {
        clearDamageStepTimers()
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
            ) : damageBusy && !damageReport ? (
              <div className="damage-progress">
                <div className="damage-progress-head">
                  <p className="damage-progress-title">{damageStatus}</p>
                  <span className="damage-progress-pct">
                    {Math.round(
                      ((Math.max(0, damageStepIndex) + 1) /
                        DAMAGE_PROGRESS_STEPS.length) *
                        100
                    )}
                    %
                  </span>
                </div>
                <div className="progress-track damage-progress-track">
                  <span
                    className="progress-fill damage-progress-fill"
                    style={{
                      width: `${
                        ((Math.max(0, damageStepIndex) + 1) /
                          DAMAGE_PROGRESS_STEPS.length) *
                        100
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
                        className={`damage-progress-step${
                          done ? ' done' : ''
                        }${current ? ' current' : ''}`}
                      >
                        <span className="damage-progress-dot" aria-hidden />
                        <span>{label}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ) : !damageReport ? (
              <div className="product-mac-empty">
                <p>
                  {damageStatus ||
                    'Mark the damaged area with 3+ corner points, then Finish.'}
                </p>
              </div>
            ) : (
              <>
                <DamageReportView
                  report={damageReport}
                  annotatedImageDataUrl={damageAnnotatedImage}
                  annotatedImageDataUrls={damageAnnotatedImages}
                  measureFactor={project.measureFactor}
                />
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
