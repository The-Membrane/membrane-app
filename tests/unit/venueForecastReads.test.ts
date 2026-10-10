import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { db } from '@/db'
import {
  RECORDED_COST_LEVELS_PCT,
  type StoredCurvePassRow,
} from '@/lib/venueCapacity/capacityCurve'
import { depthRouteIdentity } from '@/scripts/lib/depth-identity.mjs'
import { appendLocalVenueCurvePass } from '@/scripts/lib/localVenueCurveStore.mjs'
import { measureSampledCapacityPersistence } from '@/lib/venueForecast/sampledCapacity'
import {
  forecastRoute,
  mapForecastSample,
  maxFlowsAfterCoveredDay,
  readVenueForecastEvidence,
  readVenueMeasuredPersistenceEvidence,
} from '@/pages/api/_lib/venueForecastReads'
import { makeReceipt, requiredStreamIdentities, streamsFor } from '@/scripts/record-venue-flows.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

vi.mock('@/db', () => ({ db: { execute: vi.fn() } }))

const at = '2026-09-27T12:00:00Z'
const seal = {
  read_block_finalized: true,
  read_block_pinned: true,
  read_block_number: '12345678',
  read_block_hash: `0x${'a'.repeat(64)}`,
  read_block_time: Math.floor(Date.parse(at) / 1000) - 60,
}
const row = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  block: '12345678',
  observed_at: at,
  created_at: '2026-09-27T12:00:05Z',
  instant_usd: '9000000',
  params: { ...seal, depth_usd: 8000000, depth_complete: true, totalAssets: '2000000000000000000' },
  ...overrides,
})
const venueRow = (venueName: string, id: string, overrides: Record<string, unknown> = {}) => {
  const venue = recorderConfig.venues.find((item) => item.name === venueName)!
  const base = row(id, overrides)
  return {
    ...base,
    params: {
      ...(base.params as Record<string, unknown>),
      kind: venue.kind,
      aToken: venue.address,
      vault: venue.address,
      underlyingOnchain: venue.underlying,
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      underlyingDecimalsOnchain: venue.decimals,
      reads: { underlyingBalance: true },
      depthMarkets: venue.depthMarkets
        ?.filter((market) => market.enabled)
        .map((market) =>
          market.kind === 'psm-buffer'
            ? {
                ...market,
                pocketIdentity: 'match',
                gemIdentity: 'match',
                exitIdentity: 'match',
                pocketOnchain: market.buffer,
                gemOnchain: market.bufferToken,
                wrapperIdentity: 'match',
                wrapperPsmOnchain: market.address,
                wrapperPocketOnchain: market.buffer,
                wrapperUsdsOnchain: venue.underlying,
                toutRaw: '0',
                buyGemState: 'open',
                exitableUsd: 8_000_000,
              }
            : market.kind === 'curve-stableswap'
              ? {
                  ...market,
                  coinsIdentity: 'match',
                  coin0Onchain: market.token0,
                  coin1Onchain: market.token1,
                }
              : market,
        ),
    },
  }
}

const flowRows = [
  {
    block: '101',
    block_time: '2026-09-26T00:00:00.000000Z',
    direction: 'in',
    assets_raw: '2000000000000000000',
    tx_hash: `0x${'1'.repeat(64)}`,
    log_index: 0,
  },
  {
    block: '150',
    block_time: '2026-09-27T01:00:00.000000Z',
    direction: 'out',
    assets_raw: '7000000000000000000',
    tx_hash: `0x${'2'.repeat(64)}`,
    log_index: 0,
  },
  {
    block: '150',
    block_time: '2026-09-27T01:00:00.000000Z',
    direction: 'out',
    assets_raw: '3000000000000000000',
    tx_hash: `0x${'3'.repeat(64)}`,
    log_index: 0,
  },
]

function sealedFlowReceipt() {
  const streams = streamsFor({
    name: 'sUSDe',
    kind: 'erc4626-cooldown',
    address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
  })
  return makeReceipt({
    venue: 'sUSDe',
    from: 100n,
    to: 200n,
    fromHash: `0x${'a'.repeat(64)}`,
    toHash: `0x${'b'.repeat(64)}`,
    finalized: { number: 250n, hash: `0x${'c'.repeat(64)}` },
    identities: requiredStreamIdentities(streams),
    counts: [1, 2],
    rows: flowRows,
  })
}

