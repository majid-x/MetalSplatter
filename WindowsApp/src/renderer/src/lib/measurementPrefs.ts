const KEY = 'vroomk.showExactMeasurements'

export const measurementPrefs = {
  get showExactMeasurements(): boolean {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  },
  set showExactMeasurements(value: boolean) {
    try {
      localStorage.setItem(KEY, value ? '1' : '0')
    } catch {
      // ignore
    }
  }
}
