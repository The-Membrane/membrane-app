import { describe, expect, it, vi } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { ROUTE_EVENT_FEED_COVERAGE, type RouteEventQuestion } from '@/lib/carry/routeEventContext'
import {
  createRouteContextHandler,
  eligibleLocalCapacitySource,
  localAaveUsdeCapacity,
} from '@/pages/api/carry/route-context'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const registry = () =>
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )

const enrolledQuery = {
  routeKey: 'GHO → sGho [GHO]',
  destination: GHO_SGHO.destination,
  requestedRaw: '10000000000000000000000',
  payoutAsset: GHO_SGHO.borrowAsset,
  assetDecimals: '18',
  horizonHours: '24',
}

const unavailable = { status: 'unavailable' as const, reason: 'source_unavailable' as const }

function readers(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: () => Date.parse('2026-10-05T00:00:00.000Z'),
    registry,
    readEvent: vi.fn(async () => unavailable),
    readNews: vi.fn(async () => unavailable),
    readCapacity: vi.fn(async () => unavailable),
    ...overrides,
  }
}

async function request(
  handler: ReturnType<typeof createRouteContextHandler>,
  query: Record<string, unknown>,
  method = 'GET',
) {
  let code = 0
  let body: unknown
  const headers: Record<string, string> = {}
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value
      return res
    }),
    status: vi.fn((value: number) => {
      code = value
      return res
    }),
    json: vi.fn((value: unknown) => {
      body = value
      return res
    }),
  }
  await handler({ method, query, socket: { remoteAddress: '127.0.0.1' } } as never, res as never)
  return { code, body: body as any, headers }
}

