// Append-only, aggregate ERC-4626 observations for the destination contracts
// actually present in the 25 displayed August carry route groups. A route label
// is not a contract: 22 groups map to 64 route/vault subjects (63 vaults).
// This observes vault-wide cash and accounting, not holder exit ability,
// borrow-funded TVL, stablecoin USD value, or a forecast.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { isAddress } from 'viem'
import { neon } from '@neondatabase/serverless'

import { ROOT, makeClient, readEnv } from './lib/venue-reads.mjs'

const SEED_PATH = join(ROOT, 'scripts/route-cohort/aug-2026-ab-vault-seed.json')
const BOARD_PATH = join(ROOT, 'components/Carry/route-capital.json')
const DISPLAY_PATH = join(ROOT, 'components/Carry/fixtures.ts')
const HASH = /^0x[0-9a-f]{64}$/i
const DECIMAL = /^(0|[1-9][0-9]*)$/
const MAX_SOURCE_AGE_MS = 60 * 60 * 1000
const ABI = [
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
]

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const address = (value) => {
  if (!isAddress(value, { strict: false })) throw new Error('invalid_vault_or_asset_address')
  return value.toLowerCase()
}
const raw = (value) => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('invalid_vault_uint')
  return value.toString()
}
const decimal = (value) => {
  if (!Number.isInteger(value) || value < 0 || value > 255)
    throw new Error('invalid_token_decimals')
  return value
}

/** The board list is a frozen historical selection, never a current market census. */
export function deriveRouteVaultSubjects(board, seed) {
  if (
    board?.schemaVersion !== 1 ||
    !Array.isArray(board.routes) ||
    board.routes.length !== 25 ||
    seed?.schemaVersion !== 1 ||
    !Array.isArray(seed.positions) ||
    seed?.source?.sha256 !== board?.sourceSha256?.['routes_ab.json']
  ) {
    throw new Error('route_vault_source_shape_or_provenance_changed')
  }
  const keys = board.routes.map((row) => row.route)
  if (
    keys.some((key) => typeof key !== 'string' || !key.trim()) ||
    new Set(keys).size !== keys.length
  )
    throw new Error('invalid_displayed_route_keys')
  const displayed = new Set(keys)
  const subjects = new Map()
  for (const position of seed.positions) {
    const vault = address(position?.vault)
    if (!Array.isArray(position.routeIds)) throw new Error('invalid_seed_route_ids')
    for (const routeKey of position.routeIds) {
      if (!displayed.has(routeKey)) continue
      subjects.set(`${routeKey}\0${vault}`, { routeKey, vault })
    }
  }
  const mapped = new Set([...subjects.values()].map((row) => row.routeKey))
  return {
    subjects: [...subjects.values()].sort(
      (a, b) => a.routeKey.localeCompare(b.routeKey) || a.vault.localeCompare(b.vault),
    ),
    unresolvedRoutes: keys.filter((key) => !mapped.has(key)),
    displayedRouteCount: keys.length,
  }
}

/** Parse only the literal routeKey fields in the displayed ROUTES array. */
export function displayedRouteKeys(source) {
  const start = source.indexOf('export const ROUTES: Route[] = [')
  const end = source.indexOf('\n]\n', start)
  if (start < 0 || end < 0) throw new Error('displayed_routes_source_changed')
  const keys = [...source.slice(start, end).matchAll(/\brouteKey: '([^']+)'/g)].map((hit) => hit[1])
  if (keys.length !== 25 || new Set(keys).size !== 25)
    throw new Error('displayed_routes_source_changed')
  return keys
}

function sourceBlock(block, now) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number < 1n ||
    !HASH.test(block?.hash ?? '') ||
    typeof block?.timestamp !== 'bigint'
  ) {
    throw new Error('invalid_finalized_block_header')
  }
  const observedAt = new Date(Number(block.timestamp) * 1000)
  const age = now - observedAt.getTime()
  if (!Number.isFinite(observedAt.getTime()) || age < 0 || age > MAX_SOURCE_AGE_MS) {
    throw new Error('finalized_block_not_fresh')
  }
  return {
    block: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    observedAt: observedAt.toISOString(),
  }
}

async function mapBounded(items, limit, fn) {
  const result = new Array(items.length)
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor++
        if (index >= items.length) return
        result[index] = await fn(items[index])
      }
    }),
  )
  return result
}

