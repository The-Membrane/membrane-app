import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { ROUTES } from '@/components/Carry/fixtures'
import { db } from '@/db'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import { historicalCarryCashContext } from '@/lib/carry/historicalCashContext'
import { checkedLocalRouteCashSamples } from '@/lib/carry/localForecastReads'
import {
  readDirectSupplyCashForRoute,
  type DirectSupplyRouteKey,
} from '@/lib/carry/directSupplyReads'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import { checkOtherVaultAssetIdentity } from '@/lib/carry/otherVaultAssetIdentities'
import { PUBLIC_MAINNET_RPCS } from '@/lib/position-sim/rpc'
import { readLocalCarryCashObservations } from '@/scripts/lib/localCarryCashStore.mjs'
import {
  buildSupplementalAaveUsdeCashManifest,
  localSupplementalAaveUsdeCashObservationsFromVerified,
  verifyLocalSupplementalAaveUsdeCash,
} from '@/scripts/lib/localSupplementalAaveUsdeCashStore.mjs'
import { makeClient, readEnv } from '@/scripts/lib/venue-reads.mjs'
import { verifyLocalVenueSnapshots } from '@/scripts/lib/localVenueSnapshotStore.mjs'
import { buildSubjectManifest } from '@/scripts/record-carry-cash-issues.mjs'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

type ObservationRow = Record<string, unknown>

const LOCAL_ROUTE_VENUES: Record<string, string> = {
  'USDe → Staked USDe [USDe]': 'sUSDe',
  'USDS → SUsds [USDS]': 'sUSDS',
  'GHO → sGho [GHO]': 'sGHO',
  'USDe → supply on Aave V3': 'aave-v3-usde',
}

export const localDevelopmentRequest = (req: NextApiRequest) =>
  process.env.NODE_ENV === 'development' &&
  (req.socket?.remoteAddress === '127.0.0.1' ||
    req.socket?.remoteAddress === '::1' ||
    req.socket?.remoteAddress === '::ffff:127.0.0.1')

type LocalRouteSubject = {
  destinationAddress: string
}

type LocalCashSubject = {
  route_key: string
  destination: string
  asset: string
  source_kind: 'vault' | 'market'
  venue_kind?: string | null
}

type LocalCashRow = {
  routeKey: string
  destination: string
  subjectKind: 'vault' | 'direct'
  venueKind: string
  asset: string | null
  shareDecimals: number | null
  assetDecimals: number | null
  cashRaw: string | null
  state: string
  reason?: string | null
  block: string
  blockHash: string
  blockAt: string
  collectionMode: string
  evidenceKind: string
  firstLocalReceiptAt: string
}

type LocalCashReceipt = {
  collectionMode: 'current' | 'retrospective'
  evidenceKind: string
  firstLocalReceiptAt: string
  anchorAt: string
  source: { chainId: number; block: string; blockHash: string; blockAt: string }
  subjects: LocalCashRow[]
}

type LocalCashGapReason =
  | 'subject_not_in_frozen_local_cohort'
  | 'no_current_samples'
  | 'subject_unassessed'
  | 'subject_no_code'
  | 'cash_identity_unverified'

const historicalObservationGap = (
  routeKey: string,
  expectedSubjects: number,
  unavailableSubjects: Array<{
    destination: string
    status: 'unavailable'
    reason: LocalCashGapReason
  }>,
) => ({
  status:
    unavailableSubjects.length === expectedSubjects
      ? ('unavailable' as const)
      : ('partial' as const),
  claim: 'aggregate_underlying_cash_proxy_only' as const,
  sourceKind: 'local_sha_replayed_finalized_rpc' as const,
  routeKey,
  expectedSubjects,
  observedSubjects: expectedSubjects - unavailableSubjects.length,
  unavailableSubjects,
  holderExecutableExit: false as const,
  prospectiveValidated: false as const,
  predictiveAlertEligible: false as const,
})

