export type Vec3 = [number, number, number]

export type CollisionLayer = {
  floorY: number
  points: Vec3[]
}

export type CollisionBlock = {
  centerX: number
  centerZ: number
  baseY: number
  width: number
  depth: number
  height: number
  yawRadians: number
}

export type SceneNavigation = {
  startPosition: Vec3
  yawDegrees: number
  pitchDegrees: number
  moveSpeed: number | null
  measureScale: number | null
  topDownCutHeight: number | null
  topDownOrthoHalfExtent: number | null
  topDownOrthoZoomIn: number | null
  topDownOrthoZoomOut: number | null
  topDownYawDegrees: number | null
  topDownPitchDegrees: number | null
  topDownCenter: Vec3 | null
  orientationUp: Vec3 | null
  orientationForward: Vec3 | null
  collisionLayers: CollisionLayer[]
  collisionBlocks: CollisionBlock[]
  stairPolygons: Vec3[][]
}

/** @deprecated Prefer SceneNavigation — kept for call sites that only need start camera. */
export type SceneStartPose = {
  position: [number, number, number]
  yawDegrees: number
  pitchDegrees: number
  moveSpeed: number | null
  measureScale: number | null
}

export type NavSummary = {
  collisionLayerCount: number
  collisionPointCount: number
  stairPolygonCount: number
  blockCount: number
  hasTopDownCut: boolean
  hasCustomOrientation: boolean
}

const DEFAULT_BLOCK_WIDTH = 0.2
const DEFAULT_BLOCK_DEPTH = 0.2
const DEFAULT_BLOCK_HEIGHT = 2.4

function parseFloats(line: string): number[] {
  return line
    .split(/\s+/)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value))
}

