import type { CarryForecastRegistry } from './forecastRegistry'
import { resolveRouteNewsSource } from './routeNewsSources'

const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const EVENT_KIND = /^[a-z0-9_]{1,96}$/
const MAX_U256 = (1n << 256n) - 1n

export const ROUTE_EVENT_CONTEXT_ASSOCIATION =
  'contemporaneous_facts_no_causal_attribution' as const
export const ROUTE_EVENT_FEED_COVERAGE = {
  routeGroups: { enrolled: 4, total: 26 },
  subjects: { enrolled: 4, total: 68 },
} as const
export const ROUTE_NEWS_FEED_COVERAGE = {
  routeGroups: { enrolled: 26, total: 26 },
  subjects: { enrolled: 68, total: 68 },
} as const
export const ROUTE_EVENT_RECENT_MS = 7 * 24 * 60 * 60 * 1_000
export const ROUTE_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1_000
export const ROUTE_NEWS_RECENT_MS = 7 * 24 * 60 * 60 * 1_000
export const ROUTE_CAPACITY_RECENT_MS = 24 * 60 * 60 * 1_000
export const ROUTE_CAPACITY_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000

export type RouteEventQuestion = {
  routeKey: string
  destination: string
  requestedRaw: string
  payoutAsset: string
  assetDecimals: number
  horizonHours: number
}

export type RouteEventCandidate = {
  venue: string
  kind: string
  at: string
  provenance: 'observed'
}

export type RouteHeadlineCandidate = {
  venue: string
  title: string
  source: string
  url: string
  publishedAt: string | null
  fetchedAt: string
}

export type RouteCapacityCandidate = {
  routeKey: string
  destination: string
  payoutAsset: string
  assetDecimals: number
  metric: 'aggregate_cash_raw'
  observations: Array<{
    raw: string
    block: string
    blockHash: string
    blockTime: string
    sourceId: string
  }>
  verification: 'local_hash_chain_replay' | 'database_identity_checked'
  meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity'
}

export type RouteEventContextSources = {
  event:
    | { status: 'available'; entries: RouteEventCandidate[] }
    | { status: 'unavailable'; reason: 'source_unavailable' }
  news:
    | {
        status: 'available'
        coverage: 'observed_items' | 'latest_items_only'
        observedItemCount: number
        observedAt: string
        items: RouteHeadlineCandidate[]
      }
    | { status: 'unavailable'; reason: 'source_unavailable' }
  capacity:
    | { status: 'available'; value: RouteCapacityCandidate }
    | { status: 'unavailable'; reason: 'source_unavailable' }
}

type ContextEvent =
  | { status: 'observed'; kind: string; at: string; provenance: 'observed' }
  | { status: 'none'; reason: 'no_recent_observed_event' }
  | { status: 'not_recorded'; reason: 'recorder_not_enrolled' }
  | { status: 'source_unavailable'; reason: 'source_unavailable' }

type ContextNews =
  | {
      status: 'observed'
      title: string
      source: string
      url: string
      publishedAt: string | null
      observedAt: string
      treatment: 'raw_headline'
      coverage: 'observed_items' | 'latest_items_only'
      observedItemCount: number
    }
  | { status: 'source_unavailable'; reason: 'source_unavailable' }

type ContextCapacity =
  | {
      status: 'observed'
      metric: 'aggregate_cash_raw'
      direction: 'shrinking' | 'growing'
      beforeRaw: string
      afterRaw: string
      assetDecimals: number
      requestedShareBefore: string
      requestedShareAfter: string
      elapsedSourceSeconds: number
      beforeAt: string
      afterAt: string
      verification: 'local_hash_chain_replay' | 'database_identity_checked'
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity'
    }
  | { status: 'none'; reason: 'no_verified_capacity_move' }
  | { status: 'source_unavailable'; reason: 'source_unavailable' }

export type RouteEventContext = {
  status: 'route_event_context'
  question: RouteEventQuestion
  venue: string | null
  newsSource: string
  association: typeof ROUTE_EVENT_CONTEXT_ASSOCIATION
  event: ContextEvent
  news: ContextNews
  capacity: ContextCapacity
  newsImpact: { status: 'unavailable'; reason: 'no_causal_model' }
  forecastValidated: false
  prospectiveValidated: false
  holderExecutableExit: false
  coverage: typeof ROUTE_EVENT_FEED_COVERAGE
  newsCoverage: typeof ROUTE_NEWS_FEED_COVERAGE
}

