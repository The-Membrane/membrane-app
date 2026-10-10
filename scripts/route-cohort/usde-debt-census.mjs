// Exact-block USDe debt-owner census from the complete variable-debt mint index.
// Same-wallet sUSDe overlap is a capital proxy, never proof of borrowed proceeds.
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionResult, encodeFunctionData, parseAbiItem } from 'viem'

import { ROOT, makeClient, readEnv } from '../lib/venue-reads.mjs'
import { SUSDE } from './usde-susde-receipts.mjs'
import {
  DEFAULT_OUT as SOURCE_DIR,
  MIN_FREE_BYTES,
  START_BLOCK,
  TOKEN,
  USDE,
  verify as verifyMintIndex,
} from './usde-debt-mint-baseline.mjs'

export const PAGE_SIZE = 32
export const MAX_CANDIDATES = 100_000
export const MAX_SOURCE_SEGMENTS = 10_000
export const MAX_RPC_CALLS = 512
export const PRIVATE_OUT = join(ROOT, 'scripts/route-cohort/.cache/usde-debt-census')
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const MAX_BATCH_RESULT_BYTES = 1_000_000
const POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2'
const HEX32 = /^0x[0-9a-f]{64}$/
const OWNER = /^0x[0-9a-f]{40}$/
const RAW = /^(0|[1-9]\d*)$/
const NAME = /^(\d{12})-(\d{6})-([a-f0-9]{64})\.json$/
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const hex = (value) => `0x${BigInt(value).toString(16)}`
const fail = (reason) => {
  throw new Error(`usde_debt_census_${reason}`)
}
const fn = {
  aggregate3: parseAbiItem(
    'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)',
  ),
  scaledBalanceOf: parseAbiItem('function scaledBalanceOf(address) view returns (uint256)'),
  scaledTotalSupply: parseAbiItem('function scaledTotalSupply() view returns (uint256)'),
  balanceOf: parseAbiItem('function balanceOf(address) view returns (uint256)'),
  convertToAssets: parseAbiItem('function convertToAssets(uint256) view returns (uint256)'),
  totalAssets: parseAbiItem('function totalAssets() view returns (uint256)'),
  asset: parseAbiItem('function asset() view returns (address)'),
  decimals: parseAbiItem('function decimals() view returns (uint8)'),
  POOL: parseAbiItem('function POOL() view returns (address)'),
  UNDERLYING_ASSET_ADDRESS: parseAbiItem(
    'function UNDERLYING_ASSET_ADDRESS() view returns (address)',
  ),
}

function number(value) {
  try {
    const result = Number(BigInt(value))
    if (Number.isSafeInteger(result) && result >= 0) return result
  } catch {
    /* Invalid RPC integer. */
  }
  fail('integer_invalid')
}

function pathName(block, page, body) {
  return `${String(block).padStart(12, '0')}-${String(page).padStart(6, '0')}-${sha256(body)}.json`
}

