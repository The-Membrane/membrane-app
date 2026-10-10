// DB-clock prospective persistence-baseline issues for every exact Carry cash subject.
// This baseline predicts raw aggregate cash stays unchanged at 1h and 24h.
// It makes no holder exit, USD valuation, or validated-model claim.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { neon } from '@neondatabase/serverless'

import { ROOT, readEnv } from './lib/venue-reads.mjs'
import { loadRouteVaultUniverse } from './record-carry-route-vaults.mjs'

const ADDRESS = /^0x[0-9a-f]{40}$/
const TWYNE_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c'
const MARKET_SUBJECTS = [
  {
    route_key: 'USDC → supply on Aave V3',
    destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    venue_kind: 'aave_v3_atoken',
  },
  {
    route_key: 'USDC → supply on Compound v3',
    destination: '0xc3d688b66703497daa19211eedff47f25384cdc3',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    venue_kind: 'compound_v3_comet',
  },
  {
    route_key: 'USDT → supply on Spark',
    destination: '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    venue_kind: 'spark_lend_atoken',
  },
]
// The August issue/score ledger is a frozen 67-subject cohort. Newly tracked
// markets have an explicit identity here, but must receive a separately
// versioned issue cohort rather than changing that ledger's historical grid.
const SUPPLEMENTAL_MARKET_SUBJECTS = [
  {
    market_key: 'aaveV3Usde',
    route_key: 'USDe → supply on Aave V3',
    destination: '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    asset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    asset_decimals: 18,
    venue_kind: 'aave_v3_atoken',
    source_kind: 'market',
    cohort_id: 'supplemental-aave-v3-usde-2026-09',
  },
]

const readJson = async (path) => JSON.parse(await readFile(join(ROOT, path), 'utf8'))
const hash = (value) => createHash('sha256').update(value).digest('hex')