function parseFloorAttribute(lowered: string): number | null {
  const match = lowered.match(/floor\s*[=:]\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

type Section = 'none' | 'start' | 'collision' | 'stairs' | 'blocks' | 'orientation' | 'settings'

/**
 * Full nav.txt reader matching Mac `SceneNavigationData` sections:
 * [start], [collision], [stairs], [blocks], [orientation], [settings].
 */
export function parseNav(text: string): SceneNavigation | null {
  const lines = text.split(/\r?\n/)
  let section: Section = 'none'
  let startValues: number[] | null = null
  const stairPolygons: Vec3[][] = []
  let currentStairPoints: Vec3[] = []
  const layers: CollisionLayer[] = []
  let currentLayerFloor: number | null = null
  let currentLayerPoints: Vec3[] = []
  const blocks: CollisionBlock[] = []
  const orientationVectors: Vec3[] = []
  let moveSpeed: number | null = null
  let measureScale: number | null = null
  let topDownCutHeight: number | null = null
  let topDownOrthoHalfExtent: number | null = null
  let topDownOrthoZoomIn: number | null = null
  let topDownOrthoZoomOut: number | null = null
  let topDownYawDegrees: number | null = null
  let topDownPitchDegrees: number | null = null
  let topDownCenter: Vec3 | null = null

  function flushStairPolygon(): void {
    if (currentStairPoints.length >= 3) {
      stairPolygons.push(currentStairPoints)
    }
    currentStairPoints = []
  }

  function flushCollisionLayer(): void {
    if (currentLayerPoints.length === 0) {
      currentLayerFloor = null
      return
    }
    const floor =
      currentLayerFloor ??
      currentLayerPoints.reduce((sum, p) => sum + p[1], 0) / currentLayerPoints.length
    layers.push({ floorY: floor, points: currentLayerPoints })
    currentLayerPoints = []
    currentLayerFloor = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const lowered = line.toLowerCase()

    if (lowered === '[start]') {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'start'
      continue
    }
    if (lowered === '[orientation]' || lowered === '[camera-orientation]') {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'orientation'
      continue
    }
    if (lowered === '[settings]' || lowered === '[setting]') {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'settings'
      continue
    }
    if (lowered.startsWith('[collision')) {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'collision'
      currentLayerFloor = parseFloorAttribute(lowered)
      continue
    }
    if (lowered === '[stairs]' || lowered === '[stair]') {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'stairs'
      continue
    }
    if (lowered === '[blocks]' || lowered === '[block]') {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'blocks'
      continue
    }
    if (lowered.startsWith('[')) {
      flushCollisionLayer()
      flushStairPolygon()
      section = 'none'
      continue
    }

    const parts = parseFloats(line)
    switch (section) {
      case 'none':
        break
      case 'start':
        if (parts.length >= 3) startValues = parts
        break
      case 'orientation':
        if (parts.length >= 3) {
          orientationVectors.push([parts[0], parts[1], parts[2]])
        }
        break
      case 'settings': {
        if (lowered.includes('measure') && parts.length >= 1 && parts[parts.length - 1] > 0) {
          measureScale = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_cut') || lowered.includes('top_down_cut')) &&
          parts.length >= 1
        ) {
          topDownCutHeight = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_ortho_zoom_in') ||
            lowered.includes('topdown_zoom_in') ||
            lowered.includes('top_down_zoom_in')) &&
          parts.length >= 1 &&
          parts[parts.length - 1] > 0
        ) {
          topDownOrthoZoomIn = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_ortho_zoom_out') ||
            lowered.includes('topdown_zoom_out') ||
            lowered.includes('top_down_zoom_out')) &&
          parts.length >= 1 &&
          parts[parts.length - 1] > 0
        ) {
          topDownOrthoZoomOut = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_ortho') || lowered.includes('top_down_ortho')) &&
          !lowered.includes('zoom') &&
          parts.length >= 1 &&
          parts[parts.length - 1] > 0
        ) {
          topDownOrthoHalfExtent = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_pitch') || lowered.includes('top_down_pitch')) &&
          parts.length >= 1
        ) {
          topDownPitchDegrees = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_yaw') || lowered.includes('top_down_yaw')) &&
          parts.length >= 1
        ) {
          topDownYawDegrees = parts[parts.length - 1]
        } else if (
          (lowered.includes('topdown_center') || lowered.includes('top_down_center')) &&
          parts.length >= 3
        ) {
          const n = parts.length
          topDownCenter = [parts[n - 3], parts[n - 2], parts[n - 1]]
        } else if (lowered.includes('move') && parts.length >= 1 && parts[parts.length - 1] > 0) {
          moveSpeed = parts[parts.length - 1]
        } else if (parts.length >= 1 && moveSpeed == null && parts[0] > 0) {
          moveSpeed = parts[0]
        }
        break
      }
      case 'collision':
        if (parts.length >= 3) {
          currentLayerPoints.push([parts[0], parts[1], parts[2]])
        }
        break
      case 'stairs':
        if (parts.length >= 3) {
          currentStairPoints.push([parts[0], parts[1], parts[2]])
        }
        break
      case 'blocks': {
        if (parts.length < 3) break
        const width = parts.length > 3 ? parts[3] : DEFAULT_BLOCK_WIDTH
        const depth = parts.length > 4 ? parts[4] : DEFAULT_BLOCK_DEPTH
        const height = parts.length > 5 ? parts[5] : DEFAULT_BLOCK_HEIGHT
        const yawDeg = parts.length > 6 ? parts[6] : 0
        blocks.push({
          centerX: parts[0],
          centerZ: parts[1],
          baseY: parts[2],
          width,
          depth,
          height,
          yawRadians: (yawDeg * Math.PI) / 180
        })
        break
      }
    }
  }

  flushCollisionLayer()
  flushStairPolygon()

  if (!startValues || startValues.length < 3) return null

  let orientationUp: Vec3 | null = null
  let orientationForward: Vec3 | null = null
  if (orientationVectors.length >= 2) {
    const up = orientationVectors[0]
    let forward = orientationVectors[1]
    const upLen = Math.hypot(up[0], up[1], up[2])
    const forwardLen = Math.hypot(forward[0], forward[1], forward[2])
    if (upLen > 1e-5 && forwardLen > 1e-5) {
      const upN: Vec3 = [up[0] / upLen, up[1] / upLen, up[2] / upLen]
      const dot = forward[0] * upN[0] + forward[1] * upN[1] + forward[2] * upN[2]
      forward = [
        forward[0] - dot * upN[0],
        forward[1] - dot * upN[1],
        forward[2] - dot * upN[2]
      ]
      const flatLen = Math.hypot(forward[0], forward[1], forward[2])
      if (flatLen > 1e-5) {
        orientationUp = upN
        orientationForward = [forward[0] / flatLen, forward[1] / flatLen, forward[2] / flatLen]
      }
    }
  }

  return {
    startPosition: [startValues[0], startValues[1], startValues[2]],
    yawDegrees: startValues.length > 3 ? startValues[3] : 0,
    pitchDegrees: startValues.length > 4 ? startValues[4] : 0,
    moveSpeed,
    measureScale,
    topDownCutHeight,
    topDownOrthoHalfExtent,
    topDownOrthoZoomIn,
    topDownOrthoZoomOut,
    topDownYawDegrees,
    topDownPitchDegrees,
    topDownCenter,
    orientationUp,
    orientationForward,
    collisionLayers: layers,
    collisionBlocks: blocks,
    stairPolygons
  }
}