/** Adapts a manifest-bound SHA-replayed cash archive to the route API. */
export function checkedLocalHistoricalCarryObservation(
  routeKey: string,
  routeSubjects: LocalRouteSubject[],
  manifestSubjects: LocalCashSubject[],
  observations: LocalCashReceipt[],
  now = Date.now(),
) {
  const enrolled = routeSubjects.map((subject) =>
    manifestSubjects.find(
      (candidate) =>
        candidate.route_key === routeKey &&
        candidate.destination === subject.destinationAddress.toLowerCase(),
    ),
  )
  if (!routeSubjects.length || enrolled.some((subject) => !subject)) {
    const unavailableSubjects = routeSubjects.map((subject) => ({
      destination: subject.destinationAddress.toLowerCase(),
      status: 'unavailable' as const,
      reason: 'subject_not_in_frozen_local_cohort' as const,
    }))
    return {
      routeKey,
      status: 'not_enrolled' as const,
      reason: 'subject_not_in_frozen_local_cohort' as const,
      historicalObservation: historicalObservationGap(
        routeKey,
        routeSubjects.length,
        unavailableSubjects,
      ),
    }
  }

  const subjects = enrolled as LocalCashSubject[]
  const currentReceipts = observations.filter((receipt) => receipt.collectionMode === 'current')
  const latest = currentReceipts.at(-1)
  const unavailableSubjects: Array<{
    destination: string
    status: 'unavailable'
    reason: LocalCashGapReason
  }> = []
  const destinations: Array<Record<string, unknown>> = []

  for (const subject of subjects) {
    const checked = checkedLocalRouteCashSamples(observations, subject)
    if (checked.status === 'unavailable') {
      unavailableSubjects.push({
        destination: subject.destination,
        status: 'unavailable',
        reason: checked.reason,
      })
      continue
    }
    const rows = latest?.subjects.filter(
      (row) => row.routeKey === routeKey && row.destination === subject.destination,
    )
    const row = rows?.length === 1 ? rows[0] : null
    const expectedSubjectKind = subject.source_kind === 'market' ? 'direct' : 'vault'
    if (
      !latest ||
      latest.evidenceKind !== 'current_finalized_observation' ||
      latest.source.chainId !== 1 ||
      !row ||
      row.collectionMode !== 'current' ||
      row.evidenceKind !== 'current_finalized_observation' ||
      row.firstLocalReceiptAt !== latest.firstLocalReceiptAt ||
      row.subjectKind !== expectedSubjectKind ||
      (subject.source_kind === 'market' && row.venueKind !== subject.venue_kind) ||
      row.state !== 'observed' ||
      row.asset !== subject.asset ||
      !Number.isInteger(row.shareDecimals) ||
      row.shareDecimals === null ||
      row.shareDecimals < 0 ||
      row.shareDecimals > 36 ||
      row.assetDecimals !== checked.assetDecimals ||
      !raw(row.cashRaw) ||
      checked.samples.at(-1)?.sourceId !==
        `${latest.source.block}:${latest.source.blockHash}:${subject.destination}`
    ) {
      unavailableSubjects.push({
        destination: subject.destination,
        status: 'unavailable',
        reason: 'cash_identity_unverified',
      })
      continue
    }

    const configured = recorderConfig.venues.find(
      (venue) => venue.enabled && venue.address.toLowerCase() === subject.destination.toLowerCase(),
    )
    const expectedAsset =
      configured && 'underlying' in configured && typeof configured.underlying === 'string'
        ? configured.underlying.toLowerCase()
        : null
    const factoryAsset = morphoAssetByVault.get(subject.destination) ?? null
    const otherIdentity = checkOtherVaultAssetIdentity(subject.destination, subject.asset)
    const routeAssetIdentity =
      subject.source_kind === 'market'
        ? ('market_verified' as const)
        : expectedAsset !== null
          ? expectedAsset === subject.asset
            ? ('confirmed' as const)
            : ('mismatch' as const)
          : factoryAsset !== null
            ? factoryAsset === subject.asset
              ? ('factory_verified' as const)
              : ('mismatch' as const)
            : otherIdentity !== null
              ? otherIdentity.match
                ? ('source_verified' as const)
                : ('mismatch' as const)
              : ('unverified' as const)
    if (routeAssetIdentity === 'mismatch') {
      unavailableSubjects.push({
        destination: subject.destination,
        status: 'unavailable',
        reason: 'cash_identity_unverified',
      })
      continue
    }
    const historicalCash = historicalCarryCashContext(observations, subject, now)
    destinations.push({
      vault: subject.destination,
      asset: subject.asset,
      vaultDecimals: row.shareDecimals,
      assetDecimals: checked.assetDecimals,
      totalAssetsRaw: null,
      totalSupplyRaw: null,
      cashRaw: row.cashRaw,
      firstLocalReceiptAt: latest.firstLocalReceiptAt,
      source:
        subject.source_kind === 'market'
          ? ('finalized_direct_supply' as const)
          : ('finalized_erc4626' as const),
      routeAssetIdentity,
      ...(subject.source_kind === 'market' ? { marketKind: row.venueKind } : {}),
      ...(otherIdentity
        ? {
            identityEvidenceKind: otherIdentity.evidenceKind,
            identityEvidenceUrl: otherIdentity.evidenceUrl,
            exitMechanics: otherIdentity.exitMechanics,
          }
        : {}),
      ...carryVaultBalanceDisclosure(routeKey, subject.destination),
      historicalCash,
    })
  }

  const historicalObservation = {
    ...historicalObservationGap(routeKey, subjects.length, unavailableSubjects),
    ...(unavailableSubjects.length === 0 ? { status: 'available' as const } : {}),
    collectionMode: 'current' as const,
    evidenceKind: 'current_finalized_observation' as const,
    historicalContextsAvailable: destinations.filter(
      (destination) =>
        (destination.historicalCash as { status?: string } | undefined)?.status ===
        'historical_context',
    ).length,
  }
  if (!latest || destinations.length === 0) {
    return {
      routeKey,
      forecastValidation: 'not_validated' as const,
      exitProjectionStatus: 'unavailable' as const,
      durationProjectionStatus: 'unavailable' as const,
      status: 'unavailable' as const,
      reason: 'local_historical_cash_observation_unavailable' as const,
      historicalObservation,
      destinations: [],
    }
  }
  const ageMs = now - Date.parse(latest.source.blockAt)
  return {
    routeKey,
    forecastValidation: 'not_validated' as const,
    exitProjectionStatus: 'unavailable' as const,
    durationProjectionStatus: 'unavailable' as const,
    status: 'observed' as const,
    freshness: ageMs >= 0 && ageMs <= 2 * 60 * 60 * 1000 ? ('fresh' as const) : ('stale' as const),
    observationStorage: 'local_mac_verified_cash_archive' as const,
    observationSource: 'finalized_aggregate_underlying_cash_proxy' as const,
    flowStatus: 'not_measured' as const,
    continuity: 'archive_integrity_verified_feed_continuity_unestablished' as const,
    block: latest.source.block,
    blockHash: latest.source.blockHash,
    observedAt: latest.source.blockAt,
    firstLocalReceiptAt: latest.firstLocalReceiptAt,
    caveat:
      'This is aggregate cash observed at a finalized historical block. Total assets, holder execution, future capacity, competing flow, and exit duration are unmeasured.',
    historicalObservation,
    destinations,
  }
}

