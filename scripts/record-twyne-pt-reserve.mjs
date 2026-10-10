// Aave PT reserve cash shared by the tracked Twyne wrapper. This is
// PT.balanceOf(aToken), not wrapper idle cash or a holder-executable exit.
// Default capture is one fresh finalized head. An explicit older block is a
// read-only backfill seam; the prospective table rejects stale new receipts.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { parseAbi } from 'viem'

import { makeClient, readEnv } from './lib/venue-reads.mjs'

export const TWYNE_PT_RESERVE = Object.freeze({
  routeKey: 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
  wrapper: '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
  pt: '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
  aToken: '0x01e69a58ca3ddc695820ce6f66fbdf3fa55d0545',
  pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
})

const HASH = /^0x[0-9a-f]{64}$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9][0-9]*)$/
const MAX_U256 = (1n << 256n) - 1n
const MAX_FRESH_AGE_MS = 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000
const ABI = parseAbi([
  'function asset() view returns (address)',
  'function aToken() view returns (address)',
  'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  'function POOL() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])
const POOL_ABI = [
  {
    type: 'function',
    name: 'getReserveData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'configuration', type: 'uint256' },
          { name: 'liquidityIndex', type: 'uint128' },
          { name: 'currentLiquidityRate', type: 'uint128' },
          { name: 'variableBorrowIndex', type: 'uint128' },
          { name: 'currentVariableBorrowRate', type: 'uint128' },
          { name: 'currentStableBorrowRate', type: 'uint128' },
          { name: 'lastUpdateTimestamp', type: 'uint40' },
          { name: 'id', type: 'uint16' },
          { name: 'aTokenAddress', type: 'address' },
          { name: 'stableDebtTokenAddress', type: 'address' },
          { name: 'variableDebtTokenAddress', type: 'address' },
          { name: 'interestRateStrategyAddress', type: 'address' },
          { name: 'accruedToTreasury', type: 'uint128' },
          { name: 'unbacked', type: 'uint128' },
          { name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
      },
    ],
  },
]

function equalAddress(actual, expected, reason) {
  if (typeof actual !== 'string' || actual.toLowerCase() !== expected) throw new Error(reason)
}

function header(block, reason) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number <= 0n ||
    block.number > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof block?.timestamp !== 'bigint' ||
    block.timestamp <= 0n ||
    block.timestamp > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ||
    !HASH.test(String(block?.hash ?? '').toLowerCase())
  )
    throw new Error(reason)
  return {
    block: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  }
}

function selectedBlockNumber(value) {
  if (typeof value === 'bigint' && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER))
    return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value)
  throw new Error('twyne_pt_invalid_block_number')
}

function validateObservation(row) {
  if (
    row?.chainId !== 1 ||
    row?.routeKey !== TWYNE_PT_RESERVE.routeKey ||
    row?.wrapper !== TWYNE_PT_RESERVE.wrapper ||
    row?.pt !== TWYNE_PT_RESERVE.pt ||
    row?.aToken !== TWYNE_PT_RESERVE.aToken ||
    row?.pool !== TWYNE_PT_RESERVE.pool ||
    typeof row.block !== 'string' ||
    !/^[1-9][0-9]*$/.test(row.block) ||
    BigInt(row.block) > BigInt(Number.MAX_SAFE_INTEGER) ||
    !HASH.test(row.blockHash) ||
    typeof row.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.observedAt)) ||
    new Date(row.observedAt).toISOString() !== row.observedAt ||
    !Number.isInteger(row.ptDecimals) ||
    row.ptDecimals < 0 ||
    row.ptDecimals > 36 ||
    typeof row.aavePtReserveCashRaw !== 'string' ||
    !RAW.test(row.aavePtReserveCashRaw) ||
    BigInt(row.aavePtReserveCashRaw) > MAX_U256
  )
    throw new Error('twyne_pt_invalid_observation')
  return row
}

