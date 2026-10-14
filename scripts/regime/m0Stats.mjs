// m0Stats.mjs — the two M0 statistics over the price-history grid, and the quantile.
//
// Pure functions (no I/O) so the builder and the unit test compute the same thing.
// The grid convention is price-history's own (membrane-datasets price-history/manifest.json):
// index i is the hour opening at startTs + i·3600, and its value is the price at the END of
// that hour; null = no observation. Nothing here fills a gap.

export const QUANTILE_METHOD =
  'linear interpolation between order statistics (Hyndman & Fan type 7, the numpy and R default): ' +
  'sort the n values ascending as x[0..n−1]; h = (n − 1)·p; q = x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋])'

export const MOVE_METHOD =
  'm_t = |oracle_t / oracle_{t−24h} − 1| at every hour end t where both values are observed ' +
  '(oracle column as built: the Chainlink ETH/USD answer in force at each hour end)'

export const GAP_METHOD =
  'g_t = |oracle_t / coinbase_t − 1| at every hour end t where both values are observed ' +
  '(coinbase column: the Coinbase Exchange ETH-USD 1h candle close)'

/** Type-7 quantile of an ascending-sorted array. */
export function quantileSorted(sorted, p) {
  if (!sorted.length) throw new Error('quantile of an empty sample')
  if (!(p >= 0 && p <= 1)) throw new Error(`quantile p out of range: ${p}`)
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.min(lo + 1, sorted.length - 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0

/**
 * Every observed m_t and g_t, with the hour-end (unix s) of the first and last hour each
 * statistic covers. `lagHours` is the move horizon (24).
 */
export function m0Samples({ startTs, stepSeconds, oracle, coinbase }, lagHours = 24) {
  if (stepSeconds !== 3600) throw new Error(`expected an hourly grid, got step ${stepSeconds}s`)
  const end = (i) => startTs + (i + 1) * stepSeconds
  const move = []
  const gap = []
  let moveFirst = null
  let moveLast = null
  let gapFirst = null
  let gapLast = null
  for (let i = 0; i < oracle.length; i++) {
    const o = oracle[i]
    if (!ok(o)) continue
    const prev = i >= lagHours ? oracle[i - lagHours] : null
    if (ok(prev)) {
      move.push(Math.abs(o / prev - 1))
      if (moveFirst === null) moveFirst = end(i)
      moveLast = end(i)
    }
    const c = coinbase[i]
    if (ok(c)) {
      gap.push(Math.abs(o / c - 1))
      if (gapFirst === null) gapFirst = end(i)
      gapLast = end(i)
    }
  }
  return {
    move,
    gap,
    movePeriod: { from: moveFirst, to: moveLast },
    gapPeriod: { from: gapFirst, to: gapLast },
  }
}

/** The thresholds the M0 rule reads: p95 of m, p99 and p99.9 of g. */
export function m0Thresholds(grid) {
  const s = m0Samples(grid)
  const move = [...s.move].sort((a, b) => a - b)
  const gap = [...s.gap].sort((a, b) => a - b)
  return {
    move24hP95: quantileSorted(move, 0.95),
    gapP99: quantileSorted(gap, 0.99),
    gapP999: quantileSorted(gap, 0.999),
    n: { move24h: move.length, gap: gap.length },
    movePeriod: s.movePeriod,
    gapPeriod: s.gapPeriod,
  }
}
