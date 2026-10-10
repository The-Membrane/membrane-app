// A scheduler issue needs a new, sufficiently fresh current receipt from this
// invocation. The ledger's own two-hour source cap is deliberately broader.
import { readFileSync } from 'node:fs'

export const MAX_SOURCE_AGE_MS = 60 * 60 * 1000

export function validCurrentCapture(payload, nowMs = Date.now()) {
  if (
    payload?.mode !== 'current' ||
    payload.skipped !== 0 ||
    !Array.isArray(payload.captures) ||
    payload.captures.length !== 1
  )
    return false
  const capture = payload.captures[0]
  const sourceMs = Date.parse(capture?.anchorAt)
  return (
    capture?.status === 'recorded' &&
    typeof capture.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(capture.sha256) &&
    Number.isFinite(sourceMs) &&
    sourceMs <= nowMs &&
    nowMs - sourceMs <= MAX_SOURCE_AGE_MS
  )
}

if (process.argv[1]?.endsWith('/carryLocalCashTickGate.mjs')) {
  if (process.argv.length !== 3) process.exit(2)
  try {
    process.exit(validCurrentCapture(JSON.parse(readFileSync(process.argv[2], 'utf8'))) ? 0 : 1)
  } catch {
    process.exit(1)
  }
}
