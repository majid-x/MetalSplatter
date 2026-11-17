/**
 * Build-time feature flags (inlined by electron-vite `define`).
 * Production / MSIX Vroomk → damage off.
 * Local `dev` and `--mode damage` (Vroomk Test) → damage on.
 */
declare const __VROOMK_DAMAGE_ESTIMATION__: boolean | undefined

export const DAMAGE_ESTIMATION_ENABLED: boolean =
  typeof __VROOMK_DAMAGE_ESTIMATION__ !== 'undefined'
    ? Boolean(__VROOMK_DAMAGE_ESTIMATION__)
    : true
