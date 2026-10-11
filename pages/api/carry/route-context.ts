import type { NextApiRequest, NextApiResponse } from 'next'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { ROUTES } from '@/components/Carry/fixtures'
import { db } from '@/db'
import {
  buildCarryForecastRegistry,
  type CarryForecastRegistry,
} from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitAssessment'
import { checkedLocalRouteCashSamples } from '@/lib/carry/localForecastReads'
import { certifyNewsPoll } from '@/lib/carry/newsPollCertification'
import {
  resolveRouteNewsSource,
  routeNewsCatalogMatchesRegistry,
  routeNewsCoverage,
} from '@/lib/carry/routeNewsSources'
import {
  buildRouteEventContext,
  resolveRouteEventEnrollment,
  routeEventCoverage,
  ROUTE_CAPACITY_MAX_INTERVAL_MS,
  ROUTE_CAPACITY_RECENT_MS,
  ROUTE_EVENT_FEED_COVERAGE,
  ROUTE_EVENT_FUTURE_SKEW_MS,
  ROUTE_EVENT_RECENT_MS,
  ROUTE_NEWS_FEED_COVERAGE,
  safeHeadlineUrl,
  validRouteEventQuestion,
  type RouteEventContextSources,
  type RouteEventQuestion,
  type RouteHeadlineCandidate,
} from '@/lib/carry/routeEventContext'
import { readLocalCarryCashObservations } from '@/scripts/lib/localCarryCashStore.mjs'
import {
  LOCAL_VENUE_SNAPSHOT_ROOT,
  verifyLocalVenueSnapshots,
} from '@/scripts/lib/localVenueSnapshotStore.mjs'
import { readLocalNews, selectLocalNews } from '@/scripts/lib/venueNewsLocalStore.mjs'
import {
  parsedItemIdentity,
  verifyPollReceipt,
  verifyPolls,
} from '@/scripts/lib/newsPollLedger.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const LOCAL_NEWS_MAX_AGE_MS = 3 * 60 * 60 * 1_000
const LOCAL_NEWS_FUTURE_SKEW_MS = 5 * 60 * 1_000

type SourceReaders = {
  nowMs(): number
  readEvent(venue: string, nowMs: number): Promise<RouteEventContextSources['event']>
  readNews(
    sourceId: string,
    query: string,
    nowMs: number,
    req: NextApiRequest,
  ): Promise<RouteEventContextSources['news']>
  readCapacity(
    question: RouteEventQuestion,
    nowMs: number,
    req: NextApiRequest,
    venue: string | null,
  ): Promise<RouteEventContextSources['capacity']>
  registry(): CarryForecastRegistry
}

const isLocalDevelopment = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const parsed = new Date(value as string | number | Date)
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
}

async function readEvent(venue: string, nowMs: number): Promise<RouteEventContextSources['event']> {
  try {
    const since = new Date(nowMs - ROUTE_EVENT_RECENT_MS).toISOString()
    const result = await db.execute(sql`
      SELECT venue, kind, observed_at
      FROM venue_events
      WHERE venue = ${venue} AND observed_at >= ${since}
      ORDER BY observed_at DESC
      LIMIT 20`)
    const entries = (result.rows as any[]).flatMap((row) => {
      const at = iso(row.observed_at)
      return at && typeof row.venue === 'string' && typeof row.kind === 'string'
        ? [{ venue: row.venue, kind: row.kind, at, provenance: 'observed' as const }]
        : []
    })
    return { status: 'available', entries }
  } catch {
    return { status: 'unavailable', reason: 'source_unavailable' }
  }
}

