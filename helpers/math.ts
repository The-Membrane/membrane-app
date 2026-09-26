import BigNumber from 'bignumber.js'

export const shiftDigits = (
  value: string | number | undefined = 0,
  places: number,
  decimalPlaces: number = 6,
) => {
  try {
    const shifted = new BigNumber(value)?.shiftedBy(places).decimalPlaces(decimalPlaces)
    // BigNumber does not throw on unparseable input — it yields NaN — so the
    // catch below never fired and NaN propagated into balances and LTVs as
    // "NaN". Fall back to the zero this function always meant to return.
    return shifted.isNaN() ? new BigNumber(0) : shifted
  } catch (e) {
    return new BigNumber(0)
  }
}

export const sum = (...args: string[]) => {
  return args.reduce((prev, cur) => prev.plus(cur), new BigNumber(0))
}
