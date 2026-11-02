import { measurementPrefs } from './measurementPrefs'

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return Math.max(x, 1)
}

/** Imperial distance: `feet' inches fraction"` — matches MacApp Measure labels. */
export function formatMeasureDistance(meters: number, exact = measurementPrefs.showExactMeasurements): string {
  const totalFeet = meters * 3.280839895
  let feet = Math.floor(totalFeet)
  const remainingInches = (totalFeet - feet) * 12
  let inches = Math.floor(remainingInches)
  const fractionOfInch = remainingInches - inches

  const denominator = exact ? 32 : 4
  let numerator = Math.round(fractionOfInch * denominator)
  if (numerator === denominator) {
    numerator = 0
    inches += 1
  }
  if (inches >= 12) {
    inches -= 12
    feet += 1
  }

  let fractionStr = ''
  if (numerator > 0) {
    const divisor = gcd(numerator, denominator)
    fractionStr = ` ${numerator / divisor}/${denominator / divisor}`
  }

  return `${feet}' ${inches}${fractionStr}"`
}