export async function readNews(
  sourceId: string,
  query: string,
  nowMs: number,
  req: NextApiRequest,
): Promise<RouteEventContextSources['news']> {
  let poll: ReturnType<typeof certifyNewsPoll>
  try {
    const receipt = await readLatestNewsReceipt(sourceId, req)
    poll = certifyNewsPoll(receipt, sourceId, query, nowMs)
    if (poll.status === 'unavailable')
      return { status: 'unavailable', reason: 'source_unavailable' }
  } catch {
    return { status: 'unavailable', reason: 'source_unavailable' }
  }
  const identities = poll.identities
  if (isLocalDevelopment(req))
    return localReceiptBoundNews(sourceId, identities, poll.coverage, poll.observedAt, nowMs)
  let items: RouteHeadlineCandidate[]
  try {
    const result = await db.execute(sql`
      SELECT venue, title, source, url, published_at, fetched_at
      FROM venue_news
      WHERE venue = ${sourceId}
      ORDER BY fetched_at DESC
      LIMIT 1000`)
    items = (result.rows as any[]).flatMap((row): RouteHeadlineCandidate[] => {
      const fetchedAt = iso(row.fetched_at)
      const publishedAt = iso(row.published_at)
      return fetchedAt && typeof row.venue === 'string'
        ? [
            {
              venue: row.venue,
              title: String(row.title ?? ''),
              source: String(row.source ?? ''),
              url: String(row.url ?? ''),
              publishedAt,
              fetchedAt,
            },
          ]
        : []
    })
  } catch {
    return { status: 'unavailable', reason: 'source_unavailable' }
  }
  return receiptBoundNews(items, sourceId, identities, poll.coverage, poll.observedAt)
}

function localReceiptBoundNews(
  sourceId: string,
  identities: string[],
  coverage: 'observed_items' | 'latest_items_only',
  observedAt: string,
  nowMs: number,
): RouteEventContextSources['news'] {
  try {
    const snapshot = readLocalNews()
    const updatedAt = snapshot.updatedAt ? Date.parse(snapshot.updatedAt) : NaN
    if (
      !Number.isFinite(updatedAt) ||
      updatedAt < nowMs - LOCAL_NEWS_MAX_AGE_MS ||
      updatedAt > nowMs + LOCAL_NEWS_FUTURE_SKEW_MS
    )
      return { status: 'unavailable', reason: 'source_unavailable' }
    const items = selectLocalNews(snapshot, {
      venue: sourceId,
      perVenue: 100,
      fetchedAfter: new Date(nowMs - LOCAL_NEWS_MAX_AGE_MS).toISOString(),
      fetchedBefore: new Date(nowMs + LOCAL_NEWS_FUTURE_SKEW_MS).toISOString(),
    }) as RouteHeadlineCandidate[]
    return receiptBoundNews(items, sourceId, identities, coverage, observedAt)
  } catch {
    return { status: 'unavailable', reason: 'source_unavailable' }
  }
}

async function readLatestNewsReceipt(sourceId: string, req: NextApiRequest) {
  let local: any
  if (isLocalDevelopment(req)) {
    try {
      const latest = verifyPolls()
        .receipts.filter((entry: any) => entry.venue === sourceId)
        .at(-1)
      if (latest) local = verifyPollReceipt(latest)
    } catch {
      // The database mirror may still be available; a broken local chain
      // cannot certify news on its own.
    }
  }
  if (local) return local
  let result: Awaited<ReturnType<typeof db.execute>>
  try {
    result = await db.execute(sql`
      SELECT sequence, receipt_text
      FROM venue_news_poll_receipts
      WHERE source_id = ${sourceId}`)
  } catch {
    return undefined
  }
  const row = result.rows[0] as { sequence?: unknown; receipt_text?: unknown } | undefined
  if (!row) return undefined
  if (typeof row.receipt_text !== 'string' || row.receipt_text.length > 64 * 1024)
    throw new Error('news_poll_mirror_invalid')
  const mirrored = verifyPollReceipt(JSON.parse(row.receipt_text))
  if (mirrored.venue !== sourceId || Number(row.sequence) !== mirrored.sequence)
    throw new Error('news_poll_mirror_identity_mismatch')
  return mirrored
}

