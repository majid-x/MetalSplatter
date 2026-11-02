# MacApp → WindowsApp porting map

Source of truth: `MacApp/MacApp/`.

## App flow

```
MacAppApp → ContentView
  ├─ bootstrapping spinner
  ├─ AuthView (if signed out)
  └─ DashboardView (if signed in)
       ├─ Projects tab → ProjectViewerView → ClientSceneView (Metal)
       ├─ Booking tab → BookingView
       └─ Settings tab → SettingsView
```

Windows target flow:

```
Electron main → React app
  ├─ bootstrapping
  ├─ Auth
  └─ Dashboard
       ├─ Projects → ProjectViewer → SuperSplat (WebView / iframe)
       ├─ Booking
       └─ Settings
```

## Feature → file map

| Mac feature | Mac sources | Windows target (planned) |
|---|---|---|
| App entry | `MacAppApp.swift` | `src/main` (Electron) + `src/renderer` root |
| Auth gate | `ContentView.swift`, `AuthManager.swift` | `src/auth/*` |
| Auth storage | `FileAuthLocalStorage.swift` | electron-store / local file via main process |
| Supabase | `SupabaseConfig.swift`, `AccountAPIClient.swift` | `src/lib/supabase.ts` |
| Dashboard | `DashboardView.swift` | `src/dashboard/*` |
| Projects list | `ProjectLibrary.swift`, `RemoteProject.swift` | `src/projects/*` |
| Download / cache | `ProjectDownloadManager.swift`, `ProjectDownloadStore.swift`, `SandboxedZipExtractor.swift` | `src/downloads/*` + main-process FS |
| Scene viewer | `ProjectViewerView.swift`, `ClientSceneView.swift`, `Viewer/*` (Metal) | `viewer/` SuperSplat embed |
| Booking | `BookingView.swift`, `BookingAPIClient.swift`, `BookingModels.swift`, map/payment webviews | `src/booking/*` |
| Settings / legal | `SettingsView.swift`, `AppLegal.swift`, `PrivacyPolicyView.swift` | `src/settings/*`, `assets/privacy.html` |
| Product / photo search | `ProductSearch*`, `Viewer/PhotoSearch*` | later chunk; bridge into SuperSplat UI if needed |
| Measure / navigation | `MeasureOverlayRenderer`, `SceneNavigationData`, collision/stairs | SuperSplat tools + custom overlays where needed |

## Viewer decision

MacApp uses **Metal** (`MetalKitSceneRenderer`, splat renderers).

WindowsApp uses **SuperSplat** in `viewer/`:

- Load the same project package contents the Mac app unpacks (PLY / SPZ / splat assets as supported by SuperSplat).
- Host SuperSplat inside the Electron renderer (iframe or dedicated BrowserView).
- Bridge: React ↔ SuperSplat for “open file / set camera / measure hooks” as we need them.

## Config to reuse (do not commit secrets differently)

MacApp currently uses:

- Supabase URL + publishable key in `SupabaseConfig.swift`
- Booking / product / photo API clients with their own base URLs

Windows will read the same values from env / a local config module (Chunk 3).

## Out of scope for early chunks

- App Store / MSIX packaging polish
- Full parity of every Metal-only navigation/collision nuance
- iOS-only orientation lock
