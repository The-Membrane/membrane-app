import type { CarryCashSubject, CarryLiveCurrentCash } from './historicalCashContext'
import type { historicalCarryCashContext } from './historicalCashContext'
import type { HistoricalSampledCashPathsInput } from './historicalSampledCashPaths'

type Observation = Parameters<typeof historicalCarryCashContext>[0][number]
type Current = HistoricalSampledCashPathsInput['current'] & {
  firstLocalReceiptAt: string | null
  readAtUtc?: string
  sourceKind?: 'live_read_only_two_origin_finalized'
}
export type SampledCashHistoryCoverage = {
  gridAnchorCount: 120
  observedAnchorCount: number
  leadingPredeploymentAnchorCount: number
  interiorUnavailableAnchorCount: number
  trailingUnavailableAnchorCount: number
  observedFromAnchorAt: string
  observedToAnchorAt: string
  gridFromAnchorAt: string
  gridToAnchorAt: string
  observedFromAt: string
  observedToAt: string
}
export type LocalHistoricalSampledCashTimeline =
  | {
      status: 'unavailable'
      reason: 'insufficient_daily_anchors' | 'identity_mismatch' | 'insufficient_eligible_history'
    }
  | {
      status: 'sampled_timeline'
      identity: HistoricalSampledCashPathsInput['identity']
      subjectKey: string
      timeline: HistoricalSampledCashPathsInput['timeline']
      coverage: SampledCashHistoryCoverage
      current: Current | null
    }
const DAY_MS = 86400000
const LAG_MS = 90 * 60000
const MAX_RAW = (1n << 256n) - 1n
const raw = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) <= MAX_RAW
const utc = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isSafeInteger(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
const exactRow = (entry: Observation, subject: CarryCashSubject) => {
  const rows = entry.subjects.filter(
    (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
  )
  return rows.length === 1 ? rows[0] : null
}
const validSource = (entry: Observation) =>
  utc(entry.source.blockAt) &&
  raw(entry.source.block) &&
  typeof entry.source.blockHash === 'string' &&
  /^0x[0-9a-f]{64}$/.test(entry.source.blockHash) &&
  utc(entry.firstLocalReceiptAt) &&
  Date.parse(entry.firstLocalReceiptAt) >= Date.parse(entry.source.blockAt)

/** Inputs must come from the SHA/manifest/two-origin receipt verifier's observation adapter.
 * Descriptive paths may begin after deployment; fitted model pairs remain a separate gate.
 * Missing interior observations retain their dates as gaps, so replay rejects spans crossing them.
 */
export function localHistoricalSampledCashTimeline(
  observations: Observation[],
  subject: CarryCashSubject,
): LocalHistoricalSampledCashTimeline {
  const unavailable = (
    reason: Extract<LocalHistoricalSampledCashTimeline, { status: 'unavailable' }>['reason'],
  ): LocalHistoricalSampledCashTimeline => ({ status: 'unavailable', reason })
  const daily = observations
    .filter(
      (entry) =>
        entry.collectionMode === 'retrospective' && entry.anchorAt.endsWith('T00:00:00.000Z'),
    )
    .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt))
    .slice(-120)
  if (daily.length !== 120 || new Set(daily.map((entry) => entry.anchorAt)).size !== 120)
    return unavailable('insufficient_daily_anchors')
  const subjectKey = `${subject.route_key}\0${subject.destination}\0${subject.asset}`
  const timeline: HistoricalSampledCashPathsInput['timeline'][number][] = []
  let decimals: number | null = null
  let leadingPredeployment = 0
  const observedIndexes: number[] = []
  for (let i = 0; i < daily.length; i++) {
    const entry = daily[i]
    const lag = Date.parse(entry.anchorAt) - Date.parse(entry.source.blockAt)
    if (
      !utc(entry.anchorAt) ||
      !validSource(entry) ||
      lag < 0 ||
      lag > LAG_MS ||
      (i > 0 && Date.parse(entry.anchorAt) - Date.parse(daily[i - 1].anchorAt) !== DAY_MS)
    )
      return unavailable('identity_mismatch')
    const row = exactRow(entry, subject)
    if (!row) return unavailable('identity_mismatch')
    if (row.state !== 'observed') {
      if (
        !['no_code', 'unassessed'].includes(row.state) ||
        (row.state === 'no_code' && (row.asset !== null || row.assetDecimals !== null)) ||
        row.cashRaw !== null ||
        (row.asset !== null && row.asset !== subject.asset) ||
        (row.assetDecimals !== null && decimals !== null && row.assetDecimals !== decimals)
      )
        return unavailable('identity_mismatch')
      if (timeline.length === 0) {
        if (row.state !== 'no_code') return unavailable('insufficient_eligible_history')
        if ((row as typeof row & { reason?: unknown }).reason !== 'destination_not_deployed')
          return unavailable('identity_mismatch')
        leadingPredeployment++
      }
      continue
    }
    if (
      row.asset !== subject.asset ||
      !Number.isInteger(row.assetDecimals) ||
      row.assetDecimals === null ||
      row.assetDecimals < 0 ||
      row.assetDecimals > 36 ||
      !raw(row.cashRaw) ||
      (decimals !== null && row.assetDecimals !== decimals)
    )
      return unavailable('identity_mismatch')
    decimals = row.assetDecimals
    timeline.push({ subjectKey, at: entry.source.blockAt, cashRaw: row.cashRaw })
    observedIndexes.push(i)
  }
  if (decimals === null || timeline.length < 8) return unavailable('insufficient_eligible_history')
  // Select only the newest current receipt; a malformed newest read never falls back silently.
  const latest = observations
    .filter((entry) => entry.collectionMode === 'current')
    .sort((a, b) => b.source.blockAt.localeCompare(a.source.blockAt))[0]
  const currentRow = latest ? exactRow(latest, subject) : null
  const current: Current | null =
    latest &&
    validSource(latest) &&
    currentRow?.state === 'observed' &&
    currentRow.asset === subject.asset &&
    currentRow.assetDecimals === decimals &&
    raw(currentRow.cashRaw)
      ? {
          cashRaw: currentRow.cashRaw,
          blockAt: latest.source.blockAt,
          block: latest.source.block,
          blockHash: latest.source.blockHash,
          firstLocalReceiptAt: latest.firstLocalReceiptAt,
          subjectKey,
          asset: subject.asset,
          assetDecimals: decimals,
        }
      : null
  return {
    status: 'sampled_timeline',
    identity: {
      routeKey: subject.route_key,
      destination: subject.destination,
      asset: subject.asset,
      assetDecimals: decimals,
    },
    subjectKey,
    timeline,
    coverage: {
      gridAnchorCount: 120,
      observedAnchorCount: timeline.length,
      leadingPredeploymentAnchorCount: leadingPredeployment,
      interiorUnavailableAnchorCount:
        observedIndexes[observedIndexes.length - 1] - observedIndexes[0] + 1 - timeline.length,
      trailingUnavailableAnchorCount: 119 - observedIndexes[observedIndexes.length - 1],
      observedFromAnchorAt: daily[observedIndexes[0]].anchorAt,
      observedToAnchorAt: daily[observedIndexes[observedIndexes.length - 1]].anchorAt,
      gridFromAnchorAt: daily[0].anchorAt,
      gridToAnchorAt: daily[119].anchorAt,
      observedFromAt: timeline[0].at,
      observedToAt: timeline[timeline.length - 1].at,
    },
    current,
  }
}