/** A venue point can describe market state, never a holder's executable future exit. */
export function checkedLocalCarryObservation(
  routeKey: string,
  subjects: LocalRouteSubject[],
  record: Record<string, any>,
  now = Date.now(),
  verifiedPointCount = 1,
) {
  const venueName = LOCAL_ROUTE_VENUES[routeKey]
  const venue = recorderConfig.venues.find(
    (candidate) => candidate.enabled && candidate.name === venueName,
  )
  if (!venue || !record || subjects.length !== 1 || record.venue !== venueName) return null
  const vault = venue.address.toLowerCase()
  const asset = venue.underlying?.toLowerCase()
  const params = record.measurement?.params
  const source = record.source
  const observedAt = iso(record.observedAtUtc)
  const firstLocalReceiptAt = iso(record.firstLocalReceiptAtUtc)
  const blockHash = String(source?.hash ?? '').toLowerCase()
  const vaultDecimals = Number(params?.vaultDecimals ?? params?.decimals)
  const assetDecimals = Number(params?.underlyingDecimalsOnchain ?? venue.decimals)
  if (
    record.chain !== 'ethereum' ||
    subjects[0].destinationAddress.toLowerCase() !== vault ||
    !asset ||
    source?.finalized !== true ||
    source?.pinned !== true ||
    !raw(source?.block) ||
    !Number.isSafeInteger(source?.timestamp) ||
    source.timestamp <= 0 ||
    !/^0x[0-9a-f]{64}$/.test(blockHash) ||
    !observedAt ||
    !firstLocalReceiptAt ||
    firstLocalReceiptAt < observedAt ||
    !Number.isInteger(vaultDecimals) ||
    vaultDecimals !== venue.decimals ||
    !Number.isInteger(assetDecimals) ||
    assetDecimals !== venue.decimals ||
    !Number.isSafeInteger(verifiedPointCount) ||
    verifiedPointCount < 1 ||
    !raw(record.measurement?.totalSupplyRaw)
  )
    return null

  const isAave = venueName === 'aave-v3-usde'
  const isSgho = venueName === 'sGHO'
  const identityChecked = isAave || isSgho
  if (
    identityChecked &&
    (params?.underlyingIdentity !== 'match' ||
      params?.decimalsIdentity !== 'match' ||
      String(params?.underlyingOnchain ?? '').toLowerCase() !== asset ||
      String(params?.underlying ?? '').toLowerCase() !== asset ||
      raw(record.measurement?.underlyingBalanceRaw) === null ||
      (isAave &&
        (params?.kind !== 'atoken-liquidity' ||
          String(params?.aToken ?? '').toLowerCase() !== vault ||
          params?.reads?.underlyingBalance !== true)) ||
      (isSgho &&
        (params?.kind !== 'erc4626-vault-cash' ||
          String(params?.vault ?? '').toLowerCase() !== vault ||
          params?.reads?.paused !== true ||
          typeof params?.withdrawalsPaused !== 'boolean')))
  )
    return null
  if (
    !identityChecked &&
    (params?.kind !== 'erc4626-cooldown' || raw(record.measurement?.totalAssetsRaw) === null)
  )
    return null

  const rawCash =
    isSgho && params.withdrawalsPaused === true
      ? '0'
      : identityChecked
        ? record.measurement.underlyingBalanceRaw
        : null
  const ageMs = now - source.timestamp * 1000
  return {
    routeKey,
    forecastValidation: 'not_validated' as const,
    exitProjectionStatus: 'unavailable' as const,
    durationProjectionStatus: 'unavailable' as const,
    status: 'observed' as const,
    freshness: ageMs >= 0 && ageMs <= 2 * 60 * 60 * 1000 ? ('fresh' as const) : ('stale' as const),
    observationStorage: 'local_mac_recorder' as const,
    observationSource: 'finalized_venue_market_snapshot' as const,
    flowStatus: 'not_measured' as const,
    continuity: 'not_established' as const,
    historicalObservation: {
      status: 'point_series' as const,
      claim: 'aggregate_market_state_points_only' as const,
      sourceKind: 'local_sha_chained_finalized_venue_snapshots' as const,
      sampleCount: verifiedPointCount,
      holderExecutableExit: false as const,
      prospectiveValidated: false as const,
      predictiveAlertEligible: false as const,
      flowStatus: 'not_measured' as const,
      continuity: 'not_established' as const,
    },
    comparisonStatus: record.comparison?.status,
    block: source.block,
    blockHash,
    sourceBlockTime: new Date(source.timestamp * 1000).toISOString(),
    observedAt,
    firstLocalReceiptAt,
    caveat: identityChecked
      ? 'Aggregate market cash is a current upper bound. Holder execution and future exit duration are unvalidated.'
      : 'Vault assets are observed; protocol cash is unmeasured. Holder execution and future exit duration are unvalidated.',
    destinations: [
      {
        vault,
        asset,
        vaultDecimals,
        assetDecimals,
        totalAssetsRaw: record.measurement.totalAssetsRaw,
        totalSupplyRaw: record.measurement.totalSupplyRaw,
        cashRaw: rawCash,
        firstLocalReceiptAt,
        source: isAave ? ('finalized_direct_supply' as const) : ('finalized_erc4626' as const),
        routeAssetIdentity: isAave
          ? ('market_verified' as const)
          : isSgho
            ? ('confirmed' as const)
            : ('unverified' as const),
        ...(isAave ? { marketKind: 'aave_v3_atoken' as const } : {}),
        ...(!identityChecked ? { exitMechanics: 'cooldown_required' as const } : {}),
      },
    ],
  }
}

