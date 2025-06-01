import numeral from 'numeral'

/**
 * Formatter for common strings in the application.
 */
export class Formatter {
  static currency = (value: number | string | undefined, decimals: number = 2) => {
    const formatString = `$0,0.${'0'.repeat(decimals)}`

    return numeral(value ?? 0).format(formatString)
  }

  static tvlShort = (value: number | string | undefined) => {
    return numeral(value).format('0a')?.toUpperCase()
  }
  static tvl = (value: number | string | undefined) => {
    return numeral(value).format('0,0')
  }

  static percent = (value: number | string | undefined, decimals: number = 2) => {
    if (!value || value === '.') return '0%'

    const format = `0,0.${Array(decimals).fill(0).join('')}%`
    return numeral(value)?.divide(100).format(format, Math.floor)
  }

  static priceDynamicDecimals = (value: number | string | undefined, maxDecimals: number = 6) => {
    if (value === undefined || value === null || value === '') return '-';
    const numValue = typeof value === 'string' ? Number(value) : value;
    if (isNaN(numValue)) return '-';
    // Convert to string with maxDecimals, then trim trailing zeros and possible trailing dot
    return numValue
      .toFixed(maxDecimals)
      .replace(/(\.[0-9]*[1-9])0+$/,'$1') // Remove trailing zeros after last non-zero
      .replace(/\.0+$/, '') // Remove trailing .0 or .000...
  }
}
