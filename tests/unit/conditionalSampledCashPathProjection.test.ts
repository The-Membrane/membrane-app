import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localHistoricalSampledCashTimeline } from '@/lib/carry/localHistoricalSampledCashTimeline'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
  selectedConditionalSampledCashPathProjection,
  type ConditionalSampledCashCurrentSource,
} from '@/lib/carry/conditionalSampledCashPathProjection'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const root = 'data/research/venue-signals/local-carry-cash-v1'
// Core tests use the real frozen records; their independent compact pin rejects
// any alteration. Actual API tests exercise the full sealed receipt verifier.
const observations = readdirSync(root)
  .filter((n) => /^\d{12}\.json$/.test(n))
  .map((n) => JSON.parse(readFileSync(join(root, n), 'utf8')))
  .map((r) => ({
    collectionMode: r.collectionMode,
    anchorAt: r.anchorAt,
    firstLocalReceiptAt: r.firstLocalReceiptAt,
    receiptSha256: r.sha256,
    manifestSha256: r.manifestSha256,
    source: { block: r.block, blockAt: r.blockAt, blockHash: r.blockHash },
    subjects: r.rows,
  }))
const subject = {
  route_key: 'USDC → supply on Aave V3',
  destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
}
function history(s = subject) {
  const timeline = localHistoricalSampledCashTimeline(observations, s)
  if (timeline.status !== 'sampled_timeline') throw Error(timeline.reason)
  return conditionalSampledCashHistoryFromVerifiedTimeline(observations, timeline)!
}
const h = history(),
  now = Date.parse('2026-10-08T12:00:00.000Z')