export type RouteEventContextResponse = RouteEventContext

export type ExpectedRouteEventEnrollment =
  | { status: 'enrolled'; venue: string }
  | { status: 'not_enrolled' }

export type RouteEventEnrollment =
  | ExpectedRouteEventEnrollment
  | { status: 'unknown_route_destination' }

function validUtc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

export function validRouteEventQuestion(value: unknown): value is RouteEventQuestion {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const question = value as Partial<RouteEventQuestion>
  return Boolean(
    typeof question.routeKey === 'string' &&
    question.routeKey.length > 0 &&
    question.routeKey.length <= 160 &&
    typeof question.destination === 'string' &&
    ADDRESS.test(question.destination) &&
    typeof question.requestedRaw === 'string' &&
    RAW.test(question.requestedRaw) &&
    question.requestedRaw.length <= 78 &&
    BigInt(question.requestedRaw) > 0n &&
    BigInt(question.requestedRaw) <= MAX_U256 &&
    typeof question.payoutAsset === 'string' &&
    ADDRESS.test(question.payoutAsset) &&
    Number.isInteger(question.assetDecimals) &&
    question.assetDecimals! >= 0 &&
    question.assetDecimals! <= 36 &&
    Number.isInteger(question.horizonHours) &&
    question.horizonHours! >= 1 &&
    question.horizonHours! <= 720,
  )
}

function sameQuestion(left: RouteEventQuestion, right: RouteEventQuestion): boolean {
  return (
    left.routeKey === right.routeKey &&
    left.destination.toLowerCase() === right.destination.toLowerCase() &&
    left.requestedRaw === right.requestedRaw &&
    left.payoutAsset.toLowerCase() === right.payoutAsset.toLowerCase() &&
    left.assetDecimals === right.assetDecimals &&
    left.horizonHours === right.horizonHours
  )
}

export function expectedRouteEventEnrollment(
  recorderVenues: unknown,
): ExpectedRouteEventEnrollment | null {
  if (!Array.isArray(recorderVenues)) return null
  if (recorderVenues.length === 0) return { status: 'not_enrolled' }
  if (
    recorderVenues.length !== 1 ||
    typeof recorderVenues[0] !== 'string' ||
    !safeText(recorderVenues[0], 80)
  )
    return null
  return { status: 'enrolled', venue: recorderVenues[0] }
}

/** Exact contract identity is the only bridge from a Carry subject to a recorder venue. */
export function resolveRouteEventEnrollment(
  registry: CarryForecastRegistry,
  routeKey: string,
  destination: string,
): RouteEventEnrollment {
  const group = registry.routeGroups.find((entry) => entry.routeKey === routeKey)
  const subject = group?.contractSubjects.find(
    (entry) => entry.destinationAddress === destination.toLowerCase(),
  )
  if (!subject) return { status: 'unknown_route_destination' }
  const venues = subject.sourceCoverage.recorderVenues
  return venues.length === 1 ? { status: 'enrolled', venue: venues[0] } : { status: 'not_enrolled' }
}

export function routeEventCoverage(registry: CarryForecastRegistry) {
  const groups = registry.routeGroups.filter((group) =>
    group.contractSubjects.some((subject) => subject.sourceCoverage.recorderVenues.length === 1),
  )
  const subjects = registry.routeGroups.flatMap((group) =>
    group.contractSubjects.filter((subject) => subject.sourceCoverage.recorderVenues.length === 1),
  )
  return {
    routeGroups: { enrolled: groups.length, total: registry.routeGroups.length },
    subjects: {
      enrolled: subjects.length,
      total: registry.routeGroups.reduce((sum, group) => sum + group.contractSubjects.length, 0),
    },
  }
}

/** Links may be opened by the client, so only public-looking HTTPS origins survive. */
export function safeHeadlineUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !host.includes('.') ||
      /^\d+(?:\.\d+){3}$/.test(host) ||
      host.includes(':') ||
      /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|onion|arpa)$/.test(host) ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return null
    return url.toString()
  } catch {
    return null
  }
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function withinObservedWindow(value: unknown, nowMs: number, recentMs: number): value is string {
  if (!validUtc(value)) return false
  const observedMs = Date.parse(value)
  return observedMs >= nowMs - recentMs && observedMs <= nowMs + ROUTE_EVENT_FUTURE_SKEW_MS
}