/** Independent expected assets plus the pinned source-cohort hashes. */
export async function buildSubjectManifest() {
  const [{ universe, provenance }, morpho, other, config, marketSource] = await Promise.all([
    loadRouteVaultUniverse(),
    readJson('lib/carry/morpho-v2-asset-identities.json'),
    readJson('lib/carry/other-vault-asset-identities.json'),
    readJson('tools/venue-recorder.config.json'),
    readFile(join(ROOT, 'lib/carry/directSupplyMarketConstants.ts'), 'utf8'),
  ])
  const declaredMarkets = [
    ...marketSource.matchAll(
      /([a-zA-Z][a-zA-Z0-9]*): \{\s*routeKey: '([^']+)',\s*destination: '([^']+)',\s*underlying: '([^']+)',\s*decimals: (\d+),?\s*\}/g,
    ),
  ]
  const expectedMarkets = [
    ...MARKET_SUBJECTS.map((subject) => ({
      ...subject,
      asset_decimals: 6,
      market_key:
        subject.venue_kind === 'compound_v3_comet'
          ? 'compoundV3Usdc'
          : subject.venue_kind === 'spark_lend_atoken'
            ? 'sparkLendUsdt'
            : 'aaveV3Usdc',
    })),
    ...SUPPLEMENTAL_MARKET_SUBJECTS,
  ]
  if (
    declaredMarkets.length !== expectedMarkets.length ||
    expectedMarkets.some(
      (subject) =>
        !declaredMarkets.some(
          (match) =>
            match[1] === subject.market_key &&
            match[2] === subject.route_key &&
            match[3].toLowerCase() === subject.destination &&
            match[4].toLowerCase() === subject.asset &&
            Number(match[5]) === subject.asset_decimals,
        ),
    )
  )
    throw new Error('cash_issue_direct_market_manifest_changed')
  const assets = new Map()
  for (const entry of [...morpho.entries, ...other.entries]) {
    const vault = entry.vault.toLowerCase()
    const asset = entry.asset.toLowerCase()
    if (
      !ADDRESS.test(vault) ||
      !ADDRESS.test(asset) ||
      (assets.has(vault) && assets.get(vault) !== asset)
    )
      throw new Error('cash_issue_asset_manifest_conflict')
    assets.set(vault, asset)
  }
  for (const venue of config.venues.filter((row) => row.enabled && row.underlying)) {
    const vault = venue.address.toLowerCase()
    const asset = venue.underlying.toLowerCase()
    if (
      !ADDRESS.test(vault) ||
      !ADDRESS.test(asset) ||
      (assets.has(vault) && assets.get(vault) !== asset)
    )
      throw new Error('cash_issue_config_asset_conflict')
    assets.set(vault, asset)
  }
  if (
    universe.subjects.length !== 64 ||
    universe.unresolvedRoutes.length !== 3 ||
    universe.displayedRouteCount !== 25 ||
    morpho.entries.length !== 49 ||
    other.entries.length !== 11
  )
    throw new Error('cash_issue_pinned_universe_changed')
  const vaults = universe.subjects.map(({ routeKey, vault }) => {
    const asset = assets.get(vault)
    if (!asset) throw new Error('cash_issue_expected_asset_missing')
    return {
      route_key: routeKey,
      destination: vault,
      source_kind: 'vault',
      venue_kind: null,
      asset,
      cohort_id: provenance.cohortId,
      seed_source_sha256: provenance.seedSourceSha256,
      seed_sha256: provenance.seedSha256,
      board_sha256: provenance.boardSha256,
      displayed_routes_sha256: provenance.displayedRoutesSha256,
    }
  })
  const markets = MARKET_SUBJECTS.map((row) => ({
    ...row,
    source_kind: 'market',
    cohort_id: null,
    seed_source_sha256: null,
    seed_sha256: null,
    board_sha256: null,
    displayed_routes_sha256: null,
  }))
  const subjects = [...vaults, ...markets].sort(
    (a, b) => a.route_key.localeCompare(b.route_key) || a.destination.localeCompare(b.destination),
  )
  const keys = new Set(subjects.map((row) => `${row.route_key}\0${row.destination}`))
  if (
    subjects.length !== 67 ||
    keys.size !== 67 ||
    markets.some((row) => !universe.unresolvedRoutes.includes(row.route_key))
  )
    throw new Error('cash_issue_universe_not_67_exact_subjects')
  const payload = JSON.stringify(subjects)
  return {
    subjects,
    payload,
    sha256: hash(payload),
    supplementalSubjects: SUPPLEMENTAL_MARKET_SUBJECTS.map((row) => ({ ...row })),
  }
}