function receiptBoundNews(
  items: RouteHeadlineCandidate[],
  sourceId: string,
  identities: string[],
  coverage: 'observed_items' | 'latest_items_only',
  observedAt: string,
): RouteEventContextSources['news'] {
  const expected = new Set(identities)
  const boundByIdentity = new Map<string, RouteHeadlineCandidate>()
  for (const item of items) {
    const identity = parsedItemIdentity(item)
    if (
      item.venue === sourceId &&
      expected.has(identity) &&
      safeHeadlineUrl(item.url) !== null &&
      !boundByIdentity.has(identity)
    )
      boundByIdentity.set(identity, item)
  }
  const ordered = identities.map((identity) => boundByIdentity.get(identity))
  if (identities.length === 0 || ordered.some((item) => item === undefined))
    return { status: 'unavailable', reason: 'source_unavailable' }
  return {
    status: 'available',
    coverage,
    observedItemCount: identities.length,
    observedAt,
    items: ordered as RouteHeadlineCandidate[],
  }
}

type CashManifestSubject = {
  route_key: string
  destination: string
  asset: string
  source_kind: 'vault' | 'market'
  venue_kind: string | null
  asset_decimals?: number
  cohort_id: string | null
  seed_source_sha256?: string | null
  seed_sha256?: string | null
  board_sha256?: string | null
  displayed_routes_sha256?: string | null
}

type LocalCapacityReceipt = {
  receiptSha256: string
  collectionMode: string
  evidenceKind: string
  firstLocalReceiptAt: string
  source: { chainId: number; block: string; blockHash: string; blockAt: string }
  subjects: Array<{
    routeKey: string
    destination: string
    asset: string | null
    assetDecimals: number | null
    cashRaw: string | null
    state: string
    block: string
    blockHash: string
    blockAt: string
    collectionMode: string
    evidenceKind: string
    firstLocalReceiptAt: string
  }>
}

type CapacityRow = {
  route_key: unknown
  destination?: unknown
  vault?: unknown
  asset?: unknown
  underlying?: unknown
  asset_decimals?: unknown
  underlying_decimals?: unknown
  chain_id?: unknown
  venue_kind?: unknown
  cash_raw: unknown
  block: unknown
  block_hash: unknown
  observed_at: unknown
  first_local_receipt_at: unknown
  cohort_id?: unknown
  seed_source_sha256?: unknown
  seed_sha256?: unknown
  board_sha256?: unknown
  displayed_routes_sha256?: unknown
}

type LocalVenuePoint = {
  venue: string
  sequence: number
  sha256: string
  previousSha256: string | null
  chain: string
  source: { block: string; hash: string; timestamp: number; finalized: true; pinned: true }
  measurement: {
    underlyingBalanceRaw: string | null
    params: Record<string, unknown>
  }
  comparison: {
    status: string
    previousSequence: number | null
    previousBlock: string | null
    elapsedSourceSeconds: number | null
    deltas: {
      underlyingBalanceRaw: { previous: string; current: string; absolute: string } | null
    } | null
  }
}

const RAW = /^(0|[1-9][0-9]*)$/
const HASH = /^0x[0-9a-f]{64}$/

function capacityValue(
  question: RouteEventQuestion,
  observations: Array<{
    raw: string
    block: string
    blockHash: string
    blockTime: string
    sourceId: string
  }>,
  verification: 'local_hash_chain_replay' | 'database_identity_checked',
): Extract<RouteEventContextSources['capacity'], { status: 'available' }> {
  return {
    status: 'available',
    value: {
      routeKey: question.routeKey,
      destination: question.destination,
      payoutAsset: question.payoutAsset,
      assetDecimals: question.assetDecimals,
      metric: 'aggregate_cash_raw',
      observations,
      verification,
      meaning: 'aggregate_route_liquidity_proxy_not_holder_executable_capacity',
    },
  }
}

