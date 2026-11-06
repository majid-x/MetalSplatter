import { app } from 'electron'
import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { basename, extname, join, normalize, resolve, sep } from 'path'
import type { ViewerLaunchOptions } from '../shared/viewerChannels'
import { parseNav } from './navParser'
import { projectsRoot } from './projectStore'

/** FPS first-person walk default — Mac Constants.cameraMoveSpeed. */
const DEFAULT_FPS_MOVE_SPEED = 3.5

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.spz': 'application/octet-stream',
  '.sog': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
}

let server: Server | null = null
let origin = ''

type PaymentSession = {
  publishableKey: string
  clientSecret: string
  amountDisplay: string
}

const paymentSessions = new Map<string, PaymentSession>()

function viewerPublicDir(): string {
  return join(app.getAppPath(), 'node_modules', '@playcanvas', 'supersplat-viewer', 'public')
}

function appViewerDir(): string {
  return join(app.getAppPath(), 'viewer')
}

function settingsTemplatePath(): string {
  return join(appViewerDir(), 'settings.json')
}

function fpsWalkCameraPath(): string {
  return join(appViewerDir(), 'fpsWalkCamera.js')
}

function contentUrlFor(filePath: string): string {
  const fileName = basename(filePath)
  return `${origin}/content/${encodeURIComponent(fileName)}?path=${encodeURIComponent(filePath)}`
}

function buildSettingsJson(options: ViewerLaunchOptions): string {
  const template = JSON.parse(readFileSync(settingsTemplatePath(), 'utf8')) as Record<string, unknown>
  // Mac default when no nav camera: (0, 0, 1.54) looking down -Z — never empty→frameScene blob.
  const camera = options.camera ?? {
    position: [0, 0, 1.54] as [number, number, number],
    target: [0, 0, -0.46] as [number, number, number],
    fov: 65
  }
  template.cameras = [
    {
      initial: {
        position: camera.position,
        target: camera.target,
        fov: camera.fov
      }
    }
  ]
  // Room-scale captures are environments, not orbit-around-object subjects.
  template.startMode = 'default'
  return JSON.stringify(template)
}

function sendFile(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  const info = statSync(filePath)
  const mime = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': info.size,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes'
  })
  createReadStream(filePath).pipe(res)
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root) + sep
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate.startsWith(normalizedRoot) || normalizedCandidate === resolve(root)
}

function allowedContentRoots(): string[] {
  return [projectsRoot()]
}

function isAllowedContentPath(filePath: string): boolean {
  const resolved = resolve(filePath)
  if (allowedContentRoots().some((root) => isPathInside(root, resolved))) return true
  // Drag-dropped / user-picked local splat files
  const ext = extname(resolved).toLowerCase()
  if (!['.ply', '.splat', '.spz', '.sog', '.glb', '.gltf'].includes(ext)) return false
  return existsSync(resolved) && statSync(resolved).isFile()
}

function handleContent(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const raw = url.searchParams.get('path')
  if (!raw) {
    res.writeHead(400).end('Missing path')
    return
  }
  const filePath = normalize(raw)
  if (!isAllowedContentPath(filePath)) {
    res.writeHead(403).end('Forbidden')
    return
  }
  if (req.method === 'HEAD') {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404).end()
      return
    }
    const info = statSync(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes'
    })
    res.end()
    return
  }
  sendFile(res, filePath)
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/content' || url.pathname.startsWith('/content/')) {
      handleContent(req, res, url)
      return
    }

    if (url.pathname === '/settings.json' || url.pathname === '/viewer/settings.json') {
      sendFile(res, settingsTemplatePath())
      return
    }

    // Custom FPS walk module (not part of SuperSplat public/).
    if (
      url.pathname === '/vroomk/fpsWalkCamera.js' ||
      url.pathname === '/viewer/fpsWalkCamera.js'
    ) {
      sendFile(res, fpsWalkCameraPath())
      return
    }

    if (url.pathname.startsWith('/stripe-pay/')) {
      const id = decodeURIComponent(url.pathname.slice('/stripe-pay/'.length))
      const session = paymentSessions.get(id)
      if (!session) {
        res.writeHead(404).end('Payment session expired')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end(stripePaymentHtml(session))
      return
    }

    if (url.pathname === '/vroomk-viewer.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      })
      res.end(vroomkViewerHtml())
      return
    }

    let relative = url.pathname
    if (relative === '/' || relative === '/viewer' || relative === '/viewer/') {
      relative = '/viewer/index.html'
    }
    if (relative.startsWith('/viewer/')) {
      relative = relative.slice('/viewer/'.length)
    } else {
      relative = relative.replace(/^\//, '')
    }

    const safe = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '')
    sendFile(res, join(viewerPublicDir(), safe))
  } catch {
    res.writeHead(500).end('Server error')
  }
}

export async function startMediaServer(): Promise<string> {
  if (origin) return origin

  server = createServer(handleRequest)

  await new Promise<void>((resolvePromise, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => resolvePromise())
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Vroomk media server')
  }

  origin = `http://127.0.0.1:${address.port}`
  return origin
}

export function getMediaServerOrigin(): string {
  return origin
}

export function stopMediaServer(): void {
  server?.close()
  server = null
  origin = ''
}

export function buildViewerUrl(options: ViewerLaunchOptions | string): string {
  if (!origin) throw new Error('Media server is not running')

  const launch: ViewerLaunchOptions =
    typeof options === 'string' ? { modelPath: options } : options

  const params = new URLSearchParams({
    content: contentUrlFor(launch.modelPath),
    // Prefer WebGL for broad Windows GPU drivers; SuperSplat still frames the scene.
    webgl: '1',
    // Hide SuperSplat chrome — Mac-style overlay tools are drawn by the Electron UI.
    noui: '1'
  })

  if (launch.collisionPath) {
    params.set('collision', contentUrlFor(launch.collisionPath))
  }

  // FPS walk speed (Supabase move_speed when set, else Mac default 3.5).
  const speed =
    typeof launch.moveSpeed === 'number' && launch.moveSpeed > 0
      ? launch.moveSpeed
      : DEFAULT_FPS_MOVE_SPEED
  params.set('movespeed', String(speed))
  // FPS reticle like Mac look-capture affordance.
  params.set('reticle', '1')

  // Prefetching a 200MB+ PLY into memory before decode stalls at 100% on black.
  try {
    if (existsSync(launch.modelPath) && statSync(launch.modelPath).size > 48 * 1024 * 1024) {
      params.set('noprefetch', '1')
    }
  } catch {
    /* ignore */
  }

  // Inline settings so nav start camera is applied without a temp file.
  const settingsJson = buildSettingsJson(launch)
  params.set('settings', `data:application/json,${encodeURIComponent(settingsJson)}`)

  // Scene navigation for walkable clamp + wall-box slide (optional).
  if (launch.navigationPath && existsSync(launch.navigationPath)) {
    try {
      const nav = parseNav(readFileSync(launch.navigationPath, 'utf8'))
      if (nav) {
        params.set('nav', `data:application/json,${encodeURIComponent(JSON.stringify(nav))}`)
      }
    } catch {
      /* ignore — walk without clamp */
    }
  }

  // Custom wrapper adds click-to-pick postMessage bridge for photos / measure.
  return `${origin}/vroomk-viewer.html?${params.toString()}`
}

function vroomkViewerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Vroomk Viewer</title>
  <base href="/viewer/" />
  <link rel="stylesheet" href="./index.css" />
  <style>
    html, body { height: 100%; margin: 0; overflow: hidden; background: #000; }
    #pick-banner {
      display: none; position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 40; padding: 8px 14px; border-radius: 999px;
      background: rgba(20,24,32,0.92); color: #fff; font: 13px/1.3 "Segoe UI", sans-serif;
      border: 1px solid rgba(255,255,255,0.14); pointer-events: none;
    }
    #pick-banner.on { display: block; }
  </style>
  <script type="module">
    const createImage = (url) => { const img = new Image(); img.src = url; return img; };
    const url = new URL(location.href);
    const posterUrl = url.searchParams.get('poster');
    const skyboxUrl = url.searchParams.get('skybox');
    const collisionUrl = url.searchParams.get('collision') ?? url.searchParams.get('voxel');
    const settingsUrl = url.searchParams.get('settings') ?? './settings.json';
    const navUrl = url.searchParams.get('nav');
    const contentUrl = url.searchParams.get('content') ?? './scene.compressed.ply';
    const renderer = url.searchParams.has('webgl') ? 'webgl' : 'webgpu';
    const contentName = new URL(contentUrl, location.href).pathname.split('/').pop() ?? '';
    const prefetchContent =
      contentName.toLowerCase() !== 'lod-meta.json' && !url.searchParams.has('noprefetch');
    window.sse = {
      options: {
        contentUrl,
        contentFilename: decodeURIComponent(contentName),
        posterUrl,
        skyboxUrl,
        collisionUrl,
        poster: posterUrl && createImage(posterUrl),
        contents: prefetchContent ? fetch(contentUrl) : undefined,
        ui: !url.searchParams.has('noui'),
        reticle: url.searchParams.has('reticle'),
        noanim: true,
        nofx: url.searchParams.has('nofx'),
        renderer,
        exposeGlobals: true
      },
      moveSpeed: (() => {
        const raw = Number(url.searchParams.get('movespeed'));
        return Number.isFinite(raw) && raw > 0 ? raw : ${DEFAULT_FPS_MOVE_SPEED};
      })(),
      sceneNav: navUrl
        ? (navUrl.startsWith('data:')
            ? fetch(navUrl).then((r) => r.json())
            : fetch(navUrl).then((r) => r.json()))
        : Promise.resolve(null),
      settings: settingsUrl.startsWith('data:')
        ? fetch(settingsUrl).then((r) => r.json())
        : fetch(settingsUrl).then((r) => r.json())
    };
  </script>
