import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { registerAuthStorageIpc } from './authStorage'
import { registerBookingProxyIpc } from './bookingProxy'
import { registerDamageIpc } from './deepseekDamage'
import { registerHttpProxyIpc } from './httpProxy'
import { loadEnvFile } from './loadEnv'
import { registerProjectDownloadIpc } from './projectDownloadIpc'
import {
  buildViewerUrl,
  createPaymentSession,
  getMediaServerOrigin,
  startMediaServer,
  stopMediaServer
} from './mediaServer'
import { CAPTURE_CHANNELS, type CaptureRegionRequest } from '../shared/captureChannels'
import { handle } from './ipc'
import { PAYMENT_CHANNELS } from '../shared/paymentChannels'
import { VIEWER_CHANNELS } from '../shared/viewerChannels'

let windowCreated = false

function registerIpc(): void {
  loadEnvFile()
  registerAuthStorageIpc()
  registerProjectDownloadIpc()
  registerBookingProxyIpc()
  registerHttpProxyIpc()
  registerDamageIpc()

  handle(VIEWER_CHANNELS.origin, async () => getMediaServerOrigin())
  handle(VIEWER_CHANNELS.buildUrl, async (_event, options) => buildViewerUrl(options))
  handle(PAYMENT_CHANNELS.createSession, async (_event, payload) => createPaymentSession(payload))
  handle(CAPTURE_CHANNELS.region, async (event, region: CaptureRegionRequest): Promise<string> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window to capture.')
    const x = Math.max(0, Math.round(region.x))
    const y = Math.max(0, Math.round(region.y))
    const width = Math.max(1, Math.round(region.width))
    const height = Math.max(1, Math.round(region.height))
    const image = await win.capturePage({ x, y, width, height })
    return image.toDataURL()
  })
  handle(CAPTURE_CHANNELS.save, async (event, dataUrl: string): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showSaveDialog(win, {
          title: 'Save Screenshot',
          defaultPath: 'vroomk-screenshot.png',
          filters: [{ name: 'PNG Image', extensions: ['png'] }]
        })
      : await dialog.showSaveDialog({
          title: 'Save Screenshot',
          defaultPath: 'vroomk-screenshot.png',
          filters: [{ name: 'PNG Image', extensions: ['png'] }]
        })
    if (result.canceled || !result.filePath) return false
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '')
    await writeFile(result.filePath, Buffer.from(base64, 'base64'))
    return true
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'Vroomk',
    icon: join(__dirname, '../../assets/logo2.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function boot(createIfNeeded: boolean): Promise<void> {
  registerIpc()

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // pointerLock is required for FPS mouse-look inside the SuperSplat iframe.
    callback(
      permission === 'pointerLock' ||
        permission === 'fullscreen' ||
        permission === 'geolocation' ||
        permission === 'media' ||
        permission === 'notifications'
    )
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return (
      permission === 'pointerLock' ||
      permission === 'fullscreen' ||
      permission === 'geolocation' ||
      permission === 'media' ||
      permission === 'notifications'
    )
  })

  await startMediaServer()

  if (createIfNeeded && !windowCreated) {
    createWindow()
    windowCreated = true
  }
}

app.whenReady().then(async () => {
  await boot(true)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowCreated = false
      createWindow()
      windowCreated = true
    }
  })
})

// electron-vite main HMR re-evaluates this module while the app is already ready.
if (app.isReady()) {
  void boot(false)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopMediaServer()
    app.quit()
  }
})