/** Every identity and the balance is read at one canonical finalized block. */
export async function collectTwynePtReserveObservation(
  client,
  { blockNumber, clock = Date.now } = {},
) {
  if (typeof clock !== 'function') throw new Error('twyne_pt_invalid_clock')
  if ((await client.getChainId()) !== 1) throw new Error('twyne_pt_wrong_chain')
  const finalized = await client.getBlock({ blockTag: 'finalized' })
  const head = header(finalized, 'twyne_pt_invalid_finalized_head')
  const chosen = blockNumber === undefined ? finalized.number : selectedBlockNumber(blockNumber)
  if (chosen > finalized.number) throw new Error('twyne_pt_block_not_finalized')
  const before = await client.getBlock({ blockNumber: chosen })
  const source = header(before, 'twyne_pt_invalid_source_block')
  if (
    before.number !== chosen ||
    (chosen === finalized.number && source.blockHash !== head.blockHash)
  )
    throw new Error('twyne_pt_block_hash_mismatch')
  if (blockNumber === undefined) {
    const age = clock() - Date.parse(source.observedAt)
    if (!Number.isSafeInteger(age) || age < -MAX_FUTURE_SKEW_MS || age > MAX_FRESH_AGE_MS)
      throw new Error('twyne_pt_finalized_head_stale')
  }
  const call = (address, functionName, args, abi = ABI) =>
    client.readContract({
      address,
      abi,
      functionName,
      ...(args ? { args } : {}),
      blockNumber: chosen,
    })
  let wrapperAsset, wrapperAToken, underlying, pool, reserve
  try {
    ;[wrapperAsset, wrapperAToken, underlying, pool] = await Promise.all([
      call(TWYNE_PT_RESERVE.wrapper, 'asset'),
      call(TWYNE_PT_RESERVE.wrapper, 'aToken'),
      call(TWYNE_PT_RESERVE.aToken, 'UNDERLYING_ASSET_ADDRESS'),
      call(TWYNE_PT_RESERVE.aToken, 'POOL'),
    ])
    equalAddress(wrapperAsset, TWYNE_PT_RESERVE.pt, 'twyne_pt_wrapper_asset_mismatch')
    equalAddress(wrapperAToken, TWYNE_PT_RESERVE.aToken, 'twyne_pt_wrapper_atoken_mismatch')
    equalAddress(underlying, TWYNE_PT_RESERVE.pt, 'twyne_pt_atoken_underlying_mismatch')
    equalAddress(pool, TWYNE_PT_RESERVE.pool, 'twyne_pt_atoken_pool_mismatch')
    reserve = await call(TWYNE_PT_RESERVE.pool, 'getReserveData', [TWYNE_PT_RESERVE.pt], POOL_ABI)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('twyne_pt_')) throw error
    throw new Error('twyne_pt_identity_read_unavailable')
  }
  const reserveAToken = reserve?.aTokenAddress ?? reserve?.[8]
  equalAddress(reserveAToken, TWYNE_PT_RESERVE.aToken, 'twyne_pt_reserve_atoken_mismatch')

  let decimals, cash
  try {
    decimals = await call(TWYNE_PT_RESERVE.pt, 'decimals')
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw new Error('twyne_pt_invalid_decimals')
    cash = await call(TWYNE_PT_RESERVE.pt, 'balanceOf', [TWYNE_PT_RESERVE.aToken])
  } catch (error) {
    if (error instanceof Error && error.message === 'twyne_pt_invalid_decimals') throw error
    throw new Error('twyne_pt_cash_read_unavailable')
  }
  if (typeof cash !== 'bigint' || cash < 0n || cash > MAX_U256)
    throw new Error('twyne_pt_invalid_cash')
  const after = await client.getBlock({ blockNumber: chosen })
  const finalSource = header(after, 'twyne_pt_invalid_source_block')
  if (
    after.number !== chosen ||
    finalSource.blockHash !== source.blockHash ||
    finalSource.observedAt !== source.observedAt
  )
    throw new Error('twyne_pt_block_hash_changed')
  return validateObservation({
    chainId: 1,
    routeKey: TWYNE_PT_RESERVE.routeKey,
    wrapper: TWYNE_PT_RESERVE.wrapper,
    pt: TWYNE_PT_RESERVE.pt,
    aToken: TWYNE_PT_RESERVE.aToken,
    pool: TWYNE_PT_RESERVE.pool,
    ...source,
    ptDecimals: decimals,
    aavePtReserveCashRaw: cash.toString(),
  })
}

/** The database function inserts once or verifies every source field on replay. */
export async function persistTwynePtReserveObservation(sql, observation) {
  const row = validateObservation(observation)
  const payload = JSON.stringify(row)
  const result = await sql`SELECT twyne_pt_reserve_record(${payload}::jsonb) AS inserted`
  if (result?.length !== 1 || typeof result[0]?.inserted !== 'boolean')
    throw new Error('twyne_pt_persistence_receipt_missing')
  return { inserted: result[0].inserted }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--dry-run'))
    throw new Error('usage: node scripts/record-twyne-pt-reserve.mjs [--dry-run]')
  const dryRun = argv.includes('--dry-run')
  const { get } = readEnv()
  const rpc =
    process.env.RECORDER_RPC_URLS ||
    process.env.RECORDER_RPC_URL ||
    get('RECORDER_RPC_URLS') ||
    get('RECORDER_RPC_URL')
  const db =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!rpc || (!dryRun && !db)) throw new Error('twyne_pt_rpc_or_database_missing')
  const observation = await collectTwynePtReserveObservation(makeClient(rpc))
  const receipt = dryRun
    ? { inserted: false }
    : await persistTwynePtReserveObservation(neon(db), observation)
  process.stdout.write(
    JSON.stringify({
      status: dryRun ? 'read_only_complete' : receipt.inserted ? 'recorded' : 'exact_replay',
      ...observation,
      scope: 'aave_pt_reserve_cash_only_not_wrapper_cash_or_holder_exit',
    }) + '\n',
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Never print provider/DB exceptions: they can contain credential URLs.
    process.stderr.write('Twyne PT reserve observation failed closed.\n')
    process.exitCode = 1
  })
}