</head>
<body>
  <div id="pick-banner">Click in the scene to place a point</div>
  <div id="viewer-error" style="display:none;position:fixed;inset:0;z-index:50;place-items:center;background:#000;color:#fff;font:14px/1.5 Segoe UI,sans-serif;padding:24px;text-align:center;"></div>
  <script type="module">
    import { createViewer } from './index.js';
    import { createFpsWalkCamera, DEFAULT_WALK_SPEED } from '/vroomk/fpsWalkCamera.js';

    const banner = document.getElementById('pick-banner');
    const errorEl = document.getElementById('viewer-error');
    // Created after the viewer so it stacks above the canvas / SuperSplat chrome.
    const overlay = document.createElement('div');
    overlay.id = 'measure-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
    const sprintHud = document.createElement('div');
    sprintHud.id = 'sprint-hud';
    sprintHud.textContent = '2× SPRINT';
    sprintHud.style.cssText =
      'display:none;position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:10001;' +
      'padding:10px 18px;border-radius:999px;background:rgba(12,18,16,0.94);color:#7dffb2;' +
      'font:700 14px/1.2 Segoe UI,sans-serif;letter-spacing:0.06em;' +
      'border:1px solid rgba(125,255,178,0.55);pointer-events:none;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.55);';
    let pickMode = null; // 'photos' | 'damage' — measure runs its own mode
    let viewerHandle = null;
    let walker = null;
    let sceneNav = null;
    /** SuperSplat splat-depth picker (PlayCanvas/Mac parity) — set on picker:ready. */
    let splatPicker = null;
    let pickRequestId = 0;
    /** World-space Search Image pick — same Measure-style HTML pin, reprojected each frame. */
    let photoPickPoint = null;
    /** Brief screen-space flash at the click until the world pick resolves. */
    let photoClickFlash = null;
    /** PlayCanvas-style: LMB (walk) / RMB (tools) drag-look; cursor stays visible. */
    let dragLooking = false;
    /**
     * Measure / Search Image: LMB down may become look-drag or a pick on release.
     * { x, y, pointerId, kind: 'measure'|'photos' }
     */
    let pendingToolPointer = null;
    const TOOL_DRAG_THRESHOLD_PX = 6;
    let lastSprintHud = false;

    // Mac-parity measure state (PlayCanvas SplatMeasurer / MetalKitSceneRenderer).
    let measureMode = false;
    let measureDeleteMode = false;
    // Supabase measur_factor — distance readout only (Mac measureCalibrationFactor).
    let measureFactor = 1;
    // nav.txt measure_scale — pin / laser / reticle size only (Mac measureOverlayScale).
    let measureOverlayScale = 1;
    let measureExact = false;
    let measureNodes = []; // { position, screen:{x,y}, isStartOfChain, distanceToPrevious }
    let measureHover = null;
    let measureHoverScreen = null;
    let measureDeleteHoverIndex = null;
    let lastHoverPick = 0;

    function post(payload) {
      parent.postMessage({ source: 'vroomk-viewer', ...payload }, '*');
    }

    function showError(message) {
      errorEl.style.display = 'grid';
      errorEl.textContent = message;
      post({ type: 'error', message });
    }

    function gcd(a, b) {
      let x = Math.abs(a), y = Math.abs(b);
      while (y) { const t = x % y; x = y; y = t; }
      return Math.max(x, 1);
    }

    function formatMeasureDistance(meters) {
      const totalFeet = meters * 3.280839895;
      let feet = Math.floor(totalFeet);
      const remainingInches = (totalFeet - feet) * 12;
      let inches = Math.floor(remainingInches);
      const fractionOfInch = remainingInches - inches;
      const denominator = measureExact ? 32 : 4;
      let numerator = Math.round(fractionOfInch * denominator);
      if (numerator === denominator) { numerator = 0; inches += 1; }
      if (inches >= 12) { inches -= 12; feet += 1; }
      let fractionStr = '';
      if (numerator > 0) {
        const d = gcd(numerator, denominator);
        fractionStr = ' ' + (numerator / d) + '/' + (denominator / d);
      }
      return feet + "' " + inches + fractionStr + '"';
    }

    function dist(a, b) {
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      return Math.hypot(dx, dy, dz);
    }

    function emitMeasureState(status) {
      post({
        type: 'measureState',
        status,
        deleteMode: measureDeleteMode,
        pointCount: measureNodes.length,
        mode: measureMode
      });
    }

    function isSurfacePickMode() {
      return pickMode === 'photos' || pickMode === 'damage';
    }

    function toolsNeedCursor() {
      return measureMode || isSurfacePickMode();
    }

    function applyLookFromEvent(event) {
      if (!walker) return;
      const dx = event.movementX || 0;
      const dy = event.movementY || 0;
      if (!dx && !dy) return;
      walker.applyLookDeltaPixels(dx, dy);
      applyPoseToCamera(walker.getPose());
    }

    function syncToolVsWalk() {
      if (!viewerHandle?.state?.loaded) return;
      if (toolsNeedCursor()) {
        dragLooking = false;
        pendingToolPointer = null;
        // Keep walk/look alive; LMB click picks, LMB/RMB drag looks.
        if (walker) {
          walker.setPickMode(false);
          walker.setInputBlocked(false);
        }
        try { viewerHandle.state.inputEnabled = false; } catch (_) {}
      } else {
        pendingToolPointer = null;
        applyMacWalkControls(window.sse.moveSpeed, false);
      }
    }

    function runSurfacePickAt(cx, cy) {
      const modeAtClick = pickMode;
      if (modeAtClick !== 'photos' && modeAtClick !== 'damage') return;
      const req = ++pickRequestId;
      photoClickFlash = { x: cx, y: cy, until: performance.now() + 350 };
      drawToolOverlay();
      void pickWorldPoint(viewerHandle.app, cx, cy).then((result) => {
        if (!result || req !== pickRequestId || pickMode !== modeAtClick) return;
        photoPickPoint = result.point;
        photoClickFlash = null;
        drawToolOverlay();
        kickWalkFrame();
        const apiPoint = toMacPhotoPoint(viewerHandle.app, result.point, sceneNav);
        post({
          type: 'pick',
          mode: modeAtClick,
          point: apiPoint,
          camera: result.camera
        });
      });
    }

    function v3n(v) {
      const L = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / L, v[1] / L, v[2] / L];
    }
    function v3cross(a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }
    /** Quat (x,y,z,w) from orthonormal columns right / up / back (−forward). */
    function quatFromBasis(right, up, back) {
      const m00 = right[0], m01 = up[0], m02 = back[0];
      const m10 = right[1], m11 = up[1], m12 = back[1];
      const m20 = right[2], m21 = up[2], m22 = back[2];
      const tr = m00 + m11 + m22;
      let x, y, z, w;
      if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        w = 0.25 * s;
        x = (m21 - m12) / s;
        y = (m02 - m20) / s;
        z = (m10 - m01) / s;
      } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
      } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
      } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
      }
      return [x, y, z, w];
    }

    function applyPoseToCamera(pose) {
      const camera = findCamera(viewerHandle.app);
      if (!camera?.entity || !pose) return;
      const e = camera.entity;
      const p = pose.position;
      // Mac viewMatrix: right = F×navUp, up = right×F, look along F (entity −Z).
      // SuperSplat's applyCamera uses setEulerAngles (forces world Y-up / roll=0) — overwrite
      // with an explicit basis so Z-up [orientation] scenes stay level.
      let forward = pose.forward;
      if (!forward || forward.length < 3) {
        const t = pose.target;
        forward = v3n([t[0] - p[0], t[1] - p[1], t[2] - p[2]]);
      } else {
        forward = v3n(forward);
      }
      const navUp = pose.navigationUp || pose.up || [0, 1, 0];
      let right = v3cross(forward, navUp);
      let rLen = Math.hypot(right[0], right[1], right[2]);
      if (rLen < 1e-5) {
        const alt = Math.abs(navUp[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        right = v3cross(forward, alt);
        rLen = Math.hypot(right[0], right[1], right[2]) || 1;
      }
      right = [right[0] / rLen, right[1] / rLen, right[2] / rLen];
      const up = v3n(v3cross(right, forward));
      const back = [-forward[0], -forward[1], -forward[2]];
      const [qx, qy, qz, qw] = quatFromBasis(right, up, back);
      e.setPosition(p[0], p[1], p[2]);
      try {
        e.setRotation(qx, qy, qz, qw);
      } catch (_) {
        try {
          e.setLocalRotation(qx, qy, qz, qw);
        } catch (__) {
          e.lookAt(p[0] + forward[0], p[1] + forward[1], p[2] + forward[2], up[0], up[1], up[2]);
        }
      }
      if (camera.camera && typeof pose.fov === 'number') {
        camera.camera.fov = pose.fov;
      }
      viewerHandle.app.renderNextFrame = true;
    }

    function hasNavStart() {
      return !!(sceneNav && Array.isArray(sceneNav.startPosition) && sceneNav.startPosition.length >= 3);
    }

    /** Mac Constants: camera at (0, cameraGroundY=0, cameraStartZ=1.54), look -Z. */
    function macDefaultStartNav() {
      return {
        startPosition: [0, 0, 1.54],
        yawDegrees: 0,
        pitchDegrees: 0,
        orientationUp: null,
        orientationForward: null,
        moveSpeed: null,
        measureScale: null,
        topDownCutHeight: null,
        collisionLayers: [],
        collisionBlocks: [],
        stairPolygons: []
      };
    }

    function kickWalkFrame() {
      if (viewerHandle?.app) viewerHandle.app.renderNextFrame = true;
    }

    function setWalkKey(code, down) {
      if (!walker) return;
      walker.setKey(code, down);
      if (down) kickWalkFrame();
      syncSprintHud();
    }

    function syncShiftModifier(shiftKey) {
      if (!walker) return;
      // Keep sprint in sync even when Shift keydown was swallowed by the host/iframe.
      walker.setKey('ShiftLeft', !!shiftKey);
      if (!shiftKey) walker.setKey('ShiftRight', false);
      syncSprintHud();
    }

    function syncSprintHud() {
      if (!sprintHud || !walker) {
        if (sprintHud) sprintHud.style.display = 'none';
        return;
      }
      const on =
        typeof walker.isSprintMoving === 'function'
          ? walker.isSprintMoving()
          : (walker.isSprinting?.() && walker.hasMovementInput?.());
      sprintHud.style.display = on ? 'block' : 'none';
      if (on !== lastSprintHud) {
        lastSprintHud = on;
        post({ type: 'sprintState', sprinting: on });
      }
      if (on) kickWalkFrame();
    }

    function clearPhotoMarker() {
      photoPickPoint = null;
      photoClickFlash = null;
    }

    function setPickMode(mode) {
      // Surface pick (photos / damage); measure uses setMeasureMode.
      if (mode && String(mode).startsWith('measure')) {
        setMeasureMode(true);
        return;
      }
      if (mode === 'photos' || mode === 'damage') {
        setMeasureMode(false);
        pickMode = mode;
        clearPhotoMarker();
        banner.classList.add('on');
        // Damage mode must not reveal the image-search backend to the user.
        banner.textContent =
          mode === 'damage'
            ? 'Click a wall surface to estimate damage'
            : 'Click in the scene to search nearby photos';
        drawToolOverlay();
      } else {
        pickMode = null;
        clearPhotoMarker();
        if (!measureMode) {
          banner.classList.remove('on');
          overlay.innerHTML = '';
        }
      }
      syncToolVsWalk();
    }

    function setMeasureMode(enabled) {
      measureMode = !!enabled;
      measureDeleteMode = false;
      measureHover = null;
      measureHoverScreen = null;
      measureDeleteHoverIndex = null;
      if (measureMode) {
        pickMode = null;
        clearPhotoMarker();
        banner.classList.add('on');
        banner.textContent = 'Measure on · click two points';
        emitMeasureState('Measure on · click two points');
        drawToolOverlay();
      } else {
        // Mac: leaving Measure turns the tool off and drops hover/reticle.
        // Clear on-screen overlay so pins/lasers don't sit on top of other tools.
        if (!isSurfacePickMode()) banner.classList.remove('on');
        if (!isSurfacePickMode()) overlay.innerHTML = '';
        else drawToolOverlay();
        emitMeasureState(
          measureNodes.length === 0
            ? 'Measure off'
            : ('Measure off · ' + measureNodes.length + ' points kept')
        );
      }
      syncToolVsWalk();
    }

    function setMeasureDeleteMode(enabled) {
      if (!measureMode) return;
      measureDeleteMode = !!enabled;
      measureDeleteHoverIndex = null;
      banner.textContent = measureDeleteMode ? 'Delete mode · click a pin' : 'Measure on · click two points';
      emitMeasureState(measureDeleteMode ? 'Delete mode · click a pin' : 'Measure on · click two points');
      drawMeasureOverlay();
    }

    function undoMeasurePoint() {
      if (measureNodes.length === 0) return;
      measureNodes.pop();
      let status;
      if (measureNodes.length === 0) {
        status = measureMode ? 'Measure on · click two points' : 'Measure off';
      } else if (measureNodes[measureNodes.length - 1].isStartOfChain) {
        status = 'Undid point · click second point · ' + measureNodes.length + ' left';
      } else {
        status = 'Undid point · ' + measureNodes.length + ' left';
      }
      emitMeasureState(status);
      drawMeasureOverlay();
    }

    function clearMeasureGeometry() {
      measureNodes = [];
      measureHover = null;
      measureDeleteHoverIndex = null;
      measureDeleteMode = false;
      const status = measureMode ? 'Cleared · Measure on · click two points' : 'Measure off';
      banner.textContent = measureMode ? 'Measure on · click two points' : banner.textContent;
      emitMeasureState(status);
      drawMeasureOverlay();
    }

    function findCamera(app) {
      const cameras = app.root.findComponents('camera');
      if (!cameras || !cameras.length) return null;
      // Prefer the enabled camera SuperSplat is actually rendering with
      // (PlayCanvas SplatClickQuery uses Camera-Main, not a disabled Camera).
      for (let i = 0; i < cameras.length; i++) {
        const c = cameras[i];
        if (c && c.enabled && c.entity && c.entity.enabled) return c;
      }
      return cameras[0];
    }

    /**
     * PlayCanvas / Mac parity: pick the splat surface via SuperSplat GPU depth
     * (picker.pickSurface), not a fixed-depth screen guess or Ammo raycast.
     * Coords are normalized 0..1 like SuperSplat's internal fly-to-target.
     */
    async function pickWorldPoint(app, clientX, clientY) {
      const camera = findCamera(app);
      if (!camera) return null;
      const canvas = app.graphicsDevice.canvas;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1e-6, rect.width);
      const h = Math.max(1e-6, rect.height);
      const nx = (clientX - rect.left) / w;
      const ny = (clientY - rect.top) / h;
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;

      const camPos = camera.entity.getPosition();
      const camArr = [camPos.x, camPos.y, camPos.z];

      // 1) SuperSplat splat-depth pick (same idea as pc.Picker.getWorldPointAsync / Mac pick depth).
      if (splatPicker) {
        try {
          let hit = null;
          if (typeof splatPicker.pickSurface === 'function') {
            hit = await splatPicker.pickSurface(nx, ny);
          }
          const pos = hit && hit.position ? hit.position : null;
          if (pos && Number.isFinite(pos.x)) {
            return { point: [pos.x, pos.y, pos.z], camera: camArr };
          }
          if (typeof splatPicker.pick === 'function') {
            const p = await splatPicker.pick(nx, ny);
            if (p && Number.isFinite(p.x)) {
              return { point: [p.x, p.y, p.z], camera: camArr };
            }
          }
        } catch (_) {}
      }

      // 2) Optional mesh/voxel collision ray (SuperSplat may attach this; Ammo often empty).
      try {
        const sx = nx * canvas.width;
        const sy = ny * canvas.height;
        const from = camera.entity.getPosition().clone();
        const to = camera.entity.getPosition().clone();
        camera.screenToWorld(sx, sy, camera.nearClip, from);
        camera.screenToWorld(sx, sy, camera.farClip, to);
        if (app.systems.rigidbody && app.systems.rigidbody.raycastFirst) {
          const hit = app.systems.rigidbody.raycastFirst(from, to);
          if (hit && hit.point) {
            return {
              point: [hit.point.x, hit.point.y, hit.point.z],
              camera: camArr
            };
          }
        }
      } catch (_) {}

      // No fake fixed-depth point — that made pins float off the splat / stick on screen.
      return null;
    }

    function worldToScreen(app, point) {
      const camComp = findCamera(app);
      if (!camComp) return null;
      const canvas = app.graphicsDevice.canvas;
      const rect = canvas.getBoundingClientRect();
      const world = camComp.entity.getPosition().clone();
      world.set(point[0], point[1], point[2]);

      // SuperSplat convention: view-space z >= 0 is behind the camera.
      try {
        const viewPos = world.clone();
        camComp.viewMatrix.transformPoint(world, viewPos);
        if (viewPos.z >= 0) return null;
      } catch (_) {
        try {
          const viewPos = world.clone();
          camComp.camera.viewMatrix.transformPoint(world, viewPos);
          if (viewPos.z >= 0) return null;
        } catch (_) {}
      }

      let sx;
      let sy;
      try {
        // CameraComponent.worldToScreen → canvas CSS pixels (matches SuperSplat annotations).
        const screenPos = camComp.worldToScreen(world);
        sx = screenPos.x;
        sy = screenPos.y;
      } catch (_) {
        try {
          const screenPos = camComp.camera.worldToScreen(world);
          sx = screenPos.x;
          sy = screenPos.y;
        } catch (_) {
          try {
            const screen = world.clone();
            camComp.worldToScreen(world, screen);
            sx = (screen.x / canvas.width) * rect.width;
            sy = (screen.y / canvas.height) * rect.height;
          } catch (_) {
            return null;
          }
        }
      }
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return null;
      // worldToScreen may already be in page CSS relative to canvas; prefer canvas-local + rect.
      return { x: rect.left + sx, y: rect.top + sy };
    }

    function nearestPinIndex(point, radius) {
      let best = null;
      let bestD = radius;
      for (let i = 0; i < measureNodes.length; i++) {
        const d = dist(measureNodes[i].position, point);
        if (d <= bestD) { bestD = d; best = i; }
      }
      return best;
    }

    function addMeasurePoint(point) {
      let isStart = true;
      let distance = null;
      const previous = measureNodes[measureNodes.length - 1];
      if (previous && previous.isStartOfChain) {
        isStart = false;
        distance = dist(previous.position, point) * measureFactor;
      }
      // Store world position only — screen is recomputed every frame (Mac/PlayCanvas parity).
      const projected = viewerHandle ? worldToScreen(viewerHandle.app, point) : null;
      measureNodes.push({
        position: point,
        screen: projected,
        isStartOfChain: isStart,
        distanceToPrevious: distance
      });
      let status;
      if (distance != null) {
        status = 'Segment ' + formatMeasureDistance(distance) + ' · ' + measureNodes.length + ' points';
      } else {
        status = 'Point placed · click second point · ' + measureNodes.length + ' points';
      }
      emitMeasureState(status);
      drawToolOverlay();
      kickWalkFrame();
    }

    async function handleMeasureClick(clientX, clientY) {
      if (measureDeleteMode) {
        // Prefer pin nearest the click in screen space (more reliable than world radius).
        let idx = measureDeleteHoverIndex;
        if (idx == null) {
          let best = null;
          let bestD = 28 * measureOverlayScale;
          for (let i = 0; i < measureNodes.length; i++) {
            const s = measureNodes[i].screen;
            if (!s) continue;
            const d = Math.hypot(s.x - clientX, s.y - clientY);
            if (d <= bestD) { bestD = d; best = i; }
          }
          idx = best;
        }
        if (idx == null) {
          emitMeasureState('No pin near click');
          return;
        }
        measureNodes.splice(idx, 1);
        if (measureNodes.length > 0) {
          measureNodes[0].isStartOfChain = true;
          measureNodes[0].distanceToPrevious = null;
          for (let i = 1; i < measureNodes.length; i++) {
            if (measureNodes[i].isStartOfChain) {
              measureNodes[i].distanceToPrevious = null;
            } else {
              measureNodes[i].distanceToPrevious =
                dist(measureNodes[i - 1].position, measureNodes[i].position) * measureFactor;
            }
          }
        }
        measureDeleteMode = false;
        measureDeleteHoverIndex = null;
        banner.textContent = 'Measure on · click two points';
        emitMeasureState('Deleted pin · Measure on');
        drawToolOverlay();
        kickWalkFrame();
        return;
      }
      const result = await pickWorldPoint(viewerHandle.app, clientX, clientY);
      if (!result) {
        emitMeasureState('No surface at click');
        return;
      }
      addMeasurePoint(result.point);
    }

    function screenOf(app, nodeOrPoint) {
      // Always reproject from world — never keep click-time clientX/Y (that stuck pins to the display).
      const position = Array.isArray(nodeOrPoint) ? nodeOrPoint : nodeOrPoint.position;
      const projected = worldToScreen(app, position);
      if (nodeOrPoint && !Array.isArray(nodeOrPoint)) nodeOrPoint.screen = projected;
      return projected;
    }

    function clampMeasureOverlayScale(value) {
      if (!(typeof value === 'number') || !(value > 0)) return 1;
      return Math.min(2, Math.max(0.05, value));
    }

    function applyMeasureOverlayScaleFromNav(nav) {
      const raw = nav && typeof nav.measureScale === 'number' ? nav.measureScale : null;
      measureOverlayScale = clampMeasureOverlayScale(raw != null && raw > 0 ? raw : 1);
    }

    function pinHtml(s, color, size) {
      return (
        '<div style="position:absolute;left:' + s.x + 'px;top:' + s.y +
        'px;width:' + size + 'px;height:' + size + 'px;margin:-' + (size / 2) + 'px 0 0 -' + (size / 2) +
        'px;border-radius:50%;background:' + color +
        ';border:2px solid #fff;box-shadow:0 0 8px rgba(0,0,0,0.65);pointer-events:none;"></div>'
      );
    }

    function drawToolOverlay() {
      if (!overlay.isConnected) return;
      if (!viewerHandle) {
        overlay.innerHTML = '';
        return;
      }
      // Draw measure chrome and/or Search Image pin.
      if (!measureMode && !isSurfacePickMode()) {
        overlay.innerHTML = '';
        return;
      }
      const app = viewerHandle.app;
      let html = '';

      if (measureMode) {
        const oscale = measureOverlayScale;
        const strokeW = Math.max(1, 2.5 * oscale);
        const pinSize = Math.max(6, 12 * oscale);
        const pinActive = Math.max(8, 16 * oscale);
        const hoverOuter = Math.max(10, 20 * oscale);
        const hoverInner = Math.max(3, 6 * oscale);
        for (let i = 1; i < measureNodes.length; i++) {
          const node = measureNodes[i];
          if (node.isStartOfChain) continue;
          const a = screenOf(app, measureNodes[i - 1]);
          const b = screenOf(app, node);
          if (!a || !b) continue;
          html +=
            '<div style="position:absolute;left:' + Math.min(a.x, b.x) + 'px;top:' + Math.min(a.y, b.y) +
            'px;width:' + Math.max(1, Math.abs(b.x - a.x)) + 'px;height:' + Math.max(1, Math.abs(b.y - a.y)) +
            'px;pointer-events:none;">' +
            '<svg width="100%" height="100%" style="overflow:visible">' +
            '<line x1="' + (a.x - Math.min(a.x, b.x)) + '" y1="' + (a.y - Math.min(a.y, b.y)) +
            '" x2="' + (b.x - Math.min(a.x, b.x)) + '" y2="' + (b.y - Math.min(a.y, b.y)) +
            '" stroke="rgba(50,230,255,0.95)" stroke-width="' + strokeW + '" />' +
            '</svg></div>';
          if (node.distanceToPrevious != null) {
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            const label = formatMeasureDistance(node.distanceToPrevious);
            html +=
              '<div style="position:absolute;left:' + mx + 'px;top:' + my +
              'px;transform:translate(-50%,-50%);padding:4px 8px;border-radius:999px;' +
              'background:rgba(0,0,0,0.55);color:rgb(51,242,255);font:600 12px Consolas,monospace;' +
              'white-space:nowrap;pointer-events:none;">' + label + '</div>';
          }
        }

        for (let i = 0; i < measureNodes.length; i++) {
          const s = screenOf(app, measureNodes[i]);
          if (!s) continue;
          const active = measureDeleteMode && measureDeleteHoverIndex === i;
          html += pinHtml(s, active ? 'rgb(255,90,90)' : 'rgb(40,220,255)', active ? pinActive : pinSize);
        }

        if (measureHoverScreen) {
          const h = measureHoverScreen;
          html +=
            '<div style="position:absolute;left:' + h.x + 'px;top:' + h.y +
            'px;width:' + hoverOuter + 'px;height:' + hoverOuter + 'px;margin:-' + (hoverOuter / 2) +
            'px 0 0 -' + (hoverOuter / 2) + 'px;border-radius:50%;' +
            'border:2px solid rgba(50,230,255,0.55);pointer-events:none;"></div>' +
            '<div style="position:absolute;left:' + h.x + 'px;top:' + h.y +
            'px;width:' + hoverInner + 'px;height:' + hoverInner + 'px;margin:-' + (hoverInner / 2) +
            'px 0 0 -' + (hoverInner / 2) + 'px;border-radius:50%;' +
            'background:rgba(50,230,255,0.95);pointer-events:none;"></div>';
          const prev = measureNodes[measureNodes.length - 1];
          if (prev && prev.isStartOfChain && !measureDeleteMode) {
            const a = screenOf(app, prev);
            if (a) {
              html +=
                '<div style="position:absolute;left:' + Math.min(a.x, h.x) + 'px;top:' + Math.min(a.y, h.y) +
                'px;width:' + Math.max(1, Math.abs(h.x - a.x)) + 'px;height:' + Math.max(1, Math.abs(h.y - a.y)) +
                'px;pointer-events:none;"><svg width="100%" height="100%" style="overflow:visible">' +
                '<line x1="' + (a.x - Math.min(a.x, h.x)) + '" y1="' + (a.y - Math.min(a.y, h.y)) +
                '" x2="' + (h.x - Math.min(a.x, h.x)) + '" y2="' + (h.y - Math.min(a.y, h.y)) +
                '" stroke="rgba(50,230,255,0.4)" stroke-width="' + Math.max(1, 2 * oscale) +
                '" stroke-dasharray="4 4" /></svg></div>';
            }
          }
        }
      }

      // Search Image / Damage: same cyan HTML pin as Measure (reprojected every frame).
      if (isSurfacePickMode()) {
        const oscale = measureOverlayScale;
        const pinSize = Math.max(6, 12 * oscale);
        if (photoClickFlash) {
          if (performance.now() < photoClickFlash.until) {
            html += pinHtml(
              { x: photoClickFlash.x, y: photoClickFlash.y },
              'rgb(40,220,255)',
              pinSize
            );
          } else {
            photoClickFlash = null;
          }
        }
        if (photoPickPoint) {
          const s = screenOf(app, photoPickPoint);
          if (s) {
            html += pinHtml(s, 'rgb(40,220,255)', pinSize);
          }
        }
      }

      overlay.innerHTML = html;
    }

    // Back-compat alias used by older call sites in this file.
    function drawMeasureOverlay() {
      drawToolOverlay();
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.source !== 'vroomk') return;
      if (data.type === 'setPickMode') setPickMode(data.mode);
      if (data.type === 'setMeasureMode') setMeasureMode(!!data.enabled);
      if (data.type === 'setMeasureDeleteMode') setMeasureDeleteMode(!!data.enabled);
      if (data.type === 'undoMeasure') undoMeasurePoint();
      if (data.type === 'clearMeasure') clearMeasureGeometry();
      if (data.type === 'setMeasureFactor' && typeof data.factor === 'number' && data.factor > 0) {
        measureFactor = data.factor;
      }
      if (data.type === 'setMeasureExact') {
        measureExact = !!data.exact;
        drawMeasureOverlay();
      }
      if (data.type === 'frameScene' && viewerHandle?.frameScene) {
        // Host overview only — never auto-call; orbit framing feels like unwanted top-down.
        try { viewerHandle.frameScene(); } catch (_) {}
      }
      if (data.type === 'resetCamera' && viewerHandle?.resetCamera) {
        try { viewerHandle.resetCamera(); } catch (_) {}
      }
      if (data.type === 'setMacWalk') {
        applyMacWalkControls(
          typeof data.moveSpeed === 'number' && data.moveSpeed > 0
            ? data.moveSpeed
            : window.sse.moveSpeed,
          true
        );
      }
      // Host Electron window forwards WASD/arrows when the iframe lacks focus.
      if ((data.type === 'keyDown' || data.type === 'keyUp') && typeof data.code === 'string') {
        setWalkKey(data.code, data.type === 'keyDown');
        if (typeof data.shiftKey === 'boolean') syncShiftModifier(data.shiftKey);
        else if (data.code === 'ShiftLeft' || data.code === 'ShiftRight') {
          syncShiftModifier(data.type === 'keyDown');
        }
      }
    });

    function ensureWalker(moveSpeed) {
      const speed =
        typeof moveSpeed === 'number' && moveSpeed > 0
          ? moveSpeed
          : typeof window.sse.moveSpeed === 'number' && window.sse.moveSpeed > 0
            ? window.sse.moveSpeed
            : DEFAULT_WALK_SPEED;
      // Raw PLY with no nav.txt → Mac default eye pose, not SuperSplat frameScene blob.
      const navForWalk = hasNavStart() ? sceneNav : macDefaultStartNav();
      if (!walker) {
        walker = createFpsWalkCamera(navForWalk, { moveSpeed: speed });
      } else {
        walker.setMoveSpeed(speed);
      }
      return walker;
    }

    function hasCustomOrientationNav(nav) {
      return !!(nav && nav.orientationUp && nav.orientationForward);
    }

    /**
     * Mac usesCustomOrientation: view matrix skips the common 180 deg Z PLY
     * calibration, so picks/nav/camera stay in model space. SuperSplat always
     * does entity.setLocalEulerAngles(0,0,180) for .ply — undo that here so
     * Search Image / Measure / walk match Mac (Sample 3 TOPDOWN etc.).
     */
    function alignSplatToMacNavigation(app, nav) {
      if (!app || !hasCustomOrientationNav(nav)) return;
      try {
        const comps = app.root.findComponents('gsplat');
        if (!comps || !comps.length) return;
        for (let i = 0; i < comps.length; i++) {
          const ent = comps[i] && comps[i].entity;
          if (!ent) continue;
          ent.setLocalEulerAngles(0, 0, 0);
        }
        kickWalkFrame();
      } catch (err) {
        console.warn('[vroomk] splat orientation align failed', err);
      }
    }

    /** Undo gsplat entity transform → splat-local / Mac model space. */
    function worldToSplatModel(app, worldPoint) {
      try {
        const comps = app.root.findComponents('gsplat');
        const ent = comps && comps[0] && comps[0].entity;
        if (!ent || typeof ent.getWorldTransform !== 'function') {
          return worldPoint;
        }
        const inv = ent.getWorldTransform().clone().invert();
        const tmp = ent.getPosition().clone();
        tmp.set(worldPoint[0], worldPoint[1], worldPoint[2]);
        inv.transformPoint(tmp, tmp);
        return [tmp.x, tmp.y, tmp.z];
      } catch (_) {
        // SuperSplat default PLY orientation is 180° Z ≡ (-x,-y,z).
        return [-worldPoint[0], -worldPoint[1], worldPoint[2]];
      }
    }

    /**
     * Mac photo-search display frame (MetalKitSceneRenderer.handlePointClick):
     *   custom orientation → model pick as-is
     *   else → SplatNavigationSpace.fromModel(model) = (-x,-y,z)
     * Camera from the FPS walker is already in that frame — do not transform it.
     */
    function toMacPhotoPoint(app, worldPick, nav) {
      const model = worldToSplatModel(app, worldPick);
      if (hasCustomOrientationNav(nav)) return model;
      return [-model[0], -model[1], model[2]];
    }

    function applyMacWalkControls(moveSpeed, resetToSpawn) {
      if (!viewerHandle?.state?.loaded) return;
      // Don't steal the cursor while Measure / Search Image need clicks.
      if (toolsNeedCursor()) {
        dragLooking = false;
        return;
      }
      try {
        const state = viewerHandle.state;
        // Kill SuperSplat orbit/pan/WASD — we own first-person walk exclusively.
        state.inputEnabled = false;
        state.gamingControls = false;
        // Prefer fly so SuperSplat doesn't attach capsule gravity; we overwrite the entity.
        state.cameraMode = 'fly';

        alignSplatToMacNavigation(viewerHandle.app, sceneNav);

        const w = ensureWalker(moveSpeed);
        w.setPickMode(false);
        w.setInputBlocked(false);
        if (resetToSpawn) w.resetToStart();
        applyPoseToCamera(w.getPose());
        kickWalkFrame();
      } catch (_) {}
    }

    try {
      const probe = await fetch(window.sse.options.contentUrl, { method: 'HEAD' });
      if (!probe.ok) {
        showError('Could not load the splat file (' + probe.status + '). Close and reopen the project.');
        throw new Error('content ' + probe.status);
      }
    } catch (err) {
      if (!errorEl.textContent) {
        showError('Could not reach the splat file. Close and reopen the project.');
      }
      throw err;
    }

    try {
      const { options, settings } = window.sse;
      sceneNav = await window.sse.sceneNav;
      applyMeasureOverlayScaleFromNav(sceneNav);
      viewerHandle = await createViewer({ container: document.body, settings, ...options });
      document.body.appendChild(overlay);
      document.body.appendChild(sprintHud);
      // Capture splat depth picker (fires after splat load — PlayCanvas/Mac style surface pick).
      viewerHandle.events?.on?.('picker:ready', (picker) => {
        splatPicker = picker;
      });
      post({ type: 'ready' });

      const enterMacWalk = (reset) => {
        applyMacWalkControls(window.sse.moveSpeed, reset);
      };
      viewerHandle.events?.on?.('loaded:changed', (loaded) => {
        if (loaded) {
          enterMacWalk(true);
          post({ type: 'loaded' });
        }
      });
      // Controllers finish wiring slightly after loaded — re-assert FPS walk (no re-spawn).
      setTimeout(() => enterMacWalk(false), 400);
      setTimeout(() => enterMacWalk(false), 1200);

      const WALK_KEYS = new Set([
        'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'ShiftLeft', 'ShiftRight'
      ]);

      // WASD / Q/E / arrows → fps walker. Block SuperSplat "1"/F orbit + frame shortcuts.
      // Use capture on window + document so keys work under pointer-lock and after drag-look.
      function onWalkKeyDown(event) {
        if (!viewerHandle?.state?.loaded) return;
        if (event.ctrlKey || event.altKey || event.metaKey) return;
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
        if (key === '1' || key === 'f' || key === 'F') {
          event.stopPropagation();
          event.preventDefault();
          applyMacWalkControls(window.sse.moveSpeed, false);
          return;
        }
        if (!walker) return;
        if (WALK_KEYS.has(event.code)) {
          setWalkKey(event.code, true);
          syncShiftModifier(event.shiftKey);
          event.preventDefault();
          event.stopPropagation();
        } else if (event.shiftKey && event.key === 'Shift') {
          syncShiftModifier(true);
          event.preventDefault();
        }
      }
      function onWalkKeyUp(event) {
        if (!walker) return;
        if (WALK_KEYS.has(event.code)) {
          setWalkKey(event.code, false);
          syncShiftModifier(event.shiftKey);
          event.preventDefault();
          event.stopPropagation();
        } else if (event.key === 'Shift') {
          syncShiftModifier(false);
          event.preventDefault();
        }
      }
      window.addEventListener('keydown', onWalkKeyDown, true);
      window.addEventListener('keyup', onWalkKeyUp, true);
      document.addEventListener('keydown', onWalkKeyDown, true);
      document.addEventListener('keyup', onWalkKeyUp, true);
      // Stuck keys if focus leaves mid-press (common after drag-look / pointer-lock Esc).
      window.addEventListener('blur', () => {
        if (!walker) return;
        for (const code of WALK_KEYS) setWalkKey(code, false);
      });

      const canvas = viewerHandle.app.graphicsDevice.canvas;
      try {
        canvas.tabIndex = 0;
        canvas.style.outline = 'none';
      } catch (_) {}

      // Default arrow cursor (not grab/hand).
      try {
        canvas.style.cursor = 'default';
      } catch (_) {}

      window.addEventListener('pointermove', (event) => {
        // Measure / Search Image: past drag threshold → look instead of pick.
        if (pendingToolPointer && event.pointerId === pendingToolPointer.pointerId) {
          const dx = event.clientX - pendingToolPointer.x;
          const dy = event.clientY - pendingToolPointer.y;
          if (!dragLooking && Math.hypot(dx, dy) >= TOOL_DRAG_THRESHOLD_PX) {
            dragLooking = true;
            photoClickFlash = null;
            drawToolOverlay();
          }
        }
        if (!walker || !dragLooking) return;
        applyLookFromEvent(event);
      }, true);

      window.addEventListener('pointerdown', (event) => {
        if (event.button === 2) {
          // RMB always drag-look.
          if (event.target === canvas || event.target === document.body) {
            dragLooking = true;
            pendingToolPointer = null;
            try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
            event.preventDefault();
          }
          return;
        }
        if (event.button !== 0) return;
        if (event.detail > 1) return;
        if (measureMode || isSurfacePickMode()) {
          if (event.target !== canvas && event.target !== document.body) return;
          event.preventDefault();
          event.stopPropagation();
          // Defer pick until pointerup — drag looks around instead of placing a point.
          pendingToolPointer = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
            kind: measureMode ? 'measure' : pickMode
          };
          dragLooking = false;
          try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
          try { canvas.focus({ preventScroll: true }); } catch (_) { try { canvas.focus(); } catch (_) {} }
          return;
        }
        // Walk mode: click-drag to look (arrow cursor stays).
        if (event.target === canvas || event.target === document.body) {
          dragLooking = true;
          try { canvas.focus({ preventScroll: true }); } catch (_) { try { canvas.focus(); } catch (_) {} }
          try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
          event.stopPropagation();
        }
      }, true);
      window.addEventListener('pointerup', (event) => {
        if (event.button === 0 || event.button === 2) {
          const pending = pendingToolPointer;
          const wasDragLook = dragLooking;
          pendingToolPointer = null;
          dragLooking = false;
          try { canvas.style.cursor = 'default'; } catch (_) {}
          try { canvas.releasePointerCapture(event.pointerId); } catch (_) {}
          // Click (no drag) while Measure / Search Image / Damage → place / search.
          if (
            event.button === 0 &&
            pending &&
            event.pointerId === pending.pointerId &&
            !wasDragLook
          ) {
            if (pending.kind === 'measure' && measureMode) {
              void handleMeasureClick(pending.x, pending.y);
            } else if (
              (pending.kind === 'photos' || pending.kind === 'damage') &&
              pickMode === pending.kind
            ) {
              runSurfacePickAt(pending.x, pending.y);
            }
          }
        }
      }, true);
      window.addEventListener('pointercancel', () => {
        pendingToolPointer = null;
        dragLooking = false;
        try { canvas.style.cursor = 'default'; } catch (_) {}
      }, true);
      window.addEventListener('contextmenu', (event) => {
        if (event.target === canvas) event.preventDefault();
      }, true);

      window.addEventListener('pointermove', (event) => {
        if (!measureMode || !viewerHandle || dragLooking) return;
        const now = performance.now();
        if (now - lastHoverPick < 40) return;
        lastHoverPick = now;
        measureHoverScreen = { x: event.clientX, y: event.clientY };
        if (measureDeleteMode) {
          let best = null;
          let bestD = 28 * measureOverlayScale;
          for (let i = 0; i < measureNodes.length; i++) {
            const s = measureNodes[i].screen;
            if (!s) continue;
            const d = Math.hypot(s.x - event.clientX, s.y - event.clientY);
            if (d <= bestD) { bestD = d; best = i; }
          }
          measureDeleteHoverIndex = best;
          measureHover = best != null ? measureNodes[best].position : null;
          drawToolOverlay();
          return;
        }
        const req = ++pickRequestId;
        const cx = event.clientX;
        const cy = event.clientY;
        void pickWorldPoint(viewerHandle.app, cx, cy).then((result) => {
          if (req !== pickRequestId || !measureMode) return;
          if (!result) {
            measureHover = null;
            measureDeleteHoverIndex = null;
          } else {
            measureHover = result.point;
            measureDeleteHoverIndex = null;
          }
          drawToolOverlay();
          kickWalkFrame();
        });
      }, true);

      // Drive FPS walk after SuperSplat's camera update (registered later → runs later).
      // SuperSplat disables autoRender after load — keep requesting frames while keys are held.
      viewerHandle.app.on('update', (dt) => {
        if (walker && viewerHandle?.state?.loaded) {
          applyPoseToCamera(walker.update(Math.min(0.05, Math.max(0, dt))));
          if (walker.hasMovementInput()) kickWalkFrame();
          syncSprintHud();
        } else if (sprintHud) {
          sprintHud.style.display = 'none';
        }
        // Reproject Measure / Search Image HTML pins whenever a frame runs.
        if (
          measureMode ||
          (isSurfacePickMode() && (photoPickPoint || photoClickFlash))
        ) {
          drawToolOverlay();
        }
      });
      // Apply again on prerender so we win over SuperSplat's Y-up setEulerAngles.
      viewerHandle.app.on('prerender', () => {
        if (walker && viewerHandle?.state?.loaded) {
          applyPoseToCamera(walker.getPose());
        }
      });

      post({ type: 'bridge-ready' });
    } catch (err) {
      console.error(err);
      showError(err && err.message ? err.message : 'Viewer failed to start.');
    }
  </script>