function mockReadWithFlow(receipt: Record<string, unknown>, rows: Record<string, unknown>[]) {
  const execute = vi.mocked(db.execute)
  execute.mockResolvedValueOnce({ rows: [venueRow('sUSDe', 'latest')] } as never)
  execute.mockResolvedValueOnce({ rows: [venueRow('sUSDe', 'latest')] } as never)
  execute.mockResolvedValueOnce({ rows: [{ rows: '1' }] } as never)
  execute.mockResolvedValueOnce({ rows: [receipt] } as never)
  execute.mockResolvedValueOnce({ rows } as never)
}

describe('measured persistence source reads', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
  })
  const localRoots: string[] = []
  const localRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'measured-local-curves-'))
    localRoots.push(root)
    return root
  }
  afterEach(() =>
    localRoots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
  )
  const venue = recorderConfig.venues.find((item) => item.name === 'scrvUSD')!
  const markets = venue.depthMarkets!.filter((market) => market.enabled)
  const curvePass = (block: number): StoredCurvePassRow[] =>
    markets.map((market) => ({
      market: market.name,
      block,
      block_row_count: markets.length,
      observed_at: new Date(Date.parse(at) + (block - 100) * 3_600_000).toISOString(),
      points: RECORDED_COST_LEVELS_PCT.map((costPct, index) => ({
        costPct,
        capacityUsd: (index + 1) * 1000,
      })),
      meta: {
        configIdentity: depthRouteIdentity(venue, market),
        sourceBlockTime: new Date(
          Date.parse(at) + (block - 100) * 3_600_000 - 60_000,
        ).toISOString(),
        sourceBlockHash: `0x${block.toString(16).padStart(64, '0')}`,
      },
    }))
  const appendLocal = (
    root: string,
    block: number,
    capacityUsd = 100,
    oldConfig = false,
    receiptAt?: string,
  ) => {
    const rows = curvePass(block)
    const meta = rows[0].meta as Record<string, string>
    const observedAtUtc = rows[0].observed_at as string
    const identities = Object.fromEntries(
      markets.map((market) => [
        market.name,
        oldConfig ? 'e'.repeat(64) : depthRouteIdentity(venue, market),
      ]),
    )
    return appendLocalVenueCurvePass(
      {
        venue: venue.name,
        chainId: 1,
        block: String(block),
        sourceBlockHash: meta.sourceBlockHash,
        sourceBlockTime: meta.sourceBlockTime,
        observedAtUtc,
        finalized: true,
        pinned: true,
        expectedIdentities: identities,
        markets: markets.map((market) => ({
          market: market.name,
          configIdentity: identities[market.name],
          points: RECORDED_COST_LEVELS_PCT.map((costPct, index) => ({
            costPct,
            capacityUsd: (capacityUsd * (index + 1)) / (4 * markets.length),
          })),
        })),
      },
      { root, minFreeBytes: 0, now: () => new Date(receiptAt ?? observedAtUtc) },
    )
  }
  const localEvidence = { storage: 'local_mac_recorder' } as never

  it('reads local complete recorded curves without Neon, preserving source clock and first receipt', async () => {
    const root = localRoot()
    const receiptAt = '2026-09-27T12:05:00.000Z'
    const saved = appendLocal(root, 100, 120, false, receiptAt)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', {
      allowLocalFallback: true,
      localCurveRoot: root,
      forecastEvidence: localEvidence,
    })
    expect(result).toMatchObject({
      storage: 'local_mac_recorder',
      costCapPct: 1,
      unavailableReason: null,
      coverage: { returnedSamples: 1, truncated: false, localVerification: 'from_local_start' },
    })
    expect(result.samples[0]).toMatchObject({
      capacityUsd: 120,
      coverage: 'complete',
      observedAt: '2026-09-27T11:59:00.000Z',
      firstAvailableAt: receiptAt,
      sourceId: `local_venue_curve_pass_v1:${saved.record!.sha256}`,
    })
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('prefers a present local curve mirror before any database call, with exact levels and bounded read disclosure', async () => {
    const root = localRoot()
    for (let block = 100; block < 104; block++) appendLocal(root, block)
    vi.mocked(db.execute).mockImplementation(() => {
      throw new Error('database must never run')
    })
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', {
      allowLocalFallback: true,
      localCurveRoot: root,
      curveLimit: 2,
      costCapPct: 2,
    })
    expect(result.storage).toBe('local_mac_recorder')
    expect(result.samples.map((sample) => sample.capacityUsd)).toEqual([125, 125])
    expect(result.coverage).toMatchObject({
      returnedSamples: 2,
      truncated: true,
      localVerification: 'bounded_tail_links',
    })
    expect(result.coverage.localReadBytes).toBeLessThanOrEqual(4 * 32 * 1024)
    expect(db.execute).not.toHaveBeenCalled()
    expect(
      await readVenueMeasuredPersistenceEvidence('scrvUSD', {
        allowLocalFallback: true,
        localCurveRoot: root,
        forecastEvidence: localEvidence,
        costCapPct: 0.75,
      }),
    ).toMatchObject({ unavailableReason: 'cost_cap_not_recorded', samples: [] })
  })

  it('empty local mirror can use existing database curves without retaining local provenance', async () => {
    const root = localRoot()
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: curvePass(100) } as never)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', {
      allowLocalFallback: true,
      localCurveRoot: root,
    })
    expect(result).toMatchObject({ storage: 'database', unavailableReason: null })
    expect(result.samples[0].coverage).toBe('complete')
    expect(result.coverage.localReadBytes).toBeUndefined()
    expect(result.coverage.localVerification).toBeUndefined()
    expect(db.execute).toHaveBeenCalledTimes(1)
  })

  it('retains an old configured pass as a partial censor and missing cadence slots as gaps', async () => {
    const root = localRoot()
    appendLocal(root, 100, 90, true)
    appendLocal(root, 101, 100)
    appendLocal(root, 103, 110)
    appendLocal(root, 104, 90)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', {
      allowLocalFallback: true,
      localCurveRoot: root,
      forecastEvidence: localEvidence,
    })
    expect(result.samples.at(-1)).toMatchObject({ coverage: 'partial', capacityUsd: null })
    const measured = measureSampledCapacityPersistence({
      venue: result.venue,
      routeKey: result.routeKey,
      costCapPct: result.costCapPct,
      amountUsd: 100,
      asOf: '2026-09-27T16:01:00Z',
      cadenceHours: result.cadenceHours,
      snapshots: result.samples,
    })
    expect(measured.longestCompletedRun).toBeNull()
    expect(measured.coverage).toMatchObject({ missingExpectedSamples: 1, excessiveGaps: 1 })
  })

  it('fresh local receipt cannot refresh an old source block; damaged local tail is typed unavailable', async () => {
    const root = localRoot()
    appendLocal(root, 100, 120, false, '2026-09-28T12:00:00.000Z')
    const options = {
      allowLocalFallback: true,
      localCurveRoot: root,
      forecastEvidence: localEvidence,
    }
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', options)
    const measured = measureSampledCapacityPersistence({
      venue: result.venue,
      routeKey: result.routeKey,
      costCapPct: result.costCapPct,
      amountUsd: 100,
      asOf: '2026-09-28T12:00:01Z',
      cadenceHours: result.cadenceHours,
      snapshots: result.samples,
    })
    expect(measured.currentStatus).toBe('censored')
    expect(measured.currentRun).toBeNull()
    appendFileSync(join(root, 'scrvUSD.jsonl'), '{')
    expect(
      await readVenueMeasuredPersistenceEvidence('scrvUSD', {
        allowLocalFallback: true,
        localCurveRoot: root,
        forecastEvidence: { storage: 'database' } as never,
      }),
    ).toMatchObject({
      storage: 'local_mac_recorder',
      unavailableReason: 'local_curve_source_invalid',
      samples: [],
    })
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('reads complete same-block curves at exactly the recorded default 1% level', async () => {
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [...curvePass(101), ...curvePass(100)],
    } as never)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD')
    expect(result).toMatchObject({
      source: 'recorded_cost_curve',
      costCapPct: 1,
      costCapSelection: 'default_recorded_level',
      cadenceHours: 1,
      unavailableReason: null,
      coverage: { returnedSamples: 2, maxCurvePasses: 20, truncated: false },
    })
    expect(result.routeKey).toContain('recorded_cost_curve')
    expect(result.samples).toHaveLength(2)
    expect(result.samples[0]).toMatchObject({
      block: 101,
      capacityUsd: 4000 * markets.length,
      coverage: 'complete',
      observedAt: '2026-09-27T12:59:00.000Z',
      firstAvailableAt: '2026-09-27T13:00:00.000Z',
    })
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1)
  })

  it('keeps failed latest, truncated and mixed-hash passes as null samples', async () => {
    const failed = curvePass(103)
    failed[0].meta = { ...(failed[0].meta as object), error: 'quote_reverted' }
    const truncated = curvePass(102).slice(0, 1)
    const mixed = curvePass(101)
    mixed[1].meta = { ...(mixed[1].meta as object), sourceBlockHash: `0x${'f'.repeat(64)}` }
    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [...failed, ...truncated, ...mixed, ...curvePass(100)],
    } as never)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD')
    expect(result.samples.map((sample) => sample.capacityUsd)).toEqual([
      null,
      null,
      null,
      4000 * markets.length,
    ])
    expect(result.samples.map((sample) => sample.coverage)).toEqual([
      'partial',
      'partial',
      'partial',
      'complete',
    ])
    expect(result.samples[0].observedAt).toBe('2026-09-27T15:00:00.000Z')
  })

  it('rejects a changed route identity or missing recorded cost level without inventing interpolation', async () => {
    const changed = curvePass(101)
    changed[0].meta = { ...(changed[0].meta as object), configIdentity: 'different-route' }
    const missing = curvePass(100)
    missing[0].points = (missing[0].points as Array<{ costPct: number }>).filter(
      (point) => point.costPct !== 1,
    )
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [...changed, ...missing] } as never)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD')
    expect(result.samples.every((sample) => sample.capacityUsd === null)).toBe(true)
    vi.mocked(db.execute).mockClear()
    const unrecorded = await readVenueMeasuredPersistenceEvidence('scrvUSD', { costCapPct: 0.75 })
    expect(unrecorded).toMatchObject({
      costCapPct: 0.75,
      costCapSelection: 'requested_recorded_level',
      unavailableReason: 'cost_cap_not_recorded',
      samples: [],
    })
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('never replaces unavailable local curves or failed curve reads with depth inventory', async () => {
    const local = await readVenueMeasuredPersistenceEvidence('scrvUSD', {
      forecastEvidence: {
        storage: 'local_mac_recorder',
        samples: [{ capacityUsd: 99_000_000 }],
      } as never,
    })
    expect(local).toMatchObject({ unavailableReason: 'local_curves_unavailable', samples: [] })
    expect(db.execute).not.toHaveBeenCalled()
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('database unavailable'))
    expect(await readVenueMeasuredPersistenceEvidence('scrvUSD')).toMatchObject({
      unavailableReason: 'curve_source_unavailable',
      samples: [],
    })
  })

  it('reuses verified cash evidence and preserves a failed separately-read latest sample', async () => {
    const aave = recorderConfig.venues.find((item) => item.name === 'aave-v3-usde')!
    const route = forecastRoute(aave)
    const latest = mapForecastSample(
      venueRow(aave.name, 'latest', { instant_usd: null }),
      route,
      aave,
    )
    const older = mapForecastSample(venueRow(aave.name, 'older'), route, aave)
    const result = await readVenueMeasuredPersistenceEvidence(aave.name, {
      forecastEvidence: {
        venue: aave.name,
        chainId: 1,
        storage: 'database',
        route,
        latest,
        samples: [older],
        coverage: { truncated: true },
      } as never,
    })
    expect(result).toMatchObject({
      source: 'recorded_cash',
      costCapPct: null,
      costCapSelection: 'not_applicable',
      coverage: { truncated: true },
    })
    expect(result.samples.map((sample) => sample.sourceId)).toEqual(['latest', 'older'])
    expect(result.samples[0].capacityUsd).toBeNull()
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('enforces the same bounded 20-pass history cap as the curve reader', async () => {
    await expect(
      readVenueMeasuredPersistenceEvidence('scrvUSD', { curveLimit: 21 }),
    ).rejects.toThrow('integer from 1 to 20')
    expect(db.execute).not.toHaveBeenCalled()
    vi.mocked(db.execute).mockResolvedValueOnce({ rows: curvePass(100) } as never)
    const result = await readVenueMeasuredPersistenceEvidence('scrvUSD', { curveLimit: 1 })
    expect(result.coverage.truncated).toBe(true)
  })
})