function localCapacity(
  question: RouteEventQuestion,
  subject: CashManifestSubject,
  receipts: LocalCapacityReceipt[],
): RouteEventContextSources['capacity'] | null {
  const checked = checkedLocalRouteCashSamples(receipts, subject)
  if (checked.status !== 'available' || checked.assetDecimals !== question.assetDecimals)
    return null
  const observations = receipts
    .filter((receipt) => receipt.collectionMode === 'current')
    .flatMap((receipt) => {
      const rows = receipt.subjects.filter(
        (row) => row.routeKey === question.routeKey && row.destination === question.destination,
      )
      if (rows.length !== 1) return []
      const row = rows[0]
      return row.state === 'observed' &&
        row.asset === question.payoutAsset &&
        row.assetDecimals === question.assetDecimals &&
        RAW.test(row.cashRaw ?? '')
        ? [
            {
              raw: row.cashRaw!,
              block: receipt.source.block,
              blockHash: receipt.source.blockHash,
              blockTime: receipt.source.blockAt,
              sourceId: receipt.receiptSha256,
            },
          ]
        : []
    })
    .slice(-2)
  return capacityValue(question, observations, 'local_hash_chain_replay')
}

function databaseCapacity(
  question: RouteEventQuestion,
  subject: CashManifestSubject,
  rows: CapacityRow[],
): RouteEventContextSources['capacity'] | null {
  if (rows.length > 2) return null
  const observations = rows
    .map((row) => {
      const destination = String(subject.source_kind === 'market' ? row.destination : row.vault)
      const asset = String(subject.source_kind === 'market' ? row.underlying : row.asset)
      const decimals = Number(
        subject.source_kind === 'market' ? row.underlying_decimals : row.asset_decimals,
      )
      const block = String(row.block)
      const blockHash = String(row.block_hash).toLowerCase()
      const raw = String(row.cash_raw)
      const blockTime = iso(row.observed_at)
      const receivedAt = iso(row.first_local_receipt_at)
      const provenanceMatches =
        subject.source_kind === 'market'
          ? Number(row.chain_id) === 1 && row.venue_kind === subject.venue_kind
          : row.cohort_id === subject.cohort_id &&
            row.seed_source_sha256 === subject.seed_source_sha256 &&
            row.seed_sha256 === subject.seed_sha256 &&
            row.board_sha256 === subject.board_sha256 &&
            row.displayed_routes_sha256 === subject.displayed_routes_sha256
      if (
        row.route_key !== question.routeKey ||
        destination !== question.destination ||
        asset !== question.payoutAsset ||
        decimals !== question.assetDecimals ||
        !provenanceMatches ||
        !RAW.test(block) ||
        BigInt(block) <= 0n ||
        !HASH.test(blockHash) ||
        !RAW.test(raw) ||
        !blockTime ||
        !receivedAt ||
        receivedAt < blockTime
      )
        return null
      return {
        raw,
        block,
        blockHash,
        blockTime,
        sourceId: `${block}:${blockHash}:${receivedAt}`,
      }
    })
    .reverse()
  if (observations.some((row) => row === null)) return null
  return capacityValue(
    question,
    observations as NonNullable<(typeof observations)[number]>[],
    'database_identity_checked',
  )
}

