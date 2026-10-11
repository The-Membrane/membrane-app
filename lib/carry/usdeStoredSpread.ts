const LEG = {
  chainId: 1,
  borrowProtocol: 'Aave V3 Core',
  borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  borrowAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  destinationKind: 'ERC4626',
} as const

const RAW = /^(0|[1-9]\d*)$/
const HEX32 = /^0x[0-9a-f]{64}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60
const MAX_BLOCK_AGE_MS = 2 * 60 * 60 * 1000
const RAY = 10n ** 27n
function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const millis = Date.parse(value)
  return Number.isSafeInteger(millis) && new Date(millis).toISOString() === value ? millis : null
}

/** DB JSON can be stale/corrupt: recompute the collector's exact two-leg math. */
export function validStoredUsdeSpread(
  data: Record<string, unknown>,
  block: number,
  observedAt: string,
) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (!data.leg || typeof data.leg !== 'object' || Array.isArray(data.leg)) return false
  const leg = data.leg as Record<string, unknown>
  if (Object.keys(leg).length !== Object.keys(LEG).length) return false
  for (const [key, value] of Object.entries(LEG)) if (leg[key] !== value) return false
  if (
    data.schemaVersion !== 1 ||
    data.measurement !==
      'current_aave_variable_borrow_apy_vs_trailing_seven_day_susde_share_growth_apy' ||
    data.claim !== 'modeled_two_leg_spread_not_cohort_realized_return' ||
    data.rateConvention !==
      'effective APY as decimal fraction; incentives, gas, and exit costs excluded' ||
    typeof data.variableDebtToken !== 'string' ||
    !ADDRESS.test(data.variableDebtToken) ||
    /^0x0+$/.test(data.variableDebtToken) ||
    typeof data.artifactSha256 !== 'string' ||
    !SHA256.test(data.artifactSha256) ||
    typeof data.manifestSha256 !== 'string' ||
    !SHA256.test(data.manifestSha256) ||
    data.currentBlockNumber !== String(block) ||
    typeof data.currentBlockHash !== 'string' ||
    !HEX32.test(data.currentBlockHash) ||
    typeof data.priorBlockNumber !== 'string' ||
    !RAW.test(data.priorBlockNumber) ||
    data.priorBlockNumber.length > 15 ||
    typeof data.priorBlockHash !== 'string' ||
    !HEX32.test(data.priorBlockHash) ||
    data.currentBlockTimestamp !== observedAt ||
    !Number.isSafeInteger(data.lookbackSeconds) ||
    (data.lookbackSeconds as number) < LOOKBACK_SECONDS ||
    (data.lookbackSeconds as number) > LOOKBACK_SECONDS + 3600 ||
    !Number.isSafeInteger(data.collectionElapsedMs) ||
    (data.collectionElapsedMs as number) < 0 ||
    !Number.isSafeInteger(data.ageSecondsAtCapture) ||
    (data.ageSecondsAtCapture as number) < 0 ||
    (data.ageSecondsAtCapture as number) > MAX_BLOCK_AGE_MS / 1000 ||
    data.shareUnitRaw !== '1000000000000000000' ||
    data.assetDecimals !== 18 ||
    data.shareDecimals !== 18 ||
    typeof data.currentVariableBorrowRateRayRaw !== 'string' ||
    !RAW.test(data.currentVariableBorrowRateRayRaw) ||
    data.currentVariableBorrowRateRayRaw.length > 78 ||
    typeof data.currentAssetsPerShareUnitRaw !== 'string' ||
    !RAW.test(data.currentAssetsPerShareUnitRaw) ||
    data.currentAssetsPerShareUnitRaw.length > 78 ||
    typeof data.priorAssetsPerShareUnitRaw !== 'string' ||
    !RAW.test(data.priorAssetsPerShareUnitRaw) ||
    data.priorAssetsPerShareUnitRaw.length > 78 ||
    ![data.borrowApy, data.yieldApy, data.spread].every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  )
    return false

  const currentAt = timestamp(data.currentBlockTimestamp)
  const priorAt = timestamp(data.priorBlockTimestamp)
  const startedAt = timestamp(data.collectionStartedAt)
  const capturedAt = timestamp(data.capturedAt)
  if (
    currentAt === null ||
    priorAt === null ||
    startedAt === null ||
    capturedAt === null ||
    (currentAt - priorAt) / 1000 !== data.lookbackSeconds ||
    capturedAt - startedAt !== data.collectionElapsedMs ||
    capturedAt - currentAt < -120_000 ||
    capturedAt - currentAt > MAX_BLOCK_AGE_MS ||
    data.ageSecondsAtCapture !== Math.max(0, Math.floor((capturedAt - currentAt) / 1000)) ||
    BigInt(data.priorBlockNumber as string) >= BigInt(data.currentBlockNumber as string)
  )
    return false

  const currentQuote = BigInt(data.currentAssetsPerShareUnitRaw as string)
  const priorQuote = BigInt(data.priorAssetsPerShareUnitRaw as string)
  if (currentQuote <= 0n || priorQuote <= 0n) return false
  // Mirror scripts/route-rates/exact-leg-spread.mjs rather than importing
  // Node-only collector code into a Next API module.
  const apr = Number(BigInt(data.currentVariableBorrowRateRayRaw as string)) / Number(RAY)
  if (!Number.isFinite(apr) || apr < 0) return false
  const borrowApy = Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR))
  const ratio = Number((currentQuote * 10n ** 15n) / priorQuote) / 1e15
  if (!Number.isFinite(ratio) || ratio <= 0) return false
  const yieldApy = Math.expm1(
    (Math.log(ratio) * SECONDS_PER_YEAR) / (data.lookbackSeconds as number),
  )
  return (
    Number.isFinite(borrowApy) &&
    Number.isFinite(yieldApy) &&
    data.borrowApy === borrowApy &&
    data.yieldApy === yieldApy &&
    data.spread === yieldApy - borrowApy
  )
}
