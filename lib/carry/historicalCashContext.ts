/** Retrospective changes in one exact Carry subject's aggregate underlying cash. */
export type CarryCashSubject = { route_key: string; destination: string; asset: string }

type CashRow = {
  routeKey: string
  destination: string
  asset: string | null
  assetDecimals: number | null
  cashRaw: string | null
  state: string
}

type CashObservation = {
  collectionMode: 'current' | 'retrospective'
  anchorAt: string
  firstLocalReceiptAt: string
  source: { blockAt: string; block: string; blockHash: string }
  subjects: CashRow[]
}

export type CarryHistoricalCashContext =
  | {
      status: 'unavailable'
      reason:
        | 'insufficient_daily_anchors'
        | 'subject_unassessed'
        | 'subject_no_code'
        | 'identity_mismatch'
      routeKey: string
      destination: string
    }
  | {
      status: 'historical_context'
      claim: 'aggregate_underlying_cash_proxy_only'
      sourceKind: 'local_sha_replayed_finalized_rpc'
      routeKey: string
      destination: string
      asset: string
      assetDecimals: number
      horizonHours: 24
      sampleCount: number
      anchorCount: number
      gridLabel: '00:00 UTC daily / 120 days' | '22:00 UTC daily / 30 days'
      coverageFrom: string
      coverageTo: string
      p10NetChangeRaw: string
      p90NetChangeRaw: string
      worstSampledNetChangeRaw: string
      currentRead?: CarryCurrentReadStatus
      current: {
        cashRaw: string
        blockAt: string
        block: string
        blockHash: string
        firstLocalReceiptAt: string | null
        readAtUtc?: string
        sourceKind?: 'live_read_only_two_origin_finalized'
        freshness: 'fresh' | 'stale'
      } | null
    }

export type CarryLiveCurrentCash =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'available'
      sourceKind: 'live_read_only_two_origin_finalized'
      routeKey: string
      destination: string
      asset: string
      assetDecimals: number
      cashRaw: string
      block: string
      blockHash: string
      blockAt: string
      readAtUtc: string
    }

export type CarryCurrentReadStatus =
  | { status: 'available'; sourceKind: 'live_read_only_two_origin_finalized' }
  | { status: 'unavailable'; reason: string }

/** Report the bounded live-read result without exposing an RPC URL or error body. */
export function currentReadStatus(
  archived: CarryHistoricalCashContext,
  overlaid: CarryHistoricalCashContext,
  live: CarryLiveCurrentCash,
): CarryCurrentReadStatus {
  if (live.status === 'unavailable')
    return {
      status: 'unavailable',
      reason: /^[a-z_]{1,64}$/.test(live.reason) ? live.reason : 'live_read_failed',
    }
  if (overlaid === archived) return { status: 'unavailable', reason: 'live_read_rejected' }
  return { status: 'available', sourceKind: live.sourceKind }
}

/** Overlay only an independently matched transient read; history remains sealed. */
export function withReadOnlyCurrentCash(
  context: CarryHistoricalCashContext,
  subject: CarryCashSubject,
  live: CarryLiveCurrentCash,
  now = Date.now(),
): CarryHistoricalCashContext {
  if (context.status !== 'historical_context' || live.status !== 'available') return context
  const uintBlock = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,77})$/.test(value) &&
    BigInt(value) <= (1n << 256n) - 1n
  const blockAt = Date.parse(live.blockAt)
  const readAt = Date.parse(live.readAtUtc)
  if (
    live.sourceKind !== 'live_read_only_two_origin_finalized' ||
    context.routeKey !== subject.route_key ||
    context.destination !== subject.destination ||
    context.asset !== subject.asset ||
    live.routeKey !== context.routeKey ||
    live.destination !== context.destination ||
    live.asset !== context.asset ||
    live.assetDecimals !== context.assetDecimals ||
    !Number.isSafeInteger(now) ||
    !/^(0|[1-9]\d*)$/.test(live.cashRaw) ||
    !uintBlock(live.block) ||
    (context.current !== null && !uintBlock(context.current.block)) ||
    !/^0x[0-9a-f]{64}$/.test(live.blockHash) ||
    !Number.isSafeInteger(blockAt) ||
    !Number.isSafeInteger(readAt) ||
    new Date(blockAt).toISOString() !== live.blockAt ||
    new Date(readAt).toISOString() !== live.readAtUtc ||
    readAt < blockAt ||
    readAt > now ||
    blockAt > now ||
    now - blockAt > 2 * 60 * 60 * 1000 ||
    (context.current &&
      (BigInt(live.block) < BigInt(context.current.block) ||
        (BigInt(live.block) > BigInt(context.current.block) &&
          blockAt <= Date.parse(context.current.blockAt)) ||
        (live.block === context.current.block &&
          (context.current.blockHash !== live.blockHash ||
            context.current.cashRaw !== live.cashRaw ||
            context.current.blockAt !== live.blockAt))))
  )
    return context
  return {
    ...context,
    current: {
      cashRaw: live.cashRaw,
      blockAt: live.blockAt,
      block: live.block,
      blockHash: live.blockHash,
      firstLocalReceiptAt: null,
      readAtUtc: live.readAtUtc,
      sourceKind: live.sourceKind,
      freshness: 'fresh',
    },
  }
}