function assertDisk(out, stat = statfsSync, bytes = 0) {
  const space = stat(existsSync(out) ? out : ROOT)
  if (Number(space.bavail) * Number(space.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

/** Re-read and hash every immutable segment; source frontier must equal B. */
export function loadIndex({ sourceDir = SOURCE_DIR, block }) {
  if (!Number.isSafeInteger(block) || block < START_BLOCK) fail('block_invalid')
  const state = verifyMintIndex({ out: sourceDir })
  if (state.throughBlock !== block) fail('index_not_complete_to_block')
  const names = readdirSync(sourceDir).sort()
  if (!names.length || names.length > MAX_SOURCE_SEGMENTS || names.length !== state.segmentCount)
    fail('source_segment_cap')
  const owners = new Set()
  let twoReaderSegments = 0
  const sources = []
  for (const name of names) {
    const bytes = readFileSync(join(sourceDir, name))
    const physicalSha256 = sha256(bytes)
    if (!name.endsWith(`-${physicalSha256}.json`)) fail('source_hash_mismatch')
    const segment = JSON.parse(bytes)
    if (segment.peerWitness.hostCount === 2) twoReaderSegments++
    for (const owner of segment.candidateOwners) owners.add(owner)
    sources.push({ name, sha256: physicalSha256 })
  }
  if (readdirSync(sourceDir).sort().join('\n') !== names.join('\n')) fail('source_changed')
  if (owners.size > MAX_CANDIDATES) fail('candidate_cap')
  const candidateOwners = [...owners].sort()
  return {
    block,
    blockHash: state.frontierHash,
    candidateOwners,
    candidateCount: candidateOwners.length,
    pageCount: Math.max(1, Math.ceil(candidateOwners.length / PAGE_SIZE)),
    sourceSegmentCount: names.length,
    twoReaderSegments,
    legacyUnprobedSegmentCount: state.legacyUnprobedSegmentCount,
    sourceManifestSha256: sha256(JSON.stringify(sources)),
  }
}

function checkedHeader(raw, block) {
  const header = {
    number: number(raw?.number),
    hash: String(raw?.hash).toLowerCase(),
    timestamp: number(raw?.timestamp),
  }
  if (header.number !== block || !HEX32.test(header.hash)) fail('block_header_invalid')
  return header
}

function seal(out, body, stat = statfsSync) {
  const bytes = Buffer.from(JSON.stringify(body))
  if (bytes.length > 512_000) fail('page_size_cap')
  mkdirSync(out, { recursive: true })
  assertDisk(out, stat, bytes.length)
  const target = join(out, pathName(body.block, body.page, bytes))
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) fail('write_failed')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    linkSync(temporary, target)
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd)
    if (existsSync(temporary)) unlinkSync(temporary)
  }
  return target
}