function localCarryObservation(
  req: NextApiRequest,
  routeKey: string,
  subjects: LocalRouteSubject[],
) {
  if (!localDevelopmentRequest(req)) return null
  const venue = LOCAL_ROUTE_VENUES[routeKey]
  if (!venue) return null
  try {
    const { count, last } = verifyLocalVenueSnapshots(venue)
    return last ? checkedLocalCarryObservation(routeKey, subjects, last, Date.now(), count) : null
  } catch {
    return null
  }
}

async function localHistoricalCarryObservation(
  req: NextApiRequest,
  routeKey: string,
  subjects: LocalRouteSubject[],
) {
  if (!localDevelopmentRequest(req)) return null
  const manifest = await buildSubjectManifest()
  const fullyFrozenEnrolled =
    subjects.length > 0 &&
    subjects.every((subject) =>
      manifest.subjects.some(
        (candidate) =>
          candidate.route_key === routeKey &&
          candidate.destination === subject.destinationAddress.toLowerCase(),
      ),
    )
  if (fullyFrozenEnrolled) {
    const observations = readLocalCarryCashObservations(manifest) as LocalCashReceipt[]
    return checkedLocalHistoricalCarryObservation(
      routeKey,
      subjects,
      manifest.subjects as LocalCashSubject[],
      observations,
    )
  }

  const supplementalManifest = await buildSupplementalAaveUsdeCashManifest({
    issueManifest: manifest,
  })
  const fullySupplementalEnrolled =
    subjects.length > 0 &&
    subjects.every((subject) =>
      supplementalManifest.subjects.some(
        (candidate) =>
          candidate.route_key === routeKey &&
          candidate.destination === subject.destinationAddress.toLowerCase(),
      ),
    )
  if (fullySupplementalEnrolled) {
    const verified = verifyLocalSupplementalAaveUsdeCash(supplementalManifest)
    return checkedLocalHistoricalCarryObservation(
      routeKey,
      subjects,
      supplementalManifest.subjects as LocalCashSubject[],
      localSupplementalAaveUsdeCashObservationsFromVerified(verified) as LocalCashReceipt[],
    )
  }

  return checkedLocalHistoricalCarryObservation(
    routeKey,
    subjects,
    manifest.subjects as LocalCashSubject[],
    [],
  )
}

