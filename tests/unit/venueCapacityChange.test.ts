import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import handler, {
  buildObservedCapacityChange,
  readObservedCapacityChange,
} from '@/pages/api/venues/capacity-change'
import { appendLocalVenueSnapshot } from '@/scripts/lib/localVenueSnapshotStore.mjs'
import recorderConfig from '@/tools/venue-recorder.config.json'

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`
const SOURCE_AT = 1790805600 // 2026-09-30T22:00:00Z
const NOW = (SOURCE_AT + 180) * 1000
const disk = () => ({ bavail: 2_000_000_000, bsize: 4096 })
const tempRoots: string[] = []

function root() {
  const out = mkdtempSync(join(tmpdir(), 'capacity-change-'))
  tempRoots.push(out)
  return out
}

function point(venue: string, block: string, hash: string, timestamp: number, usd: number) {
  const depth = venue === 'sUSDe' || venue === 'sUSDS' || venue === 'scrvUSD'
  const configured = recorderConfig.venues.find((item) => item.name === venue)!
  return {
    venue,
    chain: 'ethereum',
    source: { block, hash, timestamp, finalized: true, pinned: true },
    observedAtUtc: new Date((timestamp + 30) * 1000).toISOString(),
    params: {
      depth_usd: depth ? usd : null,
      read_block_finalized: true,
      read_block_pinned: true,
      read_block_number: block,
      read_block_hash: hash,
      read_block_time: timestamp,
      kind: configured.kind,
      depth_complete: true,
      depthMarkets: configured.depthMarkets
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
                wrapperUsdsOnchain: configured.underlying,
                toutRaw: '0',
                buyGemState: 'open',
                exitableUsd: usd,
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
      underlyingIdentity: 'match',
      decimalsIdentity: 'match',
      underlyingOnchain: configured.underlying,
      underlyingDecimalsOnchain: configured.decimals,
      aToken: configured.address,
      vault: configured.address,
      withdrawalsPaused: false,
      reads: { underlyingBalance: true },
    },
    instantUsd: depth ? null : usd,
    coolingUsd: null,
    strandedUsd: null,
  }
}

function pair(venue: string, before: number, after: number) {
  const out = root()
  const first = appendLocalVenueSnapshot(point(venue, '26093000', HASH_A, SOURCE_AT - 60, before), {
    out,
    stat: disk as never,
    now: () => new Date((SOURCE_AT - 20) * 1000),
  }).record
  const second = appendLocalVenueSnapshot(point(venue, '26093001', HASH_B, SOURCE_AT, after), {
    out,
    stat: disk as never,
    now: () => new Date((SOURCE_AT + 60) * 1000),
  }).record
  return { out, first, second }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const out of tempRoots.splice(0)) rmSync(out, { recursive: true, force: true })
})

describe('observed local capacity change', () => {
  it('reports a material sUSDe depth decline with both finalized sources and no forecast', () => {
    const { out, first, second } = pair('sUSDe', 20_000_000, 19_000_000)
    const result = readObservedCapacityChange('sUSDe', { root: out, nowMs: NOW })
    expect(result).toMatchObject({
      venue: 'sUSDe',
      metric: 'depthUsd',
      signal: {
        status: 'observed_shrinking',
        threshold: { minimumDeclineUsd: 100_000, minimumDeclinePercent: 1 },
        before: { usd: 20_000_000, block: first.source.block, blockHash: HASH_A },
        after: { usd: 19_000_000, block: second.source.block, blockHash: HASH_B },
        declineUsd: 1_000_000,
        declinePercent: 5,
        flowStatus: 'not_measured',
        continuity: 'not_established',
        meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
        forecast: {
          status: 'unavailable',
          futureExitProbability: null,
          likelyDurationSeconds: null,
        },
      },
    })
  })

  it('uses instant cash for sGHO and suppresses sub-threshold sUSDS drift', () => {
    const cash = pair('sGHO', 20_000_000, 19_500_000)
    expect(readObservedCapacityChange('sGHO', { root: cash.out, nowMs: NOW }).signal.status).toBe(
      'observed_shrinking',
    )
    const depth = pair('sUSDS', 4_164_000_000, 4_162_839_000)
    const signal = readObservedCapacityChange('sUSDS', { root: depth.out, nowMs: NOW }).signal
    expect(signal.status).toBe('none')
    expect('declinePercent' in signal && signal.declinePercent).toBeCloseTo(0.0279, 3)
  })

  it('does not label a rise, a missing pair, or stale points as shrinking', () => {
    const rising = pair('scrvUSD', 30_000_000, 31_000_000)
    expect(
      readObservedCapacityChange('scrvUSD', { root: rising.out, nowMs: NOW }).signal.status,
    ).toBe('none')
    expect(
      readObservedCapacityChange('scrvUSD', { root: rising.out, nowMs: NOW + 3 * 3600_000 + 1 })
        .signal,
    ).toEqual({ status: 'unavailable', reason: 'latest_point_stale_or_future' })
    const empty = root()
    expect(readObservedCapacityChange('sUSDe', { root: empty, nowMs: NOW }).signal).toEqual({
      status: 'unavailable',
      reason: 'fewer_than_two_verified_points',
    })
  })

  it('censors a decline across recorder downtime instead of presenting it as current', () => {
    const out = root()
    const early = SOURCE_AT - 4 * 3600
    appendLocalVenueSnapshot(point('sUSDe', '26092000', HASH_A, early, 20_000_000), {
      out,
      stat: disk as never,
      now: () => new Date((early + 60) * 1000),
    })
    appendLocalVenueSnapshot(point('sUSDe', '26093000', HASH_B, SOURCE_AT, 19_000_000), {
      out,
      stat: disk as never,
      now: () => new Date((SOURCE_AT + 60) * 1000),
    })
    expect(readObservedCapacityChange('sUSDe', { root: out, nowMs: NOW }).signal).toEqual({
      status: 'unavailable',
      reason: 'comparison_gap_unbounded',
    })
  })

  it('rejects a broken local predecessor and a tampered comparison', () => {
    const { out, first, second } = pair('sUSDe', 20_000_000, 19_000_000)
    expect(buildObservedCapacityChange('sUSDe', null, second, NOW).signal.status).toBe(
      'unavailable',
    )
    expect(
      buildObservedCapacityChange('sUSDe', { ...first, sha256: 'wrong' }, second, NOW).signal,
    ).toEqual({ status: 'unavailable', reason: 'noncomparable_local_points' })
    expect(
      buildObservedCapacityChange(
        'sUSDe',
        first,
        {
          ...second,
          measurement: {
            ...second.measurement,
            params: { ...second.measurement.params, depthMarkets: [] },
          },
        },
        NOW,
      ).signal,
    ).toEqual({ status: 'unavailable', reason: 'noncomparable_local_points' })
    const path = join(out, 'sUSDe', '000000000002.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.comparison.deltas.depthUsd.current = 1
    writeFileSync(path, `${JSON.stringify(saved)}\n`)
    expect(() => readObservedCapacityChange('sUSDe', { root: out, nowMs: NOW })).toThrow(
      /local_snapshot_sha_mismatch/,
    )
  })

  it('withholds Curve changes when either adjacent snapshot lacks pinned coin identities', () => {
    const { first, second } = pair('scrvUSD', 30_000_000, 29_000_000)
    const withoutCoins = (snapshot: typeof first) => ({
      ...snapshot,
      measurement: {
        ...snapshot.measurement,
        params: {
          ...snapshot.measurement.params,
          depthMarkets: snapshot.measurement.params.depthMarkets.map((market: any) => {
            const { coinsIdentity, coin0Onchain, coin1Onchain, ...oldMarket } = market
            return oldMarket
          }),
        },
      },
    })
    expect(buildObservedCapacityChange('scrvUSD', withoutCoins(first), second, NOW).signal).toEqual(
      {
        status: 'unavailable',
        reason: 'noncomparable_local_points',
      },
    )
    expect(buildObservedCapacityChange('scrvUSD', first, withoutCoins(second), NOW).signal).toEqual(
      {
        status: 'unavailable',
        reason: 'noncomparable_local_points',
      },
    )
    const badMarket = {
      ...second,
      measurement: {
        ...second.measurement,
        params: {
          ...second.measurement.params,
          depthMarkets: second.measurement.params.depthMarkets.map((market: any, index: number) =>
            index === 1 ? { ...market, coin0Onchain: '0xdead' } : market,
          ),
        },
      },
    }
    expect(buildObservedCapacityChange('scrvUSD', first, badMarket, NOW).signal).toEqual({
      status: 'unavailable',
      reason: 'noncomparable_local_points',
    })
  })

  it('withholds sUSDS PSM changes without the pinned wrapper path', () => {
    const { first, second } = pair('sUSDS', 4_000_000, 3_500_000)
    expect(buildObservedCapacityChange('sUSDS', first, second, NOW).signal.status).toBe(
      'observed_shrinking',
    )
    const badMarket = (change: Record<string, unknown>) => ({
      ...second,
      measurement: {
        ...second.measurement,
        params: {
          ...second.measurement.params,
          depthMarkets: [{ ...second.measurement.params.depthMarkets[0], ...change }],
        },
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
      expect(buildObservedCapacityChange('sUSDS', first, badMarket(change), NOW).signal).toEqual({
        status: 'unavailable',
        reason: 'noncomparable_local_points',
      })
    }

    const haltedPair = pair('sUSDS', 4_000_000, 0)
    const halted = {
      ...haltedPair.second,
      measurement: {
        ...haltedPair.second.measurement,
        params: {
          ...haltedPair.second.measurement.params,
          depthMarkets: [
            {
              ...haltedPair.second.measurement.params.depthMarkets[0],
              toutRaw: ((1n << 256n) - 1n).toString(),
              buyGemState: 'halted',
              exitableUsd: 0,
            },
          ],
        },
      },
    }
    expect(buildObservedCapacityChange('sUSDS', haltedPair.first, halted, NOW).signal.status).toBe(
      'observed_shrinking',
    )
  })
})

describe('GET /api/venues/capacity-change boundary', () => {
  async function request(
    remoteAddress: string,
    query: Record<string, unknown> = {},
    method = 'GET',
  ) {
    let code = 0
    let body: unknown
    const headers: Record<string, string> = {}
    const res = {
      setHeader: (key: string, value: string) => {
        headers[key] = value
      },
      status: (value: number) => {
        code = value
        return res
      },
      json: (value: unknown) => {
        body = value
        return res
      },
    }
    handler({ method, query, socket: { remoteAddress } } as never, res as never)
    return { code, body, headers }
  }

  it('blocks production and non-loopback requests before local disk reads', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect((await request('192.0.2.5')).code).toBe(503)
    vi.stubEnv('NODE_ENV', 'production')
    expect((await request('127.0.0.1')).code).toBe(503)
  })

  it('validates method and venue, and uses no-store on all responses', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    expect((await request('127.0.0.1', {}, 'POST')).code).toBe(405)
    expect((await request('127.0.0.1', { venue: ['sGHO'] })).code).toBe(400)
    expect((await request('127.0.0.1', { venue: '../secret' })).code).toBe(400)
    expect((await request('127.0.0.1', { venue: 'sGHO' })).headers['Cache-Control']).toBe(
      'no-store',
    )
  })
})
