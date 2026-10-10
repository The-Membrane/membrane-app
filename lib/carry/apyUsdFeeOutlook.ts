const WAD = 10n ** 18n
const MAX_FEE = 5n * 10n ** 16n
const MAX_DURATION = 90 * 86_400

export type ApyUsdFeeCurve = {
  minFeeWad: string
  maxFeeWad: string
  minDurationSeconds: number
  maxDurationSeconds: number
  curvatureWad: string
}

export type ApyUsdNetOutlook = {
  feeRateWad: string
  feeRaw: string
  netRaw: string
}

export function validApyUsdFeeCurve(curve: ApyUsdFeeCurve): boolean {
  try {
    const min = BigInt(curve.minFeeWad)
    const max = BigInt(curve.maxFeeWad)
    const curvature = BigInt(curve.curvatureWad)
    return (
      min >= 0n &&
      max >= min &&
      max <= MAX_FEE &&
      Number.isSafeInteger(curve.minDurationSeconds) &&
      curve.minDurationSeconds > 0 &&
      Number.isSafeInteger(curve.maxDurationSeconds) &&
      curve.maxDurationSeconds > curve.minDurationSeconds &&
      curve.maxDurationSeconds <= MAX_DURATION &&
      curvature >= WAD / 10n &&
      curvature <= 10n * WAD
    )
  } catch {
    return false
  }
}

/** Exact onchain integer arithmetic for linear/quadratic curves and both endpoints. */
export function projectApyUsdNet(
  escrowRaw: string,
  elapsedSeconds: number,
  curve: ApyUsdFeeCurve,
): ApyUsdNetOutlook | null {
  if (
    !validApyUsdFeeCurve(curve) ||
    !/^(0|[1-9][0-9]*)$/.test(escrowRaw) ||
    !Number.isSafeInteger(elapsedSeconds) ||
    elapsedSeconds < 0
  )
    return null
  const assets = BigInt(escrowRaw)
  const min = BigInt(curve.minFeeWad)
  const max = BigInt(curve.maxFeeWad)
  const curvature = BigInt(curve.curvatureWad)
  let rate: bigint
  if (elapsedSeconds >= curve.maxDurationSeconds) rate = min
  else if (elapsedSeconds <= curve.minDurationSeconds) rate = max
  else {
    const tHat =
      (BigInt(elapsedSeconds - curve.minDurationSeconds) * WAD) /
      BigInt(curve.maxDurationSeconds - curve.minDurationSeconds)
    let power: bigint
    if (curvature === WAD) power = tHat
    else if (curvature === 2n * WAD) power = (tHat * tHat) / WAD
    else return null
    rate = max - ((max - min) * power) / WAD
  }
  const fee = (assets * rate + WAD - 1n) / WAD
  return { feeRateWad: rate.toString(), feeRaw: fee.toString(), netRaw: (assets - fee).toString() }
}
