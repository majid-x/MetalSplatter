# Chunk 5 — Project download + unpack

**Date:** 2026-10-29  
**Status:** complete

## Done

- Private local store under Electron `userData/PrivateProjects/<projectId>/`
- Main-process downloader with progress events (stoppable)
- Zip extract via `extract-zip`; finds `.ply` / `.splat` / `.spz` (+ optional `nav.txt`)
- Project viewer overlay: downloading → unpacking → package ready
- Project cards: offline badge, live progress, stop / delete local copy
- Toolbar storage usage; orphan cache cleanup after library refresh
- Account delete wipes local project caches

## Note

SuperSplat embed is Chunk 6 — ready state currently shows resolved model paths.

## Run

```bash
cd WindowsApp
npm run dev
```
