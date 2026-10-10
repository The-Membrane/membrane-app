import type { NextApiRequest, NextApiResponse } from 'next'
import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { describeRouteReading } from '@/lib/carry/liveRouteFreshness'
import { publicRouteData, publicUsdePilotData } from '@/lib/carry/publicRouteData'
import { validStoredUsdeSpread } from '@/lib/carry/usdeStoredSpread'

const HOLDER_KEY = 'GHO → sGho [GHO]'
const SPREAD_KEY =
  '1:aave v3:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f:0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
const USDE_KEY = 'USDe → Staked USDe [USDe]'
const USDE_SPREAD_KEY =
  '1:aave v3 core:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:0x4c9edd5852cd905f086c759e8383e09bff1e68b3:0x9d39a5de30e57443bff2a8307a4256c8797a3497'

type StoredRow = {
  route_key: string
  kind: 'holder_stock' | 'spread' | 'matched_capital' | 'destination_tvl' | 'prospective_overlap'
  block: string | number
  observed_at: string | Date
  data: Record<string, unknown>
}

const HEX32 = /^0x[0-9a-f]{64}$/i
const SHA256 = /^[0-9a-f]{64}$/i
const GHO_LOOKBACK_SECONDS = 7 * 24 * 60 * 60
const GHO_RATE_CONVENTION = 'effective APY, decimal fraction'
const GHO_BORROW_SOURCE = 'Aave V3 currentVariableBorrowRate, nominal ray APR compounded per second'
const GHO_YIELD_SOURCE =
  'ERC4626 convertToAssets share-price growth, realized trailing window; incentives excluded'
const RAW_AMOUNT = /^(0|[1-9]\d*)$/
const DECIMAL_AMOUNT = /^(0|[1-9]\d*)(?:\.\d+)?$/

