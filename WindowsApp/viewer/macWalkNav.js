/**
 * Mac MetalKitSceneRenderer walk / top-down navigation — ported for SuperSplat.
 * Coordinates are nav.txt / camera space (same as Mac SceneNavigationData).
 */

const LOOK_SENSITIVITY = 0.005 // rad/px — Constants.cameraLookSensitivity
const PITCH_LIMIT = Math.PI / 2 - 0.01
const FOVY_RAD = (65 * Math.PI) / 180
const FLOOR_HALF = 0.45
const BLOCK_RADIUS = 0.04
const STAIR_PAD = 0.15
const DEFAULT_SPEED = 3.5

export function v3(x = 0, y = 0, z = 0) {
  return [x, y, z]
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s]
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function len(a) {
  return Math.hypot(a[0], a[1], a[2])
}
function norm(a) {
  const L = len(a)
  if (L < 1e-8) return [0, 1, 0]
  return [a[0] / L, a[1] / L, a[2] / L]
}

function containsXZ(vertices, px, pz) {
  let inside = false
  let j = vertices.length - 1
  for (let i = 0; i < vertices.length; i++) {
    const ax = vertices[i][0]
    const az = vertices[i][1]
    const bx = vertices[j][0]
    const bz = vertices[j][1]
    const intersects =
      az > pz !== bz > pz && px < ((bx - ax) * (pz - az)) / (bz - az + 1e-12) + ax
    if (intersects) inside = !inside
    j = i
  }
  return inside
}

function closestOnSegment(ax, az, bx, bz, px, pz) {
  const abx = bx - ax
  const abz = bz - az
  const lengthSq = abx * abx + abz * abz
  if (lengthSq <= 1e-12) return [ax, az]
  let t = ((px - ax) * abx + (pz - az) * abz) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return [ax + abx * t, az + abz * t]
}

