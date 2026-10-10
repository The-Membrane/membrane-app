import { describe, expect, it } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  carryNewsSources,
  resolveRouteNewsSource,
  routeNewsCatalogMatchesRegistry,
  routeNewsCoverage,
} from '@/lib/carry/routeNewsSources'
import {
  buildRouteEventContext,
  expectedRouteEventEnrollment,
  matchingRouteEventContext,
  resolveRouteEventEnrollment,
  routeEventCoverage,
  ROUTE_EVENT_CONTEXT_ASSOCIATION,
  ROUTE_EVENT_FEED_COVERAGE,
  safeHeadlineUrl,
  type RouteEventQuestion,
} from '@/lib/carry/routeEventContext'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const registry = buildCarryForecastRegistry(
  ROUTES,
  seed,
  recorderConfig.venues,
  GHO_SGHO.destination,
  verifiedDirectSupplyDestinations(),
)

const question: RouteEventQuestion = {
  routeKey: 'GHO → sGho [GHO]',
  destination: GHO_SGHO.destination,
  requestedRaw: '25000000000000000000000000',
  payoutAsset: GHO_SGHO.borrowAsset,
  assetDecimals: 18,
  horizonHours: 24,
}

const NOW_MS = Date.parse('2026-10-05T00:00:00.000Z')
const ENROLLED = { status: 'enrolled' as const, venue: 'sGHO' }
const NOT_ENROLLED = { status: 'not_enrolled' as const }

const point = (overrides: Record<string, unknown> = {}) => ({
  raw: '100000000000000000000000000',
  block: '26120000',
  blockHash: `0x${'a'.repeat(64)}`,
  blockTime: '2026-10-04T11:00:00.000Z',
  sourceId: 'b'.repeat(64),
  ...overrides,
})

const sources = () => ({
  event: {
    status: 'available' as const,
    entries: [
      {
        venue: 'sGHO',
        kind: 'liquidity_shift',
        at: '2026-10-04T10:00:00.000Z',
        provenance: 'observed' as const,
      },
      {
        venue: 'sGHO',
        kind: 'withdrawals_paused_changed',
        at: '2026-10-04T12:00:00.000Z',
        provenance: 'observed' as const,
      },
    ],
  },
  news: {
    status: 'available' as const,
    coverage: 'observed_items' as const,
    observedItemCount: 2,
    observedAt: '2026-10-04T13:10:00.000Z',
    items: [
      {
        venue: 'sGHO',
        title: 'Unsafe headline',
        source: 'Unsafe',
        url: 'http://127.0.0.1/private',
        publishedAt: '2026-10-04T13:00:00.000Z',
        fetchedAt: '2026-10-04T13:10:00.000Z',
      },
      {
        venue: 'sGHO',
        title: 'Verbatim protocol headline',
        source: 'Publisher',
        url: 'https://news.example.com/story?id=1',
        publishedAt: '2026-10-04T12:30:00.000Z',
        fetchedAt: '2026-10-04T13:10:00.000Z',
      },
    ],
  },
  capacity: {
    status: 'available' as const,
    value: {
      routeKey: question.routeKey,
      destination: question.destination,
      payoutAsset: question.payoutAsset,
      assetDecimals: question.assetDecimals,
      metric: 'aggregate_cash_raw' as const,
      observations: [
        point(),
        point({
          raw: '50000000000000000000000000',
          block: '26120300',
          blockHash: `0x${'c'.repeat(64)}`,
          blockTime: '2026-10-04T12:00:00.000Z',
          sourceId: 'd'.repeat(64),
        }),
      ],
      verification: 'local_hash_chain_replay' as const,
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' as const,
    },
  },
})

