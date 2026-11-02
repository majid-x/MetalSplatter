# Chunk 2 — Electron + React + TypeScript scaffold

**Date:** 2026-10-29  
**Status:** complete  
**Stack:** Electron + electron-vite + React 19 + TypeScript

## Done

- `package.json` with `dev` / `build` / `preview` / `typecheck`
- Main process: `src/main/index.ts` (1280×820 window, preload, CSP-ready)
- Preload bridge: `src/preload/index.ts` → `window.avgs`
- Renderer: React app placeholder in `src/renderer/`
- Typecheck + production build verified

## Run

```bash
cd WindowsApp
npm install
npm run dev
```

## Next (Chunk 3)

Auth screen + Supabase session (parity with MacApp login/signup).