/** Same exact identity, monotonic block and two-hour freshness gates as the existing live overlay. */
export function sampledReadOnlyCurrentCash(
  history: Extract<LocalHistoricalSampledCashTimeline, { status: 'sampled_timeline' }>,
  live: CarryLiveCurrentCash | undefined,
  now: number,
): Current | null {
  const archived =
    history.current &&
    (history.current.firstLocalReceiptAt === null ||
      Date.parse(history.current.firstLocalReceiptAt) <= now)
      ? history.current
      : null
  if (!live || live.status !== 'available') return archived
  const sourceAt = Date.parse(live.blockAt)
  const readAt = Date.parse(live.readAtUtc)
  if (
    live.sourceKind !== 'live_read_only_two_origin_finalized' ||
    live.routeKey !== history.identity.routeKey ||
    live.destination !== history.identity.destination ||
    live.asset !== history.identity.asset ||
    live.assetDecimals !== history.identity.assetDecimals ||
    !Number.isSafeInteger(now) ||
    !raw(live.cashRaw) ||
    !raw(live.block) ||
    (archived !== null && !raw(archived.block)) ||
    typeof live.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(live.blockHash) ||
    !utc(live.blockAt) ||
    !utc(live.readAtUtc) ||
    readAt < sourceAt ||
    readAt > now ||
    sourceAt > now ||
    now - sourceAt > 2 * 3600000 ||
    (archived &&
      (BigInt(live.block) < BigInt(archived.block) ||
        (BigInt(live.block) > BigInt(archived.block) && sourceAt <= Date.parse(archived.blockAt)) ||
        (live.block === archived.block &&
          (archived.blockHash !== live.blockHash ||
            archived.cashRaw !== live.cashRaw ||
            archived.blockAt !== live.blockAt))))
  )
    return archived
  return {
    cashRaw: live.cashRaw,
    blockAt: live.blockAt,
    block: live.block,
    blockHash: live.blockHash,
    firstLocalReceiptAt: null,
    readAtUtc: live.readAtUtc,
    sourceKind: live.sourceKind,
    subjectKey: history.subjectKey,
    asset: history.identity.asset,
    assetDecimals: history.identity.assetDecimals,
  }
}
