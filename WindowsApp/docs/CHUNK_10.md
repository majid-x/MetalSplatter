# Chunk 10 — Skipped Mac parity items

Adds Windows features that were deferred after chunks 1–9:

1. **In-app Privacy Policy** — full policy body in Settings (not just the web link)
2. **Booking coverage map** — rate + 60 mi radius map beside location step
3. **Screenshot crop** — “Select from view” drag overlay → product search
4. **Full nav.txt parse** — start, collision layers, stairs, blocks, orientation, settings/top-down; summary chips in the viewer
5. **SuperSplat click bridge** — pick world points for photo search and two-point measure

Still not ported (by design / engine limits):

- Native Metal walk/stairs clamping (SuperSplat uses GLB collision when present)
- iOS orientation lock
- App installer packaging
