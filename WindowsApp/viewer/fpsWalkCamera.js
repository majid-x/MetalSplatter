/**
 * First-person walk — ported from windowsrenderclientapp walk-camera.ts.
 * No orbit/pan. Pointer-lock look + ground-plane WASD + Q/E vertical.
 *
 * Feel:
 *   moveSpeed        0.6  world units/sec (DEFAULT_WALK_SPEED)
 *   lookSensitivity  0.12 degrees per mouse pixel
 *   maxPitch         ±89°
 *   fallback speed   0.75 if omitted
 */

const DEFAULT_WALK_SPEED = 0.6
const FALLBACK_WALK_SPEED = 0.75
const LOOK_SENSITIVITY_DEG = 0.12
const MAX_PITCH = 89
const PLAYER_RADIUS = 0.04
const FLOOR_BAND = 0.55
const STAIR_EDGE_PAD = 0.15
const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

function v3(x = 0, y = 0, z = 0) {
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
function projectOnNavPlane(v, up) {
  const d = dot(v, up)
  return [v[0] - up[0] * d, v[1] - up[1] * d, v[2] - up[2] * d]
}

function asVec3(v, fallback) {
  if (Array.isArray(v) && v.length >= 3) return [v[0], v[1], v[2]]
  if (v && typeof v === 'object' && Number.isFinite(v.x)) return [v.x, v.y, v.z]
  return fallback
}

function createBasis(orientation) {
  let up = asVec3(orientation?.up, [0, 1, 0])
  let forward = asVec3(orientation?.forward, [0, 0, -1])
  up = norm(up)
  forward = norm(sub(forward, scale(up, dot(forward, up))))
  if (len(forward) < 0.5) {
    const fb = Math.abs(dot(up, [0, 0, -1])) < 0.9 ? [0, 0, -1] : [1, 0, 0]
    forward = norm(sub(fb, scale(up, dot(fb, up))))
  }
  let right = norm(cross(forward, up))
  if (len(right) < 0.5) right = norm(cross([0, 0, -1], up))
  up = norm(cross(right, forward))
  forward = norm(cross(up, right))
  return { up, forward, right, usesCustomOrientation: Boolean(orientation) }
}

function pointInPolygonXZ(x, z, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x
    const zi = points[i].z
    const xj = points[j].x
    const zj = points[j].z
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function closestOnSegment(px, pz, ax, az, bx, bz) {
  const abx = bx - ax
  const abz = bz - az
  const lengthSq = abx * abx + abz * abz
  if (lengthSq < 1e-12) return { x: ax, z: az }
  let t = ((px - ax) * abx + (pz - az) * abz) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return { x: ax + abx * t, z: az + abz * t }
}

function closestPointOnPolygonXZ(x, z, points) {
  let best = { x: points[0].x, z: points[0].z }
  let bestD = Infinity
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const p = closestOnSegment(x, z, a.x, a.z, b.x, b.z)
    const d = (p.x - x) ** 2 + (p.z - z) ** 2
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

function clampToWalkable(x, y, z, regions) {
  let best = null
  let bestDy = Infinity
  for (const region of regions) {
    if (region.points.length < 3) continue
    const dy = Math.abs(y - region.floorY)
    if (dy < bestDy && dy <= FLOOR_BAND) {
      bestDy = dy
      best = region
    }
  }
  if (!best) return { x, z }
  if (pointInPolygonXZ(x, z, best.points)) return { x, z }
  return closestPointOnPolygonXZ(x, z, best.points)
}

function worldToLocalXZ(x, z, block) {
  const yaw = block.yaw * DEG2RAD
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const dx = x - block.centerX
  const dz = z - block.centerZ
  return { x: dx * cos + dz * sin, z: -dx * sin + dz * cos }
}

function localToWorldXZ(localX, localZ, block) {
  const yaw = block.yaw * DEG2RAD
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  return {
    x: block.centerX + localX * cos - localZ * sin,
    z: block.centerZ + localX * sin + localZ * cos
  }
}

function hitsBlock(x, y, z, block, radius) {
  if (y < block.baseY - 0.05 || y > block.baseY + block.height + 0.35) return false
  const local = worldToLocalXZ(x, z, block)
  return (
    Math.abs(local.x) <= block.width * 0.5 + radius &&
    Math.abs(local.z) <= block.depth * 0.5 + radius
  )
}

function hitsAny(x, y, z, blocks, radius) {
  return blocks.some((b) => hitsBlock(x, y, z, b, radius))
}

function pushOutIfInside(x, y, z, fromX, fromZ, blocks, radius) {
  let cx = x
  let cz = z
  for (let iter = 0; iter < 4; iter++) {
    let moved = false
    for (const block of blocks) {
      if (!hitsBlock(cx, y, cz, block, radius)) continue
      const local = worldToLocalXZ(cx, cz, block)
      const hw = block.width * 0.5 + radius
      const hd = block.depth * 0.5 + radius
      const penX = hw - Math.abs(local.x)
      const penZ = hd - Math.abs(local.z)
      if (penX < 0 || penZ < 0) continue
      const fromLocal = worldToLocalXZ(fromX, fromZ, block)
      let outLocalX = local.x
      let outLocalZ = local.z
      if (penZ <= penX) {
        const dir = Math.abs(fromLocal.z) > 1e-6 ? Math.sign(fromLocal.z) : local.z >= 0 ? 1 : -1
        outLocalZ = dir * (hd + 1e-4)
      } else {
        const dir = Math.abs(fromLocal.x) > 1e-6 ? Math.sign(fromLocal.x) : local.x >= 0 ? 1 : -1
        outLocalX = dir * (hw + 1e-4)
      }
      const world = localToWorldXZ(outLocalX, outLocalZ, block)
      cx = world.x
      cz = world.z
      moved = true
    }
    if (!moved) break
  }
  return { x: cx, z: cz }
}

function resolveCollisionMove(fromX, fromY, fromZ, toX, toY, toZ, blocks, walkable, radius = PLAYER_RADIUS) {
  let x = toX
  let z = toZ
  if (walkable.length > 0) {
    const clamped = clampToWalkable(x, toY, z, walkable)
    x = clamped.x
    z = clamped.z
  }
  if (!blocks.length) return { x, y: toY, z }
  const cleared = pushOutIfInside(fromX, toY, fromZ, fromX, fromZ, blocks, radius)
  let curX = cleared.x
  let curZ = cleared.z
  const wantX = curX + (x - fromX)
  const wantZ = curZ + (z - fromZ)
  if (!hitsAny(wantX, toY, curZ, blocks, radius)) curX = wantX
  if (!hitsAny(curX, toY, wantZ, blocks, radius)) curZ = wantZ
  const pushed = pushOutIfInside(curX, toY, curZ, fromX, fromZ, blocks, radius)
  return { x: pushed.x, y: toY, z: pushed.z }
}

function fitPlaneY(points) {
  let sxx = 0
  let sxz = 0
  let sx = 0
  let szz = 0
  let sz = 0
  let sxy = 0
  let szy = 0
  let sy = 0
  const n = points.length
  for (const p of points) {
    sxx += p.x * p.x
    sxz += p.x * p.z
    sx += p.x
    szz += p.z * p.z
    sz += p.z
    sxy += p.x * p.y
    szy += p.z * p.y
    sy += p.y
  }
  const det =
    sxx * (szz * n - sz * sz) - sxz * (sxz * n - sz * sx) + sx * (sxz * sz - szz * sx)
  if (Math.abs(det) <= 1e-8) return { a: 0, c: 0, d: sy / n }
  const inv = 1 / det
  const a =
    inv * (sxy * (szz * n - sz * sz) - sxz * (szy * n - sz * sy) + sx * (szy * sz - szz * sy))
  const c =
    inv * (sxx * (szy * n - sz * sy) - sxy * (sxz * n - sz * sx) + sx * (sxz * sy - szy * sx))
  const d =
    inv * (sxx * (szz * sy - szy * sz) - sxz * (sxz * sy - szy * sx) + sxy * (sxz * sz - szz * sx))
  return { a, c, d }
}

function distToPolyEdge(x, z, points) {
  let best = Infinity
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const p = closestOnSegment(x, z, a.x, a.z, b.x, b.z)
    best = Math.min(best, Math.hypot(p.x - x, p.z - z))
  }
  return best
}

function buildStairs(polygons, cameraGroundY = 0) {
  const out = []
  for (const poly of polygons || []) {
    const pts = (poly.points || poly).map((p) =>
      Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] } : p
    )
    if (pts.length < 3) continue
    const plane = fitPlaneY(pts)
    let rawMinY = Infinity
    let rawMaxY = -Infinity
    for (const p of pts) {
      rawMinY = Math.min(rawMinY, p.y)
      rawMaxY = Math.max(rawMaxY, p.y)
    }
    const rise = Math.max(0, rawMaxY - rawMinY)
    out.push({
      points: pts,
      ...plane,
      rawMinY,
      rawMaxY,
      lowerFloorY: cameraGroundY,
      upperFloorY: cameraGroundY + rise,
      edgePad: STAIR_EDGE_PAD
    })
  }
  return out
}