/** One sealed page; no skipped owner and no claim until all pages reconcile. */
export async function collectPage({
  sourceDir = SOURCE_DIR,
  out = PRIVATE_OUT,
  block,
  page,
  rpcRead,
  now = () => new Date(),
  stat = statfsSync,
}) {
  const index = loadIndex({ sourceDir, block })
  if (!Number.isInteger(page) || page < 0 || page >= index.pageCount) fail('page_invalid')
  if (typeof rpcRead !== 'function') fail('rpc_unavailable')
  if (
    existsSync(out) &&
    readdirSync(out).some((name) =>
      name.startsWith(`${String(block).padStart(12, '0')}-${String(page).padStart(6, '0')}-`),
    )
  )
    fail('page_already_sealed')
  let rpcCalls = 0
  const rpc = async (method, params) => {
    assertDisk(out, stat)
    if (++rpcCalls > MAX_RPC_CALLS) fail('rpc_call_cap')
    return rpcRead(method, params)
  }
  if (number(await rpc('eth_chainId', [])) !== 1) fail('wrong_chain')
  const finalizedRaw = await rpc('eth_getBlockByNumber', ['finalized', false])
  const finalized = checkedHeader(finalizedRaw, number(finalizedRaw?.number))
  if (finalized.number < block) fail('block_not_finalized')
  const sourceHeader = checkedHeader(await rpc('eth_getBlockByNumber', [hex(block), false]), block)
  if (sourceHeader.hash !== index.blockHash) fail('source_block_hash_mismatch')
  // The historical mint token must still be the reserve's variable-debt token
  // at B; otherwise its scaled supply can reconcile while omitting new owners.
  const reserveData = await rpc('eth_call', [
    { to: POOL, data: `0x35ea6a75${USDE.slice(2).padStart(64, '0')}` },
    hex(block),
  ])
  const words = /^0x(?:[0-9a-f]{64})+$/i.test(reserveData || '')
    ? reserveData.slice(2).match(/.{64}/g)
    : null
  if (!words || words.length < 11 || `0x${words[10].slice(24)}`.toLowerCase() !== TOKEN)
    fail('reserve_debt_token_mismatch')
  const code = String(await rpc('eth_getCode', [MULTICALL3, hex(block)])).toLowerCase()
  if (!/^0x[0-9a-f]+$/.test(code) || /^0x0+$/.test(code)) fail('multicall_unavailable_at_block')
  const batch = async (calls) => {
    if (!calls.length) return []
    const data = encodeFunctionData({
      abi: [fn.aggregate3],
      functionName: 'aggregate3',
      args: [
        calls.map(({ address, functionName, args = [] }) => ({
          target: address,
          allowFailure: false,
          callData: encodeFunctionData({ abi: [fn[functionName]], functionName, args }),
        })),
      ],
    })
    const response = await rpc('eth_call', [{ to: MULTICALL3, data }, hex(block)])
    if (typeof response !== 'string' || Buffer.byteLength(response) > MAX_BATCH_RESULT_BYTES)
      fail('batch_response_size')
    let results
    try {
      results = decodeFunctionResult({
        abi: [fn.aggregate3],
        functionName: 'aggregate3',
        data: response,
      })
    } catch {
      fail('batch_decode_failed')
    }
    if (
      !Array.isArray(results) ||
      results.length !== calls.length ||
      results.some((entry) => entry.success !== true)
    )
      fail('batch_incomplete')
    return results.map((entry, i) => {
      const functionName = calls[i].functionName
      try {
        return decodeFunctionResult({
          abi: [fn[functionName]],
          functionName,
          data: entry.returnData,
        })
      } catch {
        fail('call_decode_failed')
      }
    })
  }
  const [
    underlying,
    pool,
    debtDecimals,
    vaultAsset,
    vaultDecimals,
    scaledTotalSupply,
    vaultTotalAssets,
  ] = await batch([
    { address: TOKEN, functionName: 'UNDERLYING_ASSET_ADDRESS' },
    { address: TOKEN, functionName: 'POOL' },
    { address: TOKEN, functionName: 'decimals' },
    { address: SUSDE, functionName: 'asset' },
    { address: SUSDE, functionName: 'decimals' },
    { address: TOKEN, functionName: 'scaledTotalSupply' },
    { address: SUSDE, functionName: 'totalAssets' },
  ])
  if (
    String(underlying).toLowerCase() !== USDE ||
    String(pool).toLowerCase() !== POOL ||
    Number(debtDecimals) !== 18 ||
    String(vaultAsset).toLowerCase() !== USDE ||
    Number(vaultDecimals) !== 18 ||
    typeof scaledTotalSupply !== 'bigint' ||
    typeof vaultTotalAssets !== 'bigint'
  )
    fail('contract_identity_mismatch')
  const pageOwners = index.candidateOwners.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const balanceCalls = pageOwners.flatMap((owner) => [
    { address: TOKEN, functionName: 'scaledBalanceOf', args: [owner] },
    { address: TOKEN, functionName: 'balanceOf', args: [owner] },
    { address: SUSDE, functionName: 'balanceOf', args: [owner] },
  ])
  const balances = await batch(balanceCalls)
  if (balances.some((value) => typeof value !== 'bigint' || value < 0n)) fail('balance_invalid')
  const shareHolders = pageOwners.flatMap((owner, i) =>
    balances[i * 3 + 2] > 0n ? [{ owner, shares: balances[i * 3 + 2] }] : [],
  )
  const converted = await batch(
    shareHolders.map(({ shares }) => ({
      address: SUSDE,
      functionName: 'convertToAssets',
      args: [shares],
    })),
  )
  const holdings = new Map(shareHolders.map(({ owner }, i) => [owner, converted[i]]))
  const rows = []
  for (const [i, owner] of pageOwners.entries()) {
    const [scaled, debt, shares] = balances.slice(i * 3, i * 3 + 3)
    if ([scaled, debt, shares].some((value) => typeof value !== 'bigint' || value < 0n))
      fail('balance_invalid')
    const holding = shares === 0n ? 0n : holdings.get(owner)
    if (typeof holding !== 'bigint' || holding < 0n || holding > vaultTotalAssets)
      fail('holding_invalid')
    rows.push({
      owner,
      scaledDebtRaw: scaled.toString(),
      debtRaw: debt.toString(),
      sharesRaw: shares.toString(),
      holdingRaw: holding.toString(),
      matchedRaw: (debt < holding ? debt : holding).toString(),
    })
  }
  const after = checkedHeader(await rpc('eth_getBlockByNumber', [hex(block), false]), block)
  if (after.hash !== sourceHeader.hash || after.timestamp !== sourceHeader.timestamp)
    fail('block_changed')
  const capturedAt = now().toISOString()
  if (
    !Number.isFinite(Date.parse(capturedAt)) ||
    Date.parse(capturedAt) < sourceHeader.timestamp * 1000
  )
    fail('clock_invalid')
  const body = {
    schemaVersion: 1,
    claim: 'complete_mint_owner_index_required_reconcile_before_same_wallet_overlap_not_route_tvl',
    block,
    blockHash: sourceHeader.hash,
    blockTimestamp: sourceHeader.timestamp,
    capturedAt,
    page,
    pageCount: index.pageCount,
    candidateCount: index.candidateCount,
    sourceManifestSha256: index.sourceManifestSha256,
    sourceSegmentCount: index.sourceSegmentCount,
    scaledTotalSupplyRaw: scaledTotalSupply.toString(),
    vaultTotalAssetsRaw: vaultTotalAssets.toString(),
    rows,
    rpcCalls,
  }
  seal(out, body, stat)
  return {
    block,
    page,
    pageCount: index.pageCount,
    candidateCount: index.candidateCount,
    rpcCalls,
    sealed: true,
  }
}