/** One SQL statement atomically inserts one current 15-minute slot and all 134 attempts. */
export async function issueCurrentSlot(sql, manifest) {
  const { payload, sha256, subjects } = manifest
  if (
    subjects?.length !== 67 ||
    JSON.stringify(subjects) !== payload ||
    hash(payload) !== sha256 ||
    subjects.filter((row) => row.source_kind === 'vault').length !== 64 ||
    subjects.filter((row) => row.source_kind === 'market').length !== 3 ||
    new Set(subjects.map((row) => `${row.route_key}\0${row.destination}`)).size !== 67
  )
    throw new Error('cash_issue_invalid_manifest')
  const result = await sql`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
    slot AS (
      INSERT INTO carry_cash_issue_slots
        (slot_at, started_at, subject_manifest_sha256, subject_manifest, subject_count, attempt_count)
      SELECT date_bin('15 minutes', c.at, '1970-01-01 00:00:00+00'::timestamptz),
        c.at, ${sha256}, ${payload}::jsonb, 67, 134 FROM clock c
      ON CONFLICT (slot_at) DO NOTHING RETURNING slot_at, started_at
    ),
    subjects AS (
      SELECT * FROM jsonb_to_recordset(${payload}::jsonb) AS s(
        route_key text, destination text, source_kind text, venue_kind text, asset text,
        cohort_id text, seed_source_sha256 text, seed_sha256 text,
        board_sha256 text, displayed_routes_sha256 text)
    ),
    attempts AS (
      INSERT INTO carry_cash_issue_attempts
        (slot_at, route_key, destination, source_kind, source_venue_kind,
         horizon_hours, status, issued_at, target_at, target_low_at,
         target_high_at, score_after_at, asset, asset_decimals,
         source_block, source_block_hash, source_observed_at,
         source_first_local_receipt_at, source_cash_raw, forecast_cash_raw,
         cohort_id, seed_source_sha256, seed_sha256, board_sha256, displayed_routes_sha256)
      SELECT slot.slot_at, s.route_key, s.destination, s.source_kind, s.venue_kind,
        h.horizon_hours, q.status, slot.started_at,
        slot.started_at + make_interval(hours => h.horizon_hours),
        slot.started_at + make_interval(hours => h.horizon_hours)
          - CASE h.horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END,
        slot.started_at + make_interval(hours => h.horizon_hours)
          + CASE h.horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END,
        slot.started_at + make_interval(hours => h.horizon_hours)
          + CASE h.horizon_hours WHEN 1 THEN interval '15 minutes' ELSE interval '1 hour' END
          + interval '1 hour',
        s.asset, CASE WHEN x.asset_decimals BETWEEN 0 AND 36 THEN x.asset_decimals ELSE NULL END,
        x.block, x.block_hash, x.observed_at,
        x.first_local_receipt_at, x.cash_raw,
        CASE WHEN q.status = 'issued' THEN x.cash_raw ELSE NULL END,
        CASE WHEN s.source_kind = 'vault' THEN v.cohort_id ELSE NULL END,
        CASE WHEN s.source_kind = 'vault' THEN v.seed_source_sha256 ELSE NULL END,
        CASE WHEN s.source_kind = 'vault' THEN v.seed_sha256 ELSE NULL END,
        CASE WHEN s.source_kind = 'vault' THEN v.board_sha256 ELSE NULL END,
        CASE WHEN s.source_kind = 'vault' THEN v.displayed_routes_sha256 ELSE NULL END
      FROM slot CROSS JOIN subjects s CROSS JOIN (VALUES (1), (24)) h(horizon_hours)
      LEFT JOIN LATERAL (
        SELECT o.* FROM carry_route_vault_observations o
        WHERE s.source_kind = 'vault' AND o.route_key = s.route_key AND o.vault = s.destination
          AND o.first_local_receipt_at <= slot.started_at
        ORDER BY o.block DESC, o.first_local_receipt_at DESC LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT o.* FROM carry_direct_supply_observations o
        WHERE s.source_kind = 'market' AND o.route_key = s.route_key
          AND o.destination = s.destination AND o.first_local_receipt_at <= slot.started_at
        ORDER BY o.block DESC, o.first_local_receipt_at DESC LIMIT 1
      ) m ON true
      CROSS JOIN LATERAL (SELECT
        CASE WHEN s.source_kind = 'vault' THEN v.asset_decimals ELSE m.underlying_decimals END AS asset_decimals,
        CASE WHEN s.source_kind = 'vault' THEN v.block ELSE m.block END AS block,
        CASE WHEN s.source_kind = 'vault' THEN v.block_hash ELSE m.block_hash END AS block_hash,
        CASE WHEN s.source_kind = 'vault' THEN v.observed_at ELSE m.observed_at END AS observed_at,
        CASE WHEN s.source_kind = 'vault' THEN v.first_local_receipt_at ELSE m.first_local_receipt_at END AS first_local_receipt_at,
        CASE WHEN s.source_kind = 'vault' THEN v.cash_raw ELSE m.cash_raw END AS cash_raw
      ) x
      CROSS JOIN LATERAL (SELECT CASE
        WHEN x.block IS NULL THEN 'source_unavailable'
        WHEN x.asset_decimals NOT BETWEEN 0 AND 36 OR x.observed_at > x.first_local_receipt_at
          OR x.first_local_receipt_at > slot.started_at OR x.observed_at > slot.started_at
          OR slot.started_at - x.observed_at > interval '30 minutes'
          OR (s.source_kind = 'vault' AND (
            v.asset IS DISTINCT FROM s.asset OR v.cohort_id IS DISTINCT FROM s.cohort_id
            OR v.seed_source_sha256 IS DISTINCT FROM s.seed_source_sha256
            OR v.seed_sha256 IS DISTINCT FROM s.seed_sha256
            OR v.board_sha256 IS DISTINCT FROM s.board_sha256
            OR v.displayed_routes_sha256 IS DISTINCT FROM s.displayed_routes_sha256))
          OR (s.source_kind = 'market' AND (
            m.underlying IS DISTINCT FROM s.asset OR m.underlying_decimals IS DISTINCT FROM 6
            OR m.chain_id IS DISTINCT FROM 1 OR m.venue_kind IS DISTINCT FROM s.venue_kind))
          THEN 'source_invalid'
        WHEN s.destination = ${TWYNE_WRAPPER} THEN 'unassessed'
        ELSE 'issued' END AS status) q
      RETURNING 1
    )
    SELECT c.at AS attempted_at,
      COALESCE((SELECT slot_at FROM slot),
        date_bin('15 minutes', clock_timestamp(),
          '1970-01-01 00:00:00+00'::timestamptz)) AS slot_at,
      (SELECT count(*)::integer FROM attempts) AS inserted_count,
      1 / CASE WHEN (SELECT count(*) FROM slot) = 0
        OR (SELECT count(*) FROM attempts) = 134 THEN 1 ELSE 0 END AS exact_grid_guard
    FROM clock c`
  const row = result[0]
  if (!row || ![0, 134].includes(Number(row.inserted_count)))
    throw new Error('cash_issue_partial_slot')
  const check = await sql`
    SELECT s.subject_manifest_sha256, s.subject_manifest = ${payload}::jsonb AS exact_manifest,
      count(a.*)::integer AS attempt_count,
      count(*) FILTER (WHERE a.status = 'issued')::integer AS issued_count,
      count(*) FILTER (WHERE a.status = 'unassessed')::integer AS unassessed_count,
      count(*) FILTER (WHERE a.status = 'source_unavailable')::integer AS unavailable_count,
      count(*) FILTER (WHERE a.status = 'source_invalid')::integer AS invalid_count
    FROM carry_cash_issue_slots s LEFT JOIN carry_cash_issue_attempts a USING (slot_at)
    WHERE s.slot_at = ${row.slot_at} GROUP BY s.slot_at`
  const state = check[0]
  if (
    !state ||
    state.subject_manifest_sha256 !== sha256 ||
    state.exact_manifest !== true ||
    Number(state.attempt_count) !== 134 ||
    Number(state.issued_count) !== 132 ||
    ![0, 2].includes(Number(state.unassessed_count)) ||
    Number(state.issued_count) +
      Number(state.unassessed_count) +
      Number(state.unavailable_count) +
      Number(state.invalid_count) !==
      134
  )
    throw new Error('cash_issue_replay_or_integrity_mismatch')
  return {
    slotAt: row.slot_at,
    newlyInserted: Number(row.inserted_count),
    issued: Number(state.issued_count),
    unassessed: Number(state.unassessed_count),
    sourceUnavailable: Number(state.unavailable_count),
    sourceInvalid: Number(state.invalid_count),
  }
}