function rawMatchesDecimal(raw: unknown, decimal: unknown, numeric = false) {
  if (typeof raw !== 'string' || !RAW_AMOUNT.test(raw)) return false
  if (numeric) {
    if (typeof decimal !== 'number' || !Number.isFinite(decimal)) return false
  } else if (typeof decimal !== 'string' || !DECIMAL_AMOUNT.test(decimal)) return false
  const units = BigInt(raw)
  const whole = units / 10n ** 18n
  const fraction = (units % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  const formatted = fraction ? `${whole}.${fraction}` : whole.toString()
  return numeric ? Number(formatted) === decimal : formatted === decimal
}

function isGhoLeg(leg: unknown) {
  if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return false
  const fields = leg as Record<string, unknown>
  return (
    fields.chainId === 1 &&
    fields.borrowProtocol === 'Aave V3' &&
    fields.borrowMarket === '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' &&
    fields.borrowAsset === '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' &&
    fields.destinationKind === 'ERC4626' &&
    fields.destination === '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d'
  )
}

function isGhoLookback(lookback: unknown, asOf: number, block: number) {
  if (!lookback || typeof lookback !== 'object' || Array.isArray(lookback)) return false
  const fields = lookback as Record<string, unknown>
  const priorBlock = Number(fields.priorBlockNumber)
  return (
    typeof fields.seconds === 'number' &&
    Number.isSafeInteger(fields.seconds) &&
    Math.abs(fields.seconds - GHO_LOOKBACK_SECONDS) <= 60 * 60 &&
    typeof fields.priorAt === 'number' &&
    Number.isSafeInteger(fields.priorAt) &&
    fields.priorAt >= 0 &&
    fields.priorAt === asOf - fields.seconds &&
    typeof fields.priorBlockNumber === 'string' &&
    fields.priorBlockNumber === String(priorBlock) &&
    Number.isSafeInteger(priorBlock) &&
    priorBlock >= 0 &&
    priorBlock < block
  )
}

function readableRow(row: StoredRow, usde = false) {
  const observedAt = new Date(row.observed_at)
  const block = Number(row.block)
  if (
    !Number.isFinite(observedAt.getTime()) ||
    !Number.isSafeInteger(block) ||
    block < 0 ||
    !row.data ||
    typeof row.data !== 'object' ||
    Array.isArray(row.data)
  )
    return null
  const data = usde ? publicUsdePilotData(row.kind, row.data) : publicRouteData(row.kind, row.data)
  if (!data) return null
  // Older stored rows carried a one-hour collector expiry. Display age is
  // governed by this API's daily-reading policy, not that legacy field.
  delete data.freshness
  return {
    ...data,
    block,
    observedAt: observedAt.toISOString(),
    ...describeRouteReading(observedAt),
  }
}

function eligibleUsdeRow(row: StoredRow) {
  const reading = readableRow(row, true)
  if (!reading) return null
  const blockHash = row.kind === 'spread' ? row.data.currentBlockHash : row.data.blockHash
  // The stored row has no separate DB hash column. This checks syntax; only a
  // complete pilot trio can also cross-check its three embedded block hashes.
  if (typeof blockHash !== 'string' || !HEX32.test(blockHash)) return null
  if (row.kind === 'spread') {
    if (
      row.data.currentBlockNumber !== String(reading.block) ||
      row.data.currentBlockTimestamp !== reading.observedAt ||
      !validStoredUsdeSpread(row.data, reading.block, reading.observedAt)
    )
      return null
  } else if (
    row.data.blockNumber !== String(reading.block) ||
    row.data.blockTimestamp !== reading.observedAt
  ) {
    return null
  }
  return { row, reading, blockHash: blockHash.toLowerCase() }
}

function eligibleGhoSpread(row: StoredRow) {
  const reading = readableRow(row)
  if (!reading || row.kind !== 'spread') return null
  const { status, key, leg, blockNumber, blockHash, asOf, lookback, borrowApy, yieldApy, spread } =
    row.data
  if (
    status !== 'priced' ||
    key !== SPREAD_KEY ||
    !isGhoLeg(leg) ||
    blockNumber !== String(reading.block) ||
    typeof blockHash !== 'string' ||
    !HEX32.test(blockHash) ||
    typeof asOf !== 'number' ||
    !Number.isSafeInteger(asOf) ||
    asOf < 0 ||
    asOf * 1000 !== Date.parse(reading.observedAt) ||
    !isGhoLookback(lookback, asOf, reading.block) ||
    row.data.rateConvention !== GHO_RATE_CONVENTION ||
    row.data.borrowSource !== GHO_BORROW_SOURCE ||
    row.data.yieldSource !== GHO_YIELD_SOURCE ||
    typeof borrowApy !== 'number' ||
    !Number.isFinite(borrowApy) ||
    typeof yieldApy !== 'number' ||
    !Number.isFinite(yieldApy) ||
    typeof spread !== 'number' ||
    !Number.isFinite(spread) ||
    Math.abs(spread - (yieldApy - borrowApy)) > 1e-12
  )
    return null
  return reading
}

/** A stored GHO rate must match its DB head and its own arithmetic. */
export function selectLatestGhoExactSpread(rows: StoredRow[], nowMs = Date.now()) {
  return (
    rows
      .filter((row) => row.route_key === SPREAD_KEY && row.kind === 'spread')
      .map(eligibleGhoSpread)
      .filter((reading) => reading !== null && Date.parse(reading.observedAt) <= nowMs)
      .sort(
        (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.block - a.block,
      )[0] ?? null
  )
}

/** A valid rate leg does not require a matching fixed-wallet capital/TVL pair. */
export function selectLatestUsdeExactSpread(rows: StoredRow[], nowMs = Date.now()) {
  return (
    rows
      .filter((row) => row.route_key === USDE_SPREAD_KEY && row.kind === 'spread')
      .map(eligibleUsdeRow)
      .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
      .sort(
        (a, b) =>
          Date.parse(b.reading.observedAt) - Date.parse(a.reading.observedAt) ||
          b.reading.block - a.reading.block,
      )[0]?.reading ?? null
  )
}

function eligibleUsdeCapital(row: StoredRow) {
  const eligible = eligibleUsdeRow(row)
  if (!eligible || row.kind !== 'matched_capital') return null
  const data = row.data
  if (
    data.claim !== 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit' ||
    data.measurement !==
      'lesser_of_current_aave_usde_variable_debt_and_susde_holding_per_august_receipt_attested_wallet' ||
    data.observedWalletCount !== 25 ||
    data.completeWalletCount !== 25 ||
    data.unknownWalletCount !== 0 ||
    !rawMatchesDecimal(data.matchedRaw, data.matchedUsde) ||
    typeof data.artifactSha256 !== 'string' ||
    !SHA256.test(data.artifactSha256) ||
    typeof data.manifestSha256 !== 'string' ||
    !SHA256.test(data.manifestSha256)
  )
    return null
  return eligible
}

function eligibleUsdeDestination(row: StoredRow) {
  const eligible = eligibleUsdeRow(row)
  if (!eligible || row.kind !== 'destination_tvl') return null
  const data = row.data
  if (
    data.claim !== 'all_depositor_vault_assets_not_route_tvl' ||
    data.measurement !== 'destination_vault_total_assets_all_depositors' ||
    data.observedWalletCount !== 25 ||
    data.completeWalletCount !== 25 ||
    data.unknownWalletCount !== 0 ||
    !rawMatchesDecimal(data.totalAssetsRaw, data.totalAssetsUsde) ||
    typeof data.artifactSha256 !== 'string' ||
    !SHA256.test(data.artifactSha256) ||
    typeof data.manifestSha256 !== 'string' ||
    !SHA256.test(data.manifestSha256)
  )
    return null
  return eligible
}

/** The fixed August-wallet overlap can be dated independently of the rate leg. */
export function selectLatestUsdeMatchedCapital(rows: StoredRow[], nowMs = Date.now()) {
  const matched = rows
    .filter((row) => row.route_key === USDE_KEY && row.kind === 'matched_capital')
    .map(eligibleUsdeCapital)
    .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
    .sort(
      (a, b) =>
        Date.parse(b.reading.observedAt) - Date.parse(a.reading.observedAt) ||
        b.reading.block - a.reading.block,
    )
  const destinations = rows
    .filter((row) => row.route_key === USDE_KEY && row.kind === 'destination_tvl')
    .map(eligibleUsdeDestination)
    .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
  for (const capital of matched) {
    const destination = destinations.find(
      (candidate) =>
        candidate.reading.block === capital.reading.block &&
        candidate.reading.observedAt === capital.reading.observedAt &&
        candidate.blockHash === capital.blockHash &&
        candidate.row.data.artifactSha256 === capital.row.data.artifactSha256 &&
        candidate.row.data.manifestSha256 === capital.row.data.manifestSha256,
    )
    if (destination) return capital.reading
  }
  return null
}

/** The GHO fixed-20 overlap has no destination pairing requirement. */
export function selectLatestGhoMatchedCapital(rows: StoredRow[], nowMs = Date.now()) {
  return (
    rows
      .filter((row) => row.route_key === HOLDER_KEY && row.kind === 'matched_capital')
      .map((row) => {
        const reading = readableRow(row)
        const data = row.data
        if (
          !reading ||
          data.measurement !==
            'lesser_of_current_aave_gho_debt_and_sgho_holding_per_august_observed_wallet' ||
          data.sourceSha256 !==
            'a0aee85535cb4c96f09d2f3bce3af3d2bcc9d1e2ee0156e24265111263c4cf63' ||
          data.borrowMarket !== '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' ||
          data.borrowAsset !== '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' ||
          data.destination !== '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d' ||
          data.receiptProofCount !== 20 ||
          data.observedWalletCount !== 20 ||
          data.completeWalletCount !== 20 ||
          data.unknownWalletCount !== 0 ||
          typeof data.blockHash !== 'string' ||
          !HEX32.test(data.blockHash) ||
          !rawMatchesDecimal(data.matchedRaw, data.matchedGho, true)
        )
          return null
        return reading
      })
      .filter((reading) => reading !== null && Date.parse(reading.observedAt) <= nowMs)
      .sort(
        (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt) || b.block - a.block,
      )[0] ?? null
  )
}

/** Never combine a fixed-cohort capital row with a rate leg from another head. */
export function selectUsdePilotPair(rows: StoredRow[], nowMs = Date.now()) {
  const empty = {
    asOf: null,
    matchedCapital: null,
    destinationVaultTvl: null,
    exactSpread: null,
  }
  const matched = rows
    .filter((row) => row.route_key === USDE_KEY && row.kind === 'matched_capital')
    .map(eligibleUsdeCapital)
    .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
    .sort(
      (a, b) =>
        Date.parse(b.reading.observedAt) - Date.parse(a.reading.observedAt) ||
        b.reading.block - a.reading.block,
    )
  const destinations = rows
    .filter((row) => row.route_key === USDE_KEY && row.kind === 'destination_tvl')
    .map(eligibleUsdeDestination)
    .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
  const spreads = rows
    .filter((row) => row.route_key === USDE_SPREAD_KEY && row.kind === 'spread')
    .map(eligibleUsdeRow)
    .filter((row) => row !== null && Date.parse(row.reading.observedAt) <= nowMs)
  for (const capital of matched) {
    const sameHead = (candidate: NonNullable<ReturnType<typeof eligibleUsdeRow>>) =>
      candidate.reading.block === capital.reading.block &&
      candidate.reading.observedAt === capital.reading.observedAt &&
      candidate.blockHash === capital.blockHash
    const destination = destinations.find(
      (candidate) =>
        sameHead(candidate) &&
        typeof capital.row.data.artifactSha256 === 'string' &&
        SHA256.test(capital.row.data.artifactSha256) &&
        candidate.row.data.artifactSha256 === capital.row.data.artifactSha256 &&
        typeof capital.row.data.manifestSha256 === 'string' &&
        SHA256.test(capital.row.data.manifestSha256) &&
        candidate.row.data.manifestSha256 === capital.row.data.manifestSha256,
    )
    const spread = spreads.find(sameHead)
    if (!destination || !spread) continue
    return {
      asOf: {
        block: capital.reading.block,
        blockHash: capital.blockHash,
        observedAt: capital.reading.observedAt,
      },
      matchedCapital: capital.reading,
      destinationVaultTvl: destination.reading,
      exactSpread: spread.reading,
    }
  }
  return empty
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'GET only' })
  }

  let rows: StoredRow[]
  try {
    rows = (
      await db.execute(sql`
        SELECT route_key, kind, block, observed_at, data
        FROM (
          SELECT route_key, kind, block, observed_at, data,
            ROW_NUMBER() OVER (PARTITION BY route_key, kind ORDER BY observed_at DESC, block DESC) AS ordinal
          FROM carry_route_hourly
          WHERE status = 'ok'
            AND observed_at <= NOW()
            AND ((route_key = ${HOLDER_KEY} AND kind IN ('holder_stock', 'matched_capital', 'destination_tvl', 'prospective_overlap'))
              OR (route_key = ${SPREAD_KEY} AND kind = 'spread')
              OR (route_key = ${USDE_KEY} AND kind IN ('matched_capital', 'destination_tvl'))
              OR (route_key = ${USDE_SPREAD_KEY} AND kind = 'spread'))
        ) recent
        WHERE ordinal <= 32
        ORDER BY route_key, kind, observed_at DESC, block DESC
      `)
    ).rows as StoredRow[]
  } catch {
    // Migration or database may be unavailable. Do not imply no reading exists.
    return res.status(503).json({ error: 'Route readings temporarily unavailable' })
  }

  const latestGood = (routeKey: string, kind: StoredRow['kind']) => {
    const nowMs = Date.now()
    for (const row of rows) {
      if (row.route_key !== routeKey || row.kind !== kind) continue
      const reading = readableRow(row)
      if (reading && Date.parse(reading.observedAt) <= nowMs) return reading
    }
    return null
  }

  res.setHeader('Cache-Control', 'public, s-maxage=60')
  return res.status(200).json({
    scope: 'Exact Carry route pilots',
    holderStock: latestGood(HOLDER_KEY, 'holder_stock'),
    matchedCapital: selectLatestGhoMatchedCapital(rows),
    prospectiveOverlap: latestGood(HOLDER_KEY, 'prospective_overlap'),
    destinationVaultTvl: latestGood(HOLDER_KEY, 'destination_tvl'),
    exactAaveSpread: selectLatestGhoExactSpread(rows),
    latestUsdeExactSpread: selectLatestUsdeExactSpread(rows),
    latestUsdeMatchedCapital: selectLatestUsdeMatchedCapital(rows),
    usdePilot: {
      scope: 'Aave Core USDe → sUSDe',
      ...selectUsdePilotPair(rows),
      caveat:
        'Vault totalAssets is all depositors. Fixed August-wallet debt/holding overlap is not route-attributed TVL or a current borrower census. The spread compares current Aave borrowing with trailing seven-day sUSDe share growth, excluding incentives, gas, and exit costs.',
    },
    caveat:
      'Destination TVL is all sGHO vault depositors. Matched debt/holding in the 20 August-observed wallets and any separate post-watch event-observed borrower sample are not route-attributed TVL; GHO is fungible. Prospective discovery covers only its sealed block window, not all users. The exact Aave rate leg is independent of both cohorts.',
  })
}
