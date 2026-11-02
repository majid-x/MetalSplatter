import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import { ScreenshotSelectionOverlay } from '../components/ScreenshotSelectionOverlay'
import { formatBytes } from '../lib/formatBytes'
import { useDownloads } from '../projects/DownloadContext'
import type { RemoteProject } from '../projects/types'
import {
  SuperSplatViewer,
  type MeasureCommands,
  type MeasureStateEvent,
  type ViewerPickEvent,
  type ViewerPickMode
} from '../viewer/SuperSplatViewer'
import { ViewerToolsPanel, type ViewerToolId } from '../viewer/ViewerToolsPanel'

type Phase = 'downloading' | 'unpacking' | 'ready' | { failed: string }

type ScreenshotPurpose = 'products' | 'save' | null

const DEFAULT_HINT = 'Click to look · mouse looks around · WASD / arrows move · Esc releases cursor'

function RailIcon({ name }: { name: 'measure' | 'products' | 'shot' | 'search' | 'topdown' }) {
  if (name === 'measure') {
    return (
      <svg className="rail-svg" viewBox="0 0 16 16" aria-hidden>
        <path
          fill="currentColor"
          d="M2 11.5V4.5h1.2V6H4.4V4.5h1.2V6H6.8V4.5h1.2V6H9.2V4.5h1.2V6H11.6V4.5H12.8v7H2zm1.2-1.2h8.4V7.8H12V9H10.8V7.8H9.6V9H8.4V7.8H7.2V9H6V7.8H4.8V9H3.6V7.8H3.2v2.5z"
        />
      </svg>
    )
  }
  if (name === 'products') {
    return (
      <svg className="rail-svg" viewBox="0 0 16 16" aria-hidden>
        <path
          fill="currentColor"
          d="M2.5 2.5h4v4h-4v-4zm7 0h4v4h-4v-4zm-7 7h4v4h-4v-4zm7 0h4v4h-4v-4z"
        />
      </svg>
    )
  }
  if (name === 'shot') {
    return (
      <svg className="rail-svg" viewBox="0 0 16 16" aria-hidden>
        <path
          fill="currentColor"
          d="M5.2 3.2 6 2h4l.8 1.2H14v10.6H2V3.2h3.2zM8 12.2A3.4 3.4 0 1 0 8 5.4a3.4 3.4 0 0 0 0 6.8zm0-1.5a1.9 1.9 0 1 1 0-3.8 1.9 1.9 0 0 1 0 3.8z"
        />
      </svg>
    )
  }
  if (name === 'search') {
    return (
      <svg className="rail-svg" viewBox="0 0 16 16" aria-hidden>
        <path
          fill="currentColor"
          d="M7 2.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6zm0 1.5a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6zm4.4 6.5 2.7 2.7-1.1 1.1-2.7-2.7 1.1-1.1z"
        />
      </svg>
    )
  }
  return (
    <svg className="rail-svg" viewBox="0 0 16 16" aria-hidden>
      <path
        fill="currentColor"
        d="M2 3h12v2H2V3zm0 4h12v2H2V7zm0 4h12v2H2v-2z"
      />
    </svg>
  )
}