function isOnAnyStair(regions, x, z) {
  for (const r of regions) {
    if (pointInPolygonXZ(x, z, r.points) || distToPolyEdge(x, z, r.points) <= r.edgePad) {
      return true
    }
  }
  return false
}

function applyStairHeight(regions, x, z) {
  for (const r of regions) {
    if (!(pointInPolygonXZ(x, z, r.points) || distToPolyEdge(x, z, r.points) <= r.edgePad)) {
      continue
    }
    const raw = r.a * x + r.c * z + r.d
    const rise = r.rawMaxY - r.rawMinY
    const t = rise < 1e-6 ? 0 : Math.max(0, Math.min(1, (raw - r.rawMinY) / rise))
    return r.lowerFloorY + t * (r.upperFloorY - r.lowerFloorY)
  }
  return null
}

/** Map MetalSplatter SceneNavigation JSON → walkable / blocks / stairs. */
function navFromScene(nav) {
  if (!nav) {
    return { walkable: [], blocks: [], stairs: [], orientation: null, start: null }
  }
  const walkable = (nav.collisionLayers || []).map((layer) => ({
    floorY: layer.floorY,
    points: (layer.points || []).map((p) => ({ x: p[0], y: p[1], z: p[2] }))
  }))
  const blocks = (nav.collisionBlocks || []).map((b, i) => ({
    id: `blk_${i}`,
    centerX: b.centerX,
    centerZ: b.centerZ,
    baseY: b.baseY,
    width: b.width,
    depth: b.depth,
    height: b.height,
    yaw: (b.yawRadians ?? 0) * RAD2DEG
  }))
  const stairs = (nav.stairPolygons || []).map((poly) => ({
    points: poly.map((p) => ({ x: p[0], y: p[1], z: p[2] }))
  }))
  const orientation =
    nav.orientationUp && nav.orientationForward
      ? {
          up: [...nav.orientationUp],
          forward: [...nav.orientationForward]
        }
      : null
  const start = nav.startPosition
    ? {
        x: nav.startPosition[0],
        y: nav.startPosition[1],
        z: nav.startPosition[2],
        yaw: nav.yawDegrees ?? 0,
        pitch: nav.pitchDegrees ?? 0
      }
    : null
  return { walkable, blocks, stairs, orientation, start }
}

