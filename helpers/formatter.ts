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
}