function requestedShare(requestedRaw: string, capacityRaw: string): string | null {
  if (!RAW.test(requestedRaw) || !RAW.test(capacityRaw)) return null
  if (BigInt(capacityRaw) === 0n) return '∞'
  const hundredths =
    (BigInt(requestedRaw) * 10_000n + BigInt(capacityRaw) / 2n) / BigInt(capacityRaw)
  const whole = hundredths / 100n
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''}%`
}

function contextEvent(
  venue: string | null,
  source: RouteEventContextSources['event'],
  nowMs: number,
): ContextEvent {
  if (venue === null) return { status: 'not_recorded', reason: 'recorder_not_enrolled' }
  if (source.status === 'unavailable')
    return { status: 'source_unavailable', reason: source.reason }
  const entry = source.entries
    .filter(
      (item) =>
        item.venue === venue &&
        item.provenance === 'observed' &&
        typeof item.kind === 'string' &&
        EVENT_KIND.test(item.kind) &&
        withinObservedWindow(item.at, nowMs, ROUTE_EVENT_RECENT_MS),
    )
    .sort((left, right) => right.at.localeCompare(left.at))[0]
  return entry
    ? { status: 'observed', kind: entry.kind, at: entry.at, provenance: 'observed' }
    : { status: 'none', reason: 'no_recent_observed_event' }
}

function contextNews(
  venue: string,
  source: RouteEventContextSources['news'],
  nowMs: number,
): ContextNews {
  if (source.status === 'unavailable')
    return { status: 'source_unavailable', reason: source.reason }
  if (
    !['observed_items', 'latest_items_only'].includes(source.coverage) ||
    !Number.isSafeInteger(source.observedItemCount) ||
    source.observedItemCount < 1 ||
    source.observedItemCount > 25 ||
    !withinObservedWindow(source.observedAt, nowMs, ROUTE_NEWS_RECENT_MS) ||
    source.items.length !== source.observedItemCount
  )
    return { status: 'source_unavailable', reason: 'source_unavailable' }
  const item = source.items.filter(
    (candidate) =>
      candidate.venue === venue &&
      safeText(candidate.title, 500) &&
      safeText(candidate.source, 200) &&
      (candidate.publishedAt === null || validUtc(candidate.publishedAt)) &&
      withinObservedWindow(
        candidate.publishedAt ?? source.observedAt,
        nowMs,
        ROUTE_NEWS_RECENT_MS,
      ) &&
      (candidate.publishedAt === null ||
        Date.parse(source.observedAt) >= Date.parse(candidate.publishedAt)) &&
      safeHeadlineUrl(candidate.url) !== null,
  )[0]
  if (!item) return { status: 'source_unavailable', reason: 'source_unavailable' }
  return {
    status: 'observed',
    title: item.title,
    source: item.source,
    url: item.url,
    publishedAt: item.publishedAt,
    observedAt: source.observedAt,
    treatment: 'raw_headline',
    coverage: source.coverage,
    observedItemCount: source.observedItemCount,
  }
}

function contextCapacity(
  question: RouteEventQuestion,
  source: RouteEventContextSources['capacity'],
  nowMs: number,
): ContextCapacity {
  if (source.status === 'unavailable')
    return { status: 'source_unavailable', reason: source.reason }
  const value = source.value
  if (
    value.routeKey !== question.routeKey ||
    typeof value.destination !== 'string' ||
    value.destination.toLowerCase() !== question.destination ||
    typeof value.payoutAsset !== 'string' ||
    value.payoutAsset.toLowerCase() !== question.payoutAsset ||
    value.assetDecimals !== question.assetDecimals ||
    value.metric !== 'aggregate_cash_raw' ||
    value.meaning !== 'aggregate_route_liquidity_proxy_not_holder_executable_capacity' ||
    !['local_hash_chain_replay', 'database_identity_checked'].includes(value.verification) ||
    !Array.isArray(value.observations) ||
    value.observations.length > 2
  ) {
    return { status: 'source_unavailable', reason: 'source_unavailable' }
  }
  const validPoint = (point: RouteCapacityCandidate['observations'][number]) =>
    typeof point.raw === 'string' &&
    RAW.test(point.raw) &&
    point.raw.length <= 78 &&
    BigInt(point.raw) <= MAX_U256 &&
    typeof point.block === 'string' &&
    RAW.test(point.block) &&
    point.block.length <= 78 &&
    BigInt(point.block) > 0n &&
    BigInt(point.block) <= MAX_U256 &&
    typeof point.blockHash === 'string' &&
    /^0x[0-9a-f]{64}$/.test(point.blockHash.toLowerCase()) &&
    validUtc(point.blockTime) &&
    safeText(point.sourceId, 256)
  if (value.observations.some((point) => !validPoint(point)))
    return { status: 'source_unavailable', reason: 'source_unavailable' }
  if (value.observations.length < 2) return { status: 'none', reason: 'no_verified_capacity_move' }
  const [before, after] = value.observations
  const elapsedSourceSeconds = (Date.parse(after.blockTime) - Date.parse(before.blockTime)) / 1_000
  if (
    BigInt(after.block) <= BigInt(before.block) ||
    !Number.isSafeInteger(elapsedSourceSeconds) ||
    elapsedSourceSeconds <= 0 ||
    elapsedSourceSeconds * 1_000 > ROUTE_CAPACITY_MAX_INTERVAL_MS ||
    Date.parse(after.blockTime) < nowMs - ROUTE_CAPACITY_RECENT_MS ||
    Date.parse(after.blockTime) > nowMs + ROUTE_EVENT_FUTURE_SKEW_MS ||
    before.sourceId === after.sourceId
  )
    return { status: 'source_unavailable', reason: 'source_unavailable' }
  if (before.raw === after.raw) return { status: 'none', reason: 'no_verified_capacity_move' }
  const beforeShare = requestedShare(question.requestedRaw, before.raw)
  const afterShare = requestedShare(question.requestedRaw, after.raw)
  if (!beforeShare || !afterShare)
    return { status: 'source_unavailable', reason: 'source_unavailable' }
  return {
    status: 'observed',
    metric: value.metric,
    direction: BigInt(after.raw) < BigInt(before.raw) ? 'shrinking' : 'growing',
    beforeRaw: before.raw,
    afterRaw: after.raw,
    assetDecimals: value.assetDecimals,
    requestedShareBefore: beforeShare,
    requestedShareAfter: afterShare,
    elapsedSourceSeconds,
    beforeAt: before.blockTime,
    afterAt: after.blockTime,
    verification: value.verification,
    meaning: value.meaning,
  }
}

export function buildRouteEventContext(
  question: RouteEventQuestion,
  venue: string | null,
  sources: RouteEventContextSources,
  nowMs = Date.now(),
  newsSource = venue,
): RouteEventContext {
  if (
    !validRouteEventQuestion(question) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !newsSource
  ) {
    throw new Error('route_event_context_input_invalid')
  }
  return {
    status: 'route_event_context',
    question,
    venue,
    newsSource,
    association: ROUTE_EVENT_CONTEXT_ASSOCIATION,
    event: contextEvent(venue, sources.event, nowMs),
    news: contextNews(newsSource, sources.news, nowMs),
    capacity: contextCapacity(question, sources.capacity, nowMs),
    newsImpact: { status: 'unavailable', reason: 'no_causal_model' },
    forecastValidated: false,
    prospectiveValidated: false,
    holderExecutableExit: false,
    coverage: ROUTE_EVENT_FEED_COVERAGE,
    newsCoverage: ROUTE_NEWS_FEED_COVERAGE,
  }
}

export function matchingRouteEventContext(
  value: unknown,
  question: RouteEventQuestion,
  expectedEnrollment: ExpectedRouteEventEnrollment,
  nowMs = Date.now(),
): RouteEventContextResponse | null {
  if (
    !validRouteEventQuestion(question) ||
    !expectedEnrollment ||
    (expectedEnrollment.status !== 'not_enrolled' &&
      (expectedEnrollment.status !== 'enrolled' || !safeText(expectedEnrollment.venue, 80))) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  )
    return null
  const result = value as RouteEventContextResponse
  const expectedNewsSource = resolveRouteNewsSource(question.routeKey, question.destination)?.id
  if (
    !validRouteEventQuestion(result.question) ||
    !sameQuestion(result.question, question) ||
    JSON.stringify(result.coverage) !== JSON.stringify(ROUTE_EVENT_FEED_COVERAGE) ||
    JSON.stringify(result.newsCoverage) !== JSON.stringify(ROUTE_NEWS_FEED_COVERAGE) ||
    result.newsImpact?.status !== 'unavailable' ||
    result.newsImpact.reason !== 'no_causal_model' ||
    result.forecastValidated !== false ||
    result.prospectiveValidated !== false ||
    result.holderExecutableExit !== false
  )
    return null
  if (
    result.status !== 'route_event_context' ||
    !expectedNewsSource ||
    result.newsSource !== expectedNewsSource ||
    result.venue !== (expectedEnrollment.status === 'enrolled' ? expectedEnrollment.venue : null) ||
    result.association !== ROUTE_EVENT_CONTEXT_ASSOCIATION ||
    !['observed', 'none', 'not_recorded', 'source_unavailable'].includes(result.event?.status) ||
    !['observed', 'source_unavailable'].includes(result.news?.status)
  )
    return null
  if (
    (expectedEnrollment.status === 'not_enrolled' && result.event.status !== 'not_recorded') ||
    (expectedEnrollment.status === 'enrolled' && result.event.status === 'not_recorded')
  )
    return null
  if (result.event.status === 'not_recorded' && result.event.reason !== 'recorder_not_enrolled')
    return null
  if (!['observed', 'none', 'source_unavailable'].includes(result.capacity?.status)) return null
  if (
    result.status === 'route_event_context' &&
    result.event.status === 'observed' &&
    (typeof result.event.kind !== 'string' ||
      !EVENT_KIND.test(result.event.kind) ||
      !withinObservedWindow(result.event.at, nowMs, ROUTE_EVENT_RECENT_MS) ||
      result.event.provenance !== 'observed')
  )
    return null
  if (
    result.status === 'route_event_context' &&
    result.news.status === 'observed' &&
    (!safeText(result.news.title, 500) ||
      !safeText(result.news.source, 200) ||
      !safeHeadlineUrl(result.news.url) ||
      !withinObservedWindow(result.news.observedAt, nowMs, ROUTE_NEWS_RECENT_MS) ||
      (result.news.publishedAt !== null && !validUtc(result.news.publishedAt)) ||
      !withinObservedWindow(
        result.news.publishedAt ?? result.news.observedAt,
        nowMs,
        ROUTE_NEWS_RECENT_MS,
      ) ||
      (result.news.publishedAt !== null &&
        Date.parse(result.news.observedAt) < Date.parse(result.news.publishedAt)) ||
      result.news.treatment !== 'raw_headline' ||
      !['observed_items', 'latest_items_only'].includes(result.news.coverage) ||
      !Number.isSafeInteger(result.news.observedItemCount) ||
      result.news.observedItemCount < 1 ||
      result.news.observedItemCount > 25)
  )
    return null
  if (
    result.capacity.status === 'observed' &&
    (typeof result.capacity.beforeRaw !== 'string' ||
      typeof result.capacity.afterRaw !== 'string' ||
      !RAW.test(result.capacity.beforeRaw) ||
      !RAW.test(result.capacity.afterRaw) ||
      result.capacity.beforeRaw.length > 78 ||
      result.capacity.afterRaw.length > 78 ||
      BigInt(result.capacity.beforeRaw) > MAX_U256 ||
      BigInt(result.capacity.afterRaw) > MAX_U256 ||
      result.capacity.beforeRaw === result.capacity.afterRaw ||
      result.capacity.metric !== 'aggregate_cash_raw' ||
      result.capacity.direction !==
        (BigInt(result.capacity.afterRaw) < BigInt(result.capacity.beforeRaw)
          ? 'shrinking'
          : 'growing') ||
      result.capacity.assetDecimals !== question.assetDecimals ||
      result.capacity.requestedShareBefore !==
        requestedShare(question.requestedRaw, result.capacity.beforeRaw) ||
      result.capacity.requestedShareAfter !==
        requestedShare(question.requestedRaw, result.capacity.afterRaw) ||
      !validUtc(result.capacity.beforeAt) ||
      !validUtc(result.capacity.afterAt) ||
      !Number.isSafeInteger(result.capacity.elapsedSourceSeconds) ||
      result.capacity.elapsedSourceSeconds <= 0 ||
      result.capacity.elapsedSourceSeconds * 1_000 > ROUTE_CAPACITY_MAX_INTERVAL_MS ||
      Date.parse(result.capacity.afterAt) - Date.parse(result.capacity.beforeAt) !==
        result.capacity.elapsedSourceSeconds * 1_000 ||
      !withinObservedWindow(result.capacity.afterAt, nowMs, ROUTE_CAPACITY_RECENT_MS) ||
      !['local_hash_chain_replay', 'database_identity_checked'].includes(
        result.capacity.verification,
      ) ||
      result.capacity.meaning !== 'aggregate_route_liquidity_proxy_not_holder_executable_capacity')
  )
    return null
  return result
}