/** Q-relative aggregate cash arithmetic, never a holder-executable exit quote. */
export type CarryAggregateCashStress24h =
  | {
      status: 'unavailable'
      reason:
        | 'historical_context_unavailable'
        | 'identity_mismatch'
        | 'invalid_requested_assets'
        | 'current_cash_unavailable'
        | 'current_cash_stale'
        | 'invalid_cash_context'
      routeKey: string
      destination: string
      asset: string
      requestedAssetsRaw: string
    }
  | {
      status: 'available'
      claim: 'aggregate_cash_proxy_only'
      routeKey: string
      destination: string
      asset: string
      assetDecimals: number
      horizonHours: 24
      sampleCount: number
      requestedAssetsRaw: string
      currentCashRaw: string
      currentAfterRequestedRaw: string
      p10ProjectedCashRaw: string
      p10AfterRequestedRaw: string
      worstSampledProjectedCashRaw: string
      worstSampledAfterRequestedRaw: string
      currentBlock: string
      currentBlockHash: string
      currentBlockAt: string
    }

const SIGNED_RAW = /^-?\d+$/

/** Shift historical net cash changes onto fresh current cash, then subtract Q. */
export function projectAggregateCashStress24h(
  context: CarryHistoricalCashContext,
  subject: CarryCashSubject,
  requestedAssetsRaw: string,
  now = Date.now(),
): CarryAggregateCashStress24h {
  const unavailable = (
    reason: Extract<CarryAggregateCashStress24h, { status: 'unavailable' }>['reason'],
  ): CarryAggregateCashStress24h => ({
    status: 'unavailable',
    reason,
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    requestedAssetsRaw,
  })
  if (context.routeKey !== subject.route_key || context.destination !== subject.destination)
    return unavailable('identity_mismatch')
  if (context.status !== 'historical_context') return unavailable('historical_context_unavailable')
  if (context.asset !== subject.asset) return unavailable('identity_mismatch')
  if (!/^[1-9]\d*$/.test(requestedAssetsRaw)) return unavailable('invalid_requested_assets')
  if (!context.current) return unavailable('current_cash_unavailable')
  if (context.current.freshness !== 'fresh') return unavailable('current_cash_stale')
  const currentAgeMs = now - Date.parse(context.current.blockAt)
  if (!Number.isFinite(currentAgeMs) || currentAgeMs < 0 || currentAgeMs > 2 * 60 * 60 * 1000)
    return unavailable('current_cash_stale')
  if (
    !RAW.test(context.current.cashRaw) ||
    !SIGNED_RAW.test(context.p10NetChangeRaw) ||
    !SIGNED_RAW.test(context.worstSampledNetChangeRaw) ||
    !Number.isSafeInteger(context.sampleCount) ||
    context.sampleCount < 1
  )
    return unavailable('invalid_cash_context')

  const q = BigInt(requestedAssetsRaw)
  const currentCash = BigInt(context.current.cashRaw)
  const projectedCash = (netChangeRaw: string) => {
    const shifted = currentCash + BigInt(netChangeRaw)
    return shifted > 0n ? shifted : 0n
  }
  const p10ProjectedCash = projectedCash(context.p10NetChangeRaw)
  const worstSampledProjectedCash = projectedCash(context.worstSampledNetChangeRaw)
  return {
    status: 'available',
    claim: 'aggregate_cash_proxy_only',
    routeKey: context.routeKey,
    destination: context.destination,
    asset: context.asset,
    assetDecimals: context.assetDecimals,
    horizonHours: 24,
    sampleCount: context.sampleCount,
    requestedAssetsRaw,
    currentCashRaw: context.current.cashRaw,
    currentAfterRequestedRaw: (currentCash - q).toString(),
    p10ProjectedCashRaw: p10ProjectedCash.toString(),
    p10AfterRequestedRaw: (p10ProjectedCash - q).toString(),
    worstSampledProjectedCashRaw: worstSampledProjectedCash.toString(),
    worstSampledAfterRequestedRaw: (worstSampledProjectedCash - q).toString(),
    currentBlock: context.current.block,
    currentBlockHash: context.current.blockHash,
    currentBlockAt: context.current.blockAt,
  }
}