/**
 * @param {object|null} sceneNav — SceneNavigation from navParser
 * @param {{ moveSpeed?: number|null }} options
 */
export function createFpsWalkCamera(sceneNav, options = {}) {
  const parsed = navFromScene(sceneNav)
  let basis = createBasis(parsed.orientation)
  let walkable = parsed.walkable
  let blocks = parsed.blocks
  let stairs = buildStairs(parsed.stairs, parsed.start?.y ?? 0)
  let collisionEnabled = true

  let moveSpeed =
    typeof options.moveSpeed === 'number' && options.moveSpeed > 0
      ? options.moveSpeed
      : typeof sceneNav?.moveSpeed === 'number' && sceneNav.moveSpeed > 0
        ? sceneNav.moveSpeed
        : DEFAULT_WALK_SPEED
  // Cap absurd Supabase speeds — reference interiors use ~0.6.
  if (moveSpeed > 2.5) moveSpeed = DEFAULT_WALK_SPEED

  let lookSensitivity = LOOK_SENSITIVITY_DEG
  const maxPitch = MAX_PITCH

  let position = parsed.start
    ? v3(parsed.start.x, parsed.start.y, parsed.start.z)
    : v3(0, 1.6, 0)
  let yaw = parsed.start?.yaw ?? 0
  let pitch = Math.max(-maxPitch, Math.min(maxPitch, parsed.start?.pitch ?? 0))
  let persistentFloorY = dot(position, basis.up)

  const pressed = new Set()
  let pickMode = false
  let inputBlocked = false
  let topDown = false
  let savedWalk = null
  const topDownCutHeight = sceneNav?.topDownCutHeight ?? null
  const savedTdCenter = sceneNav?.topDownCenter ? [...sceneNav.topDownCenter] : null
  const savedTdYaw = sceneNav?.topDownYawDegrees
  const savedTdPitch = sceneNav?.topDownPitchDegrees
  const savedOrtho = sceneNav?.topDownOrthoHalfExtent ?? sceneNav?.topDownOrthoZoomOut ?? 1
  const FOVY = 65 * DEG2RAD

  function heightAlongUp(p) {
    return dot(p, basis.up)
  }

  function setHeightAlongUp(h) {
    const cur = heightAlongUp(position)
    position = add(position, scale(basis.up, h - cur))
  }

  /** Local euler pitch/yaw relative to basis → world forward (camera looks −Z local). */
  function cameraForward() {
    const pitchR = pitch * DEG2RAD
    const yawR = yaw * DEG2RAD
    const cp = Math.cos(pitchR)
    const sp = Math.sin(pitchR)
    const cy = Math.cos(yawR)
    const sy = Math.sin(yawR)
    // PlayCanvas local forward after pitch(X) then yaw(Y): approx
    // Local look dir (−Z): rotate by yaw around up, pitch around right
    // pitch>0 looks up (sin*up); mouse-down decreases pitch → look down (matches walk-camera.ts).
    const yawed = norm(add(scale(basis.forward, cy), scale(basis.right, sy)))
    return norm(add(scale(yawed, cp), scale(basis.up, sp)))
  }

  function cameraRight() {
    const f = cameraForward()
    const r = cross(f, basis.up)
    return len(r) > 1e-4 ? norm(r) : basis.right
  }

  function getPose() {
    const forward = cameraForward()
    return {
      position: [...position],
      target: add(position, scale(forward, 2)),
      forward,
      up: [...basis.up],
      yaw,
      pitch,
      fov: 65,
      topDown,
      hasTopDownCut: topDownCutHeight != null
    }
  }

  function applyLookDeltaPixels(dx, dy) {
    if (inputBlocked || pickMode) return
    // PlayCanvas-style drag look: drag left → camera turns right (grab / invert yaw).
    yaw -= dx * lookSensitivity
    pitch -= dy * lookSensitivity
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch))
  }

  function setKey(code, down) {
    if (down) pressed.add(code)
    else pressed.delete(code)
  }

  function update(dt) {
    if (inputBlocked) return getPose()

    if (topDown) {
      // Flat pan only (Top Down tool) — still no orbit.
      let move = v3()
      let forward = projectOnNavPlane(cameraForward(), basis.up)
      let right = projectOnNavPlane(cameraRight(), basis.up)
      if (len(forward) > 1e-8) forward = norm(forward)
      if (len(right) > 1e-8) right = norm(right)
      if (pressed.has('KeyW') || pressed.has('ArrowUp')) move = add(move, forward)
      if (pressed.has('KeyS') || pressed.has('ArrowDown')) move = sub(move, forward)
      if (pressed.has('KeyD') || pressed.has('ArrowRight')) move = add(move, right)
      if (pressed.has('KeyA') || pressed.has('ArrowLeft')) move = sub(move, right)
      if (len(move) > 1e-8) {
        position = add(position, scale(norm(move), moveSpeed * dt))
      }
      return getPose()
    }

    if (pressed.size === 0) return getPose()

    let forward = projectOnNavPlane(cameraForward(), basis.up)
    let right = projectOnNavPlane(cameraRight(), basis.up)
    if (len(forward) > 1e-8) forward = norm(forward)
    if (len(right) > 1e-8) right = norm(right)

    let move = v3()
    if (pressed.has('KeyW') || pressed.has('ArrowUp')) move = add(move, forward)
    if (pressed.has('KeyS') || pressed.has('ArrowDown')) move = sub(move, forward)
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) move = add(move, right)
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) move = sub(move, right)

    let vertical = 0
    if (pressed.has('KeyE')) vertical += 1
    if (pressed.has('KeyQ')) vertical -= 1

    const hasHorizontal = len(move) >= 1e-8
    if (!hasHorizontal && Math.abs(vertical) < 1e-8) return getPose()

    let next = [...position]
    if (hasHorizontal) {
      const step = scale(norm(move), moveSpeed * dt)
      next = add(position, step)
    }
    if (Math.abs(vertical) > 1e-8) {
      next = add(next, scale(basis.up, vertical * moveSpeed * dt))
      persistentFloorY = heightAlongUp(next)
    }

    const onStairs =
      stairs.length > 0 &&
      (isOnAnyStair(stairs, position[0], position[2]) || isOnAnyStair(stairs, next[0], next[2]))

    if (collisionEnabled && (blocks.length > 0 || (!onStairs && walkable.length > 0))) {
      const resolved = resolveCollisionMove(
        position[0],
        position[1],
        position[2],
        next[0],
        next[1],
        next[2],
        blocks,
        onStairs ? [] : walkable
      )
      next = [resolved.x, resolved.y, resolved.z]
    }

    if (stairs.length > 0) {
      const stairY = applyStairHeight(stairs, next[0], next[2])
      if (stairY !== null) {
        next[1] = stairY
        persistentFloorY = heightAlongUp(next)
      } else if (Math.abs(vertical) < 1e-8) {
        const h = heightAlongUp(next)
        next = add(next, scale(basis.up, persistentFloorY - h))
      }
    } else if (Math.abs(vertical) < 1e-8) {
      const h = heightAlongUp(next)
      next = add(next, scale(basis.up, persistentFloorY - h))
    }

    position = next
    return getPose()
  }

  function resetToStart() {
    if (parsed.start) {
      position = v3(parsed.start.x, parsed.start.y, parsed.start.z)
      yaw = parsed.start.yaw
      pitch = Math.max(-maxPitch, Math.min(maxPitch, parsed.start.pitch))
    }
    persistentFloorY = heightAlongUp(position)
    topDown = false
    savedWalk = null
    pressed.clear()
  }

  function setTopDown(enabled) {
    if (enabled) {
      if (topDownCutHeight == null) return false
      if (!topDown) {
        savedWalk = { position: [...position], yaw, pitch, persistentFloorY }
        if (savedTdYaw != null) yaw = savedTdYaw
        if (savedTdPitch != null) pitch = Math.max(-maxPitch, Math.min(maxPitch, savedTdPitch))
        if (savedTdCenter) position = [...savedTdCenter]
        else {
          pitch = -maxPitch
          const hover = Math.max(0.001, savedOrtho / Math.max(1e-4, Math.tan(FOVY * 0.5)))
          setHeightAlongUp(topDownCutHeight + hover)
        }
        topDown = true
      }
      return true
    }
    if (topDown && savedWalk) {
      position = [...savedWalk.position]
      yaw = savedWalk.yaw
      pitch = savedWalk.pitch
      persistentFloorY = savedWalk.persistentFloorY
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
    const minH = topDownCutHeight + 0.001
    if (heightAlongUp(position) < minH) setHeightAlongUp(minH)
  }

  resetToStart()

  return {
    update,
    applyLookDeltaPixels,
    setKey,
    setPickMode(enabled) {
      pickMode = enabled
      if (enabled) pressed.clear()
    },
    setInputBlocked(blocked) {
      inputBlocked = blocked
      pressed.clear()
    },
    setMoveSpeed(speed) {
      if (typeof speed === 'number' && speed > 0) {
        moveSpeed = Math.max(0.05, Math.min(speed, 2.5))
      }
    },
    setLookSensitivity(s) {
      if (typeof s === 'number' && s > 0) lookSensitivity = s
    },
    /** True while any walk/look key is held — host must keep requesting frames. */
    hasMovementInput() {
      return pressed.size > 0
    },
    resetToStart,
    setTopDown,
    nudgeZoom,
    getPose,
    get topDown() {
      return topDown
    },
    get hasTopDownCut() {
      return topDownCutHeight != null
    },
    get hasNavClamp() {
      return walkable.length > 0 || blocks.length > 0 || stairs.length > 0
    }
  }
}

// Back-compat alias used by older mediaServer import paths.
export function createMacWalker(nav, options) {
  return createFpsWalkCamera(nav, options)
}

export { DEFAULT_WALK_SPEED, FALLBACK_WALK_SPEED, LOOK_SENSITIVITY_DEG }
