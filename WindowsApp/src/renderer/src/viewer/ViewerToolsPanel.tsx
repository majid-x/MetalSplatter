import { useEffect, useMemo, useRef, useState } from 'react'
import {
  analyzeDamageFromPhotos,
  DAMAGE_PHOTO_COUNT
} from '../lib/damageEstimation'
import { searchPhotos, type PhotoSearchResult } from '../lib/photoSearch'
import { searchProductsFromImage, type ProductSearchMatch } from '../lib/productSearch'
import { formatMeasureDistance } from '../lib/formatMeasureDistance'
import { measurementPrefs } from '../lib/measurementPrefs'
import type { RemoteProject } from '../projects/types'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import type { WallDamageReport } from '../../../shared/wallDamageReport'
import { DamageReportView } from './DamageReportView'
import type { ViewerPickEvent, ViewerPickMode } from './SuperSplatViewer'

type Tool = 'photos' | 'products' | 'measure' | 'damage'

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
  const [damageStatus, setDamageStatus] = useState(
    'Click a wall surface to estimate damage.'
  )
  const [damageBusy, setDamageBusy] = useState(false)
  const damageGenRef = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!lastPick) return
    if (lastPick.mode === 'damage') {
      setPoint(lastPick.point)
      setCamera(lastPick.camera)
      void runDamageEstimation(lastPick.point, lastPick.camera)
    } else if (lastPick.mode === 'photos') {
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

  async function runDamageEstimation(
    queryPoint = point,
    cam = camera
  ) {
    if (!project.photoAPIBaseURL) return
    const gen = ++damageGenRef.current
    setDamageBusy(true)
    setDamageReport(null)
    setDamageAnnotatedImage(null)
    setDamageStatus('Inspecting surface…')
    try {
      const photoResponse = await searchPhotos({
        baseURL: project.photoAPIBaseURL,
        point: queryPoint,
        cameraPosition: cam,
        useSPZCoordinates: project.isSPZ,
        useServerCalibration: project.useServerCalibration,
        maxResults: DAMAGE_PHOTO_COUNT,
        offset: 0
      })
      if (gen !== damageGenRef.current) return
      setDamageStatus('Analyzing damage…')
      const analysis = await analyzeDamageFromPhotos(photoResponse.photos, {
        projectName: project.name,
        measureFactor: project.measureFactor
      })
      if (gen !== damageGenRef.current) return
      setDamageReport(analysis.report)
      setDamageAnnotatedImage(analysis.annotatedImageDataUrl)
      setDamageStatus('Report ready')
    } catch (error) {
      if (gen !== damageGenRef.current) return
      setDamageReport(null)
      setDamageAnnotatedImage(null)
      const raw =
        error instanceof Error ? error.message : 'Damage estimation failed.'
      // Never surface the photo-search backend wording to the user.
      setDamageStatus(
        /photo|search api|deepseek|syntaxerror|json|invoking remote|avgs:damage/i.test(
          raw
        )
          ? 'Could not complete damage estimation. Try another point.'
          : raw
      )
    } finally {
      if (gen === damageGenRef.current) setDamageBusy(false)
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
              <div className="product-mac-empty">
                <span className="spinner" />
                <p>{damageStatus}</p>
              </div>
            ) : !damageReport ? (
              <div className="product-mac-empty">
                <p>{damageStatus || 'Click a wall surface to estimate damage.'}</p>
              </div>
            ) : (
              <>
                <DamageReportView
                  report={damageReport}
                  annotatedImageDataUrl={damageAnnotatedImage}
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
