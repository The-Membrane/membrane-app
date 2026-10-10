const MAX_BLOCK_AGE_MS = 45 * 60_000
const MAX_FUTURE_SKEW_MS = 2 * 60_000

export function isApyUsdOpenReceiptBlockFreshAt(timestampSeconds: number, nowMs: number): boolean {
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    timestampSeconds <= 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  )
    return false
  const ageMs = nowMs - timestampSeconds * 1000
  return ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= MAX_BLOCK_AGE_MS
}

export function apyUsdOpenReceiptBlockExpiresAt(timestampSeconds: number): number {
  return timestampSeconds * 1000 + MAX_BLOCK_AGE_MS
}
