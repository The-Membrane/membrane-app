/** Sparse times belong to independently verified headers, never a seconds-per-block guess. */
export type HistoricalFlowDurationPath = {
  originBlock: number
  targetBlock: number
  sourceJoinSha256: string
  coverage: 'complete_end_of_block_transfer_path'
  timestampProvenance: 'verified_two_origin_direct_headers_hash_join'
  points: { blockNumber: number; blockHash: string; cashAfterRaw: string }[]
  timeHeaders: { blockNumber: number; blockHash: string; timestampSec: number }[]
  gaps: { fromBlock: number; toBlock: number }[]
}

export type DurationBracket = { lowerSeconds: number; upperSeconds: number }
export type HistoricalBelowQRun = {
  firstBelowBlock: number
  recoveryBlock: number | null
  timeToFirstBelow: DurationBracket | null
  timeToRecovery: DurationBracket | null
  belowQDuration: DurationBracket | null
  observedBelowQLowerSeconds: number | null
  censoring: { left: boolean; right: boolean; gap: boolean }
}

const RAW = /^(0|[1-9][0-9]*)$/
const HASH = /^0x[0-9a-f]{64}$/
const SHA = /^[0-9a-f]{64}$/
const fail = (okay: unknown) => {
  if (!okay) throw new Error('historical_duration_invalid_path')
}
const cash = (value: string) => {
  fail(typeof value === 'string' && RAW.test(value))
  return BigInt(value)
}

/** Subtract interval endpoints outwards; overlapping bounds can only prove zero elapsed. */
export function elapsedHistoricalBracket(
  start: DurationBracket | null,
  end: DurationBracket | null,
): DurationBracket | null {
  if (!start || !end) return null
  for (const bracket of [start, end])
    fail(
      Number.isSafeInteger(bracket.lowerSeconds) &&
        Number.isSafeInteger(bracket.upperSeconds) &&
        bracket.lowerSeconds >= 0 &&
        bracket.upperSeconds >= bracket.lowerSeconds,
    )
  fail(end.upperSeconds >= start.lowerSeconds)
  return {
    lowerSeconds: Math.max(0, end.lowerSeconds - start.upperSeconds),
    upperSeconds: Math.max(0, end.upperSeconds - start.lowerSeconds),
  }
}