export function localAaveUsdeCapacity(
  question: RouteEventQuestion,
  venue: string | null,
): RouteEventContextSources['capacity'] | null {
  if (venue !== 'aave-v3-usde') return null
  const configured = recorderConfig.venues.find(
    (row) =>
      row.enabled &&
      row.name === venue &&
      row.address.toLowerCase() === question.destination &&
      row.underlying?.toLowerCase() === question.payoutAsset &&
      row.decimals === question.assetDecimals,
  )
  if (!configured) return null
  const { count, last: rawLast } = verifyLocalVenueSnapshots(venue)
  if (count < 2 || !rawLast) return capacityValue(question, [], 'local_hash_chain_replay')
  const last = rawLast as LocalVenuePoint
  const path = join(LOCAL_VENUE_SNAPSHOT_ROOT, venue, `${String(count - 1).padStart(12, '0')}.json`)
  const bytes = readFileSync(path, 'utf8')
  const previous = JSON.parse(bytes) as LocalVenuePoint
  const { sha256, ...body } = previous
  const params = last.measurement.params
  const previousParams = previous.measurement.params
  const delta = last.comparison.deltas?.underlyingBalanceRaw
  const validPoint = (point: LocalVenuePoint, pointParams: Record<string, unknown>) =>
    point.venue === venue &&
    point.chain === 'ethereum' &&
    point.source.finalized === true &&
    point.source.pinned === true &&
    RAW.test(point.source.block) &&
    HASH.test(point.source.hash.toLowerCase()) &&
    Number.isSafeInteger(point.source.timestamp) &&
    point.source.timestamp > 0 &&
    RAW.test(point.measurement.underlyingBalanceRaw ?? '') &&
    pointParams.kind === configured.kind &&
    pointParams.underlyingIdentity === 'match' &&
    pointParams.decimalsIdentity === 'match' &&
    String(pointParams.underlyingOnchain).toLowerCase() === question.payoutAsset &&
    Number(pointParams.underlyingDecimalsOnchain) === question.assetDecimals &&
    String(pointParams.aToken).toLowerCase() === question.destination &&
    (pointParams.reads as { underlyingBalance?: unknown } | undefined)?.underlyingBalance === true
  if (
    bytes !== `${JSON.stringify(previous)}\n` ||
    sha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex') ||
    last.previousSha256 !== previous.sha256 ||
    last.sequence !== previous.sequence + 1 ||
    last.comparison.status !== 'two_observed_points' ||
    last.comparison.previousSequence !== previous.sequence ||
    last.comparison.previousBlock !== previous.source.block ||
    last.comparison.elapsedSourceSeconds !== last.source.timestamp - previous.source.timestamp ||
    !delta ||
    delta.previous !== previous.measurement.underlyingBalanceRaw ||
    delta.current !== last.measurement.underlyingBalanceRaw ||
    !validPoint(previous, previousParams) ||
    !validPoint(last, params)
  )
    return null
  return capacityValue(
    question,
    [previous, last].map((point) => ({
      raw: point.measurement.underlyingBalanceRaw!,
      block: point.source.block,
      blockHash: point.source.hash.toLowerCase(),
      blockTime: new Date(point.source.timestamp * 1_000).toISOString(),
      sourceId: point.sha256,
    })),
    'local_hash_chain_replay',
  )
}

export function eligibleLocalCapacitySource(
  source: RouteEventContextSources['capacity'] | null,
  nowMs: number,
): source is Extract<RouteEventContextSources['capacity'], { status: 'available' }> {
  if (
    !source ||
    source.status !== 'available' ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Array.isArray(source.value.observations) ||
    source.value.observations.length !== 2
  )
    return false
  const [before, after] = source.value.observations
  if (
    !before ||
    !after ||
    typeof before.blockTime !== 'string' ||
    typeof after.blockTime !== 'string' ||
    typeof before.block !== 'string' ||
    typeof after.block !== 'string' ||
    !RAW.test(before.block) ||
    !RAW.test(after.block) ||
    before.block.length > 78 ||
    after.block.length > 78 ||
    typeof before.sourceId !== 'string' ||
    typeof after.sourceId !== 'string' ||
    before.sourceId === after.sourceId
  )
    return false
  const beforeMs = Date.parse(before.blockTime)
  const afterMs = Date.parse(after.blockTime)
  const elapsedMs = afterMs - beforeMs
  return (
    Number.isFinite(beforeMs) &&
    Number.isFinite(afterMs) &&
    new Date(beforeMs).toISOString() === before.blockTime &&
    new Date(afterMs).toISOString() === after.blockTime &&
    BigInt(after.block) > BigInt(before.block) &&
    Number.isSafeInteger(elapsedMs / 1_000) &&
    elapsedMs > 0 &&
    elapsedMs <= ROUTE_CAPACITY_MAX_INTERVAL_MS &&
    afterMs >= nowMs - ROUTE_CAPACITY_RECENT_MS &&
    afterMs <= nowMs + ROUTE_EVENT_FUTURE_SKEW_MS
  )
}