</body>
</html>`
}

export function createPaymentSession(session: PaymentSession): string {
  if (!origin) throw new Error('Media server is not running')
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  paymentSessions.set(id, session)
  // Drop after 30 minutes.
  setTimeout(() => paymentSessions.delete(id), 30 * 60 * 1000).unref?.()
  return `${origin}/stripe-pay/${encodeURIComponent(id)}`
}

function escapeJs(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function stripePaymentHtml(session: PaymentSession): string {
  const pk = escapeJs(session.publishableKey)
  const secret = escapeJs(session.clientSecret)
  const amount = escapeHtml(session.amountDisplay)
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <script src="https://js.stripe.com/v3/"></script>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 16px;
      font-family: "Segoe UI", sans-serif;
      background: transparent; color: rgba(255,255,255,0.9);
    }
    h2 { font-weight: 500; font-size: 16px; margin: 0 0 6px; }
    p { margin: 0 0 16px; font-size: 13px; color: rgba(255,255,255,0.45); }
    #card-element {
      padding: 14px 12px;
      border-radius: 10px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
    }
    #pay {
      margin-top: 16px; width: 100%; height: 40px;
      border: none; border-radius: 999px; cursor: pointer;
      background: rgba(255,255,255,0.12);
      color: white; font-size: 14px; font-weight: 500;
    }
    #pay:disabled { opacity: 0.5; cursor: default; }
    #error { margin-top: 12px; color: #f28c85; font-size: 13px; min-height: 18px; }
  </style>
</head>
<body>
  <h2>Pay ${amount} advance</h2>
  <p>Secure card payment for your on-site scan booking.</p>
  <div id="card-element"></div>
  <button id="pay" type="button">Pay ${amount}</button>
  <div id="error"></div>
  <script>
    const stripe = Stripe("${pk}");
    const elements = stripe.elements();
    const card = elements.create("card", {
      hidePostalCode: true,
      style: {
        base: {
          color: "#ffffff",
          fontFamily: "Segoe UI, sans-serif",
          fontSize: "15px",
          "::placeholder": { color: "rgba(255,255,255,0.35)" }
        },
        invalid: { color: "#f28c85" }
      }
    });
    card.mount("#card-element");
    const payBtn = document.getElementById("pay");
    const errorEl = document.getElementById("error");
    function post(payload) {
      parent.postMessage({ source: "vroomk-booking", ...payload }, "*");
    }
    payBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      payBtn.disabled = true;
      payBtn.textContent = "Processing…";
      try {
        const result = await stripe.confirmCardPayment("${secret}", {
          payment_method: { card: card }
        });
        if (result.error) {
          errorEl.textContent = result.error.message || "Payment failed.";
          post({ type: "error", message: result.error.message || "Payment failed." });
          payBtn.disabled = false;
          payBtn.textContent = "Pay ${amount}";
          return;
        }
        const pi = result.paymentIntent;
        if (pi && pi.status === "succeeded") {
          post({ type: "success", paymentIntentId: pi.id });
          payBtn.textContent = "Paid";
        } else {
          const msg = "Payment was not completed.";
          errorEl.textContent = msg;
          post({ type: "error", message: msg });
          payBtn.disabled = false;
          payBtn.textContent = "Pay ${amount}";
        }
      } catch (e) {
        const msg = (e && e.message) ? e.message : "Payment failed.";
        errorEl.textContent = msg;
        post({ type: "error", message: msg });
        payBtn.disabled = false;
        payBtn.textContent = "Pay ${amount}";
      }
    });
  </script>
</body>
</html>`
}