describe('route event context', () => {
  it('covers every exact public route subject with destination-protocol headlines', () => {
    expect(routeNewsCatalogMatchesRegistry(registry)).toBe(true)
    expect(routeNewsCoverage(registry)).toEqual({
      routeGroups: { enrolled: 26, total: 26 },
      subjects: { enrolled: 68, total: 68 },
    })
    expect(carryNewsSources).toHaveLength(16)
    expect(new Set(carryNewsSources.map((source) => source.id)).size).toBe(16)
    for (const group of registry.routeGroups) {
      for (const subject of group.contractSubjects) {
        const source = resolveRouteNewsSource(group.routeKey, subject.destinationAddress)
        expect(source?.query).toBeTruthy()
        expect(
          resolveRouteNewsSource(group.routeKey, '0x0000000000000000000000000000000000000000'),
        ).toBeNull()
      }
    }
    expect(
      resolveRouteNewsSource('USDS → StUsds [USDS]', '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9')
        ?.id,
    ).toBe('spark')
    expect(
      resolveRouteNewsSource('USDS → SUsds [USDS]', '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd')
        ?.id,
    ).toBe('sUSDS')
    expect(
      resolveRouteNewsSource(
        'USDe → supply on Aave V3',
        '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
      )?.id,
    ).toBe('aave-v3-usde')
    expect(routeEventCoverage(registry)).toEqual(ROUTE_EVENT_FEED_COVERAGE)
  })

  it('derives exactly four Carry enrollments only from exact registry source coverage', () => {
    expect(routeEventCoverage(registry)).toEqual(ROUTE_EVENT_FEED_COVERAGE)
    const enrolled = registry.routeGroups.flatMap((group) =>
      group.contractSubjects.flatMap((subject) => {
        const result = resolveRouteEventEnrollment(
          registry,
          group.routeKey,
          subject.destinationAddress,
        )
        return result.status === 'enrolled'
          ? [{ routeKey: group.routeKey, venue: result.venue }]
          : []
      }),
    )
    expect(enrolled).toEqual([
      { routeKey: 'USDe → Staked USDe [USDe]', venue: 'sUSDe' },
      { routeKey: 'GHO → sGho [GHO]', venue: 'sGHO' },
      { routeKey: 'USDS → SUsds [USDS]', venue: 'sUSDS' },
      { routeKey: 'USDe → supply on Aave V3', venue: 'aave-v3-usde' },
    ])
    expect(resolveRouteEventEnrollment(registry, 'USDC → VaultV2 [USDC]', '0xdead')).toEqual({
      status: 'unknown_route_destination',
    })
    expect(expectedRouteEventEnrollment([])).toEqual(NOT_ENROLLED)
    expect(expectedRouteEventEnrollment(['sGHO'])).toEqual(ENROLLED)
    expect(expectedRouteEventEnrollment(['sGHO', 'sUSDe'])).toBeNull()
    expect(expectedRouteEventEnrollment(undefined)).toBeNull()
  })

  it('composes one recent event, one safe raw headline, and a verified Q-share move', () => {
    const result = buildRouteEventContext(question, 'sGHO', sources(), NOW_MS)
    expect(result).toMatchObject({
      status: 'route_event_context',
      association: ROUTE_EVENT_CONTEXT_ASSOCIATION,
      event: {
        status: 'observed',
        kind: 'withdrawals_paused_changed',
        provenance: 'observed',
      },
      news: {
        status: 'observed',
        title: 'Verbatim protocol headline',
        url: 'https://news.example.com/story?id=1',
        treatment: 'raw_headline',
        coverage: 'observed_items',
        observedItemCount: 2,
        observedAt: '2026-10-04T13:10:00.000Z',
      },
      capacity: {
        status: 'observed',
        direction: 'shrinking',
        beforeRaw: '100000000000000000000000000',
        afterRaw: '50000000000000000000000000',
        assetDecimals: 18,
        requestedShareBefore: '25%',
        requestedShareAfter: '50%',
        verification: 'local_hash_chain_replay',
      },
      newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
      forecastValidated: false,
      prospectiveValidated: false,
      holderExecutableExit: false,
    })
    expect(matchingRouteEventContext(result, question, ENROLLED, NOW_MS)).toEqual(result)
  })

  it('drops stale or future headlines rather than presenting them as current context', () => {
    for (const item of [
      {
        venue: 'sGHO',
        title: 'Stale headline',
        source: 'Publisher',
        url: 'https://news.example.com/stale',
        publishedAt: '2026-09-27T23:59:59.999Z',
        fetchedAt: '2026-10-04T13:10:00.000Z',
      },
      {
        venue: 'sGHO',
        title: 'Future headline',
        source: 'Publisher',
        url: 'https://news.example.com/future',
        publishedAt: '2026-10-05T00:05:00.001Z',
        fetchedAt: '2026-10-05T00:05:00.001Z',
      },
    ]) {
      const result = buildRouteEventContext(
        question,
        'sGHO',
        {
          ...sources(),
          news: {
            status: 'available',
            coverage: 'observed_items',
            observedItemCount: 1,
            observedAt: '2026-10-04T13:10:00.000Z',
            items: [item],
          },
        },
        NOW_MS,
      )
      expect(result.news).toEqual({ status: 'source_unavailable', reason: 'source_unavailable' })
    }
  })

  it('rejects stale and overlong capacity pairs at composition time', () => {
    const candidate = (beforeAt: string, afterAt: string) => ({
      ...sources(),
      capacity: {
        ...sources().capacity,
        value: {
          ...sources().capacity.value,
          observations: [
            point({ blockTime: beforeAt }),
            point({
              raw: '50000000000000000000000000',
              block: '26120300',
              blockHash: `0x${'c'.repeat(64)}`,
              blockTime: afterAt,
              sourceId: 'd'.repeat(64),
            }),
          ],
        },
      },
    })
    for (const input of [
      candidate('2026-10-03T22:00:00.000Z', '2026-10-03T23:00:00.000Z'),
      candidate('2026-09-27T22:59:59.000Z', '2026-10-04T23:00:00.000Z'),
    ]) {
      expect(buildRouteEventContext(question, 'sGHO', input, NOW_MS).capacity).toEqual({
        status: 'source_unavailable',
        reason: 'source_unavailable',
      })
    }
  })

  it('rejects malformed numeric event kinds and raw values without throwing', () => {
    const malformed = {
      ...sources(),
      event: {
        status: 'available' as const,
        entries: [
          {
            venue: 'sGHO',
            kind: 7,
            at: '2026-10-04T12:00:00.000Z',
            provenance: 'observed' as const,
          },
        ],
      },
      capacity: {
        ...sources().capacity,
        value: {
          ...sources().capacity.value,
          observations: [point(), point({ raw: 7 })],
        },
      },
    }
    expect(() => buildRouteEventContext(question, 'sGHO', malformed as never, NOW_MS)).not.toThrow()
    const result = buildRouteEventContext(question, 'sGHO', malformed as never, NOW_MS)
    expect(result.event).toEqual({ status: 'none', reason: 'no_recent_observed_event' })
    expect(result.capacity).toEqual({ status: 'source_unavailable', reason: 'source_unavailable' })

    const valid = buildRouteEventContext(question, 'sGHO', sources(), NOW_MS)
    const numericKind = { ...valid, event: { ...valid.event, kind: 7 } }
    expect(() => matchingRouteEventContext(numericKind, question, ENROLLED, NOW_MS)).not.toThrow()
    expect(matchingRouteEventContext(numericKind, question, ENROLLED, NOW_MS)).toBeNull()
    expect(
      matchingRouteEventContext(
        { ...valid, capacity: { ...valid.capacity, beforeRaw: 7 } },
        question,
        ENROLLED,
        NOW_MS,
      ),
    ).toBeNull()
  })

  it('keeps an empty headline feed unavailable rather than treating it as quiet', () => {
    const empty = buildRouteEventContext(
      question,
      'sGHO',
      {
        event: { status: 'available', entries: [] },
        news: {
          status: 'available',
          coverage: 'observed_items',
          observedItemCount: 0,
          observedAt: '2026-10-04T13:10:00.000Z',
          items: [],
        },
        capacity: {
          status: 'available',
          value: {
            ...sources().capacity.value,
            observations: [
              point(),
              point({
                block: '26120300',
                blockHash: `0x${'c'.repeat(64)}`,
                blockTime: '2026-10-04T12:00:00.000Z',
                sourceId: 'd'.repeat(64),
              }),
            ],
          },
        },
      },
      NOW_MS,
    )
    expect(empty.event).toEqual({ status: 'none', reason: 'no_recent_observed_event' })
    expect(empty.news).toEqual({ status: 'source_unavailable', reason: 'source_unavailable' })
    expect(empty.capacity).toEqual({ status: 'none', reason: 'no_verified_capacity_move' })

    const unavailable = buildRouteEventContext(
      question,
      'sGHO',
      {
        event: { status: 'unavailable', reason: 'source_unavailable' },
        news: { status: 'unavailable', reason: 'source_unavailable' },
        capacity: { status: 'unavailable', reason: 'source_unavailable' },
      },
      NOW_MS,
    )
    expect(unavailable.event.status).toBe('source_unavailable')
    expect(unavailable.news.status).toBe('source_unavailable')
    expect(unavailable.capacity.status).toBe('source_unavailable')
  })

  it('preserves bounded latest-item coverage without inferring quiet or impact', () => {
    const bounded = {
      ...sources(),
      news: { ...sources().news, coverage: 'latest_items_only' as const },
    }
    const result = buildRouteEventContext(question, 'sGHO', bounded, NOW_MS)
    expect(result.news).toMatchObject({
      status: 'observed',
      coverage: 'latest_items_only',
      observedItemCount: 2,
      treatment: 'raw_headline',
    })
    expect(result.newsImpact).toEqual({ status: 'unavailable', reason: 'no_causal_model' })
    expect(matchingRouteEventContext(result, question, ENROLLED, NOW_MS)).toEqual(result)
    expect(
      matchingRouteEventContext(
        { ...result, news: { ...result.news, coverage: 'complete_feed' } },
        question,
        ENROLLED,
        NOW_MS,
      ),
    ).toBeNull()
  })

  it('selects the first safe headline in sealed parser order', () => {
    const ordered = sources()
    ordered.news = {
      ...ordered.news,
      observedItemCount: 2,
      items: [
        {
          venue: 'sGHO',
          title: 'First sealed item',
          source: 'First publisher',
          url: 'https://news.example.com/first',
          publishedAt: '2026-10-04T11:00:00.000Z',
          fetchedAt: '2026-10-04T09:00:00.000Z',
        },
        {
          venue: 'sGHO',
          title: 'Later sealed item with newer publication time',
          source: 'Second publisher',
          url: 'https://news.example.com/second',
          publishedAt: '2026-10-04T13:00:00.000Z',
          fetchedAt: '2026-10-04T14:00:00.000Z',
        },
      ],
    }
    const result = buildRouteEventContext(question, 'sGHO', ordered, NOW_MS)
    expect(result.news).toMatchObject({
      status: 'observed',
      title: 'First sealed item',
      source: 'First publisher',
      observedAt: ordered.news.observedAt,
    })
  })

  it('fails closed on every exact-question field, URL safety, and causal or validation drift', () => {
    const result = buildRouteEventContext(question, 'sGHO', sources(), NOW_MS)
    const drifts = [
      { ...question, routeKey: 'USDS → SUsds [USDS]' },
      { ...question, destination: `0x${'1'.repeat(40)}` },
      { ...question, requestedRaw: '1' },
      { ...question, payoutAsset: `0x${'2'.repeat(40)}` },
      { ...question, assetDecimals: 6 },
      { ...question, horizonHours: 1 },
    ]
    for (const drift of drifts)
      expect(matchingRouteEventContext(result, drift, ENROLLED, NOW_MS)).toBeNull()
    expect(
      matchingRouteEventContext({ ...result, association: 'causal' }, question, ENROLLED, NOW_MS),
    ).toBeNull()
    expect(
      matchingRouteEventContext(
        { ...result, newsImpact: { status: 'available', reason: null } },
        question,
        ENROLLED,
        NOW_MS,
      ),
    ).toBeNull()
    expect(
      matchingRouteEventContext({ ...result, venue: 'sUSDe' }, question, ENROLLED, NOW_MS),
    ).toBeNull()
    expect(
      matchingRouteEventContext({ ...result, status: 'unavailable' }, question, ENROLLED, NOW_MS),
    ).toBeNull()
    expect(matchingRouteEventContext(result, question, NOT_ENROLLED, NOW_MS)).toBeNull()
    expect(
      matchingRouteEventContext({ ...result, forecastValidated: true }, question, ENROLLED, NOW_MS),
    ).toBeNull()
    expect(
      matchingRouteEventContext(
        { ...result, news: { ...result.news, url: 'https://127.0.0.1/private' } },
        question,
        ENROLLED,
        NOW_MS,
      ),
    ).toBeNull()
    expect(
      buildRouteEventContext(
        question,
        'sGHO',
        {
          ...sources(),
          capacity: {
            ...sources().capacity,
            value: {
              ...sources().capacity.value,
              destination: `0x${'1'.repeat(40)}`,
            },
          },
        },
        NOW_MS,
      ).capacity,
    ).toEqual({ status: 'source_unavailable', reason: 'source_unavailable' })
  })

  it('rechecks event, news, and capacity clocks when consuming a response', () => {
    const result = buildRouteEventContext(question, 'sGHO', sources(), NOW_MS)
    const capacityAt = (beforeAt: string, afterAt: string, elapsedSourceSeconds: number) => ({
      ...result,
      capacity: { ...result.capacity, beforeAt, afterAt, elapsedSourceSeconds },
    })
    const invalid = [
      { ...result, event: { ...result.event, at: '2026-09-27T23:59:59.999Z' } },
      { ...result, event: { ...result.event, at: '2026-10-05T00:05:00.001Z' } },
      {
        ...result,
        news: {
          ...result.news,
          publishedAt: '2026-09-27T23:59:59.999Z',
          observedAt: '2026-10-04T13:10:00.000Z',
        },
      },
      {
        ...result,
        news: {
          ...result.news,
          publishedAt: '2026-10-05T00:05:00.001Z',
          observedAt: '2026-10-05T00:05:00.001Z',
        },
      },
      capacityAt('2026-10-03T22:00:00.000Z', '2026-10-03T23:00:00.000Z', 3_600),
      capacityAt('2026-09-27T22:59:59.000Z', '2026-10-04T23:00:00.000Z', 604_801),
      capacityAt('2026-10-04T23:05:00.001Z', '2026-10-05T00:05:00.001Z', 3_600),
    ]
    for (const candidate of invalid)
      expect(matchingRouteEventContext(candidate, question, ENROLLED, NOW_MS)).toBeNull()

    expect(matchingRouteEventContext(result, question, NOT_ENROLLED, NOW_MS)).toBeNull()
  })

  it('rejects unsafe headline origins', () => {
    expect(safeHeadlineUrl('https://news.example.com/story?q=1')).toBe(
      'https://news.example.com/story?q=1',
    )
    for (const value of [
      'http://news.example.com/story',
      'https://localhost/story',
      'https://127.0.0.1/story',
      'https://user:pass@news.example.com/story',
      'javascript:alert(1)',
    ])
      expect(safeHeadlineUrl(value)).toBeNull()
  })
})