async function readCapacity(
  question: RouteEventQuestion,
  nowMs: number,
  _req: NextApiRequest,
  venue: string | null,
): Promise<RouteEventContextSources['capacity']> {
  try {
    const manifest = await buildSubjectManifest()
    const frozenSubjects = manifest.subjects as CashManifestSubject[]
    const frozenSubject = frozenSubjects.find(
      (row) =>
        row.route_key === question.routeKey &&
        row.destination === question.destination &&
        row.asset === question.payoutAsset,
    )
    const subject =
      frozenSubject ??
      manifest.supplementalSubjects
        .map(
          (row): CashManifestSubject => ({
            ...row,
            source_kind: 'market',
            seed_source_sha256: null,
            seed_sha256: null,
            board_sha256: null,
            displayed_routes_sha256: null,
          }),
        )
        .find(
          (row) =>
            row.route_key === question.routeKey &&
            row.destination === question.destination &&
            row.asset === question.payoutAsset,
        )
    if (!subject) return { status: 'unavailable', reason: 'source_unavailable' }
    if (frozenSubject) {
      try {
        const local = localCapacity(
          question,
          subject,
          readLocalCarryCashObservations(manifest) as LocalCapacityReceipt[],
        )
        if (eligibleLocalCapacitySource(local, nowMs)) return local
      } catch {
        // The independently checked database ledger remains a valid fallback.
      }
    }
    const supplementalLocal = localAaveUsdeCapacity(question, venue)
    if (eligibleLocalCapacitySource(supplementalLocal, nowMs)) return supplementalLocal
    const result =
      subject.source_kind === 'market'
        ? await db.execute(sql`
            SELECT route_key, venue_kind, destination, underlying, underlying_decimals, chain_id,
              cash_raw, block, block_hash, observed_at, first_local_receipt_at
            FROM carry_direct_supply_observations
            WHERE route_key = ${question.routeKey} AND destination = ${question.destination}
              AND underlying = ${question.payoutAsset}
            ORDER BY block DESC LIMIT 2`)
        : await db.execute(sql`
            SELECT route_key, vault, asset, asset_decimals, cash_raw, block, block_hash,
              observed_at, first_local_receipt_at, cohort_id, seed_source_sha256, seed_sha256,
              board_sha256, displayed_routes_sha256
            FROM carry_route_vault_observations
            WHERE route_key = ${question.routeKey} AND vault = ${question.destination}
              AND asset = ${question.payoutAsset} AND cohort_id = ${subject.cohort_id}
              AND seed_source_sha256 = ${subject.seed_source_sha256}
              AND seed_sha256 = ${subject.seed_sha256}
              AND board_sha256 = ${subject.board_sha256}
              AND displayed_routes_sha256 = ${subject.displayed_routes_sha256}
            ORDER BY block DESC LIMIT 2`)
    return (
      databaseCapacity(question, subject, result.rows as CapacityRow[]) ?? {
        status: 'unavailable',
        reason: 'source_unavailable',
      }
    )
  } catch {
    return { status: 'unavailable', reason: 'source_unavailable' }
  }
}