const sha256 = (name: string) =>
  createHash('sha256')
    .update(readFileSync(join(process.cwd(), name)))
    .digest('hex')

const iso = (value: unknown) => {
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

const raw = (value: unknown) => {
  const string = String(value)
  return /^(0|[1-9][0-9]*)$/.test(string) ? string : null
}

const morphoAssetByVault = new Map(
  morphoIdentities.entries.map((entry) => [entry.vault.toLowerCase(), entry.asset.toLowerCase()]),
)
const TWYNE_ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]'
const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const USD3_ROUTE = 'USDC → USD3 [USDC]'
const USD3_VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc'

/** This wrapper owns aTokens; raw PT balance and accounting assets are not exit cash. */
export function carryVaultBalanceDisclosure(routeKey: string, vault: string) {
  const address = vault.toLowerCase()
  if (routeKey === TWYNE_ROUTE && address === TWYNE_WRAPPER) {
    return {
      cashRaw: null,
      totalAssetsRaw: null,
      cashInterpretation: 'wrapped_atoken_exit_cash_unassessed' as const,
    }
  }
  if (routeKey === USD3_ROUTE && address === USD3_VAULT) {
    return { cashInterpretation: 'direct_buffer_only' as const }
  }
  return {}
}
if (
  morphoIdentities.cohortId !== seed.cohortId ||
  morphoIdentities.entries.length !== 49 ||
  morphoAssetByVault.size !== 49
) {
  throw new Error('morpho_asset_identity_manifest_invalid')
}

function directSupplyRpc() {
  const configured = process.env.RECORDER_RPC_URLS || process.env.RECORDER_RPC_URL
  if (configured) return configured
  try {
    const env = readEnv()
    return env.get('RECORDER_RPC_URLS') || env.get('RECORDER_RPC_URL') || null
  } catch {
    return null
  }
}

type DirectCashReading = Awaited<ReturnType<typeof readDirectSupplyCashForRoute>>
type DirectCashWitness = { host: string; reading: DirectCashReading }

function directSupplyOrigins(): Array<{ host: string; url: string }> {
  const configured = directSupplyRpc()?.split(',') ?? []
  const candidates = [
    ...configured,
    process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? '',
    ...PUBLIC_MAINNET_RPCS,
  ]
  const origins: Array<{ host: string; url: string }> = []
  for (const candidate of candidates) {
    const url = candidate.trim()
    if (!url) continue
    try {
      const parsed = new URL(url)
      if (!['https:', 'http:'].includes(parsed.protocol)) continue
      const host = parsed.hostname.toLowerCase()
      if (origins.some((origin) => origin.host === host)) continue
      origins.push({ host, url })
      if (origins.length === 3) break
    } catch {
      // Ignore a malformed configured URL and try the next independent origin.
    }
  }
  return origins
}

