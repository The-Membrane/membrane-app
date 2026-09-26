import test from 'node:test'
import assert from 'node:assert/strict'
import { assessMetric, screen, validMetric } from './venue-intraday-screen.mjs'
import { START, END, VENUES } from './venue-intraday-export.mjs'

const base = Date.parse('2026-08-21T00:00:00Z')
const time = (h) => new Date(base + h * 3_600_000).toISOString()
const aave = {
  name: 'aave-v3-usde',
  kind: 'atoken-liquidity',
  address: '0x0000000000000000000000000000000000000011',
  underlying: '0x0000000000000000000000000000000000000022',
  decimals: 0,
  enabled: true,
  depthMarkets: [],
}
const pool = {
  name: 'pool',
  kind: 'curve-stableswap',
  address: '0xabc',
  token0: '0xdola',
  token1: '0xsusde',
  exitFrom: '0xsusde',
  enabled: true,
}
const secondary = { name: 'sUSDe', kind: 'erc4626-cooldown', enabled: true, depthMarkets: [pool] }
const config = [
  aave,
  secondary,
  ...VENUES.filter((v) => !['aave-v3-usde', 'sUSDe'].includes(v)).map((name) => ({
    name,
    kind: 'erc4626-cooldown',
    enabled: true,
    depthMarkets: [pool],
  })),
]
const cash = (h, value, verified = false) => ({
  venue: aave.name,
  block: h + 1,
  observed_at: time(h),
  instant_usd: value,
  params: {
    kind: aave.kind,
    underlyingBalance: String(value),
    decimals: 0,
    priceAssumptionUsd: 1,
    reads: { underlyingBalance: true },
    ...(verified ? { aToken: aave.address, underlying: aave.underlying } : {}),
  },
  source: 'observed',
})
const withOnchainIdentity = (row) => ({
  ...row,
  params: {
    ...row.params,
    aToken: aave.address,
    underlying: aave.underlying,
    underlyingOnchain: aave.underlying,
    underlyingDecimalsOnchain: aave.decimals,
    underlyingIdentity: 'match',
    decimalsIdentity: 'match',
    reads: {
      underlyingBalance: true,
      underlyingAsset: true,
      underlyingDecimals: true,
    },
  },
})
const depth = (h, value, extra = {}) => ({
  venue: secondary.name,
  block: h + 1,
  observed_at: time(h),
  instant_usd: null,
  source: 'observed',
  params: {
    kind: secondary.kind,
    depth_usd: value,
    depth_complete: true,
    depthMarkets: [
      {
        kind: pool.kind,
        address: '0xabc',
        token0: pool.token0,
        token1: pool.token1,
        exitFrom: pool.exitFrom,
        reserve0Usd: value,
        reserve1Usd: 100,
        priceAssumptionUsd: 1,
        exitableUsd: value,
        reads: { reserve0: true, reserve1: true, decimals0: true, decimals1: true },
        ...extra,
      },
    ],
  },
})
const report = (rows, pinned = false) =>
  screen({ start: START, end: END, fetchedAt: '2026-09-26T12:00:00Z', config, rows })[
    pinned ? 'readBlockPinnedOnly' : 'completeAll'
  ].results

test('Aave cash is reconciled to raw balance; only pinned on-chain identity verifies the row', () => {
  assert.equal(assessMetric(cash(0, 100), aave).value, 100)
  assert.equal(assessMetric(cash(0, 100), aave).identityVerified, false)
  assert.equal(assessMetric(cash(0, 100, true), aave).identityVerified, false)
  assert.deepEqual(assessMetric(withOnchainIdentity(cash(0, 100)), aave), {
    value: 100,
    identityVerified: true,
  })
  assert.equal(assessMetric({ ...cash(0, 100), instant_usd: 99 }, aave), null)
  assert.equal(
    assessMetric({ ...cash(0, 100), params: { ...cash(0, 100).params, decimals: 18 } }, aave),
    null,
  )
  assert.equal(
    assessMetric(
      { ...cash(0, 100, true), params: { ...cash(0, 100, true).params, underlying: '0xwrong' } },
      aave,
    ),
    null,
  )
  const rows = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => cash(h, 100))
  rows.forEach((row) => {
    row.params.read_block_pinned = true
  })
  const strata = screen({ start: START, end: END, fetchedAt: '2026-09-26T12:00:00Z', config, rows })
  assert.equal(strata.readBlockPinnedOnly.results[0].validRows, 9)
  assert.equal(strata.pinnedIdentityVerified.results[0].validRows, 0)
})