function input(cashRaw = '100', requestedRaw = '90') {
  const source: ConditionalSampledCashCurrentSource = {
    ...h.identity,
    chainId: 1,
    cashRaw,
    block: '26190000',
    blockHash: `0x${'a'.repeat(64)}`,
    blockTime: new Date(now - 1000).toISOString(),
    readAt: new Date(now).toISOString(),
    sourceKind: 'live_read_only_two_origin_finalized',
  }
  return {
    history: structuredClone(h),
    currentSource: source,
    request: { requestedRaw, asOf: new Date(now).toISOString() },
  }
}
function estimated(i = input()) {
  const r = buildConditionalSampledCashPathProjection(i, hash)
  if (r.status !== 'estimated') throw Error(r.reason)
  return r
}
function selected(r: unknown, i = input(), clock = now) {
  return selectedConditionalSampledCashPathProjection(
    r,
    {
      identity: i.history.identity,
      requestedRaw: i.request.requestedRaw,
      currentSource: i.currentSource,
      asOfMs: clock,
    },
    hash,
  )
}
describe('joint future daily sampled native cash paths', () => {
  it('retains every joint episode and all seven actual observed horizons', () => {
    const r = estimated()
    expect(r.counts).toMatchObject({ samples: 120, eligibleEpisodes: 17, gapRejectedEpisodes: 0 })
    expect(r.scenarios).toHaveLength(17)
    expect(r.horizons).toHaveLength(7)
    for (const s of r.scenarios) {
      const origin = BigInt(h.points[s.episodeIndex * 7][4])
      s.capacityRaw.forEach((v, j) => {
        const translated = 100n + BigInt(h.points[s.episodeIndex * 7 + j][4]) - origin
        expect(v).toBe((translated < 0n ? 0n : translated).toString())
        expect(s.userHeadroomRaw[j]).toBe((BigInt(v) - 90n).toString())
      })
      expect(s.troughObservation).toBe(
        s.capacityRaw.findIndex(
          (v) => v === s.capacityRaw.reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b)),
        ),
      )
    }
    r.horizons.forEach((v, j) => {
      const times = r.scenarios.map((s) => s.elapsedSeconds[j + 1])
      expect(v.target.lowerSeconds).toBe(Math.min(...times))
      expect(v.target.upperSeconds).toBe(Math.max(...times))
      expect(Date.parse(v.target.earliestAt)).toBe(
        Date.parse(r.currentSource.blockTime) + Math.min(...times) * 1000,
      )
      expect(Date.parse(v.target.earliestAt)).toBeGreaterThan(now)
    })
    expect(r.holderExecutableExit).toBe(false)
    expect(r.forwardProbability).toBe(false)
    expect(selected(r)).not.toBeNull()
  })
  it('averages floors per path, preserves signed deficits and empirical joint order statistics', () => {
    const r = estimated(input('0', '900000000000000000000000000'))
    for (const [j, v] of r.horizons.entries()) {
      const capacity = r.scenarios.map((s) => BigInt(s.capacityRaw[j + 1])),
        margin = r.scenarios.map((s) => BigInt(s.userHeadroomRaw[j + 1])),
        sum = margin.reduce((a, b) => a + b, 0n),
        n = BigInt(margin.length)
      expect(v.capacity.mean.numeratorRaw).toBe(capacity.reduce((a, b) => a + b, 0n).toString())
      expect(v.userHeadroom.mean).toEqual({
        numeratorRaw: sum.toString(),
        denominator: 17,
        floorRaw: (sum / n - (sum < 0n && sum % n !== 0n ? 1n : 0n)).toString(),
      })
      const sorted = margin.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(v.userHeadroom.p10Raw).toBe(sorted[1].toString())
      expect(v.userHeadroom.p90Raw).toBe(sorted[14].toString())
      expect(v.userHeadroom.maximumRaw.startsWith('-')).toBe(true)
    }
    for (const s of r.scenarios) {
      expect(s.sampledShortfalls).toEqual([
        {
          firstBelowObservation: 0,
          lastBelowObservation: 7,
          onset: null,
          recovery: null,
          leftCensored: true,
          rightCensored: true,
          sampledSpanSeconds: s.elapsedSeconds[7],
        },
      ])
    }
  })
  it('reports honest sampled onset/recovery brackets for every observed run', () => {
    const r = estimated()
    let runCount = 0
    for (const s of r.scenarios)
      for (const run of s.sampledShortfalls) {
        runCount++
        const at = (j: number) =>
          new Date(Date.parse(r.currentSource.blockTime) + s.elapsedSeconds[j] * 1000).toISOString()
        if (run.firstBelowObservation > 0)
          expect(run.onset).toEqual({
            earliestAt: at(run.firstBelowObservation - 1),
            latestAt: at(run.firstBelowObservation),
          })
        if (run.lastBelowObservation < 7)
          expect(run.recovery).toEqual({
            earliestAt: at(run.lastBelowObservation),
            latestAt: at(run.lastBelowObservation + 1),
          })
      }
    expect(runCount).toBeGreaterThan(0)
  })
  it('allows 109 postdeployment observations without zero-filling eleven leading anchors', () => {
    const i = input()
    i.history = history({
      ...subject,
      route_key: 'USDC → VaultV2 [USDC]',
      destination: '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
    })
    i.currentSource = { ...i.currentSource, ...i.history.identity }
    const r = estimated(i)
    expect(r.counts).toMatchObject({ samples: 109, eligibleEpisodes: 15 })
    expect(r.history.coverage.leadingPredeploymentAnchorCount).toBe(11)
    expect(r.scenarios[0].originAnchorIndex).toBe(11)
  })
  it('accepts distinct genuine local source metadata, never a live alias', () => {
    const i = input()
    i.currentSource.sourceKind = 'manifest_bound_ledger'
    i.currentSource.manifestSha256 = h.witness.manifestSha256
    i.currentSource.receiptSha256 = 'b'.repeat(64)
    const r = estimated(i)
    expect(selected(r, i)).not.toBeNull()
    delete i.currentSource.receiptSha256
    expect(buildConditionalSampledCashPathProjection(i, hash)).toEqual({
      status: 'unavailable',
      reason: 'invalid_current_source',
    })
  })
  it('rejects training after C2 even with fresh response/read clocks', () => {
    const i = input()
    i.currentSource.block = (BigInt(h.points.at(-1)![1]) - 1n).toString()
    expect(buildConditionalSampledCashPathProjection(i, hash)).toEqual({
      status: 'unavailable',
      reason: 'historical_training_after_source',
    })
  })
  it('rejects the unsupported two-origin claim for manifest-bound ledger evidence', () => {
    const i = input()
    i.currentSource.sourceKind = 'manifest_bound_ledger'
    i.currentSource.manifestSha256 = h.witness.manifestSha256
    i.currentSource.receiptSha256 = 'b'.repeat(64)
    const valid = estimated(i)
    expect(valid.currentSource.sourceKind).toBe('manifest_bound_ledger')
    const misleading = 'manifest_bound_two_origin_ledger' as ConditionalSampledCashCurrentSource['sourceKind']
    i.currentSource.sourceKind = misleading
    expect(buildConditionalSampledCashPathProjection(i, hash)).toEqual({
      status: 'unavailable',
      reason: 'invalid_current_source',
    })
    i.currentSource.sourceKind = 'manifest_bound_ledger'
    expect(selected({ ...valid, currentSource: { ...valid.currentSource, sourceKind: misleading } }, i)).toBeNull()
  })
  it.each(['cash', 'block', 'hash', 'time', 'anchor', 'coverage', 'receipt', 'manifest', 'hole'])(
    'rejects corrupted pinned %s history',
    (field) => {
      const i = input()
      if (field === 'cash') i.history.points[1][4] = '0'
      if (field === 'block') i.history.points[1][1] = '1'
      if (field === 'hash') i.history.points[1][2] = `0x${'b'.repeat(64)}`
      if (field === 'time') i.history.points[1][3] = i.history.points[0][3]
      if (field === 'anchor') i.history.points[1][0]++
      if (field === 'coverage') i.history.coverage.leadingPredeploymentAnchorCount++
      if (field === 'receipt') i.history.witness.lastDailyReceiptSha256 = 'b'.repeat(64)
      if (field === 'manifest') i.history.witness.manifestSha256 = 'b'.repeat(64)
      if (field === 'hole') i.history.points.splice(3, 1)
      expect(buildConditionalSampledCashPathProjection(i, hash)).toEqual({
        status: 'unavailable',
        reason: 'history_unverified',
      })
    },
  )
  it.each(['0', '-1', '1.2', '01', '0x10', '9'.repeat(79)])('rejects invalid native Q %s', (q) => {
    expect(buildConditionalSampledCashPathProjection(input('100', q), hash)).toEqual({
      status: 'unavailable',
      reason: 'invalid_requested_raw',
    })
  })
  it('uses 30-minute inclusive freshness and does not retime response projections', () => {
    const i = input()
    i.currentSource.blockTime = new Date(now - 1800000).toISOString()
    const r = estimated(i)
    expect(selected(r, i)).not.toBeNull()
    expect(selected(r, i, now + 1)).toBeNull()
    i.currentSource.blockTime = new Date(now - 1800001).toISOString()
    expect(buildConditionalSampledCashPathProjection(i, hash)).toEqual({
      status: 'unavailable',
      reason: 'source_stale',
    })
  })
  it.each([
    'futureRead',
    'futureSource',
    'readBeforeSource',
    'crossAsset',
    'crossDecimals',
    'arrayBlock',
    'unverifiedKind',
  ])('rejects %s current source', (kind) => {
    const i = input()
    if (kind === 'futureRead') i.currentSource.readAt = new Date(now + 1).toISOString()
    if (kind === 'futureSource') i.currentSource.blockTime = new Date(now + 1).toISOString()
    if (kind === 'readBeforeSource') i.currentSource.readAt = new Date(now - 2000).toISOString()
    if (kind === 'crossAsset') i.currentSource.asset = `0x${'b'.repeat(40)}`
    if (kind === 'crossDecimals') i.currentSource.assetDecimals = 18
    if (kind === 'arrayBlock') i.currentSource.block = [] as never
    if (kind === 'unverifiedKind') i.currentSource.sourceKind = 'local' as never
    expect(buildConditionalSampledCashPathProjection(i, hash).status).toBe('unavailable')
  })
  it.each([
    'q',
    'cash',
    'hash',
    'clock',
    'mean',
    'quantile',
    'path',
    'censor',
    'flag',
    'history',
    'objectArray',
  ])('browser drops forged or externally mismatched %s independently', (field) => {
    const i = input()
    const r: any = estimated(i)
    if (field === 'q') i.request.requestedRaw = '91'
    if (field === 'cash') i.currentSource.cashRaw = '101'
    if (field === 'hash') i.currentSource.blockHash = `0x${'b'.repeat(64)}`
    if (field === 'clock') r.request.asOf = new Date(now + 1).toISOString()
    if (field === 'mean') r.horizons[0].capacity.mean.floorRaw = '1'
    if (field === 'quantile') r.horizons[0].userHeadroom.p10Raw = '1'
    if (field === 'path') r.scenarios[0].capacityRaw[1] = '1'
    if (field === 'censor') r.scenarios[0].sampledShortfalls = []
    if (field === 'flag') r.holderExecutableExit = true
    if (field === 'history') r.history.points[1][4] = '1'
    if (field === 'objectArray') r.horizons = Object.assign({}, r.horizons)
    expect(selected(r, i)).toBeNull()
  })
  it('does not mutate input evidence or source', () => {
    const i = input(),
      before = structuredClone(i)
    const r = estimated(i)
    r.history.points[0][4] = '0'
    r.currentSource.cashRaw = '0'
    expect(i).toEqual(before)
  })
})