export function sameDirectCashReading(first: DirectCashReading, second: DirectCashReading) {
  return (
    first.source.chainId === second.source.chainId &&
    first.source.blockNumber === second.source.blockNumber &&
    first.source.blockHash.toLowerCase() === second.source.blockHash.toLowerCase() &&
    first.source.blockTimestamp === second.source.blockTimestamp &&
    first.asset.address.toLowerCase() === second.asset.address.toLowerCase() &&
    first.asset.decimals === second.asset.decimals &&
    first.route.routeKey === second.route.routeKey &&
    first.route.destination.toLowerCase() === second.route.destination.toLowerCase() &&
    first.route.venueKind === second.route.venueKind &&
    first.route.cashRaw === second.route.cashRaw &&
    first.route.totalSupplyRaw === second.route.totalSupplyRaw
  )
}

export function selectDirectCashWitness(witnesses: DirectCashWitness[]) {
  if (witnesses.length === 1)
    return { reading: witnesses[0].reading, originValidation: 'single_rpc_host' as const }
  if (
    witnesses.length > 1 &&
    new Set(witnesses.map((witness) => witness.host)).size === witnesses.length &&
    witnesses
      .slice(1)
      .every((witness) => sameDirectCashReading(witnesses[0].reading, witness.reading))
  )
    return { reading: witnesses[0].reading, originValidation: 'multi_rpc_host_match' as const }
  return null
}

export async function readCurrentDirectCashOrigins(routeKey: DirectSupplyRouteKey) {
  const origins = directSupplyOrigins()
  if (!origins.length) return { status: 'no_origins' as const }
  const results = await Promise.allSettled(
    origins.map(async (origin) => ({
      host: origin.host,
      reading: await readDirectSupplyCashForRoute(makeClient(origin.url), routeKey),
    })),
  )
  const witnesses: DirectCashWitness[] = []
  for (const result of results) if (result.status === 'fulfilled') witnesses.push(result.value)
  const selected = selectDirectCashWitness(witnesses)
  if (selected) return { status: 'observed' as const, ...selected }
  if (witnesses.length > 1) return { status: 'disagreement' as const }
  return { status: 'read_unavailable' as const }
}

