// Daily USDe→sUSDe pilot. Fixed August overlap + destination assets share
// one sealed block; the exact two-leg spread is independently promoted.
// The hourly tick may invoke this, but only successful legs reset their 24h clock.
import { createHash, randomUUID } from 'node:crypto'
import { access, link, mkdir, open, readFile, statfs, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'
import { formatUnits } from 'viem'

import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'
import { COHORT_SIZE, ROUTE, SOURCE_SHA256 } from './route-cohort/usde-susde-receipts.mjs'
import { RECEIPT_SHA256, main as matchedMain } from './route-cohort/usde-susde-matched.mjs'
import { USDE_LEG, main as spreadMain } from './route-rates/usde-exact-spread.mjs'

export const CADENCE_MS = 24 * 60 * 60 * 1000
export const MAX_PROMOTION_AGE_MS = 2 * 60 * 60 * 1000
export const MIN_FREE_BYTES = 1_073_741_824
export const SPREAD_KEY = [
  USDE_LEG.chainId,
  USDE_LEG.borrowProtocol,
  USDE_LEG.borrowMarket,
  USDE_LEG.borrowAsset,
  USDE_LEG.destination,
]
  .map((part) => String(part).toLowerCase())
  .join(':')

const COHORT_CACHE = join(ROOT, 'scripts', 'route-cohort', '.cache')
const RATE_CACHE = join(COHORT_CACHE, 'usde-daily')
const SOURCE_PATH = join(COHORT_CACHE, 'usde-aug-source-a0aee855.json')
const RECEIPT_PATH = join(COHORT_CACHE, 'usde-susde-receipts-413d45d1.json')
const BOOTSTRAP = Object.freeze({
  matched: {
    day: '2026-09-27',
    path: join(COHORT_CACHE, 'usde-susde-matched-32adb0aa.json'),
    sha256: '32adb0aae6817a12e9c452ecb5bb5ce6349d607941a02e02cfa77e4de2b481eb',
  },
  spread: {
    day: '2026-09-27',
    path: join(COHORT_CACHE, 'usde-susde-spread-66af12ec.json'),
    sha256: '66af12ec3d0c09c71530890ebfc0540ec69fb375e862934088755ae8d5ec20a8',
  },
})
const HEX64 = /^[a-f0-9]{64}$/
const HEX32 = /^0x[a-f0-9]{64}$/
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const fail = (code) => {
  throw new Error(`usde_recorder_${code}`)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function assertDiskReserve(path, bytes, statfsFn = statfs) {
  const stats = await statfsFn(path)
  const freeBytes = Number(stats?.bavail) * Number(stats?.bsize)
  if (!Number.isFinite(freeBytes) || freeBytes - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

async function writeImmutable(path, bytes, statfsFn = statfs) {
  await assertDiskReserve(dirname(path), bytes.length, statfsFn)
  const temp = `${path}.tmp-${randomUUID()}`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await link(temp, path)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
  }
}

function manifestBody(kind, day, artifactPath, artifactSha256) {
  return {
    schemaVersion: 1,
    kind,
    day,
    artifactPath,
    artifactSha256,
    source:
      kind === 'matched'
        ? { augustSha256: SOURCE_SHA256, receiptsSha256: RECEIPT_SHA256 }
        : { leg: SPREAD_KEY },
  }
}

function checkManifest(manifest, kind, day) {
  const { manifestSha256, ...body } = manifest ?? {}
  if (
    !HEX64.test(manifestSha256 || '') ||
    sha256(JSON.stringify(body)) !== manifestSha256 ||
    body.schemaVersion !== 1 ||
    body.kind !== kind ||
    body.day !== day ||
    typeof body.artifactPath !== 'string' ||
    !resolve(body.artifactPath).endsWith('.json') ||
    !HEX64.test(body.artifactSha256 || '') ||
    JSON.stringify(body.source) !==
      JSON.stringify(manifestBody(kind, day, body.artifactPath, body.artifactSha256).source)
  )
    fail('manifest_invalid')
  return body
}

/** A manifest's physical artifact hash must exist before any Neon write. */
export async function loadOrCollect({
  kind,
  day,
  cacheDir,
  run,
  verify,
  bootstrap = null,
  statfsFn = statfs,
}) {
  if (!['matched', 'spread'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    fail('cache_identity_invalid')
  await mkdir(cacheDir, { recursive: true })
  const artifactPath = join(cacheDir, `${kind}-${day}.json`)
  const manifestPath = join(cacheDir, `${kind}-${day}.manifest.json`)
  let manifest
  let reused = false
  if (await exists(manifestPath)) {
    manifest = checkManifest(JSON.parse(await readFile(manifestPath)), kind, day)
    if (manifest.artifactPath !== artifactPath && manifest.artifactPath !== bootstrap?.path)
      fail('manifest_path_invalid')
    reused = true
  } else {
    let path = artifactPath
    let hash
    if (bootstrap?.day === day && (await exists(bootstrap.path))) {
      path = bootstrap.path
      hash = bootstrap.sha256
      if (!HEX64.test(hash || '')) fail('bootstrap_invalid')
      reused = true
    } else {
      // An orphan output has no independently retained hash. Do not requery,
      // overwrite, or silently promote it after a crash; operator recovery is needed.
      if (await exists(artifactPath)) fail('orphan_artifact')
      const sealed = await run(artifactPath)
      hash = sealed?.outputSha256
      if (!HEX64.test(hash || '')) fail('collector_output_hash_invalid')
    }
    const bytes = await readFile(path)
    if (sha256(bytes) !== hash) fail('artifact_hash_mismatch')
    const body = manifestBody(kind, day, path, hash)
    manifest = { ...body, manifestSha256: sha256(JSON.stringify(body)) }
    await writeImmutable(
      manifestPath,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      statfsFn,
    )
  }
  const bytes = await readFile(manifest.artifactPath)
  if (sha256(bytes) !== manifest.artifactSha256) fail('artifact_hash_mismatch')
  await verify(manifest.artifactPath, manifest.artifactSha256)
  const document = JSON.parse(bytes)
  if (
    !Number.isFinite(Date.parse(document?.capturedAt)) ||
    document.capturedAt.slice(0, 10) !== day
  )
    fail('cache_capture_day_mismatch')
  return {
    document,
    artifactSha256: manifest.artifactSha256,
    manifestSha256: manifest.manifestSha256,
    reused,
  }
}

export function dueKinds(rows, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs)) fail('clock_invalid')
  const last = (routeKey, kind) => {
    const times = rows
      .filter((row) => row.route_key === routeKey && row.kind === kind)
      .map((row) => Date.parse(row.observed_at))
      .filter((time) => Number.isFinite(time) && time <= nowMs)
    return times.length ? Math.max(...times) : NaN
  }
  const due = (time) => !Number.isFinite(time) || nowMs - time >= CADENCE_MS
  return {
    matched_capital: due(last(ROUTE, 'matched_capital')),
    destination_tvl: due(last(ROUTE, 'destination_tvl')),
    spread: due(last(SPREAD_KEY, 'spread')),
  }
}

export function assertPromotable(document, kind, day, nowMs) {
  const capturedAt = Date.parse(document?.capturedAt)
  const observedAt = Date.parse(
    kind === 'matched' ? document?.blockTimestamp : document?.currentBlockTimestamp,
  )
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(observedAt) ||
    document.capturedAt.slice(0, 10) !== day ||
    capturedAt - observedAt < -120_000 ||
    capturedAt - observedAt > MAX_PROMOTION_AGE_MS ||
    nowMs - observedAt < -120_000 ||
    nowMs - observedAt > MAX_PROMOTION_AGE_MS
  )
    fail('artifact_not_fresh_for_store')
  return true
}

function matchedAnchor(document) {
  return {
    blockNumber: document?.blockNumber,
    blockHash: document?.blockHash,
    blockTimestamp: document?.blockTimestamp,
  }
}

function spreadAnchor(document) {
  return {
    blockNumber: document?.currentBlockNumber,
    blockHash: document?.currentBlockHash,
    blockTimestamp: document?.currentBlockTimestamp,
  }
}

export function assertSameBlockPair(matchedDocument, spreadDocument, anchor = null) {
  const first = matchedAnchor(matchedDocument)
  const second = {
    blockNumber: spreadDocument?.currentBlockNumber,
    blockHash: spreadDocument?.currentBlockHash,
    blockTimestamp: spreadDocument?.currentBlockTimestamp,
  }
  if (
    !/^\d+$/.test(first.blockNumber || '') ||
    !HEX32.test(first.blockHash || '') ||
    !Number.isFinite(Date.parse(first.blockTimestamp)) ||
    first.blockNumber !== second.blockNumber ||
    first.blockHash.toLowerCase() !== second.blockHash?.toLowerCase() ||
    first.blockTimestamp !== second.blockTimestamp ||
    (anchor &&
      (first.blockNumber !== anchor.blockNumber ||
        first.blockHash.toLowerCase() !== anchor.blockHash ||
        first.blockTimestamp !== anchor.blockTimestamp))
  )
    fail('daily_pair_block_mismatch')
  return first
}

export async function selectFinalizedAnchor(client, nowMs) {
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const timestampMs = Number(block?.timestamp) * 1000
  if (
    typeof block?.number !== 'bigint' ||
    block.number <= 0n ||
    !HEX32.test(block.hash || '') ||
    !Number.isSafeInteger(timestampMs) ||
    nowMs - timestampMs < -120_000 ||
    nowMs - timestampMs > MAX_PROMOTION_AGE_MS
  )
    fail('finalized_anchor_invalid')
  return {
    blockNumber: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    blockTimestamp: new Date(timestampMs).toISOString(),
  }
}

export async function assertCanonicalAnchor(client, anchor, nowMs) {
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  if (!/^\d+$/.test(anchor?.blockNumber || '') || !HEX32.test(anchor?.blockHash || ''))
    fail('daily_pair_block_mismatch')
  const [finalized, block] = await Promise.all([
    client.getBlock({ blockTag: 'finalized' }),
    client.getBlock({ blockNumber: BigInt(anchor.blockNumber) }),
  ])
  const timestampMs = Number(block?.timestamp) * 1000
  if (
    typeof finalized?.number !== 'bigint' ||
    finalized.number < BigInt(anchor.blockNumber) ||
    !HEX32.test(finalized.hash || '') ||
    block?.number?.toString() !== anchor.blockNumber ||
    block?.hash?.toLowerCase() !== anchor.blockHash.toLowerCase() ||
    !Number.isSafeInteger(timestampMs) ||
    new Date(timestampMs).toISOString() !== anchor.blockTimestamp ||
    !Number.isSafeInteger(nowMs) ||
    nowMs - timestampMs < -120_000 ||
    nowMs - timestampMs > MAX_PROMOTION_AGE_MS
  )
    fail('daily_pair_block_changed')
  return true
}

/** Aggregate-only Neon projections; never include `document.rows` or wallet addresses. */
export function projectMatched(document, artifactSha256, manifestSha256) {
  if (
    document?.completeWalletCount !== COHORT_SIZE ||
    document.observedWalletCount !== COHORT_SIZE ||
    document.unknownWalletCount !== 0 ||
    document.claim !== 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit' ||
    !/^\d+$/.test(document.matchedRaw || '') ||
    !/^\d+$/.test(document.destinationVaultTotalAssetsRaw || '')
  )
    fail('matched_incomplete')
  const common = {
    sourceSha256: document.sourceSha256,
    receiptsSha256: document.sourceArtifactSha256,
    artifactSha256,
    manifestSha256,
    blockNumber: document.blockNumber,
    blockHash: document.blockHash,
    blockTimestamp: document.blockTimestamp,
    capturedAt: document.capturedAt,
    ageSecondsAtCapture: document.ageSecondsAtCapture,
    observedWalletCount: COHORT_SIZE,
    completeWalletCount: COHORT_SIZE,
    unknownWalletCount: 0,
    borrowMarket: document.borrowMarket,
    borrowAsset: document.borrowAsset,
    destination: document.destination,
  }
  return {
    matched: {
      measurement: document.measurement,
      claim: document.claim,
      ...common,
      matchedRaw: document.matchedRaw,
      matchedUsde: formatUnits(BigInt(document.matchedRaw), 18),
      caveat:
        'Lesser of current debt and sUSDe holding in each fixed August-observed wallet; fungible balances do not prove route attribution or discover new entrants.',
    },
    destination: {
      measurement: 'destination_vault_total_assets_all_depositors',
      claim: 'all_depositor_vault_assets_not_route_tvl',
      ...common,
      totalAssetsRaw: document.destinationVaultTotalAssetsRaw,
      totalAssetsUsde: formatUnits(BigInt(document.destinationVaultTotalAssetsRaw), 18),
      caveat:
        'sUSDe totalAssets includes unrelated depositors; it is not capital attributed to USDe borrowing.',
    },
  }
}

export function projectSpread(document, artifactSha256, manifestSha256) {
  if (
    document?.claim !== 'modeled_two_leg_spread_not_cohort_realized_return' ||
    !Number.isFinite(document.spread)
  )
    fail('spread_invalid')
  const { documentSha256: _localSeal, ...data } = document
  return { ...data, artifactSha256, manifestSha256 }
}

export function createNeonStorage(sql) {
  const insert = ({ routeKey, kind, block, observedAt, data }) => sql`INSERT INTO carry_route_hourly
    (route_key, kind, block, observed_at, status, data)
    VALUES (${routeKey}, ${kind}, ${block}, ${observedAt}, 'ok', ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (route_key, kind, block) DO UPDATE
      SET status = EXCLUDED.status, data = EXCLUDED.data, recorded_at = now()
      WHERE carry_route_hourly.status <> 'ok'`
  // A preexisting ok row with the same key but different provenance must abort
  // the entire non-interactive Neon transaction. Query results inspected after
  // transaction() returns would be too late: earlier inserts would be committed.
  const assertExact = ({ routeKey, kind, block, observedAt, data }) => sql`SELECT 1 / CASE
    WHEN EXISTS (
      SELECT 1 FROM carry_route_hourly
      WHERE route_key = ${routeKey} AND kind = ${kind} AND block = ${block}
        AND status = 'ok'
        AND observed_at = ${observedAt}::timestamptz
        AND data = ${JSON.stringify(data)}::jsonb
    ) THEN 1 ELSE 0 END AS exact_pair_row`
  return {
    latestSuccess: (
      nowMs = Date.now(),
    ) => sql`SELECT kind, route_key, MAX(observed_at) AS observed_at
      FROM carry_route_hourly
      WHERE status = 'ok'
        AND observed_at <= ${new Date(nowMs).toISOString()}::timestamptz
        AND ((route_key = ${ROUTE} AND kind IN ('matched_capital', 'destination_tvl'))
          OR (route_key = ${SPREAD_KEY} AND kind = 'spread'))
      GROUP BY kind, route_key`,
    // The caller supplies either the two rows from one matched artifact or a
    // single spread row. Exact-key guards execute inside the same transaction.
    storePair: (rows) => sql.transaction(rows.flatMap((row) => [insert(row), assertExact(row)])),
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length !== 1 || argv[0] !== '--run') fail('cli_invalid')
  const clock = dependencies.clock ?? (() => Date.now())
  const now = clock()
  if (!Number.isSafeInteger(now)) fail('clock_invalid')
  const day = new Date(now).toISOString().slice(0, 10)
  const env = dependencies.env ?? readEnv()
  const get = (key) => process.env[key] || env.get(key)
  const storage =
    dependencies.storage ??
    (() => {
      const url = get('DATABASE_URL_UNPOOLED') || get('DATABASE_URL')
      if (!url) fail('database_unavailable')
      return createNeonStorage(neon(url))
    })()
  const due = dueKinds(await storage.latestSuccess(now), now)
  const result = { day, due, stored: [], failed: [], reused: [] }
  if (!Object.values(due).some(Boolean)) return result
  // Cached manifests do not call writeImmutable. Guard the entire due run so
  // reuse cannot promote to Neon or issue RPC reads below the disk floor.
  await assertDiskReserve(ROOT, 0, dependencies.statfsFn ?? statfs)
  const cohortOutputDir = dependencies.cohortOutputDir ?? join(COHORT_CACHE, 'usde-daily')
  const rateOutputDir = dependencies.rateOutputDir ?? join(RATE_CACHE, 'rates')
  const matchedManifest = join(cohortOutputDir, `matched-${day}.manifest.json`)
  const spreadManifest = join(rateOutputDir, `spread-${day}.manifest.json`)
  const matchedBootstrap =
    dependencies.bootstrapMatched === undefined ? BOOTSTRAP.matched : dependencies.bootstrapMatched
  const spreadBootstrap =
    dependencies.bootstrapSpread === undefined ? BOOTSTRAP.spread : dependencies.bootstrapSpread
  const savedMatched =
    (await exists(matchedManifest)) ||
    (matchedBootstrap?.day === day && (await exists(matchedBootstrap.path)))
  const savedSpread =
    (await exists(spreadManifest)) ||
    (spreadBootstrap?.day === day && (await exists(spreadBootstrap.path)))
  const capitalDue = due.matched_capital || due.destination_tvl
  const rpc = (get('RECORDER_RPC_URLS') || get('RECORDER_RPC_URL') || '').split(',')[0].trim()
  if (!rpc && !dependencies.client) fail('rpc_unavailable')
  const client = dependencies.client ?? (rpc ? makeClient(rpc) : null)
  const matchedReader = dependencies.matchedReader ?? matchedMain
  const spreadReader = dependencies.spreadReader ?? spreadMain
  let matchedReading = null
  if (capitalDue) {
    try {
      const anchor = savedMatched ? null : await selectFinalizedAnchor(client, clock())
      const sourceBytes = await readFile(dependencies.sourcePath ?? SOURCE_PATH)
      const receiptBytes = await readFile(dependencies.receiptPath ?? RECEIPT_PATH)
      if (sha256(sourceBytes) !== SOURCE_SHA256 || sha256(receiptBytes) !== RECEIPT_SHA256)
        fail('source_hash_mismatch')
      const sourcePath = dependencies.sourcePath ?? SOURCE_PATH
      const receiptPath = dependencies.receiptPath ?? RECEIPT_PATH
      const { document, artifactSha256, manifestSha256, reused } = await loadOrCollect({
        kind: 'matched',
        day,
        cacheDir: cohortOutputDir,
        bootstrap: matchedBootstrap,
        statfsFn: dependencies.statfsFn,
        run: (out) =>
          matchedReader(
            [
              '--run',
              '--source',
              sourcePath,
              '--source-sha256',
              SOURCE_SHA256,
              '--receipts',
              receiptPath,
              '--out',
              out,
            ],
            { client, env, clock, anchor },
          ),
        verify: (out, hash) =>
          matchedReader([
            '--verify',
            '--source',
            sourcePath,
            '--source-sha256',
            SOURCE_SHA256,
            '--receipts',
            receiptPath,
            '--out',
            out,
            '--out-sha256',
            hash,
          ]),
      })
      assertPromotable(document, 'matched', day, clock())
      if (reused) result.reused.push('matched')
      const projections = projectMatched(document, artifactSha256, manifestSha256)
      const observedAt = document.blockTimestamp
      const rows = [
        {
          routeKey: ROUTE,
          kind: 'matched_capital',
          block: document.blockNumber,
          observedAt,
          data: projections.matched,
        },
        {
          routeKey: ROUTE,
          kind: 'destination_tvl',
          block: document.blockNumber,
          observedAt,
          data: projections.destination,
        },
      ]
      await assertCanonicalAnchor(client, matchedAnchor(document), clock())
      await storage.storePair(rows)
      result.stored.push(...rows.map((row) => row.kind))
      matchedReading = { document, artifactSha256, manifestSha256 }
    } catch {
      result.failed.push('matched_capital', 'destination_tvl')
    }
  }

  if (due.spread) {
    try {
      // A same-block trio is still possible when the capital artifact was
      // collected first. Its failure never prevents an independent rate read.
      const anchor = savedSpread
        ? null
        : matchedReading
          ? matchedAnchor(matchedReading.document)
          : await selectFinalizedAnchor(client, clock())
      const spreadReading = await loadOrCollect({
        kind: 'spread',
        day,
        cacheDir: rateOutputDir,
        bootstrap: spreadBootstrap,
        statfsFn: dependencies.statfsFn,
        run: (out) => spreadReader(['--run', '--out', out], { client, env, clock, anchor }),
        verify: (out, hash) => spreadReader(['--verify', '--out', out, '--out-sha256', hash]),
      })
      assertPromotable(spreadReading.document, 'spread', day, clock())
      if (spreadReading.reused) result.reused.push('spread')
      const row = {
        routeKey: SPREAD_KEY,
        kind: 'spread',
        block: spreadReading.document.currentBlockNumber,
        observedAt: spreadReading.document.currentBlockTimestamp,
        data: projectSpread(
          spreadReading.document,
          spreadReading.artifactSha256,
          spreadReading.manifestSha256,
        ),
      }
      await assertCanonicalAnchor(client, spreadAnchor(spreadReading.document), clock())
      await storage.storePair([row])
      result.stored.push('spread')
    } catch {
      result.failed.push('spread')
    }
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      if (result.failed.length) process.exitCode = 2
    },
    (error) => {
      // Database and RPC errors can contain credential-bearing URLs.
      process.stderr.write(
        `${/^usde_recorder_[a-z_]+$/.test(error?.message) ? error.message : 'usde_recorder_failed'}\n`,
      )
      process.exitCode = 1
    },
  )
}