export function ProjectViewerView({
  project,
  initialPackage = null,
  onBack
}: {
  project: RemoteProject
  initialPackage?: OpenedPackage | null
  onBack: () => void
}) {
  const downloads = useDownloads()
  const status = downloads.statusFor(project.id)
  const [phase, setPhase] = useState<Phase>(initialPackage ? 'ready' : 'downloading')
  const [opened, setOpened] = useState<OpenedPackage | null>(initialPackage)
  const [hadCache, setHadCache] = useState(false)
  const [activeTool, setActiveTool] = useState<ViewerToolId | null>(null)
  const [pickMode, setPickMode] = useState<ViewerPickMode>(null)
  const [lastPick, setLastPick] = useState<(ViewerPickEvent & { id: number }) | null>(null)
  const pickSeqRef = useRef(0)
  const openGenRef = useRef(0)
  const [screenshotPurpose, setScreenshotPurpose] = useState<ScreenshotPurpose>(null)
  const [toolHint, setToolHint] = useState(DEFAULT_HINT)
  const [measureStatus, setMeasureStatus] = useState('Measure off')
  const [measureDeleteMode, setMeasureDeleteMode] = useState(false)
  const measureCommandsRef = useRef<MeasureCommands | null>(null)
  const [savingShot, setSavingShot] = useState(false)
  const [viewerError, setViewerError] = useState<string | null>(null)
  const [showSidePanel, setShowSidePanel] = useState(false)
  const [pendingProductDataUrl, setPendingProductDataUrl] = useState<string | null>(null)

  // Once the package is open, never let a stale "unpacking" status event hide the viewer.
  // (Previously: idle/unpacking race set phase back to Preparing forever while opened was set.)
  const livePhase: Phase =
    typeof phase === 'object'
      ? phase
      : opened
        ? 'ready'
        : status.state === 'downloading'
          ? 'downloading'
          : status.state === 'unpacking'
            ? 'unpacking'
            : phase
  const progress = status.state === 'downloading' ? status.progress : null
  const supportsPhotoSearch = Boolean(project.photoAPIBaseURL)
  const hasTopDownCut = Boolean(opened?.navSummary?.hasTopDownCut)

  const title = useMemo(() => {
    if (typeof livePhase === 'object') return "Couldn't open project"
    if (livePhase === 'downloading') return 'Downloading project'
    if (livePhase === 'unpacking') return 'Preparing project'
    return 'Loading scene'
  }, [livePhase])

  const subtitle = useMemo(() => {
    if (typeof livePhase === 'object') return livePhase.failed
    if (livePhase === 'downloading') {
      return hadCache
        ? 'Opening your saved copy…'
        : 'Downloading from your project library — this can take a while for large scans.'
    }
    if (livePhase === 'unpacking') return 'Unpacking the scene package…'
    return 'Opening in SuperSplat…'
  }, [livePhase, hadCache])

  function clearModes() {
    setPickMode(null)
    setScreenshotPurpose(null)
  }

  /** Mac ClientSceneView: enabling another tool forces Measure off and clears its UI. */
  function dismissMeasureTool() {
    measureCommandsRef.current?.clear()
    setMeasureDeleteMode(false)
    setMeasureStatus('Measure off')
  }

  function resetTools() {
    clearModes()
    dismissMeasureTool()
    setActiveTool(null)
    setShowSidePanel(false)
    setToolHint(DEFAULT_HINT)
  }

  function setMeasureOn(enabled: boolean) {
    clearModes()
    setMeasureDeleteMode(false)
    if (enabled) {
      setActiveTool('measure')
      setPickMode(null)
      setMeasureStatus('Measure on · click two points')
      setToolHint('Measure on · click two points for a distance · drag to look · Delete / Undo')
      setShowSidePanel(false)
    } else {
      dismissMeasureTool()
      setActiveTool(null)
      setToolHint(DEFAULT_HINT)
    }
  }

  const onMeasureState = useCallback((event: MeasureStateEvent) => {
    setMeasureStatus(event.status)
    setMeasureDeleteMode(event.deleteMode)
  }, [])

  function setPhotosOn(enabled: boolean) {
    clearModes()
    dismissMeasureTool()
    if (enabled) {
      setActiveTool('photos')
      setPickMode('photos')
      setShowSidePanel(true)
      setToolHint('Search Image on · click a surface to search · drag to look · tap tool again to leave')
    } else {
      setActiveTool(null)
      setShowSidePanel(false)
      setToolHint(DEFAULT_HINT)
    }
  }

  const onPick = useCallback((event: ViewerPickEvent) => {
    pickSeqRef.current += 1
    setLastPick({ ...event, id: pickSeqRef.current })
    if (event.mode === 'photos') {
      setActiveTool('photos')
      setShowSidePanel(true)
    }
  }, [])

  async function finishScreenshot(
    selection: { x: number; y: number; width: number; height: number },
    overlayBounds: DOMRect
  ) {
    const purpose = screenshotPurpose
    setScreenshotPurpose(null)
    try {
      const dataUrl = await window.avgs.capture.region({
        x: overlayBounds.left + selection.x,
        y: overlayBounds.top + selection.y,
        width: selection.width,
        height: selection.height
      })
      if (purpose === 'save') {
        setSavingShot(true)
        const saved = await window.avgs.capture.save(dataUrl)
        setToolHint(saved ? 'Screenshot saved' : DEFAULT_HINT)
        setSavingShot(false)
        return
      }
      setActiveTool('products')
      setShowSidePanel(true)
      setPendingProductDataUrl(dataUrl)
    } catch (error) {
      console.error(error)
      setToolHint('Screenshot failed. Try again.')
      setSavingShot(false)
    }
  }

  async function openPackage(forceRedownload = false) {
    const gen = ++openGenRef.current
    setOpened(null)
    setActiveTool(null)
    setPickMode(null)
    setLastPick(null)
    setViewerError(null)
    setShowSidePanel(false)
    const cached =
      !forceRedownload && (await downloads.isCached(project.id, project.remoteURL))
    if (gen !== openGenRef.current) return
    setHadCache(cached)
    setPhase(cached ? 'unpacking' : 'downloading')

    try {
      const result = await downloads.openPackage(
        {
          id: project.id,
          name: project.name,
          remoteURL: project.remoteURL
        },
        forceRedownload
      )
      if (gen !== openGenRef.current) return
      setOpened(result)
      setPhase('ready')
      await downloads.refreshTotals()
      downloads.bumpCacheRevision()
    } catch (error) {
      if (gen !== openGenRef.current) return
      if (error instanceof Error && /stopped/i.test(error.message)) {
        onBack()
        return
      }
      setPhase({
        failed:
          error instanceof Error
            ? error.message
            : 'Something went wrong while opening this project.'
      })
    }
  }

  useEffect(() => {
    if (initialPackage) {
      setOpened(initialPackage)
      setPhase('ready')
      return
    }
    void openPackage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, initialPackage?.packagePath])

  // Mirror download/unpack progress into phase only while we don't have a scene yet.
  useEffect(() => {
    if (opened) return
    if (status.state === 'unpacking') setPhase('unpacking')
    if (status.state === 'downloading' && !hadCache) setPhase('downloading')
  }, [status, hadCache, opened])

  const sidePanelOpen =
    showSidePanel && (activeTool === 'photos' || activeTool === 'products')

  return (
    <div className="project-viewer">
      <div className="project-viewer-top">
        <button type="button" className="back-pill" onClick={onBack}>
          <span className="back-chevron" aria-hidden>
            ‹
          </span>
          Projects
        </button>
        <span className="project-viewer-title">{project.name}</span>
      </div>

      {opened ? (
        <div className={`viewer-stage ${sidePanelOpen ? 'with-tools' : ''}`}>
          <div className="viewer-canvas-wrap">
            <SuperSplatViewer
              packageInfo={opened}
              projectName={project.name}
              pickMode={pickMode}
              measureMode={activeTool === 'measure'}
              measureDeleteMode={measureDeleteMode}
              measureFactor={
                project.measureFactor * (opened.measureScale && opened.measureScale > 0 ? opened.measureScale : 1)
              }
              moveSpeed={project.moveSpeed}
              measureCommandsRef={measureCommandsRef}
              onPick={onPick}
              onMeasureState={onMeasureState}
              onViewerError={setViewerError}
            />
            {viewerError && (
              <div className="viewer-inline-error">
                <strong>Viewer error</strong>
                <p>{viewerError}</p>
                <button
                  type="button"
                  className="pill-button compact"
                  onClick={() => void openPackage(true)}
                >
                  Reload
                </button>
              </div>
            )}
            {screenshotPurpose && (
              <ScreenshotSelectionOverlay
                onComplete={(rect, bounds) => void finishScreenshot(rect, bounds)}
                onCancel={() => {
                  setScreenshotPurpose(null)
                  setToolHint(DEFAULT_HINT)
                }}
              />
            )}

            <div className="viewer-tool-rail" aria-label="Viewer tools">
              {supportsPhotoSearch && (
                <button
                  type="button"
                  className={`viewer-rail-btn accent-orange ${activeTool === 'photos' ? 'active' : ''}`}
                  onClick={() => setPhotosOn(activeTool !== 'photos')}
                  disabled={Boolean(screenshotPurpose)}
                >
                  <RailIcon name="search" />
                  {activeTool === 'photos' ? 'Search Image On' : 'Search Image'}
                  {activeTool === 'photos' && <span className="rail-dot orange" />}
                </button>
              )}

              <button
                type="button"
                className={`viewer-rail-btn accent-cyan ${activeTool === 'measure' ? 'active' : ''}`}
                onClick={() => setMeasureOn(activeTool !== 'measure')}
                disabled={Boolean(screenshotPurpose)}
              >
                <RailIcon name="measure" />
                {activeTool === 'measure' ? 'Measure On' : 'Measure'}
                {activeTool === 'measure' && <span className="rail-dot cyan" />}
              </button>

              {activeTool === 'measure' && (
                <div className="viewer-rail-subrow">
                  <button
                    type="button"
                    className={`viewer-rail-sub ${measureDeleteMode ? 'active' : ''} danger`}
                    onClick={() => setMeasureDeleteMode((value) => !value)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="viewer-rail-sub"
                    onClick={() => measureCommandsRef.current?.undo()}
                  >
                    Undo
                  </button>
                  <button
                    type="button"
                    className="viewer-rail-sub danger"
                    onClick={() => {
                      measureCommandsRef.current?.clear()
                      setMeasureDeleteMode(false)
                    }}
                  >
                    Delete All
                  </button>
                </div>
              )}

              {hasTopDownCut && (
                <button type="button" className="viewer-rail-btn accent-purple" disabled>
                  <RailIcon name="topdown" />
                  Top Down
                </button>
              )}

              <button
                type="button"
                className={`viewer-rail-btn accent-blue ${
                  screenshotPurpose === 'products' || activeTool === 'products' ? 'active' : ''
                }`}
                onClick={() => {
                  if (screenshotPurpose === 'products') {
                    setScreenshotPurpose(null)
                    setToolHint(DEFAULT_HINT)
                    return
                  }
                  resetTools()
                  setScreenshotPurpose('products')
                  setToolHint('Drag a rectangle to search products')
                }}
                disabled={savingShot || screenshotPurpose === 'save'}
              >
                <RailIcon name="products" />
                Search Products
                {(screenshotPurpose === 'products' || activeTool === 'products') && (
                  <span className="rail-dot blue" />
                )}
              </button>

              <button
                type="button"
                className={`viewer-rail-btn accent-green ${screenshotPurpose === 'save' ? 'active' : ''}`}
                onClick={() => {
                  if (screenshotPurpose === 'save') {
                    setScreenshotPurpose(null)
                    setToolHint(DEFAULT_HINT)
                    return
                  }
                  resetTools()
                  setScreenshotPurpose('save')
                  setToolHint('Drag a rectangle to save a screenshot')
                }}
                disabled={savingShot || screenshotPurpose === 'products'}
              >
                <RailIcon name="shot" />
                {savingShot ? 'Saving…' : 'Screenshot'}
                {screenshotPurpose === 'save' && <span className="rail-dot green" />}
              </button>

              {activeTool === 'measure' && (
                <p className="viewer-tool-status">{measureStatus}</p>
              )}

              {activeTool === 'measure' || screenshotPurpose || activeTool === 'photos' ? (
                <p className="viewer-tool-hint">{toolHint}</p>
              ) : (
                <p className="viewer-tool-hint">{DEFAULT_HINT}</p>
              )}
            </div>
          </div>

          {sidePanelOpen && activeTool && (
            <ViewerToolsPanel
              project={project}
              packageInfo={opened}
              active={activeTool}
              onClose={() => {
                setShowSidePanel(false)
                setPendingProductDataUrl(null)
                if (activeTool === 'photos') setPhotosOn(false)
                else {
                  setActiveTool(null)
                  setToolHint(DEFAULT_HINT)
                }
              }}
              pickMode={pickMode}
              onPickModeChange={setPickMode}
              lastPick={lastPick}
              pendingProductDataUrl={pendingProductDataUrl}
              onPendingProductConsumed={() => setPendingProductDataUrl(null)}
              onRequestScreenshot={() => {
                setScreenshotPurpose('products')
                setToolHint('Drag a rectangle to search products')
              }}
            />
          )}
        </div>
      ) : (
        <div className="project-loader">
          <div className="project-loader-orb" aria-hidden />
          <div className="project-loader-card">
            <div className="project-loader-icon">
              {typeof phase === 'object' ? '!' : <span className="spinner large" />}
            </div>
            <h1>{title}</h1>
            <p>{subtitle}</p>

            {livePhase === 'downloading' && (
              <div className="download-progress">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: progress?.totalBytes
                        ? `${Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)}%`
                        : '35%'
                    }}
                  />
                </div>
                {progress && (
                  <p className="progress-label">
                    {formatBytes(progress.receivedBytes)}
                    {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                  </p>
                )}
                {status.state === 'downloading' && (
                  <button
                    type="button"
                    className="pill-button compact"
                    onClick={() => {
                      void downloads.stopDownload(project.id)
                      onBack()
                    }}
                  >
                    Stop
                  </button>
                )}
              </div>
            )}

            {livePhase === 'unpacking' && (
              <p className="progress-label">Almost there — opening the local scene files…</p>
            )}

            {typeof livePhase === 'object' && (
              <button
                type="button"
                className="pill-button compact"
                onClick={() => void openPackage(true)}
              >
                Try Again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