test('Aave mismatched and malformed pinned identity is excluded; failed reads remain exploratory', () => {
  const matched = withOnchainIdentity(cash(0, 100))
  const changed = (params) => ({ ...matched, params: { ...matched.params, ...params } })
  assert.equal(
    assessMetric(
      changed({ underlyingOnchain: '0x0000000000000000000000000000000000000033' }),
      aave,
    ),
    null,
  )
  assert.equal(assessMetric(changed({ underlyingOnchain: '0xwrong' }), aave), null)
  assert.equal(assessMetric(changed({ underlyingDecimalsOnchain: 18 }), aave), null)
  assert.equal(assessMetric(changed({ underlyingDecimalsOnchain: '0' }), aave), null)
  assert.equal(assessMetric(changed({ underlyingIdentity: 'mismatch' }), aave), null)
  assert.equal(assessMetric(changed({ decimalsIdentity: 'mismatch' }), aave), null)
  assert.deepEqual(
    assessMetric(
      changed({
        underlyingOnchain: null,
        underlyingIdentity: 'unknown',
        reads: { ...matched.params.reads, underlyingAsset: false },
      }),
      aave,
    ),
    { value: 100, identityVerified: false },
  )
  assert.equal(
    assessMetric(changed({ reads: { ...matched.params.reads, underlyingAsset: false } }), aave)
      .identityVerified,
    false,
  )
})

test('an intraday fall and recovery missed by daily endpoints is a first observed crossing', () => {
  const r = report([0, 3, 7, 10, 13, 16, 19, 22, 25].map((h) => cash(h, h === 7 ? 79 : 100)))[0]
  assert.equal(r.directions.fall.targetAnchors, 1)
  assert.equal(r.anchors[0].fall.crossingAt, time(7))
  assert.equal(r.anchors[0].fall.leadHours, 7)
  assert.equal(r.directions.fall.targetEpisodes48h, 1)
  assert.equal(r.directions.rise.targetAnchors, 0)
})

test('rise and recovery are counted separately from falls', () => {
  const r = report([0, 3, 7, 10, 13, 16, 19, 22, 25].map((h) => cash(h, h === 7 ? 121 : 100)))[0]
  assert.equal(r.anchors[0].rise.status, 'target')
  assert.equal(r.anchors[0].fall.status, 'quiet')
  assert.equal(r.directions.rise.targetEpisodes48h, 1)
})

test('crossing before six hours is too-soon, and gaps censor a non-crossing', () => {
  const early = report([0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => cash(h, h === 3 ? 79 : 100)))[0]
  assert.equal(early.anchors[0].fall.status, 'too-soon')
  assert.equal(early.directions.fall.targetAnchors, 0)
  const gap = report([cash(0, 100), cash(3, 100), cash(9, 100), cash(22, 100), cash(25, 100)])[0]
  assert.equal(gap.anchors[0].fall.status, 'censored')
  const covered = report([0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => cash(h, 100)))[0]
  assert.equal(covered.anchors[0].fall.status, 'quiet')
  const noRightEdge = report([0, 3, 6, 9, 12, 15, 18, 21].map((h) => cash(h, 100)))[0]
  assert.equal(noRightEdge.anchors[0].fall.status, 'censored')
})

test('incomplete or changed market set never supplies valid coverage', () => {
  assert.equal(validMetric(depth(0, 100), secondary), 100)
  assert.equal(validMetric(depth(0, 100, { address: '0xdef' }), secondary), null)
  assert.equal(validMetric(depth(0, 100, { reads: { reserve0: false } }), secondary), null)
  assert.equal(validMetric(depth(0, 100, { token0: '0xwrong' }), secondary), null)
  assert.equal(validMetric(depth(0, 100, { exitFrom: '0xwrong' }), secondary), null)
  assert.equal(validMetric(depth(0, 100, { reserve0Usd: 99 }), secondary), null)
  assert.equal(
    assessMetric(depth(0, 100, { token0: undefined }), secondary).identityVerified,
    false,
  )
  const rows = [depth(0, 100), depth(3, 100, { address: '0xdef' }), depth(6, 100)]
  const r = report(rows).find((v) => v.venue === 'sUSDe')
  assert.equal(r.rawRows, 3)
  assert.equal(r.validRows, 2)
  assert.equal(r.anchors[0].fall.status, 'censored')
})