/** Offline all-page gate; returns an aggregate only after exact supply equality. */
export function reconcile({ sourceDir = SOURCE_DIR, out = PRIVATE_OUT, block }) {
  const index = loadIndex({ sourceDir, block })
  const names = existsSync(out)
    ? readdirSync(out)
        .filter((name) => name.startsWith(`${String(block).padStart(12, '0')}-`))
        .sort()
    : []
  if (names.length !== index.pageCount) fail('pages_incomplete')
  let scaledSum = 0n,
    debtSum = 0n,
    holdingSum = 0n,
    matchedSum = 0n,
    borrowerCount = 0,
    overlapCount = 0,
    supply = null,
    assets = null,
    blockTimestamp = null,
    latestCapturedAt = null
  for (const [page, name] of names.entries()) {
    const match = NAME.exec(name)
    if (!match || Number(match[1]) !== block || Number(match[2]) !== page) fail('page_name_invalid')
    const bytes = readFileSync(join(out, name))
    if (sha256(bytes) !== match[3]) fail('page_hash_mismatch')
    const body = JSON.parse(bytes)
    if (
      body.schemaVersion !== 1 ||
      body.claim !==
        'complete_mint_owner_index_required_reconcile_before_same_wallet_overlap_not_route_tvl' ||
      body.block !== block ||
      body.blockHash !== index.blockHash ||
      body.page !== page ||
      body.pageCount !== index.pageCount ||
      body.candidateCount !== index.candidateCount ||
      body.sourceManifestSha256 !== index.sourceManifestSha256 ||
      body.sourceSegmentCount !== index.sourceSegmentCount ||
      !Number.isSafeInteger(body.blockTimestamp) ||
      !Number.isFinite(Date.parse(body.capturedAt)) ||
      !Array.isArray(body.rows) ||
      body.rows.length !==
        Math.max(0, Math.min(PAGE_SIZE, index.candidateCount - page * PAGE_SIZE)) ||
      !RAW.test(body.scaledTotalSupplyRaw) ||
      !RAW.test(body.vaultTotalAssetsRaw)
    )
      fail('page_invalid')
    if (supply !== null && supply !== body.scaledTotalSupplyRaw) fail('supply_inconsistent')
    if (assets !== null && assets !== body.vaultTotalAssetsRaw) fail('assets_inconsistent')
    if (blockTimestamp !== null && blockTimestamp !== body.blockTimestamp)
      fail('block_time_inconsistent')
    supply = body.scaledTotalSupplyRaw
    assets = body.vaultTotalAssetsRaw
    blockTimestamp = body.blockTimestamp
    if (!latestCapturedAt || body.capturedAt > latestCapturedAt) latestCapturedAt = body.capturedAt
    for (const [offset, row] of body.rows.entries()) {
      if (
        row.owner !== index.candidateOwners[page * PAGE_SIZE + offset] ||
        !OWNER.test(row.owner) ||
        [row.scaledDebtRaw, row.debtRaw, row.sharesRaw, row.holdingRaw, row.matchedRaw].some(
          (value) => !RAW.test(value),
        )
      )
        fail('row_invalid')
      const scaled = BigInt(row.scaledDebtRaw),
        debt = BigInt(row.debtRaw),
        holding = BigInt(row.holdingRaw),
        matched = BigInt(row.matchedRaw)
      if (
        matched !== (debt < holding ? debt : holding) ||
        (row.sharesRaw === '0' && holding !== 0n) ||
        holding > BigInt(assets)
      )
        fail('row_arithmetic_invalid')
      scaledSum += scaled
      debtSum += debt
      holdingSum += holding
      matchedSum += matched
      if (debt > 0n) borrowerCount++
      if (matched > 0n) overlapCount++
    }
  }
  if (scaledSum !== BigInt(supply)) fail('scaled_supply_mismatch')
  return {
    status: 'reconciled_same_block',
    claim: 'same_wallet_debt_susde_overlap_not_borrowed_proceeds_or_route_attributed_tvl',
    block,
    blockHash: index.blockHash,
    blockTimestamp,
    latestCapturedAt,
    sourceManifestSha256: index.sourceManifestSha256,
    sourceSegmentCount: index.sourceSegmentCount,
    candidateCount: index.candidateCount,
    borrowerCount,
    overlapCount,
    scaledDebtRaw: scaledSum.toString(),
    debtRaw: debtSum.toString(),
    holdingRaw: holdingSum.toString(),
    matchedRaw: matchedSum.toString(),
  }
}

