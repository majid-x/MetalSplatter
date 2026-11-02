import { useRef, useState } from 'react'

type Rect = { x: number; y: number; width: number; height: number }

function normalizeRect(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y)
  }
}

/** Darkened drag-to-select overlay for screenshot product search. */
export function ScreenshotSelectionOverlay({
  onComplete,
  onCancel
}: {
  onComplete: (selection: Rect, overlayBounds: DOMRect) => void
  onCancel: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [start, setStart] = useState<{ x: number; y: number } | null>(null)
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null)

  const selection = start && current ? normalizeRect(start, current) : null

  return (
    <div
      ref={rootRef}
      className="screenshot-overlay"
      role="presentation"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const bounds = rootRef.current?.getBoundingClientRect()
        if (!bounds) return
        const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        setStart(point)
        setCurrent(point)
        ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!start) return
        const bounds = rootRef.current?.getBoundingClientRect()
        if (!bounds) return
        setCurrent({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
      }}
      onPointerUp={(event) => {
        if (!start) return
        const bounds = rootRef.current?.getBoundingClientRect()
        if (!bounds) {
          onCancel()
          return
        }
        const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        const rect = normalizeRect(start, end)
        setStart(null)
        setCurrent(null)
        if (rect.width >= 8 && rect.height >= 8) {
          onComplete(rect, bounds)
        } else {
          onCancel()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      tabIndex={0}
    >
      <div className="screenshot-overlay-hint">
        Drag to select · Esc to cancel
      </div>
      {selection && (
        <>
          <div
            className="screenshot-selection"
            style={{
              left: selection.x,
              top: selection.y,
              width: selection.width,
              height: selection.height
            }}
          />
          <div
            className="screenshot-size"
            style={{
              left: selection.x + selection.width / 2,
              top: Math.max(8, selection.y - 28)
            }}
          >
            {Math.round(selection.width)} × {Math.round(selection.height)}
          </div>
        </>
      )}
    </div>
  )
}