test('comparator reads only past six hours and applies 24h cooldown', () => {
  const r = report([
    cash(0, 100),
    cash(5, 94),
    cash(6, 94),
    cash(12, 88),
    cash(18, 80),
    cash(24, 80),
  ])[0]
  assert.equal(r.anchors[0].fall.comparatorAlert, false)
  assert.equal(r.anchors.find((a) => a.at === time(6)).fall.comparatorAlert, true)
  assert.equal(r.anchors.find((a) => a.at === time(12)).fall.comparatorAlert, false)
  assert.equal(r.directions.fall.comparator.alerts, 1)
  assert.equal(r.directions.rise.comparator.alerts, 0)
})

test('right edge and pinned-read stratum are reported separately', () => {
  const rows = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => cash(h, 100))
  rows[2].params.read_block_pinned = true
  assert.equal(report(rows)[0].validRows, 9)
  assert.equal(report(rows, true)[0].validRows, 1)
  assert.equal(report(rows, true)[0].directions.fall.censoredAnchors, 1)
})

test('full export cutoff censors and episode-overlapping quiet windows are not controls', () => {
  const cutoffBase = Date.parse(END) - 23 * 3_600_000
  const late = [0, 3, 6].map((h) => ({
    ...cash(h, h === 6 ? 121 : 100),
    observed_at: new Date(cutoffBase + h * 3_600_000).toISOString(),
  }))
  const lateResult = report(late)[0]
  assert.equal(lateResult.anchors[0].rise.status, 'censored')
  const rows = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33].map((h) => cash(h, h >= 6 ? 121 : 100))
  const r = report(rows)[0]
  assert.ok(r.directions.fall.quietAnchors > 0)
  assert.ok(r.directions.fall.independentControls24h > r.directions.rise.independentControls24h)
  assert.ok(r.directions.rise.independentControls24h <= r.directions.rise.episodeClearQuiet)
})

test('zero inventory is a valid fall endpoint, while zero anchors cannot define ratios', () => {
  const r = report([0, 3, 7, 10, 13, 16, 19, 22, 25].map((h) => cash(h, h === 7 ? 0 : 100)))[0]
  assert.equal(r.validRows, 9)
  assert.equal(r.anchors[0].fall.status, 'target')
  assert.equal(r.anchors[0].fall.crossingPct, -100)
  assert.equal(r.zeroAnchors, 1)
  assert.equal(r.anchors.find((a) => a.at === time(7)).fall.status, 'zero-anchor')
})

test('same physical crossing is assigned to one episode despite target and too-soon anchors', () => {
  const r = report(
    [0, 3, 6, 7, 10, 13, 16, 19, 22, 25, 28, 31].map((h) => cash(h, h === 7 ? 79 : 100)),
  )[0]
  assert.equal(r.directions.fall.targetAnchors, 1)
  assert.equal(r.directions.fall.tooSoonAnchors, 1)
  assert.equal(r.directions.fall.allCrossingEpisodes48h, 1)
  assert.equal(r.directions.fall.targetEpisodes48h + r.directions.fall.tooSoonEpisodes48h, 1)
})

test('PSM identity and exit orientation are bound to the effective configuration', () => {
  const cfg = {
    name: 'sUSDS',
    kind: 'erc4626-cooldown',
    depthMarkets: [
      {
        kind: 'psm-buffer',
        address: '0xpsm',
        buffer: '0xpocket',
        bufferToken: '0xusdc',
        exitFrom: '0xusds',
        enabled: true,
      },
    ],
  }
  const row = {
    instant_usd: null,
    params: {
      kind: cfg.kind,
      depth_complete: true,
      depth_usd: 0,
      depthMarkets: [
        {
          kind: 'psm-buffer',
          address: '0xpsm',
          buffer: '0xpocket',
          bufferToken: '0xusdc',
          exitFrom: '0xusds',
          exitableUsd: 0,
          priceAssumptionUsd: 1,
          reads: { buffer: true, decimals: true },
        },
      ],
    },
  }
  assert.deepEqual(assessMetric(row, cfg), { value: 0, identityVerified: true })
  assert.equal(
    assessMetric(
      {
        ...row,
        params: {
          ...row.params,
          depthMarkets: [
            {
              ...row.params.depthMarkets[0],
              bufferToken: '0xwrong',
            },
          ],
        },
      },
      cfg,
    ),
    null,
  )
})

test('a same-timestamp row cannot be a crossing in the open outcome interval', () => {
  const rows = [cash(0, 100), cash(0, 0), ...[3, 6, 9, 12, 15, 18, 21, 24].map((h) => cash(h, 100))]
  rows[1].block = 2
  const r = report(rows)[0]
  assert.equal(r.anchors[0].fall.status, 'quiet')
})