const RAW = /^\d+$/
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_ANCHOR_LAG_MS = 90 * 60 * 1000

type Grid = {
  label: Extract<CarryHistoricalCashContext, { status: 'historical_context' }>['gridLabel']
  anchorHourUtc: '00' | '22'
  anchorCount: 120 | 30
}
const LONG_GRID: Grid = {
  label: '00:00 UTC daily / 120 days',
  anchorHourUtc: '00',
  anchorCount: 120,
}
const SHORT_GRID: Grid = {
  label: '22:00 UTC daily / 30 days',
  anchorHourUtc: '22',
  anchorCount: 30,
}

const unavailable = (
  subject: CarryCashSubject,
  reason: Extract<CarryHistoricalCashContext, { status: 'unavailable' }>['reason'],
) => ({
  status: 'unavailable' as const,
  reason,
  routeKey: subject.route_key,
  destination: subject.destination,
})

function exactRow(observation: CashObservation, subject: CarryCashSubject): CashRow | null {
  const rows = observation.subjects.filter(
    (row) => row.routeKey === subject.route_key && row.destination === subject.destination,
  )
  return rows.length === 1 ? rows[0] : null
}

function percentile(sorted: bigint[], percent: number): bigint {
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]
}

function completeDailyGrid(observations: CashObservation[], grid: Grid): CashObservation[] | null {
  const daily = observations
    .filter(
      (entry) =>
        entry.collectionMode === 'retrospective' &&
        entry.anchorAt.endsWith(`T${grid.anchorHourUtc}:00:00.000Z`),
    )
    .sort((a, b) => a.anchorAt.localeCompare(b.anchorAt))
    .slice(-grid.anchorCount)
  if (
    daily.length !== grid.anchorCount ||
    new Set(daily.map((row) => row.anchorAt)).size !== grid.anchorCount
  )
    return null
  for (let i = 0; i < daily.length; i++) {
    const lag = Date.parse(daily[i].anchorAt) - Date.parse(daily[i].source.blockAt)
    if (!Number.isFinite(lag) || lag < 0 || lag > MAX_ANCHOR_LAG_MS) return null
    if (i > 0 && Date.parse(daily[i].anchorAt) - Date.parse(daily[i - 1].anchorAt) !== DAY_MS)
      return null
  }
  for (let i = 0; i < daily.length; i += 2) {
    const elapsed = Date.parse(daily[i + 1].source.blockAt) - Date.parse(daily[i].source.blockAt)
    if (elapsed < DAY_MS - MAX_ANCHOR_LAG_MS || elapsed > DAY_MS + MAX_ANCHOR_LAG_MS) return null
  }
  return daily
}

type UnavailableReason = Extract<CarryHistoricalCashContext, { status: 'unavailable' }>['reason']
type SubjectGrid =
  | { status: 'observed'; rows: CashRow[]; decimals: number }
  | { status: 'unavailable'; reason: UnavailableReason }

