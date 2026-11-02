# Chunk 6 — SuperSplat viewer + Vroomk branding

**Date:** 2026-10-29  
**Status:** complete

## Done

- App title / package branding set to **Vroomk**
- Local media server serves SuperSplat Viewer (`@playcanvas/supersplat-viewer`) + project files under `PrivateProjects`
- After download/unpack, project opens in an embedded SuperSplat iframe (`webgl` mode)
- Content URLs preserve the real `.ply` / `.splat` / `.spz` filename for format detection

## Run

```bash
cd WindowsApp
npm run dev
```

Open a project from the dashboard to download (if needed) and view in SuperSplat.