/** All reads use one finalized block number and fail the batch on any bad vault. */
export async function collectRouteVaultObservations(
  client,
  universe,
  provenance,
  clock = Date.now,
) {
  if ((await client.getChainId()) !== 1) throw new Error('route_vault_wrong_chain')
  const start = await client.getBlock({ blockTag: 'finalized' })
  const source = sourceBlock(start, clock())
  const blockNumber = start.number
  const vaults = [...new Set(universe.subjects.map((row) => address(row.vault)))].sort()
  if (!vaults.length) throw new Error('route_vault_universe_empty')
  const vaultRows = await mapBounded(vaults, 4, async (vault) => {
    const code = await client.getCode({ address: vault, blockNumber })
    if (typeof code !== 'string' || code === '0x') throw new Error(`route_vault_no_code:${vault}`)
    const call = (contract, functionName, args) =>
      client.readContract({
        address: contract,
        abi: ABI,
        functionName,
        ...(args ? { args } : {}),
        blockNumber,
      })
    const [assetValue, vaultDecimalsValue, totalAssetsValue, totalSupplyValue] = await Promise.all([
      call(vault, 'asset'),
      call(vault, 'decimals'),
      call(vault, 'totalAssets'),
      call(vault, 'totalSupply'),
    ])
    const asset = address(assetValue)
    const assetCode = await client.getCode({ address: asset, blockNumber })
    if (typeof assetCode !== 'string' || assetCode === '0x')
      throw new Error(`route_asset_no_code:${asset}`)
    const [assetDecimalsValue, cashValue] = await Promise.all([
      call(asset, 'decimals'),
      call(asset, 'balanceOf', [vault]),
    ])
    return {
      vault,
      asset,
      vaultDecimals: decimal(vaultDecimalsValue),
      assetDecimals: decimal(assetDecimalsValue),
      totalAssetsRaw: raw(totalAssetsValue),
      totalSupplyRaw: raw(totalSupplyValue),
      cashRaw: raw(cashValue),
    }
  })
  const end = await client.getBlock({ blockNumber })
  if (
    end?.number !== start.number ||
    String(end.hash).toLowerCase() !== source.blockHash ||
    end?.timestamp !== start.timestamp
  )
    throw new Error('route_vault_block_changed')
  sourceBlock(end, clock())
  const byVault = new Map(vaultRows.map((row) => [row.vault, row]))
  const rows = universe.subjects.map(({ routeKey, vault }) => ({
    routeKey,
    ...byVault.get(address(vault)),
    ...source,
    seedSha256: provenance.seedSha256,
    boardSha256: provenance.boardSha256,
    displayedRoutesSha256: provenance.displayedRoutesSha256,
    cohortId: provenance.cohortId,
    seedSourceSha256: provenance.seedSourceSha256,
  }))
  if (rows.some((row) => !row.asset || !DECIMAL.test(row.cashRaw))) {
    throw new Error('route_vault_partial_batch')
  }
  return {
    rows,
    vaultCount: vaults.length,
    routeCount: universe.displayedRouteCount,
    unresolvedRoutes: universe.unresolvedRoutes,
    ...source,
  }
}

export async function loadRouteVaultUniverse(
  seedPath = SEED_PATH,
  boardPath = BOARD_PATH,
  displayPath = DISPLAY_PATH,
) {
  const [seedBytes, boardBytes, displayBytes] = await Promise.all([
    readFile(seedPath),
    readFile(boardPath),
    readFile(displayPath),
  ])
  const seed = JSON.parse(seedBytes.toString())
  const board = JSON.parse(boardBytes.toString())
  const keys = displayedRouteKeys(displayBytes.toString())
  const selected = board.routes.filter((row) => keys.includes(row.route))
  if (
    selected.length !== keys.length ||
    keys.some((key) => !selected.some((row) => row.route === key))
  ) {
    throw new Error('displayed_routes_missing_from_capital_source')
  }
  board.routes = selected
  return {
    universe: deriveRouteVaultSubjects(board, seed),
    provenance: {
      cohortId: seed.cohortId,
      seedSourceSha256: seed.source.sha256,
      seedSha256: sha256(seedBytes),
      boardSha256: sha256(boardBytes),
      displayedRoutesSha256: sha256(displayBytes),
    },
  }
}

