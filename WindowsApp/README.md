# Vroomk (Windows)

Windows port of `MacApp` — branded **Vroomk**, with **SuperSplat** as the 3D Gaussian splat viewer (instead of Metal / MetalSplatter).

## Goal

Ship a Windows desktop app that mirrors MacApp’s product flow:

1. Auth (Supabase sign-in / sign-up / password reset)
2. Dashboard — Projects / Booking / Settings
3. Project download + unpack into local app storage
4. Open project in an embedded **SuperSplat** viewer
5. Supporting features (photo search, product search, measure prefs, privacy) ported in later chunks

## Folder layout

```
WindowsApp/
  README.md
  docs/
  src/
    main/            ← Electron main process
    preload/         ← contextBridge (window.avgs)
    renderer/        ← React UI
  viewer/            ← SuperSplat embed / bridge (later)
  assets/
```

## Stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron + electron-vite |
| UI | React 19 + TypeScript |
| Auth / data | Supabase JS (Chunk 3) |
| Viewer | SuperSplat (`@playcanvas/supersplat-viewer`) |

## Run

```bash
cd WindowsApp
npm install
npm run dev
```

## Build chunks

| Chunk | Deliverable | Status |
|---|---|---|
| **1** | Create `WindowsApp/` + porting plan | **done** |
| **2** | Electron + React + TS scaffold; blank window boots | **done** |
| **3** | Auth screen + Supabase session (parity with MacApp login/signup) | **done** |
| **4** | Dashboard shell (Projects / Booking / Settings tabs) | **done** |
| **5** | Project library + download/unpack into local storage | **done** |
| **6** | Embed SuperSplat viewer; open a local splat package | **done** |
| **7** | Wire project → viewer end-to-end | **done** |
| **8** | Booking / Settings / extras (photo search, measure, etc.) | **done** |
| **9** | Viewer extras: photo search, product search, measure | **done** |
| **10** | Skipped Mac parity: privacy body, coverage map, screenshot crop, full nav parse, click-to-pick | **done** |

We do **one chunk at a time**. After each chunk, we stop for your review before starting the next.