function parseArgs(argv) {
  let mode = null,
    block = null,
    page = null
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--run-page' || flag === '--reconcile') {
      if (mode) fail('cli_invalid')
      mode = flag
    } else if (flag === '--block') block = Number(argv[++i])
    else if (flag === '--page') page = Number(argv[++i])
    else fail('cli_invalid')
  }
  if (
    !mode ||
    !Number.isSafeInteger(block) ||
    block < START_BLOCK ||
    (mode === '--run-page' && (!Number.isSafeInteger(page) || page < 0)) ||
    (mode === '--reconcile' && page !== null)
  )
    fail('cli_invalid')
  return { mode, block, page }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (args.mode === '--reconcile') return reconcile({ block: args.block })
  const env = dependencies.env ?? readEnv()
  const raw =
    dependencies.rpcUrl ??
    process.env.RECORDER_RPC_URLS ??
    process.env.RECORDER_RPC_URL ??
    env.get('RECORDER_RPC_URLS') ??
    env.get('RECORDER_RPC_URL')
  if (!raw) fail('rpc_unavailable')
  const client = (dependencies.makeClient ?? makeClient)(String(raw).split(',')[0].trim())
  try {
    return await collectPage({
      block: args.block,
      page: args.page,
      rpcRead: (method, params) => client.request({ method, params }),
      now: dependencies.now,
    })
  } catch (error) {
    if (/^usde_debt_census_[a-z_]+$/.test(String(error?.message))) throw error
    fail('rpc_or_provider_failure')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      const message = String(error?.message)
      process.stderr.write(
        `${/^usde_debt_census_[a-z_]+$/.test(message) ? message : 'usde_debt_census_failure'}\n`,
      )
      process.exitCode = 1
    },
  )
}