/** Retrospective translation of a complete matching cash path at selected C2 and Q. */
export function projectHistoricalFlowDuration(
  path: HistoricalFlowDurationPath,
  currentCashRaw: string,
  requestedRaw: string,
) {
  const current = cash(currentCashRaw)
  const requested = cash(requestedRaw)
  fail(
    requested > 0n &&
      path.coverage === 'complete_end_of_block_transfer_path' &&
      path.timestampProvenance === 'verified_two_origin_direct_headers_hash_join' &&
      SHA.test(path.sourceJoinSha256) &&
      Number.isSafeInteger(path.originBlock) &&
      path.originBlock >= 0 &&
      Number.isSafeInteger(path.targetBlock) &&
      path.targetBlock > path.originBlock &&
      Array.isArray(path.points) &&
      path.points.length >= 2 &&
      path.points.length <= path.targetBlock - path.originBlock + 1 &&
      Array.isArray(path.timeHeaders) &&
      Array.isArray(path.gaps),
  )
  const points = path.points.map((point, index) => {
    fail(
      Number.isSafeInteger(point.blockNumber) &&
        point.blockNumber >= path.originBlock &&
        point.blockNumber <= path.targetBlock &&
        (index === 0 || point.blockNumber > path.points[index - 1].blockNumber) &&
        HASH.test(point.blockHash),
    )
    return { ...point, cash: cash(point.cashAfterRaw) }
  })
  fail(
    points[0].blockNumber === path.originBlock && points.at(-1)!.blockNumber === path.targetBlock,
  )
  const headers = path.timeHeaders
  headers.forEach((header, index) => {
    const previous = headers[index - 1]
    fail(
      Number.isSafeInteger(header.blockNumber) &&
        header.blockNumber >= 0 &&
        HASH.test(header.blockHash) &&
        Number.isSafeInteger(header.timestampSec) &&
        header.timestampSec >= 0 &&
        (!previous ||
          (header.blockNumber > previous.blockNumber &&
            header.timestampSec > previous.timestampSec)),
    )
    const point = points.find((item) => item.blockNumber === header.blockNumber)
    if (point) fail(point.blockHash === header.blockHash)
  })
  const gaps = path.gaps
  gaps.forEach((gap, index) =>
    fail(
      Number.isSafeInteger(gap.fromBlock) &&
        Number.isSafeInteger(gap.toBlock) &&
        gap.fromBlock >= path.originBlock &&
        gap.toBlock <= path.targetBlock &&
        gap.toBlock > gap.fromBlock &&
        (!index || gap.fromBlock >= gaps[index - 1].toBlock),
    ),
  )
  const timeAt = (blockNumber: number): DurationBracket | null => {
    const exact = headers.find((header) => header.blockNumber === blockNumber)
    if (exact) return { lowerSeconds: exact.timestampSec, upperSeconds: exact.timestampSec }
    const before = [...headers].reverse().find((header) => header.blockNumber < blockNumber)
    const after = headers.find((header) => header.blockNumber > blockNumber)
    return before && after
      ? { lowerSeconds: before.timestampSec, upperSeconds: after.timestampSec }
      : null
  }
  const origin = timeAt(path.originBlock)
  const horizonDuration = elapsedHistoricalBracket(origin, timeAt(path.targetBlock))
  const source = points[0].cash
  const below = (point: (typeof points)[number]) => {
    const translated = current + point.cash - source
    return (translated < 0n ? 0n : translated) < requested
  }
  const runs: HistoricalBelowQRun[] = []
  let startIndex: number | null = null
  let startAfterGap = false
  const close = (endIndex: number, recovery: boolean, gap: boolean) => {
    if (startIndex === null) return
    const start = points[startIndex]
    const end = points[endIndex]
    const span = elapsedHistoricalBracket(timeAt(start.blockNumber), timeAt(end.blockNumber))
    const left = startIndex === 0 || startAfterGap
    runs.push({
      firstBelowBlock: start.blockNumber,
      recoveryBlock: recovery ? end.blockNumber : null,
      timeToFirstBelow: left ? null : elapsedHistoricalBracket(origin, timeAt(start.blockNumber)),
      timeToRecovery: recovery ? elapsedHistoricalBracket(origin, timeAt(end.blockNumber)) : null,
      belowQDuration: recovery && !left && !gap ? span : null,
      observedBelowQLowerSeconds: span?.lowerSeconds ?? null,
      censoring: { left, right: !recovery, gap },
    })
    startIndex = null
    startAfterGap = false
  }
  points.forEach((point, index) => {
    const previous = points[index - 1]
    const gap =
      previous &&
      gaps.find((item) => item.fromBlock < point.blockNumber && item.toBlock > previous.blockNumber)
    if (gap) close(index - 1, false, true)
    if (below(point)) {
      if (startIndex === null) {
        startIndex = index
        startAfterGap = Boolean(gap)
      }
    } else if (startIndex !== null) close(index, true, false)
  })
  close(points.length - 1, false, false)
  return {
    observation: 'end_of_block_cash_only' as const,
    timeBasis: 'verified_header_timestamp_brackets' as const,
    currentCashRaw,
    requestedRaw,
    originBlock: path.originBlock,
    targetBlock: path.targetBlock,
    sourceJoinSha256: path.sourceJoinSha256,
    horizonDuration,
    pathGapCensored: gaps.length > 0,
    initiallyBelowQ: below(points[0]),
    belowQRunCount: runs.length,
    runs,
  }
}

export type HistoricalFlowDuration = ReturnType<typeof projectHistoricalFlowDuration>

/** UI minutes round away from the measured interval; never format a bracket as an exact date. */
export function formatHistoricalDurationBracket(bracket: DurationBracket | null) {
  if (!bracket) return 'time unbounded'
  const lower = Math.floor(bracket.lowerSeconds / 60)
  const upper = Math.ceil(bracket.upperSeconds / 60)
  return lower === upper ? `${lower}m` : `${lower}–${upper}m`
}

export function historicalDurationLabel(duration: HistoricalFlowDuration) {
  if (duration.pathGapCensored) return 'DURATION · GAP CENSORED'
  const first = duration.runs[0]
  if (!first)
    return `BELOW Q NOT SEEN IN ${formatHistoricalDurationBracket(duration.horizonDuration)}`
  const onset = first.censoring.left
    ? 'ALREADY BELOW Q'
    : `FIRST BELOW Q ${formatHistoricalDurationBracket(first.timeToFirstBelow)}`
  const recovery =
    first.recoveryBlock === null
      ? `RECOVERY NOT SEEN${first.observedBelowQLowerSeconds === null ? '' : ` · OBSERVED BELOW ≥${Math.floor(first.observedBelowQLowerSeconds / 60)}m`}`
      : first.censoring.left
        ? `RECOVERS BY ${formatHistoricalDurationBracket(first.timeToRecovery)}`
        : `RECOVERS AFTER ${formatHistoricalDurationBracket(first.belowQDuration)}`
  return `${onset} · ${recovery}${duration.belowQRunCount > 1 ? ` · ${duration.belowQRunCount} RUNS` : ''}`
}