describe('GET /api/carry/route-context', () => {
  it('binds all six question fields before reading the exact recorder venue', async () => {
    const deps = readers()
    const result = await request(createRouteContextHandler(deps), enrolledQuery)
    expect(result.code).toBe(200)
    expect(result.headers['Cache-Control']).toBe('no-store')
    expect(result.body).toMatchObject({
      status: 'route_event_context',
      question: {
        ...enrolledQuery,
        assetDecimals: 18,
        horizonHours: 24,
      },
      venue: 'sGHO',
      association: 'contemporaneous_facts_no_causal_attribution',
      event: { status: 'source_unavailable' },
      news: { status: 'source_unavailable' },
      capacity: { status: 'source_unavailable' },
      newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
      coverage: ROUTE_EVENT_FEED_COVERAGE,
    })
    expect(deps.readEvent).toHaveBeenCalledWith('sGHO', Date.parse('2026-10-05T00:00:00.000Z'))
    expect(deps.readNews).toHaveBeenCalledWith(
      'sGHO',
      'Aave sGHO savings',
      Date.parse('2026-10-05T00:00:00.000Z'),
      expect.anything(),
    )
    expect(deps.readCapacity).toHaveBeenCalledWith(
      {
        ...enrolledQuery,
        assetDecimals: 18,
        horizonHours: 24,
      },
      Date.parse('2026-10-05T00:00:00.000Z'),
      expect.anything(),
      'sGHO',
    )
  })

  it('keeps the event recorder gap separate from protocol headlines and capacity', async () => {
    const injectedNow = Date.parse('2035-01-02T00:00:00.000Z')
    const readCapacity = vi.fn(async (question: RouteEventQuestion) => ({
      status: 'available' as const,
      value: {
        routeKey: question.routeKey,
        destination: question.destination,
        payoutAsset: question.payoutAsset,
        assetDecimals: question.assetDecimals,
        metric: 'aggregate_cash_raw' as const,
        observations: [
          {
            raw: '20000000000',
            block: '26120000',
            blockHash: `0x${'a'.repeat(64)}`,
            blockTime: '2035-01-01T11:00:00.000Z',
            sourceId: 'first',
          },
          {
            raw: '15000000000',
            block: '26120300',
            blockHash: `0x${'b'.repeat(64)}`,
            blockTime: '2035-01-01T12:00:00.000Z',
            sourceId: 'second',
          },
        ],
        verification: 'local_hash_chain_replay' as const,
        meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' as const,
      },
    }))
    const deps = readers({ nowMs: () => injectedNow, readCapacity })
    const result = await request(createRouteContextHandler(deps), {
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      requestedRaw: '10000000000',
      payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      assetDecimals: '6',
      horizonHours: '24',
    })
    expect(result.code).toBe(200)
    expect(result.body).toMatchObject({
      status: 'route_event_context',
      venue: null,
      newsSource: 'aave-v3-usdc',
      event: { status: 'not_recorded' },
      news: { status: 'source_unavailable' },
      capacity: {
        status: 'observed',
        beforeRaw: '20000000000',
        afterRaw: '15000000000',
        requestedShareBefore: '50%',
        requestedShareAfter: '66.67%',
        direction: 'shrinking',
      },
      coverage: ROUTE_EVENT_FEED_COVERAGE,
      newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
    })
    expect(deps.readEvent).not.toHaveBeenCalled()
    expect(deps.readNews).toHaveBeenCalledWith(
      'aave-v3-usdc',
      'Aave V3 USDC',
      injectedNow,
      expect.anything(),
    )
    expect(readCapacity).toHaveBeenCalledOnce()
  })

  it('shows a raw protocol headline on a known route with no event recorder', async () => {
    const deps = readers({
      readNews: vi.fn(async () => ({
        status: 'available',
        coverage: 'observed_items',
        observedItemCount: 1,
        observedAt: '2026-10-04T22:10:01.000Z',
        items: [
          {
            venue: 'spark',
            title: 'Spark protocol headline',
            source: 'Publisher',
            url: 'https://news.example.com/spark',
            publishedAt: '2026-10-04T22:00:00.000Z',
            fetchedAt: '2026-10-04T22:10:00.000Z',
          },
        ],
      })),
    })
    const result = await request(createRouteContextHandler(deps), {
      routeKey: 'USDS → StUsds [USDS]',
      destination: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
      requestedRaw: '1000000000000000000',
      payoutAsset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
      assetDecimals: '18',
      horizonHours: '24',
    })
    expect(result).toMatchObject({
      code: 200,
      body: {
        venue: null,
        newsSource: 'spark',
        event: { status: 'not_recorded' },
        news: {
          status: 'observed',
          title: 'Spark protocol headline',
          treatment: 'raw_headline',
          coverage: 'observed_items',
          observedItemCount: 1,
          observedAt: '2026-10-04T22:10:01.000Z',
        },
        forecastValidated: false,
      },
    })
    expect(deps.readEvent).not.toHaveBeenCalled()
  })

  it('replays the real local cash archive for an unenrolled tracked route', async () => {
    const result = await request(createRouteContextHandler(), {
      routeKey: 'USDC → supply on Aave V3',
      destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      requestedRaw: '10000000000',
      payoutAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      assetDecimals: '6',
      horizonHours: '24',
    })
    expect(result).toMatchObject({
      code: 200,
      body: {
        status: 'route_event_context',
        event: { status: 'not_recorded' },
        capacity: {
          metric: 'aggregate_cash_raw',
          verification: 'local_hash_chain_replay',
        },
      },
    })
    expect(result.body.capacity.status).toBe('observed')
    expect(result.body.capacity.requestedShareBefore).toMatch(/^\d+(?:\.\d{1,2})?%$/)
    expect(result.body.capacity.requestedShareAfter).toMatch(/^\d+(?:\.\d{1,2})?%$/)
  })

  it('replays the supplemental Aave USDe point chain by its exact recorder mapping', () => {
    const capacity = localAaveUsdeCapacity(
      {
        routeKey: 'USDe → supply on Aave V3',
        destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
        requestedRaw: '10000000000000000000000',
        payoutAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
        assetDecimals: 18,
        horizonHours: 24,
      },
      'aave-v3-usde',
    )
    expect(capacity).toMatchObject({
      status: 'available',
      value: {
        routeKey: 'USDe → supply on Aave V3',
        verification: 'local_hash_chain_replay',
      },
    })
    if (capacity?.status !== 'available') throw new Error('expected supplemental local capacity')
    expect(capacity.value.observations).toHaveLength(2)
    expect(BigInt(capacity.value.observations[1].block)).toBeGreaterThan(
      BigInt(capacity.value.observations[0].block),
    )
  })

  it('lets stale, future, or overlong local pairs fall through to the database source', () => {
    const nowMs = Date.parse('2026-10-05T00:00:00.000Z')
    const candidate = (beforeAt: string, afterAt: string) => ({
      status: 'available' as const,
      value: {
        routeKey: enrolledQuery.routeKey,
        destination: enrolledQuery.destination,
        payoutAsset: enrolledQuery.payoutAsset,
        assetDecimals: 18,
        metric: 'aggregate_cash_raw' as const,
        observations: [
          {
            raw: '200',
            block: '26120000',
            blockHash: `0x${'a'.repeat(64)}`,
            blockTime: beforeAt,
            sourceId: 'first',
          },
          {
            raw: '150',
            block: '26120300',
            blockHash: `0x${'b'.repeat(64)}`,
            blockTime: afterAt,
            sourceId: 'second',
          },
        ],
        verification: 'local_hash_chain_replay' as const,
        meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' as const,
      },
    })
    expect(
      eligibleLocalCapacitySource(
        candidate('2026-10-04T11:00:00.000Z', '2026-10-04T12:00:00.000Z'),
        nowMs,
      ),
    ).toBe(true)
    for (const source of [
      candidate('2026-10-03T22:00:00.000Z', '2026-10-03T23:00:00.000Z'),
      candidate('2026-09-27T22:59:59.000Z', '2026-10-04T23:00:00.000Z'),
      candidate('2026-10-04T23:05:00.001Z', '2026-10-05T00:05:00.001Z'),
    ])
      expect(eligibleLocalCapacitySource(source, nowMs)).toBe(false)
  })

  it('rejects payout and recorder-decimal identity drift before opening any source', async () => {
    for (const query of [
      { ...enrolledQuery, payoutAsset: `0x${'1'.repeat(40)}` },
      { ...enrolledQuery, assetDecimals: '6' },
    ]) {
      const deps = readers()
      const result = await request(createRouteContextHandler(deps), query)
      expect(result).toMatchObject({
        code: 409,
        body: { error: 'route_event_identity_mismatch' },
      })
      expect(deps.readEvent).not.toHaveBeenCalled()
    }
  })

  it('distinguishes malformed and unknown questions and enforces GET', async () => {
    const deps = readers()
    expect(
      await request(createRouteContextHandler(deps), { ...enrolledQuery, requestedRaw: '1.0' }),
    ).toMatchObject({ code: 400, body: { error: 'invalid_route_event_question' } })
    expect(
      await request(createRouteContextHandler(deps), {
        ...enrolledQuery,
        routeKey: 'unknown',
      }),
    ).toMatchObject({ code: 404, body: { error: 'unknown_route_destination' } })
    expect(await request(createRouteContextHandler(deps), enrolledQuery, 'POST')).toMatchObject({
      code: 405,
      body: { error: 'GET only' },
    })
  })

  it('fails closed if the registry coverage changes', async () => {
    const changed = registry()
    changed.routeGroups[0].contractSubjects[0].sourceCoverage.recorderVenues = ['invented']
    const deps = readers({ registry: () => changed })
    const result = await request(createRouteContextHandler(deps), enrolledQuery)
    expect(result).toMatchObject({
      code: 503,
      body: { error: 'route_event_coverage_mismatch' },
    })
  })
})