describe('venue forecast evidence reads', () => {
  beforeEach(() => {
    vi.mocked(db.execute).mockReset()
  })

  it('reads observed mainnet Aave cash with physical provenance and uncertified flow', async () => {
    const execute = vi.mocked(db.execute)
    execute.mockResolvedValueOnce({ rows: [venueRow('aave-v3-usde', 'latest')] } as never)
    execute.mockResolvedValueOnce({
      rows: [venueRow('aave-v3-usde', 'latest'), venueRow('aave-v3-usde', 'older')],
    } as never)
    execute.mockResolvedValueOnce({
      rows: [{ rows: '2', span_start: '2026-09-01T00:00:00Z', span_end: at }],
    } as never)
    execute.mockResolvedValueOnce({ rows: [] } as never)

    const evidence = await readVenueForecastEvidence('aave-v3-usde')
    expect(evidence.chainId).toBe(1)
    expect(evidence.route).toMatchObject({
      kind: 'aave_reserve_cash',
      metric: 'instant_usd',
      limit: 'reserve_cash',
    })
    expect(evidence.latest).toMatchObject({
      sourceId: 'latest',
      source: 'observed',
      block: 12345678,
      capacityUsd: 9000000,
      coverage: 'complete',
      observedAt: '2026-09-27T11:59:00.000Z',
      firstAvailableAt: '2026-09-27T12:00:05.000Z',
    })
    expect(evidence.coverage).toMatchObject({
      observedRows: 2,
      returnedRows: 2,
      truncated: false,
      flowStatus: 'uncertified',
      maxGrossOutflowUsd: null,
      maxNetOutflowUsd: null,
      exitDurationDistribution: null,
    })
    expect(execute).toHaveBeenCalledTimes(4)
  })

  it.each(['sUSDe', 'sUSDS', 'scrvUSD'])(
    'uses secondary swap-in inventory for %s and keeps protocol redemption separate',
    async (venue) => {
      const execute = vi.mocked(db.execute)
      execute.mockResolvedValueOnce({ rows: [venueRow(venue, 'latest')] } as never)
      execute.mockResolvedValueOnce({ rows: [venueRow(venue, 'latest')] } as never)
      execute.mockResolvedValueOnce({
        rows: [{ rows: '1', span_start: at, span_end: at }],
      } as never)
      execute.mockResolvedValueOnce({ rows: [] } as never)
      const evidence = await readVenueForecastEvidence(venue)
      expect(evidence.route).toMatchObject({
        metric: 'depth_usd',
        kind: 'secondary_swap_in_inventory',
        limit: 'raw_swap_in_inventory',
      })
      expect(evidence.latest).toMatchObject({
        capacityUsd: 8000000,
        coverage: 'complete',
        tvlUsd: 2,
      })
      expect(evidence.latest?.cooldownSeconds).toBeNull()
    },
  )

  it('keeps legacy and mismatched Curve rows partial while preserving PSM depth', () => {
    for (const venueName of ['sUSDe', 'scrvUSD']) {
      const venue = recorderConfig.venues.find((item) => item.name === venueName)!
      const route = forecastRoute(venue)
      const verified = venueRow(venueName, 'verified')
      expect(mapForecastSample(verified, route, venue).capacityUsd).toBe(8_000_000)
      const params = verified.params as Record<string, any>
      const legacy = {
        ...verified,
        params: {
          ...params,
          depthMarkets: params.depthMarkets.map((market: any) => {
            const { coinsIdentity, coin0Onchain, coin1Onchain, ...oldMarket } = market
            return oldMarket
          }),
        },
      }
      expect(mapForecastSample(legacy, route, venue)).toMatchObject({
        capacityUsd: null,
        coverage: 'partial',
      })
      const mismatched = {
        ...verified,
        params: {
          ...params,
          depthMarkets: params.depthMarkets.map((market: any, index: number) =>
            index === 0 ? { ...market, coin1Onchain: '0xdead' } : market,
          ),
        },
      }
      expect(mapForecastSample(mismatched, route, venue).capacityUsd).toBeNull()
    }
    const psm = recorderConfig.venues.find((item) => item.name === 'sUSDS')!
    expect(mapForecastSample(venueRow('sUSDS', 'psm'), forecastRoute(psm), psm).capacityUsd).toBe(
      8_000_000,
    )
  })

  it('requires the pinned Sky wrapper path before using PSM depth', () => {
    const venue = recorderConfig.venues.find((item) => item.name === 'sUSDS')!
    const route = forecastRoute(venue)
    const verified = venueRow('sUSDS', 'verified-psm')
    expect(mapForecastSample(verified, route, venue).capacityUsd).toBe(8_000_000)
    const params = verified.params as Record<string, any>
    const withMarket = (change: Record<string, unknown>) => ({
      ...verified,
      params: {
        ...params,
        depthMarkets: [{ ...params.depthMarkets[0], ...change }],
      },
    })
    for (const change of [
      { wrapperIdentity: undefined, wrapperPsmOnchain: undefined },
      { wrapperIdentity: 'mismatch' },
      { wrapperPsmOnchain: '0xdead' },
      { wrapperPocketOnchain: '0xdead' },
      { wrapperUsdsOnchain: '0xdead' },
      { wrapper: '0xdead' },
      { exitIdentity: 'unknown' },
      { toutRaw: undefined, buyGemState: undefined },
      { toutRaw: '1000000000000000001', buyGemState: 'open' },
      { toutRaw: '01', buyGemState: 'open' },
      { toutRaw: '0', buyGemState: 'halted' },
      { toutRaw: ((1n << 256n) - 1n).toString(), buyGemState: 'open' },
      { exitableUsd: null, buyGemState: 'open' },
      { exitableUsd: 1, buyGemState: 'open' },
    ]) {
      expect(mapForecastSample(withMarket(change), route, venue)).toMatchObject({
        capacityUsd: null,
        coverage: 'partial',
      })
    }

    const halted = withMarket({
      toutRaw: ((1n << 256n) - 1n).toString(),
      buyGemState: 'halted',
      exitableUsd: 0,
    })
    expect(mapForecastSample(halted, route, venue).capacityUsd).toBeNull()
    expect(
      mapForecastSample(
        { ...halted, params: { ...(halted.params as Record<string, unknown>), depth_usd: 0 } },
        route,
        venue,
      ).capacityUsd,
    ).toBe(0)
  })

  it('keeps sGHO vault cash separate from swap inventory and rejects an unverified asset identity', async () => {
    const route = forecastRoute({
      name: 'sGHO',
      kind: 'erc4626-vault-cash',
      address: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
      underlying: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
      enabled: true,
    })
    expect(route).toMatchObject({ kind: 'vault_cash', metric: 'instant_usd', limit: 'vault_cash' })
    const verified = mapForecastSample(
      row('sgho', {
        params: {
          ...seal,
          underlyingIdentity: 'match',
          decimalsIdentity: 'match',
          withdrawalsPaused: false,
          totalAssets: '2000000000000000000',
        },
      }),
      route,
    )
    expect(verified).toMatchObject({ capacityUsd: 9000000, coverage: 'complete', tvlUsd: 2 })
    const mismatch = mapForecastSample(
      row('sgho-bad', {
        params: {
          ...seal,
          underlyingIdentity: 'mismatch',
          decimalsIdentity: 'match',
          withdrawalsPaused: false,
        },
      }),
      route,
    )
    expect(mismatch).toMatchObject({ capacityUsd: null, coverage: 'partial' })
  })

  it('retains a failed latest read and rejects legacy false-zero depth', () => {
    const route = forecastRoute({
      name: 'sUSDe',
      kind: 'erc4626-cooldown',
      address: '0x1',
      enabled: true,
      depthMarkets: [{ name: 'pool', enabled: true, exitFrom: '0x1' }],
    })
    expect(
      mapForecastSample(row('failed', { params: { depth_usd: 0, depth_complete: false } }), route)
        .capacityUsd,
    ).toBeNull()
    expect(
      mapForecastSample(
        row('legacy', {
          observed_at: '2026-09-20T00:00:00Z',
          params: { depth_usd: 0 },
        }),
        route,
      ).capacityUsd,
    ).toBeNull()
    expect(
      mapForecastSample(row('true-zero', { params: { depth_usd: 0, depth_complete: true } }), route)
        .capacityUsd,
    ).toBe(0)
  })

  it('does not replace a failed latest snapshot with an older healthy reading', async () => {
    const execute = vi.mocked(db.execute)
    execute.mockResolvedValueOnce({
      rows: [
        venueRow('sUSDe', 'latest-failed', { params: { depth_usd: null, depth_complete: false } }),
      ],
    } as never)
    execute.mockResolvedValueOnce({
      rows: [
        venueRow('sUSDe', 'latest-failed', { params: { depth_usd: null, depth_complete: false } }),
        venueRow('sUSDe', 'older-good', { observed_at: '2026-09-27T11:00:00Z' }),
      ],
    } as never)
    execute.mockResolvedValueOnce({ rows: [{ rows: '2' }] } as never)
    execute.mockResolvedValueOnce({ rows: [] } as never)

    const evidence = await readVenueForecastEvidence('sUSDe')
    expect(evidence.latest?.sourceId).toBe('latest-failed')
    expect(evidence.latest?.capacityUsd).toBeNull()
    expect(evidence.latest?.coverage).toBe('unverified')
    expect(evidence.samples[1].capacityUsd).toBe(8000000)
  })

  it('does not date information before observation or accept unknown venues', async () => {
    const route = forecastRoute({
      name: 'aave',
      kind: 'atoken-liquidity',
      address: '0x1',
      enabled: true,
    })
    expect(
      mapForecastSample(row('bad-clock', { created_at: '2026-09-27T11:00:00Z' }), route)
        .firstAvailableAt,
    ).toBeNull()
    expect(mapForecastSample(row('sealed'), route).coverage).toBe('complete')
    expect(mapForecastSample(row('missing-seal', { params: {} }), route).coverage).toBe(
      'unverified',
    )
    expect(mapForecastSample(row('partial', { instant_usd: null }), route).coverage).toBe('partial')
    await expect(readVenueForecastEvidence('not-configured')).rejects.toThrow(
      'Unknown enabled venue',
    )
    expect(db.execute).not.toHaveBeenCalled()
  })

  it('withholds 24h maximum when receipt source start time is missing', async () => {
    mockReadWithFlow(sealedFlowReceipt(), flowRows)
    const evidence = await readVenueForecastEvidence('sUSDe')
    expect(evidence.coverage).toMatchObject({
      flowStatus: 'sealed_partial',
      flowReason: 'source_start_time_missing',
      sealedRanges: 1,
      sealedEvents: 3,
      maxFlowWindowHours: 24,
      maxGrossOutflowUsd: null,
      maxNetOutflowUsd: null,
      exitDurationDistribution: null,
    })
  })

  it('includes early full-window peaks when the sealed source start precedes the first event', () => {
    const hour = 3_600_000
    const maximum = maxFlowsAfterCoveredDay(
      [
        { at: 25 * hour, direction: 'out', raw: 100n },
        { at: 26 * hour, direction: 'out', raw: 1n },
        { at: 50 * hour, direction: 'out', raw: 1n },
      ],
      0,
    )
    expect(maximum).toEqual({ maxGross: 101n, maxNet: 101n })
    expect(
      maxFlowsAfterCoveredDay([{ at: 25 * hour, direction: 'out', raw: 1n }], 2 * hour),
    ).toBeNull()
  })

  it('rejects an altered stored event instead of publishing a historical maximum', async () => {
    mockReadWithFlow(sealedFlowReceipt(), [
      flowRows[0],
      { ...flowRows[1], assets_raw: '8000000000000000000' },
      flowRows[2],
    ])
    const evidence = await readVenueForecastEvidence('sUSDe')
    expect(evidence.coverage).toMatchObject({
      flowStatus: 'invalid',
      maxGrossOutflowUsd: null,
      maxNetOutflowUsd: null,
    })
  })
})