/** A route-wide read is accepted only when every August vault belongs to the same sealed batch. */
export function checkedCarryRouteBatch(
  rows: ObservationRow[],
  expectedVaults: string[],
  expected: {
    seedSha256: string
    boardSha256: string
    displayedRoutesSha256: string
    seedSourceSha256: string
    cohortId: string
  },
) {
  if (!expectedVaults.length) return null
  const byVault = new Map<string, ObservationRow>()
  for (const row of rows) {
    const vault = String(row.vault).toLowerCase()
    if (byVault.has(vault)) return null
    byVault.set(vault, row)
  }
  if (byVault.size !== expectedVaults.length) return null
  const sorted = expectedVaults.map((vault) => byVault.get(vault.toLowerCase()))
  if (sorted.some((row) => !row)) return null
  const batch = sorted as ObservationRow[]
  const block = raw(batch[0].block)
  const blockHash = String(batch[0].block_hash).toLowerCase()
  const observedAt = iso(batch[0].observed_at)
  if (!block || !/^0x[0-9a-f]{64}$/.test(blockHash) || !observedAt) return null
  const destinations = batch.map((row) => {
    const vault = String(row.vault).toLowerCase()
    const asset = String(row.asset).toLowerCase()
    const receipt = iso(row.first_local_receipt_at)
    const vaultDecimals = Number(row.vault_decimals)
    const assetDecimals = Number(row.asset_decimals)
    const totalAssetsRaw = raw(row.total_assets_raw)
    const totalSupplyRaw = raw(row.total_supply_raw)
    const cashRaw = raw(row.cash_raw)
    if (
      raw(row.block) !== block ||
      String(row.block_hash).toLowerCase() !== blockHash ||
      iso(row.observed_at) !== observedAt ||
      row.seed_sha256 !== expected.seedSha256 ||
      row.board_sha256 !== expected.boardSha256 ||
      row.displayed_routes_sha256 !== expected.displayedRoutesSha256 ||
      row.seed_source_sha256 !== expected.seedSourceSha256 ||
      row.cohort_id !== expected.cohortId ||
      !/^0x[0-9a-f]{40}$/.test(vault) ||
      !/^0x[0-9a-f]{40}$/.test(asset) ||
      !Number.isInteger(vaultDecimals) ||
      vaultDecimals < 0 ||
      vaultDecimals > 255 ||
      !Number.isInteger(assetDecimals) ||
      assetDecimals < 0 ||
      assetDecimals > 255 ||
      !totalAssetsRaw ||
      !totalSupplyRaw ||
      !cashRaw ||
      !receipt ||
      receipt < observedAt
    ) {
      return null
    }
    return {
      vault,
      asset,
      vaultDecimals,
      assetDecimals,
      totalAssetsRaw,
      totalSupplyRaw,
      cashRaw,
      firstLocalReceiptAt: receipt,
      source: 'finalized_erc4626' as const,
    }
  })
  const completeDestinations = destinations.filter(
    (row): row is NonNullable<typeof row> => row !== null,
  )
  if (completeDestinations.length !== batch.length) return null
  return {
    block,
    blockHash,
    observedAt,
    firstLocalReceiptAt: completeDestinations
      .map((row) => row.firstLocalReceiptAt)
      .sort()
      .at(-1)!,
    destinations: completeDestinations,
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }
  const routeKey = Array.isArray(req.query.routeKey) ? null : req.query.routeKey
  if (typeof routeKey !== 'string' || !routeKey || routeKey.length > 160) {
    return res.status(400).json({ error: 'routeKey required' })
  }
  const registry = buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )
  const route = registry.routeGroups.find((group) => group.routeKey === routeKey)
  if (!route) return res.status(404).json({ error: 'unknown route' })
  const base = {
    routeKey,
    forecastValidation: 'not_validated' as const,
    exitProjectionStatus: 'unavailable' as const,
    durationProjectionStatus: 'unavailable' as const,
  }
  let frozenCohortHistoricalObservation:
    | ReturnType<typeof checkedLocalHistoricalCarryObservation>['historicalObservation']
    | null = null
  if (localDevelopmentRequest(req)) {
    try {
      const localHistorical = await localHistoricalCarryObservation(
        req,
        routeKey,
        route.contractSubjects,
      )
      if (localHistorical && localHistorical.status !== 'not_enrolled')
        return res.status(200).json(localHistorical)
      frozenCohortHistoricalObservation = localHistorical?.historicalObservation ?? null
      const localPointSeries = localCarryObservation(req, routeKey, route.contractSubjects)
      if (localPointSeries)
        return res.status(200).json({
          ...localPointSeries,
          ...(frozenCohortHistoricalObservation ? { frozenCohortHistoricalObservation } : {}),
        })
    } catch {
      return res.status(503).json({ error: 'local_historical_cash_evidence_unavailable' })
    }
  }
  const frozenCohortGap = frozenCohortHistoricalObservation
    ? { frozenCohortHistoricalObservation }
    : {}
  const augustVaults = route.contractSubjects
    .filter((subject) => subject.identitySource.kind === 'august_observed')
    .map((subject) => subject.destinationAddress)
  if (!augustVaults.length) {
    const market = route.contractSubjects.find(
      (subject) =>
        subject.identitySource.kind === 'repo_verified_market' ||
        subject.identitySource.kind === 'receipt_verified_market',
    )
    if (market && route.contractSubjects.length === 1) {
      const current = await readCurrentDirectCashOrigins(routeKey as DirectSupplyRouteKey)
      if (current.status === 'no_origins') {
        const local = localCarryObservation(req, routeKey, route.contractSubjects)
        if (local) return res.status(200).json(local)
        return res.status(503).json({
          ...base,
          ...frozenCohortGap,
          status: 'unavailable',
          reason: 'direct_supply_rpc_unavailable',
          destinations: [],
        })
      }
      if (current.status === 'disagreement')
        return res.status(503).json({
          ...base,
          ...frozenCohortGap,
          status: 'unavailable',
          reason: 'direct_supply_provider_disagreement',
          destinations: [],
        })
      if (current.status === 'read_unavailable') {
        const local = localCarryObservation(req, routeKey, route.contractSubjects)
        if (local) return res.status(200).json(local)
        return res.status(503).json({
          ...base,
          ...frozenCohortGap,
          status: 'unavailable',
          reason: 'direct_supply_read_unavailable',
          destinations: [],
        })
      }
      try {
        const { reading, originValidation } = current
        const direct = reading.route
        if (direct.destination.toLowerCase() !== market.destinationAddress) {
          throw new Error('direct_supply_destination_mismatch')
        }
        return res.status(200).json({
          ...base,
          ...frozenCohortGap,
          status: 'observed',
          freshness: 'fresh',
          block: String(reading.source.blockNumber),
          blockHash: reading.source.blockHash,
          observedAt: reading.source.blockTimestamp,
          originValidation,
          caveat: reading.caveat,
          destinations: [
            {
              vault: direct.destination.toLowerCase(),
              asset: reading.asset.address.toLowerCase(),
              assetDecimals: reading.asset.decimals,
              vaultDecimals: reading.asset.decimals,
              cashRaw: direct.cashRaw,
              totalSupplyRaw: direct.totalSupplyRaw,
              routeAssetIdentity: 'market_verified',
              marketKind: direct.venueKind,
              source: 'finalized_direct_supply',
            },
          ],
        })
      } catch {
        const local = localCarryObservation(req, routeKey, route.contractSubjects)
        if (local) return res.status(200).json(local)
        return res.status(503).json({
          ...base,
          ...frozenCohortGap,
          status: 'unavailable',
          reason: 'direct_supply_read_unavailable',
          destinations: [],
        })
      }
    }
    return res.status(200).json({
      ...base,
      ...frozenCohortGap,
      status: 'unavailable',
      reason:
        route.addressCoverage === 'address_unresolved'
          ? 'destination_contract_unresolved'
          : 'no_august_erc4626_destination_contract',
      destinations: [],
    })
  }
  try {
    const result = await db.execute(sql`
      SELECT DISTINCT ON (vault) vault, asset, vault_decimals, asset_decimals,
        total_assets_raw, total_supply_raw, cash_raw, block, block_hash,
        observed_at, first_local_receipt_at, cohort_id, seed_sha256, board_sha256,
        displayed_routes_sha256, seed_source_sha256
      FROM carry_route_vault_observations
      WHERE route_key = ${routeKey}
      ORDER BY vault, block DESC
    `)
    const batch = checkedCarryRouteBatch(result.rows as ObservationRow[], augustVaults, {
      seedSha256: sha256('scripts/route-cohort/aug-2026-ab-vault-seed.json'),
      boardSha256: sha256('components/Carry/route-capital.json'),
      displayedRoutesSha256: sha256('components/Carry/fixtures.ts'),
      seedSourceSha256: seed.source.sha256,
      cohortId: seed.cohortId,
    })
    if (!batch) {
      return res.status(200).json({
        ...base,
        status: 'unavailable',
        reason: 'complete_same_block_observation_missing',
        destinations: [],
      })
    }
    const destinations = batch.destinations.map((destination) => {
      const configured = recorderConfig.venues.find(
        (venue) => venue.enabled && venue.address.toLowerCase() === destination.vault.toLowerCase(),
      )
      const expectedAsset =
        configured && 'underlying' in configured && typeof configured.underlying === 'string'
          ? configured.underlying.toLowerCase()
          : null
      const factoryAsset = morphoAssetByVault.get(destination.vault) ?? null
      const otherIdentity = checkOtherVaultAssetIdentity(destination.vault, destination.asset)
      return {
        ...destination,
        ...carryVaultBalanceDisclosure(routeKey, destination.vault),
        ...(otherIdentity
          ? {
              identityEvidenceKind: otherIdentity.evidenceKind,
              identityEvidenceUrl: otherIdentity.evidenceUrl,
              exitMechanics: otherIdentity.exitMechanics,
            }
          : {}),
        routeAssetIdentity:
          expectedAsset !== null
            ? expectedAsset === destination.asset
              ? ('confirmed' as const)
              : ('mismatch' as const)
            : factoryAsset !== null
              ? factoryAsset === destination.asset
                ? ('factory_verified' as const)
                : ('mismatch' as const)
              : otherIdentity !== null
                ? otherIdentity.match
                  ? ('source_verified' as const)
                  : ('mismatch' as const)
                : ('unverified' as const),
      }
    })
    if (destinations.some((destination) => destination.routeAssetIdentity === 'mismatch')) {
      return res.status(200).json({
        ...base,
        status: 'unavailable',
        reason: 'configured_route_asset_identity_mismatch',
        destinations: [],
      })
    }
    const ageMs = Date.now() - Date.parse(batch.observedAt)
    return res.status(200).json({
      ...base,
      status: 'observed',
      freshness: ageMs >= 0 && ageMs <= 2 * 60 * 60 * 1000 ? 'fresh' : 'stale',
      ...batch,
      destinations,
    })
  } catch {
    const local = localCarryObservation(req, routeKey, route.contractSubjects)
    if (local) return res.status(200).json(local)
    return res.status(503).json({
      ...base,
      status: 'unavailable',
      reason: 'observation_store_unavailable',
      destinations: [],
    })
  }
}