const DEFAULT_READERS: SourceReaders = {
  nowMs: () => Date.now(),
  readEvent,
  readNews,
  readCapacity,
  registry: () =>
    buildCarryForecastRegistry(
      ROUTES,
      seed,
      recorderConfig.venues,
      GHO_SGHO.destination,
      verifiedDirectSupplyDestinations(),
    ),
}

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function questionFrom(req: NextApiRequest): RouteEventQuestion | null {
  const routeKey = single(req.query.routeKey)
  const destination = single(req.query.destination)?.toLowerCase()
  const requestedRaw = single(req.query.requestedRaw)
  const payoutAsset = single(req.query.payoutAsset)?.toLowerCase()
  const decimalsRaw = single(req.query.assetDecimals)
  const horizonRaw = single(req.query.horizonHours)
  if (
    routeKey === null ||
    destination === undefined ||
    requestedRaw === null ||
    payoutAsset === undefined ||
    decimalsRaw === null ||
    horizonRaw === null
  )
    return null
  const question: RouteEventQuestion = {
    routeKey,
    destination,
    requestedRaw,
    payoutAsset,
    assetDecimals: Number(decimalsRaw),
    horizonHours: Number(horizonRaw),
  }
  return validRouteEventQuestion(question) ? question : null
}

function coverageMatchesRegistry(registry: CarryForecastRegistry): boolean {
  const coverage = routeEventCoverage(registry)
  const newsCoverage = routeNewsCoverage(registry)
  return (
    JSON.stringify(coverage) === JSON.stringify(ROUTE_EVENT_FEED_COVERAGE) &&
    JSON.stringify(newsCoverage) === JSON.stringify(ROUTE_NEWS_FEED_COVERAGE) &&
    routeNewsCatalogMatchesRegistry(registry)
  )
}

export function createRouteContextHandler(readers: SourceReaders = DEFAULT_READERS) {
  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET')
      return res.status(405).json({ error: 'GET only' })
    }
    const question = questionFrom(req)
    if (!question) return res.status(400).json({ error: 'invalid_route_event_question' })

    let registry: CarryForecastRegistry
    try {
      registry = readers.registry()
    } catch {
      return res.status(503).json({ error: 'route_event_registry_unavailable' })
    }
    if (!coverageMatchesRegistry(registry))
      return res.status(503).json({ error: 'route_event_coverage_mismatch' })

    const enrollment = resolveRouteEventEnrollment(
      registry,
      question.routeKey,
      question.destination,
    )
    if (enrollment.status === 'unknown_route_destination')
      return res.status(404).json({ error: 'unknown_route_destination' })
    const newsSource = resolveRouteNewsSource(question.routeKey, question.destination)
    if (!newsSource) return res.status(503).json({ error: 'route_news_catalog_gap' })

    let expectedPayoutAsset: string
    try {
      expectedPayoutAsset = resolveHolderExitSubject(
        question.routeKey,
        question.destination as `0x${string}`,
      ).payoutAsset.toLowerCase()
    } catch {
      return res.status(409).json({ error: 'route_event_identity_mismatch' })
    }
    if (expectedPayoutAsset !== question.payoutAsset)
      return res.status(409).json({ error: 'route_event_identity_mismatch' })

    const nowMs = readers.nowMs()
    if (!Number.isSafeInteger(nowMs) || nowMs < 0)
      return res.status(503).json({ error: 'route_event_clock_unavailable' })
    const venue = enrollment.status === 'enrolled' ? enrollment.venue : null
    const matches =
      venue === null
        ? []
        : recorderConfig.venues.filter(
            (candidate) =>
              candidate.enabled &&
              candidate.name === venue &&
              candidate.address.toLowerCase() === question.destination &&
              candidate.underlying?.toLowerCase() === question.payoutAsset &&
              candidate.decimals === question.assetDecimals,
          )
    if (venue !== null && matches.length !== 1)
      return res.status(409).json({ error: 'route_event_identity_mismatch' })

    const [event, news, capacity] = await Promise.all([
      venue === null
        ? Promise.resolve({ status: 'available' as const, entries: [] })
        : readers.readEvent(venue, nowMs),
      readers.readNews(newsSource.id, newsSource.query, nowMs, req),
      readers.readCapacity(question, nowMs, req, venue),
    ])
    return res
      .status(200)
      .json(
        buildRouteEventContext(question, venue, { event, news, capacity }, nowMs, newsSource.id),
      )
  }
}

export default createRouteContextHandler()
