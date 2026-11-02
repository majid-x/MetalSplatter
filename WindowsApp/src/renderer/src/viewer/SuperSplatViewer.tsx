import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { OpenedPackage } from '../../../shared/projectDownloadChannels'
import { measurementPrefs } from '../lib/measurementPrefs'

export type ViewerPickMode = 'photos' | 'measure-a' | 'measure-b' | null

export type ViewerPickEvent = {
  mode: Exclude<ViewerPickMode, null>
  point: [number, number, number]
  camera: [number, number, number]
}

export type MeasureStateEvent = {
  status: string
  deleteMode: boolean
  pointCount: number
  mode: boolean
}

export type MeasureCommands = {
  undo: () => void
  clear: () => void
}

export function SuperSplatViewer({
  packageInfo,
  projectName,
  pickMode = null,
  measureMode = false,
  measureDeleteMode = false,
  measureFactor = 1,
  /** Supabase move_speed when set; Mac default 3.5 (nav move_speed ignored). */
  moveSpeed = null,
  measureCommandsRef,
  onPick,
  onMeasureState,
  onSprintState,
  onViewerError
}: {
  packageInfo: OpenedPackage
  projectName: string
  pickMode?: ViewerPickMode
  measureMode?: boolean
  measureDeleteMode?: boolean
  measureFactor?: number
  moveSpeed?: number | null
  measureCommandsRef?: MutableRefObject<MeasureCommands | null>
  onPick?: (event: ViewerPickEvent) => void
  onMeasureState?: (event: MeasureStateEvent) => void
  onSprintState?: (sprinting: boolean) => void
  onViewerError?: (message: string | null) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const onErrorRef = useRef(onViewerError)
  onErrorRef.current = onViewerError
  const onMeasureRef = useRef(onMeasureState)
  onMeasureRef.current = onMeasureState
  const onSprintRef = useRef(onSprintState)
  onSprintRef.current = onSprintState

  function postToViewer(payload: Record<string, unknown>) {
    iframeRef.current?.contentWindow?.postMessage({ source: 'vroomk', ...payload }, '*')
  }

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setError(null)
    onErrorRef.current?.(null)

    // Mac: Supabase move_speed only; nil → Constants.cameraMoveSpeed (3.5). Nav ignored.
    const speed = typeof moveSpeed === 'number' && moveSpeed > 0 ? moveSpeed : 3.5

    void window.avgs.viewer
      .buildUrl({
        modelPath: packageInfo.modelPath,
        collisionPath: packageInfo.collisionPath,
        camera: packageInfo.camera,
        navigationPath: packageInfo.navigationPath,
        moveSpeed: speed,
        projectName
      })
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : 'Could not start SuperSplat viewer.'
          setError(message)
          onErrorRef.current?.(message)
        }
      })

    return () => {
      cancelled = true
    }
  }, [packageInfo, projectName, moveSpeed])

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      const data = event.data as {
        source?: string
        type?: string
        mode?: string | boolean
        message?: string
        status?: string
        deleteMode?: boolean
        pointCount?: number
        point?: number[]
        camera?: number[]
      } | null
      if (!data || data.source !== 'vroomk-viewer') return
      if (data.type === 'error' && data.message) {
        onErrorRef.current?.(data.message)
        return
      }
      if (data.type === 'measureState' && typeof data.status === 'string') {
        onMeasureRef.current?.({
          status: data.status,
          deleteMode: Boolean(data.deleteMode),
          pointCount: typeof data.pointCount === 'number' ? data.pointCount : 0,
          mode: Boolean(data.mode)
        })
        return
      }
      if (data.type === 'sprintState') {
        onSprintRef.current?.(Boolean((data as { sprinting?: boolean }).sprinting))
        return
      }
      if (data.type === 'ready' || data.type === 'bridge-ready') {
        onErrorRef.current?.(null)
        postToViewer({ type: 'setMeasureFactor', factor: measureFactor })
        postToViewer({ type: 'setMeasureExact', exact: measurementPrefs.showExactMeasurements })
        postToViewer({ type: 'setMeasureMode', enabled: measureMode })
        postToViewer({ type: 'setMeasureDeleteMode', enabled: measureDeleteMode })
        if (pickMode === 'photos') {
          postToViewer({ type: 'setPickMode', mode: 'photos' })
        }
        // Enter FPS walk at nav spawn — never frameScene (orbit/top-down overview).
        postToViewer({
          type: 'setMacWalk',
          moveSpeed: typeof moveSpeed === 'number' && moveSpeed > 0 ? moveSpeed : 3.5
        })
        return
      }
      if (
        data.type === 'pick' &&
        data.mode &&
        typeof data.mode === 'string' &&
        Array.isArray(data.point) &&
        data.point.length >= 3 &&
        Array.isArray(data.camera) &&
        data.camera.length >= 3
      ) {
        onPickRef.current?.({
          mode: data.mode as Exclude<ViewerPickMode, null>,
          point: [data.point[0], data.point[1], data.point[2]],
          camera: [data.camera[0], data.camera[1], data.camera[2]]
        })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [pickMode, measureMode, measureDeleteMode, measureFactor, moveSpeed])

  useEffect(() => {
    postToViewer({ type: 'setMeasureFactor', factor: measureFactor })
  }, [measureFactor, src])

  useEffect(() => {
    postToViewer({ type: 'setMeasureExact', exact: measurementPrefs.showExactMeasurements })
  }, [src])

  useEffect(() => {
    postToViewer({ type: 'setMeasureMode', enabled: measureMode })
    if (!measureMode) {
      postToViewer({ type: 'setMeasureDeleteMode', enabled: false })
      if (pickMode === 'photos') {
        postToViewer({ type: 'setPickMode', mode: 'photos' })
      } else {
        postToViewer({ type: 'setPickMode', mode: null })
      }
    }
  }, [measureMode, pickMode, src])

  useEffect(() => {
    if (!measureMode) return
    postToViewer({ type: 'setMeasureDeleteMode', enabled: measureDeleteMode })
  }, [measureDeleteMode, measureMode, src])

  useEffect(() => {
    if (measureMode) return
    postToViewer({ type: 'setPickMode', mode: pickMode })
  }, [pickMode, measureMode, src])

  useEffect(() => {
    if (!measureCommandsRef) return
    measureCommandsRef.current = {
      undo: () => postToViewer({ type: 'undoMeasure' }),
      clear: () => postToViewer({ type: 'clearMeasure' })
    }
    return () => {
      measureCommandsRef.current = null
    }
  }, [measureCommandsRef, src])

  // When the iframe lacks focus (tool rail / after drag), arrows & WASD never reach it.
  // Forward walk keys from the Electron host window into the viewer.
  useEffect(() => {
    if (!src) return
    const walkCodes = new Set([
      'KeyW',
      'KeyA',
      'KeyS',
      'KeyD',
      'KeyQ',
      'KeyE',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ShiftLeft',
      'ShiftRight'
    ])

    function isTypingTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      )
    }

    function onKey(event: KeyboardEvent, down: boolean): void {
      if (event.ctrlKey || event.altKey || event.metaKey) return
      if (!walkCodes.has(event.code)) return
      if (isTypingTarget(event.target)) return
      // Always forward: in Electron, arrows often hit the host even when the iframe
      // "has focus". setKey is idempotent, so a duplicate from the iframe is fine.
      postToViewer({
        type: down ? 'keyDown' : 'keyUp',
        code: event.code,
        shiftKey: event.shiftKey
      })
      event.preventDefault()
    }

    const down = (e: KeyboardEvent) => onKey(e, true)
    const up = (e: KeyboardEvent) => onKey(e, false)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      for (const code of Array.from(walkCodes)) {
        postToViewer({ type: 'keyUp', code })
      }
    }
  }, [src])

  if (error) {
    return (
      <div className="viewer-error">
        <h2>Viewer error</h2>
        <p>{error}</p>
      </div>
    )
  }

  if (!src) {
    return (
      <div className="viewer-loading">
        <span className="spinner large" />
        <p>Starting SuperSplat…</p>
      </div>
    )
  }

  return (
    <iframe
      ref={iframeRef}
      className="supersplat-frame"
      title={`${projectName} — Vroomk`}
      src={src}
      tabIndex={0}
      allow="fullscreen; xr-spatial-tracking; gamepad; pointer-lock"
      onMouseDown={() => {
        try {
          iframeRef.current?.focus()
        } catch {
          /* ignore */
        }
      }}
    />
  )
}
