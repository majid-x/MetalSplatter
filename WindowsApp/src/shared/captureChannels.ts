export const CAPTURE_CHANNELS = {
  region: 'avgs:capture:region',
  save: 'avgs:capture:save'
} as const

export type CaptureRegionRequest = {
  /** DIP coordinates relative to the BrowserWindow content area. */
  x: number
  y: number
  width: number
  height: number
}