export function navSummary(nav: SceneNavigation | null): NavSummary | null {
  if (!nav) return null
  return {
    collisionLayerCount: nav.collisionLayers.length,
    collisionPointCount: nav.collisionLayers.reduce((n, layer) => n + layer.points.length, 0),
    stairPolygonCount: nav.stairPolygons.length,
    blockCount: nav.collisionBlocks.length,
    hasTopDownCut: nav.topDownCutHeight != null,
    hasCustomOrientation: nav.orientationUp != null && nav.orientationForward != null
  }
}

/** Minimal start-pose helper used by older call sites. */
export function parseNavStart(text: string): SceneStartPose | null {
  const nav = parseNav(text)
  if (!nav) return null
  return {
    position: nav.startPosition,
    yawDegrees: nav.yawDegrees,
    pitchDegrees: nav.pitchDegrees,
    moveSpeed: nav.moveSpeed,
    measureScale: nav.measureScale
  }
}

function normalize3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  if (len < 1e-8) return [0, 1, 0]
  return [v[0] / len, v[1] / len, v[2] / len]
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ]
}

/**
 * Convert nav start (pos + yaw/pitch degrees) into SuperSplat camera position/target.
 * Matches Mac `MetalKitSceneRenderer.cameraForward` when `[orientation]` is present.
 */
export function cameraFromStartPose(start: SceneStartPose | SceneNavigation): {
  position: [number, number, number]
  target: [number, number, number]
  fov: number
} {
  const position: Vec3 =
    'startPosition' in start ? start.startPosition : start.position
  const yaw = (start.yawDegrees * Math.PI) / 180
  const pitch = (start.pitchDegrees * Math.PI) / 180

  const nav = 'orientationUp' in start ? start : null
  const up = normalize3(nav?.orientationUp ?? [0, 1, 0])
  let forward0 = nav?.orientationForward ?? [0, 0, -1]
  // Level forward onto the plane ⊥ up (Mac applyOrientation).
  const upDot = forward0[0] * up[0] + forward0[1] * up[1] + forward0[2] * up[2]
  forward0 = normalize3([
    forward0[0] - up[0] * upDot,
    forward0[1] - up[1] * upDot,
    forward0[2] - up[2] * upDot
  ])
  if (Math.hypot(forward0[0], forward0[1], forward0[2]) < 0.5) {
    forward0 = Math.abs(up[1]) < 0.9 ? [0, 0, -1] : [-1, 0, 0]
    const fd = forward0[0] * up[0] + forward0[1] * up[1] + forward0[2] * up[2]
    forward0 = normalize3([
      forward0[0] - up[0] * fd,
      forward0[1] - up[1] * fd,
      forward0[2] - up[2] * fd
    ])
  }
  // Mac: navigationRight = normalize(cross(navigationForward, navigationUp))
  const right = normalize3(cross3(forward0, up))
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const yawed: Vec3 = [
    cosYaw * forward0[0] + sinYaw * right[0],
    cosYaw * forward0[1] + sinYaw * right[1],
    cosYaw * forward0[2] + sinYaw * right[2]
  ]
  const look = normalize3([
    cosPitch * yawed[0] + sinPitch * up[0],
    cosPitch * yawed[1] + sinPitch * up[1],
    cosPitch * yawed[2] + sinPitch * up[2]
  ])
  const distance = 2
  return {
    position,
    target: [
      position[0] + look[0] * distance,
      position[1] + look[1] * distance,
      position[2] + look[2] * distance
    ],
    // Mac Constants.fovy is 65° — closer to eye-level walk than SuperSplat's 85°.
    fov: 65
  }
}