/** Seal outcomes only after the complete target window and one-hour ingestion grace. */
export async function scoreDueIssues(sql) {
  const result = await sql`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at),
    due AS MATERIALIZED (
      SELECT i.* FROM carry_cash_issue_attempts i CROSS JOIN clock c
      WHERE i.status = 'issued' AND i.score_after_at <= c.at
        AND NOT EXISTS (SELECT 1 FROM carry_cash_issue_scores z
          WHERE z.slot_at = i.slot_at AND z.route_key = i.route_key
            AND z.destination = i.destination AND z.horizon_hours = i.horizon_hours)
      ORDER BY i.score_after_at, i.slot_at, i.route_key, i.destination, i.horizon_hours
      LIMIT 5000
    ),
    scored AS (
      INSERT INTO carry_cash_issue_scores
        (slot_at, route_key, destination, horizon_hours, status, scored_at,
         outcome_block, outcome_block_hash, outcome_observed_at,
         outcome_first_local_receipt_at, outcome_cash_raw, absolute_error_raw)
      SELECT i.slot_at, i.route_key, i.destination, i.horizon_hours,
        CASE WHEN x.block IS NULL THEN 'censored_missing' ELSE 'observed' END,
        c.at, x.block, x.block_hash, x.observed_at, x.first_local_receipt_at,
        x.cash_raw, CASE WHEN x.block IS NULL THEN NULL ELSE abs(x.cash_raw - i.forecast_cash_raw) END
      FROM due i CROSS JOIN clock c
      LEFT JOIN LATERAL (
        SELECT o.block, o.block_hash, o.observed_at, o.first_local_receipt_at, o.cash_raw
        FROM carry_route_vault_observations o
        WHERE i.source_kind = 'vault' AND o.route_key = i.route_key AND o.vault = i.destination
          AND o.block > i.source_block AND o.asset = i.asset
          AND o.asset_decimals = i.asset_decimals
          AND o.cohort_id = i.cohort_id AND o.seed_source_sha256 = i.seed_source_sha256
          AND o.seed_sha256 = i.seed_sha256 AND o.board_sha256 = i.board_sha256
          AND o.displayed_routes_sha256 = i.displayed_routes_sha256
          AND o.observed_at BETWEEN i.target_low_at AND i.target_high_at
          AND o.first_local_receipt_at > i.issued_at
          AND o.first_local_receipt_at <= i.score_after_at
          AND o.first_local_receipt_at >= o.observed_at
        ORDER BY abs(extract(epoch FROM o.observed_at - i.target_at)),
          o.first_local_receipt_at, o.block LIMIT 1
      ) v ON true
      LEFT JOIN LATERAL (
        SELECT o.block, o.block_hash, o.observed_at, o.first_local_receipt_at, o.cash_raw
        FROM carry_direct_supply_observations o
        WHERE i.source_kind = 'market' AND o.route_key = i.route_key
          AND o.destination = i.destination AND o.block > i.source_block
          AND o.underlying = i.asset AND o.underlying_decimals = i.asset_decimals
          AND o.venue_kind = i.source_venue_kind AND o.chain_id = 1
          AND o.observed_at BETWEEN i.target_low_at AND i.target_high_at
          AND o.first_local_receipt_at > i.issued_at
          AND o.first_local_receipt_at <= i.score_after_at
          AND o.first_local_receipt_at >= o.observed_at
        ORDER BY abs(extract(epoch FROM o.observed_at - i.target_at)),
          o.first_local_receipt_at, o.block LIMIT 1
      ) m ON true
      CROSS JOIN LATERAL (SELECT
        CASE WHEN i.source_kind = 'vault' THEN v.block ELSE m.block END AS block,
        CASE WHEN i.source_kind = 'vault' THEN v.block_hash ELSE m.block_hash END AS block_hash,
        CASE WHEN i.source_kind = 'vault' THEN v.observed_at ELSE m.observed_at END AS observed_at,
        CASE WHEN i.source_kind = 'vault' THEN v.first_local_receipt_at ELSE m.first_local_receipt_at END AS first_local_receipt_at,
        CASE WHEN i.source_kind = 'vault' THEN v.cash_raw ELSE m.cash_raw END AS cash_raw
      ) x
      ON CONFLICT (slot_at, route_key, destination, horizon_hours) DO NOTHING
      RETURNING status
    )
    SELECT count(*)::integer AS sealed,
      count(*) FILTER (WHERE status = 'observed')::integer AS observed,
      count(*) FILTER (WHERE status = 'censored_missing')::integer AS censored_missing
    FROM scored`
  const row = result[0]
  if (!row) throw new Error('cash_score_missing_result')
  return {
    sealed: Number(row.sealed),
    observed: Number(row.observed),
    censoredMissing: Number(row.censored_missing),
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !['--issue', '--score'].includes(argv[0]))
    throw new Error('usage: node scripts/record-carry-cash-issues.mjs --issue|--score')
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('DATABASE_URL_UNPOOLED_or_DATABASE_URL_required')
  const sql = neon(url)
  const result =
    argv[0] === '--issue'
      ? await issueCurrentSlot(sql, await buildSubjectManifest())
      : await scoreDueIssues(sql)
  process.stdout.write(JSON.stringify({ action: argv[0].slice(2), ...result }) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Carry cash issue/score run failed closed.\n')
    process.exitCode = 1
  })
}