function nearestBoundary(vertices, px, pz) {
  let best = vertices[0]
  let bestDist = Infinity
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    const c = closestOnSegment(a[0], a[1], b[0], b[1], px, pz)
    const d = (c[0] - px) ** 2 + (c[1] - pz) ** 2
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

function distToBoundary(vertices, px, pz) {
  let best = Infinity
  const n = vertices.length
  for (let i = 0; i < n; i++) {
    const a = vertices[i]
    const b = vertices[(i + 1) % n]
    const c = closestOnSegment(a[0], a[1], b[0], b[1], px, pz)
    best = Math.min(best, Math.hypot(c[0] - px, c[1] - pz))
  }
  return best
}

function buildWalkableLayers(collisionLayers) {
  const layers = []
  for (const layer of collisionLayers || []) {
    const pts = layer.points || []
    if (pts.length < 3) continue
    layers.push({
      floorY: layer.floorY,
      halfHeight: FLOOR_HALF,
      vertices: pts.map((p) => [p[0], p[2]])
    })
  }
  return layers
}

function clampWalkable(layers, position) {
  if (!layers.length) return position
  let best = null
  let bestDist = Infinity
  for (const layer of layers) {
    if (Math.abs(position[1] - layer.floorY) > layer.halfHeight) continue
    const dist = Math.abs(position[1] - layer.floorY)
    if (dist < bestDist) {
      bestDist = dist
      best = layer
    }
  }
  if (!best) return position
  const px = position[0]
  const pz = position[2]
  if (containsXZ(best.vertices, px, pz)) return position
  const n = nearestBoundary(best.vertices, px, pz)
  return [n[0], position[1], n[1]]
}

function fitPlane(vertices) {
  let sxx = 0
  let sxz = 0
  let sx = 0
  let szz = 0
  let sz = 0
  let sxy = 0
  let szy = 0
  let sy = 0
  const n = vertices.length
  for (const v of vertices) {
    sxx += v[0] * v[0]
    sxz += v[0] * v[2]
    sx += v[0]
    szz += v[2] * v[2]
    sz += v[2]
    sxy += v[0] * v[1]
    szy += v[2] * v[1]
    sy += v[1]
  }
  const m00 = sxx
  const m01 = sxz
  const m02 = sx
  const m10 = sxz
  const m11 = szz
  const m12 = sz
  const m20 = sx
  const m21 = sz
  const m22 = n
  const det =
    m00 * (m11 * m22 - m12 * m21) -
    m01 * (m10 * m22 - m12 * m20) +
    m02 * (m10 * m21 - m11 * m20)
  if (Math.abs(det) <= 1e-8) return { a: 0, c: 0, d: sy / n }
  const inv = 1 / det
  const a =
    inv *
    (sxy * (m11 * m22 - m12 * m21) -
      m01 * (szy * m22 - m12 * sy) +
      m02 * (szy * m21 - m11 * sy))
  const c =
    inv *
    (m00 * (szy * m22 - m12 * sy) -
      sxy * (m10 * m22 - m12 * m20) +
      m02 * (m10 * sy - szy * m20))
  const d =
    inv *
    (m00 * (m11 * sy - szy * m21) -
      m01 * (m10 * sy - szy * m20) +
      sxy * (m10 * m21 - m11 * m20))
  return { a, c, d }
}

function buildStairs(stairPolygons) {
  const regions = []
  for (const poly of stairPolygons || []) {
    if (!poly || poly.length < 3) continue
    const plane = fitPlane(poly)
    const ys = poly.map((p) => p[1])
    regions.push({
      vertices: poly,
      xz: poly.map((p) => [p[0], p[2]]),
      ...plane,
      lowerFloorY: Math.min(...ys),
      upperFloorY: Math.max(...ys),
      edgePadding: STAIR_PAD
    })
  }
  return regions
}

function stairHeight(region, position) {
  const px = position[0]
  const pz = position[2]
  const inside =
    containsXZ(region.xz, px, pz) || distToBoundary(region.xz, px, pz) <= region.edgePadding
  if (!inside) return null
  return region.a * position[0] + region.c * position[2] + region.d
}

function toLocalXZ(block, point) {
  const dx = point[0] - block.centerX
  const dz = point[2] - block.centerZ
  const c = Math.cos(block.yawRadians)
  const s = Math.sin(block.yawRadians)
  return [dx * c - dz * s, dx * s + dz * c]
}

function fromLocalXZ(block, local) {
  const c = Math.cos(block.yawRadians)
  const s = Math.sin(block.yawRadians)
  return [local[0] * c + local[1] * s, -local[0] * s + local[1] * c]
}

function overlapsPlayer(block, y, radius) {
  const playerMin = y - 0.15
  const playerMax = y + 0.35
  const wallMin = block.baseY - radius
  const wallMax = block.baseY + block.height + radius
  return wallMin <= playerMax && wallMax >= playerMin
}

function penetratesXZ(block, point, radius) {
  if (!overlapsPlayer(block, point[1], radius)) return false
  const local = toLocalXZ(block, point)
  const halfW = block.width * 0.5 + radius
  const halfD = block.depth * 0.5 + radius
  return Math.abs(local[0]) < halfW && Math.abs(local[1]) < halfD
}

function anyPenetrates(point, blocks, radius) {
  return blocks.some((b) => penetratesXZ(b, point, radius))
}

function depenetrate(position, bias, blocks, radius) {
  let p = [...position]
  for (let iter = 0; iter < 4; iter++) {
    for (const block of blocks) {
      if (!penetratesXZ(block, p, radius)) continue
      let local = toLocalXZ(block, p)
      const halfW = block.width * 0.5 + radius
      const halfD = block.depth * 0.5 + radius
      const left = local[0] + halfW
      const right = halfW - local[0]
      const near = local[1] + halfD
      const far = halfD - local[1]
      const biasLocal = sub(
        toLocalXZ(block, [p[0] + bias[0], p[1], p[2] + bias[2]]),
        local
      )
      const faces = [
        [biasLocal[0] < 0 ? left * 0.2 : left, 0],
        [biasLocal[0] > 0 ? right * 0.2 : right, 1],
        [biasLocal[1] < 0 ? near * 0.2 : near, 2],
        [biasLocal[1] > 0 ? far * 0.2 : far, 3]
      ]
      faces.sort((a, b) => a[0] - b[0])
      const best = faces[0][1]
      if (best === 0) local[0] = -halfW
      else if (best === 1) local[0] = halfW
      else if (best === 2) local[1] = -halfD
      else local[1] = halfD
      const world = fromLocalXZ(block, local)
      p[0] = block.centerX + world[0]
      p[2] = block.centerZ + world[1]
    }
  }
  return p
}

function blockMove(start, end, blocks, radius = BLOCK_RADIUS) {
  if (!blocks.length) return end
  let p = [...start]
  if (anyPenetrates(p, blocks, radius)) {
    const travel = sub(end, start)
    p = depenetrate(p, scale(travel, -1), blocks, radius)
    if (anyPenetrates(p, blocks, radius)) return start
  }
  const xProbe = [end[0], p[1], p[2]]
  if (!anyPenetrates(xProbe, blocks, radius)) p[0] = end[0]
  const zProbe = [p[0], p[1], end[2]]
  if (!anyPenetrates(zProbe, blocks, radius)) p[2] = end[2]
  return p
}

function buildBasis(upIn, forwardIn) {
  let up = upIn ? norm(upIn) : [0, 1, 0]
  let forward = forwardIn ? [...forwardIn] : [0, 0, -1]
  const upDot = dot(forward, up)
  forward = norm(sub(forward, scale(up, upDot)))
  if (len(forward) < 0.5) {
    forward = Math.abs(up[1]) < 0.9 ? [0, 0, -1] : [-1, 0, 0]
    forward = norm(sub(forward, scale(up, dot(forward, up))))
  }
  let right = norm(cross(forward, up))
  if (len(right) < 0.5) {
    const alt = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    right = norm(cross(forward, alt))
  }
  return { up, forward, right }
}

/**
 * @param {object|null} nav — SceneNavigation JSON from navParser
 * @param {{ moveSpeed?: number|null }} options
 */
export function createMacWalker(nav, options = {}) {
  const basis = buildBasis(nav?.orientationUp, nav?.orientationForward)
  const layers = buildWalkableLayers(nav?.collisionLayers)
  const stairs = buildStairs(nav?.stairPolygons)
  const blocks = (nav?.collisionBlocks || []).slice()
  const hasCustomOrientation = Boolean(nav?.orientationUp && nav?.orientationForward)

  const start = nav?.startPosition ? [...nav.startPosition] : [0, 1.6, 0]
  let position = [...start]
  let yaw = ((nav?.yawDegrees ?? 0) * Math.PI) / 180
  let pitch = ((nav?.pitchDegrees ?? 0) * Math.PI) / 180
  let persistentFloorY = heightAlongUp(position, basis.up)
  let moveSpeed =
    typeof options.moveSpeed === 'number' && options.moveSpeed > 0
      ? options.moveSpeed
      : typeof nav?.moveSpeed === 'number' && nav.moveSpeed > 0
        ? nav.moveSpeed
        : DEFAULT_SPEED

  const keys = { f: false, b: false, l: false, r: false }
  let topDown = false
  let savedWalk = null
  let topDownCutHeight = nav?.topDownCutHeight ?? null
  let topDownOrtho = nav?.topDownOrthoHalfExtent ?? nav?.topDownOrthoZoomOut ?? 1
  const savedOrthoOut = nav?.topDownOrthoZoomOut
  const savedOrtho = nav?.topDownOrthoHalfExtent
  const savedTdYaw = nav?.topDownYawDegrees != null ? (nav.topDownYawDegrees * Math.PI) / 180 : null
  const savedTdPitch =
    nav?.topDownPitchDegrees != null ? (nav.topDownPitchDegrees * Math.PI) / 180 : null
  const savedTdCenter = nav?.topDownCenter ? [...nav.topDownCenter] : null

  function heightAlongUp(p, up = basis.up) {
    return dot(p, up)
  }

  function setHeightAlongUp(h) {
    const cur = heightAlongUp(position)
    position = add(position, scale(basis.up, h - cur))
  }

  function cameraForward() {
    const cosYaw = Math.cos(yaw)
    const sinYaw = Math.sin(yaw)
    const cosPitch = Math.cos(pitch)
    const sinPitch = Math.sin(pitch)
    const yawed = norm(
      add(scale(basis.forward, cosYaw), scale(basis.right, sinYaw))
    )
    return norm(add(scale(yawed, cosPitch), scale(basis.up, sinPitch)))
  }

  function cameraRight() {
    const f = cameraForward()
    const r = cross(f, basis.up)
    return len(r) > 1e-4 ? norm(r) : basis.right
  }

  function flatAxes() {
    let forward = sub(cameraForward(), scale(basis.up, dot(cameraForward(), basis.up)))
    let right = sub(cameraRight(), scale(basis.up, dot(cameraRight(), basis.up)))
    if (len(forward) > 1e-4) forward = norm(forward)
    else forward = basis.forward
    if (len(right) > 1e-4) right = norm(right)
    else right = basis.right
    return { forward, right }
  }

  function applyStairOrGroundHeight() {
    for (const region of stairs) {
      const h = stairHeight(region, position)
      if (h != null) {
        persistentFloorY = h
        setHeightAlongUp(h)
        return
      }
    }
    setHeightAlongUp(persistentFloorY)
  }

  function hoverDistance(halfExtent) {
    return Math.max(0.001, halfExtent / Math.max(1e-4, Math.tan(FOVY_RAD * 0.5)))
  }

  function refreshOrthoFromCamera() {
    const heightAbove = Math.abs(heightAlongUp(position) - (topDownCutHeight ?? 0))
    topDownOrtho = Math.max(0.001, heightAbove * Math.tan(FOVY_RAD * 0.5))
  }

  function clampTopDownZoom() {
    if (topDownCutHeight == null) return
    let height = Math.max(topDownCutHeight + 0.001, heightAlongUp(position))
    if (savedOrthoOut != null && savedOrthoOut > 0) {
      const maxHeight = topDownCutHeight + hoverDistance(savedOrthoOut)
      height = Math.min(height, maxHeight)
    }
    setHeightAlongUp(height)
    refreshOrthoFromCamera()
  }

  function applyTopDownStartPose() {
    if (savedOrtho != null && savedOrtho > 0) topDownOrtho = savedOrtho
    else if (savedOrthoOut != null && savedOrthoOut > 0) topDownOrtho = savedOrthoOut
    if (savedTdYaw != null) yaw = savedTdYaw
    if (savedTdPitch != null) pitch = savedTdPitch
    if (savedTdCenter) {
      position = [...savedTdCenter]
    } else {
      pitch = -PITCH_LIMIT
      setHeightAlongUp((topDownCutHeight ?? 0) + hoverDistance(topDownOrtho))
    }
    clampTopDownZoom()
  }

  function applyLookDelta(dx, dy) {
    yaw += dx * LOOK_SENSITIVITY
    pitch -= dy * LOOK_SENSITIVITY
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch))
  }

  function setKeys(next) {
    Object.assign(keys, next)
  }

  function keysActive() {
    return keys.f || keys.b || keys.l || keys.r
  }

  function update(dt) {
    const delta = Math.min(1 / 30, dt)
    const { forward, right } = flatAxes()
    let direction = [0, 0, 0]
    if (keys.f) direction = add(direction, forward)
    if (keys.b) direction = sub(direction, forward)
    if (keys.r) direction = add(direction, right)
    if (keys.l) direction = sub(direction, right)
    const dLen = len(direction)

    if (topDown) {
      if (dLen > 1e-5) {
        position = add(position, scale(norm(direction), moveSpeed * delta))
        clampTopDownZoom()
      }
      return getPose()
    }

    if (!keysActive()) return getPose()

    const proposed = add(position, scale(norm(direction), moveSpeed * delta))
    const clamped = clampWalkable(layers, proposed)
    position = blockMove(position, clamped, blocks)
    applyStairOrGroundHeight()
    return getPose()
  }

  function getPose() {
    const forward = cameraForward()
    return {
      position: [...position],
      target: add(position, scale(forward, 2)),
      forward,
      yaw,
      pitch,
      fov: 65,
      topDown,
      hasTopDownCut: topDownCutHeight != null,
      hasCustomOrientation
    }
  }

  function setTopDown(enabled) {
    if (enabled) {
      if (topDownCutHeight == null) return false
      if (!topDown) {
        savedWalk = { position: [...position], yaw, pitch, persistentFloorY }
        applyTopDownStartPose()
        topDown = true
      }
      return true
    }
    if (topDown && savedWalk) {
      position = [...savedWalk.position]
      yaw = savedWalk.yaw
      pitch = savedWalk.pitch
      persistentFloorY = savedWalk.persistentFloorY
      applyStairOrGroundHeight()
      savedWalk = null
    }
    topDown = false
    return true
  }

  function nudgeZoom(zoomIn) {
    if (!topDown || topDownCutHeight == null) return
    const heightAbove = Math.max(0.001, heightAlongUp(position) - topDownCutHeight)
    const step = Math.max(0.08, heightAbove * 0.2)
    setHeightAlongUp(heightAlongUp(position) + (zoomIn ? -step : step))
    clampTopDownZoom()
  }

  function resetToStart() {
    position = [...start]
    yaw = ((nav?.yawDegrees ?? 0) * Math.PI) / 180
    pitch = ((nav?.pitchDegrees ?? 0) * Math.PI) / 180
    persistentFloorY = heightAlongUp(position)
    applyStairOrGroundHeight()
    topDown = false
    savedWalk = null
  }

  // Snap to floor/stair at spawn.
  applyStairOrGroundHeight()

  return {
    update,
    applyLookDelta,
    setKeys,
    setTopDown,
    nudgeZoom,
    resetToStart,
    getPose,
    setMoveSpeed(speed) {
      if (typeof speed === 'number' && speed > 0) moveSpeed = speed
    },
    get topDown() {
      return topDown
    },
    get hasTopDownCut() {
      return topDownCutHeight != null
    },
    get hasNavClamp() {
      return layers.length > 0 || blocks.length > 0 || stairs.length > 0
    }
  }
}