function subjectRowsForGrid(daily: CashObservation[], subject: CarryCashSubject): SubjectGrid {
  const rows = daily.map((entry) => exactRow(entry, subject))
  if (rows.some((row) => !row)) return { status: 'unavailable', reason: 'identity_mismatch' }
  if (rows.some((row) => row?.state === 'unassessed'))
    return { status: 'unavailable', reason: 'subject_unassessed' }
  if (rows.some((row) => row?.state === 'no_code'))
    return { status: 'unavailable', reason: 'subject_no_code' }
  if (rows.some((row) => row?.state !== 'observed'))
    return { status: 'unavailable', reason: 'identity_mismatch' }
  const decimals = rows[0]!.assetDecimals
  if (
    !Number.isInteger(decimals) ||
    decimals === null ||
    decimals < 0 ||
    decimals > 36 ||
    rows.some(
      (row) =>
        row?.asset !== subject.asset ||
        row?.assetDecimals !== decimals ||
        !RAW.test(row?.cashRaw ?? ''),
    )
  )
    return { status: 'unavailable', reason: 'identity_mismatch' }
  return { status: 'observed', rows: rows as CashRow[], decimals }
}

export function historicalCarryCashContext(
  observations: CashObservation[],
  subject: CarryCashSubject,
  now = Date.now(),
): CarryHistoricalCashContext {
  const longDaily = completeDailyGrid(observations, LONG_GRID)
  const shortDaily = completeDailyGrid(observations, SHORT_GRID)
  const longSubject = longDaily ? subjectRowsForGrid(longDaily, subject) : null
  const shortSubject = shortDaily ? subjectRowsForGrid(shortDaily, subject) : null
  const chosen =
    longDaily && longSubject?.status === 'observed'
      ? { grid: LONG_GRID, daily: longDaily, subjectRows: longSubject }
      : shortDaily && shortSubject?.status === 'observed'
        ? { grid: SHORT_GRID, daily: shortDaily, subjectRows: shortSubject }
        : null
  if (!chosen)
    return unavailable(
      subject,
      shortSubject?.status === 'unavailable'
        ? shortSubject.reason
        : longSubject?.status === 'unavailable'
          ? longSubject.reason
          : 'insufficient_daily_anchors',
    )
  const { grid, daily, subjectRows } = chosen
  const { rows, decimals } = subjectRows

  const changes: bigint[] = []
  for (let i = 0; i < rows.length; i += 2) {
    // The next pair starts after the prior pair's endpoint: no shared snapshots.
    changes.push(BigInt(rows[i + 1]!.cashRaw!) - BigInt(rows[i]!.cashRaw!))
  }
  changes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const currentObservations = observations
    .filter((entry) => entry.collectionMode === 'current')
    .sort((a, b) => b.source.blockAt.localeCompare(a.source.blockAt))
  let current: Extract<CarryHistoricalCashContext, { status: 'historical_context' }>['current'] =
    null
  for (const entry of currentObservations) {
    const row = exactRow(entry, subject)
    if (!row) return unavailable(subject, 'identity_mismatch')
    if (row.state === 'unassessed') return unavailable(subject, 'subject_unassessed')
    if (row.state === 'no_code') return unavailable(subject, 'subject_no_code')
    if (row.state !== 'observed') return unavailable(subject, 'identity_mismatch')
    if (
      row.asset !== subject.asset ||
      row.assetDecimals !== decimals ||
      !RAW.test(row.cashRaw ?? '')
    )
      return unavailable(subject, 'identity_mismatch')
    current = {
      cashRaw: row.cashRaw!,
      blockAt: entry.source.blockAt,
      block: entry.source.block,
      blockHash: entry.source.blockHash,
      firstLocalReceiptAt: entry.firstLocalReceiptAt,
      freshness:
        now >= Date.parse(entry.source.blockAt) &&
        now - Date.parse(entry.source.blockAt) <= 2 * 60 * 60 * 1000
          ? 'fresh'
          : 'stale',
    }
    break
  }
  return {
    status: 'historical_context',
    claim: 'aggregate_underlying_cash_proxy_only',
    sourceKind: 'local_sha_replayed_finalized_rpc',
    routeKey: subject.route_key,
    destination: subject.destination,
    asset: subject.asset,
    assetDecimals: decimals,
    horizonHours: 24,
    sampleCount: changes.length,
    anchorCount: daily.length,
    gridLabel: grid.label,
    coverageFrom: daily[0].anchorAt,
    coverageTo: daily[daily.length - 1].anchorAt,
    p10NetChangeRaw: percentile(changes, 10).toString(),
    p90NetChangeRaw: percentile(changes, 90).toString(),
    worstSampledNetChangeRaw: changes[0].toString(),
    current,
  }
}
