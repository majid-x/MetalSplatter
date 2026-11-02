# Chunk 7 — Project → viewer end-to-end

**Date:** 2026-10-29  
**Status:** complete

## Done

- Package open prefers the largest splat model when several exist
- Finds `nav.txt` / `navigation.txt` / `scene-nav.txt` and applies start camera into SuperSplat settings
- Finds collision `glb`/`gltf` (preferred names first) and passes `?collision=` to SuperSplat
- Cached projects skip the download phase and go straight to prepare/open
- Viewer chrome shows Nav start / Walk collision chips when those assets are present

## Run

Restart `npm run dev`, then open a project from the dashboard.
