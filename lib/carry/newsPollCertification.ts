import { rssUrl } from '@/scripts/fetch-venue-news.mjs'
import { MAX_PER_RUN, sourceIdentity } from '@/scripts/lib/newsPollLedger.mjs'

// The native venue-observations job runs hourly. One missed mirror cannot
// keep an earlier receipt looking current for multiple scheduled cycles.
const MAX_AGE_MS = 90 * 60 * 1_000
const FUTURE_SKEW_MS = 5 * 60 * 1_000
const MAX_POLL_DURATION_MS = 10 * 60 * 1_000

type Receipt = {
  venue?: unknown
  receiptVersion?: unknown
  status?: unknown
  coverageStatus?: unknown
  source?: { kind?: unknown; querySha256?: unknown; urlSha256?: unknown }
  startedAtUtc?: unknown
  endedAtUtc?: unknown
  feedItemCount?: unknown
  parsedItemCount?: unknown
  parsedItemIdentitySha256s?: unknown
}

export function certifyNewsPoll(
  receipt: Receipt | undefined,
  sourceId: string,
  query: string,
  nowMs: number,
):
  | { status: 'unavailable'; identities: [] }
  | {
      status: 'items'
      coverage: 'observed_items' | 'latest_items_only'
      observedAt: string
      identities: string[]
    } {
  const unavailable: { status: 'unavailable'; identities: [] } = {
    status: 'unavailable',
    identities: [],
  }
  if (!receipt || !Number.isSafeInteger(nowMs) || nowMs < 0) return unavailable
  const expected = sourceIdentity(query, rssUrl(query))
  const coverage =
    receipt.coverageStatus === 'observed_below_cap'
      ? ('observed_items' as const)
      : receipt.coverageStatus === 'at_or_over_cap'
        ? ('latest_items_only' as const)
        : null
  const startedAt =
    typeof receipt.startedAtUtc === 'string' ? Date.parse(receipt.startedAtUtc) : NaN
  const endedAt = typeof receipt.endedAtUtc === 'string' ? Date.parse(receipt.endedAtUtc) : NaN
  if (
    receipt.venue !== sourceId ||
    receipt.receiptVersion !== 3 ||
    receipt.status !== 'success' ||
    coverage === null ||
    receipt.source?.kind !== expected.kind ||
    receipt.source.querySha256 !== expected.querySha256 ||
    receipt.source.urlSha256 !== expected.urlSha256 ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt) ||
    new Date(startedAt).toISOString() !== receipt.startedAtUtc ||
    new Date(endedAt).toISOString() !== receipt.endedAtUtc ||
    startedAt > endedAt ||
    startedAt < nowMs - MAX_AGE_MS ||
    startedAt > nowMs + FUTURE_SKEW_MS ||
    endedAt - startedAt > MAX_POLL_DURATION_MS ||
    endedAt < nowMs - MAX_AGE_MS ||
    endedAt > nowMs + FUTURE_SKEW_MS ||
    !Number.isInteger(receipt.feedItemCount) ||
    !Number.isInteger(receipt.parsedItemCount) ||
    (receipt.feedItemCount as number) < (receipt.parsedItemCount as number) ||
    (receipt.parsedItemCount as number) > MAX_PER_RUN ||
    !Array.isArray(receipt.parsedItemIdentitySha256s) ||
    receipt.parsedItemIdentitySha256s.length !== receipt.parsedItemCount ||
    new Set(receipt.parsedItemIdentitySha256s).size !== receipt.parsedItemCount ||
    receipt.parsedItemIdentitySha256s.some(
      (identity) => typeof identity !== 'string' || !/^[0-9a-f]{64}$/.test(identity),
    ) ||
    (coverage === 'observed_items' &&
      (receipt.feedItemCount !== receipt.parsedItemCount ||
        (receipt.feedItemCount as number) >= MAX_PER_RUN)) ||
    (coverage === 'latest_items_only' &&
      ((receipt.feedItemCount as number) < MAX_PER_RUN || receipt.parsedItemCount !== MAX_PER_RUN))
  )
    return unavailable
  // An empty Google News feed has no headline identity to show and does not
  // establish venue quiet. In particular, production cannot mistake an old
  // mirrored empty poll for evidence of the latest native poll.
  if (receipt.parsedItemCount === 0) return unavailable
  return {
    status: 'items',
    coverage,
    observedAt: receipt.startedAtUtc as string,
    identities: receipt.parsedItemIdentitySha256s as string[],
  }
}