/** One database transaction means every mapped route-vault row commits or none do. */
export async function persistRouteVaultObservations(sql, batch) {
  if (!Array.isArray(batch?.rows) || batch.rows.length === 0)
    throw new Error('empty_route_vault_batch')
  // jsonb_to_recordset binds JSON keys by name; keep this explicit instead of
  // relying on the camelCase collector representation matching SQL columns.
  const payload = JSON.stringify(
    batch.rows.map((row) => ({
      route_key: row.routeKey,
      vault: row.vault,
      block: row.block,
      block_hash: row.blockHash,
      observed_at: row.observedAt,
      asset: row.asset,
      vault_decimals: row.vaultDecimals,
      asset_decimals: row.assetDecimals,
      total_assets_raw: row.totalAssetsRaw,
      total_supply_raw: row.totalSupplyRaw,
      cash_raw: row.cashRaw,
      cohort_id: row.cohortId,
      seed_source_sha256: row.seedSourceSha256,
      seed_sha256: row.seedSha256,
      board_sha256: row.boardSha256,
      displayed_routes_sha256: row.displayedRoutesSha256,
    })),
  )
  await sql.transaction([
    sql`INSERT INTO carry_route_vault_observations
      (route_key, vault, block, block_hash, observed_at, asset, vault_decimals,
       asset_decimals, total_assets_raw, total_supply_raw, cash_raw, cohort_id,
       seed_source_sha256, seed_sha256, board_sha256, displayed_routes_sha256)
      SELECT route_key, vault, block, block_hash, observed_at, asset, vault_decimals,
        asset_decimals, total_assets_raw, total_supply_raw, cash_raw, cohort_id,
        seed_source_sha256, seed_sha256, board_sha256, displayed_routes_sha256
      FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        route_key text, vault text, block bigint, block_hash text, observed_at timestamptz,
        asset text, vault_decimals smallint, asset_decimals smallint,
        total_assets_raw numeric, total_supply_raw numeric, cash_raw numeric,
        cohort_id text, seed_source_sha256 text, seed_sha256 text, board_sha256 text,
        displayed_routes_sha256 text)
      ON CONFLICT (route_key, vault, block) DO NOTHING`,
    sql`SELECT 1 / CASE WHEN (
      SELECT count(*) FROM jsonb_to_recordset(${payload}::jsonb) AS r(
        route_key text, vault text, block bigint, block_hash text, observed_at timestamptz,
        asset text, vault_decimals smallint, asset_decimals smallint,
        total_assets_raw numeric, total_supply_raw numeric, cash_raw numeric,
        cohort_id text, seed_source_sha256 text, seed_sha256 text, board_sha256 text,
        displayed_routes_sha256 text)
      JOIN carry_route_vault_observations o USING (route_key, vault, block)
      WHERE o.block_hash = r.block_hash AND o.observed_at = r.observed_at
        AND o.asset = r.asset AND o.vault_decimals = r.vault_decimals
        AND o.asset_decimals = r.asset_decimals AND o.total_assets_raw = r.total_assets_raw
        AND o.total_supply_raw = r.total_supply_raw AND o.cash_raw = r.cash_raw
        AND o.cohort_id = r.cohort_id AND o.seed_source_sha256 = r.seed_source_sha256
        AND o.seed_sha256 = r.seed_sha256 AND o.board_sha256 = r.board_sha256
        AND o.displayed_routes_sha256 = r.displayed_routes_sha256
    ) = ${batch.rows.length} THEN 1 ELSE 0 END AS exact_batch`,
  ])
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--dry-run')) {
    throw new Error('usage: node scripts/record-carry-route-vaults.mjs [--dry-run]')
  }
  const dryRun = argv[0] === '--dry-run'
  const { get } = readEnv()
  const rpcUrl =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const dbUrl =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!rpcUrl || (!dryRun && !dbUrl)) throw new Error('recorder_rpc_and_database_url_required')
  const { universe, provenance } = await loadRouteVaultUniverse()
  const batch = await collectRouteVaultObservations(makeClient(rpcUrl), universe, provenance)
  if (!dryRun) await persistRouteVaultObservations(neon(dbUrl), batch)
  process.stdout.write(
    JSON.stringify({
      status: dryRun ? 'read_only_complete' : 'recorded',
      block: batch.block,
      blockHash: batch.blockHash,
      observedAt: batch.observedAt,
      vaultCount: batch.vaultCount,
      routeVaultCount: batch.rows.length,
      displayedRouteCount: batch.routeCount,
      unresolvedRoutes: batch.unresolvedRoutes,
    }) + '\n',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // RPC and database errors can include credential-bearing URLs.
    process.stderr.write('Carry route-vault observation failed closed.\n')
    process.exitCode = 1
  })
}
