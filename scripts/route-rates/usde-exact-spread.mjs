// Aave Core USDe borrow versus trailing seven-day sUSDe share growth.
// This is a two-leg rate comparison, not a realized borrower or vault-user return.
import { createHash, randomUUID } from 'node:crypto'
import { link, open, readFile, statfs, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAddress } from 'viem'
import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  LOOKBACK_SECONDS,
  aaveNominalAprToEffectiveApy,
  annualizeShareGrowth,
} from './exact-leg-spread.mjs'

export const USDE_LEG = Object.freeze({
  chainId: 1,
  borrowProtocol: 'Aave V3 Core',
  borrowMarket: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2',
  borrowAsset: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  destination: '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
  destinationKind: 'ERC4626',
})
export const MAX_BLOCK_AGE_MS = 2 * 60 * 60 * 1000
export const MIN_FREE_BYTES = 1_073_741_824
const SHARE_UNIT = 10n ** 18n
const HEX32 = /^0x[0-9a-f]{64}$/i
const RAW = /^(0|[1-9]\d*)$/
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const fail = (code) => {
  throw new Error(`usde_spread_${code}`)
}
const erc20Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'UNDERLYING_ASSET_ADDRESS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'POOL',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]
const vaultAbi = [
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
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
]

function validBlock(block) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number <= 0n ||
    typeof block.timestamp !== 'bigint' ||
    !HEX32.test(block.hash || '') ||
    !Number.isSafeInteger(Number(block.timestamp) * 1000)
  )
    fail('block_invalid')
  return block
}

function checkedAge(block, now) {
  validBlock(block)
  const age = now - Number(block.timestamp) * 1000
  if (
    !Number.isSafeInteger(now) ||
    !Number.isFinite(age) ||
    age < -120_000 ||
    age > MAX_BLOCK_AGE_MS
  )
    fail('finalized_block_stale')
  return Math.max(0, Math.floor(age / 1000))
}

/** Newest archive block at or before B.timestamp - seven days, at most one hour behind. */
export async function findPriorBlock(client, head) {
  validBlock(head)
  const target = head.timestamp - BigInt(LOOKBACK_SECONDS)
  if (target <= 0n) fail('lookback_unavailable')
  let low = 1n
  let high = head.number - 1n
  let best = null
  while (low <= high) {
    const middle = (low + high) / 2n
    const candidate = validBlock(await client.getBlock({ blockNumber: middle }))
    if (candidate.number !== middle) fail('archive_block_mismatch')
    if (candidate.timestamp <= target) {
      best = candidate
      low = middle + 1n
    } else high = middle - 1n
  }
  if (!best || target - best.timestamp > 3600n) fail('lookback_unavailable')
  return best
}

async function readVaultQuote(client, blockNumber) {
  const [asset, assetDecimals, shareDecimals, quote] = await Promise.all([
    client.readContract({
      address: USDE_LEG.destination,
      abi: vaultAbi,
      functionName: 'asset',
      blockNumber,
    }),
    client.readContract({
      address: USDE_LEG.borrowAsset,
      abi: erc20Abi,
      functionName: 'decimals',
      blockNumber,
    }),
    client.readContract({
      address: USDE_LEG.destination,
      abi: vaultAbi,
      functionName: 'decimals',
      blockNumber,
    }),
    client.readContract({
      address: USDE_LEG.destination,
      abi: vaultAbi,
      functionName: 'convertToAssets',
      args: [SHARE_UNIT],
      blockNumber,
    }),
  ])
  if (
    !eq(asset, USDE_LEG.borrowAsset) ||
    Number(assetDecimals) !== 18 ||
    Number(shareDecimals) !== 18
  )
    fail('vault_identity_mismatch')
  if (typeof quote !== 'bigint' || quote <= 0n) fail('share_quote_invalid')
  return quote
}

async function readCurrentBorrowRay(client, blockNumber) {
  const data = `0x35ea6a75${USDE_LEG.borrowAsset.slice(2).padStart(64, '0')}`
  const reserve = await client.request({
    method: 'eth_call',
    params: [{ to: USDE_LEG.borrowMarket, data }, `0x${blockNumber.toString(16)}`],
  })
  const words = /^0x(?:[0-9a-f]{64})+$/i.test(reserve || '')
    ? reserve.slice(2).match(/.{64}/g)
    : null
  if (!words || words.length < 11) fail('reserve_data_unavailable')
  const debtToken = `0x${words[10].slice(24)}`.toLowerCase()
  if (!isAddress(debtToken, { strict: false }) || /^0x0+$/.test(debtToken))
    fail('reserve_identity_invalid')
  const [underlying, pool, decimals] = await Promise.all([
    client.readContract({
      address: debtToken,
      abi: erc20Abi,
      functionName: 'UNDERLYING_ASSET_ADDRESS',
      blockNumber,
    }),
    client.readContract({ address: debtToken, abi: erc20Abi, functionName: 'POOL', blockNumber }),
    client.readContract({
      address: debtToken,
      abi: erc20Abi,
      functionName: 'decimals',
      blockNumber,
    }),
  ])
  if (
    !eq(underlying, USDE_LEG.borrowAsset) ||
    !eq(pool, USDE_LEG.borrowMarket) ||
    Number(decimals) !== 18
  )
    fail('reserve_identity_invalid')
  return { ray: BigInt(`0x${words[4]}`), debtToken }
}

/** One RPC host, one finalized current block, one timestamp-selected archive block. */
export async function collectUsdeExactSpread(client, clock = () => Date.now(), anchor = null) {
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const head = validBlock(
    anchor
      ? await client.getBlock({ blockNumber: BigInt(anchor.blockNumber) })
      : await client.getBlock({ blockTag: 'finalized' }),
  )
  const startedAt = clock()
  checkedAge(head, startedAt)
  if (
    anchor &&
    (head.number.toString() !== anchor.blockNumber ||
      head.hash.toLowerCase() !== anchor.blockHash ||
      new Date(Number(head.timestamp) * 1000).toISOString() !== anchor.blockTimestamp)
  )
    fail('anchor_mismatch')
  const prior = await findPriorBlock(client, head)
  const lookbackSeconds = Number(head.timestamp - prior.timestamp)
  if (lookbackSeconds < LOOKBACK_SECONDS || lookbackSeconds > LOOKBACK_SECONDS + 3600)
    fail('lookback_invalid')
  const [borrow, currentQuoteRaw, priorQuoteRaw] = await Promise.all([
    readCurrentBorrowRay(client, head.number),
    readVaultQuote(client, head.number),
    readVaultQuote(client, prior.number),
  ])
  const [headAfter, priorAfter] = await Promise.all([
    client.getBlock({ blockNumber: head.number }),
    client.getBlock({ blockNumber: prior.number }),
  ])
  if (
    headAfter?.number !== head.number ||
    !eq(headAfter.hash, head.hash) ||
    headAfter.timestamp !== head.timestamp ||
    priorAfter?.number !== prior.number ||
    !eq(priorAfter.hash, prior.hash) ||
    priorAfter.timestamp !== prior.timestamp
  )
    fail('block_changed')
  const completedAt = clock()
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt
  )
    fail('clock_invalid')
  const ageSecondsAtCapture = checkedAge(head, completedAt)
  const borrowApy = aaveNominalAprToEffectiveApy(borrow.ray)
  const yieldApy = annualizeShareGrowth(currentQuoteRaw, priorQuoteRaw, lookbackSeconds)
  const spread = yieldApy - borrowApy
  if (![borrowApy, yieldApy, spread].every(Number.isFinite)) fail('rate_invalid')
  const body = {
    schemaVersion: 1,
    leg: USDE_LEG,
    variableDebtToken: borrow.debtToken,
    measurement: 'current_aave_variable_borrow_apy_vs_trailing_seven_day_susde_share_growth_apy',
    claim: 'modeled_two_leg_spread_not_cohort_realized_return',
    rateConvention: 'effective APY as decimal fraction; incentives, gas, and exit costs excluded',
    currentBlockNumber: head.number.toString(),
    currentBlockHash: head.hash.toLowerCase(),
    currentBlockTimestamp: new Date(Number(head.timestamp) * 1000).toISOString(),
    priorBlockNumber: prior.number.toString(),
    priorBlockHash: prior.hash.toLowerCase(),
    priorBlockTimestamp: new Date(Number(prior.timestamp) * 1000).toISOString(),
    lookbackSeconds,
    collectionStartedAt: new Date(startedAt).toISOString(),
    capturedAt: new Date(completedAt).toISOString(),
    collectionElapsedMs: completedAt - startedAt,
    ageSecondsAtCapture,
    currentVariableBorrowRateRayRaw: borrow.ray.toString(),
    shareUnitRaw: SHARE_UNIT.toString(),
    currentAssetsPerShareUnitRaw: currentQuoteRaw.toString(),
    priorAssetsPerShareUnitRaw: priorQuoteRaw.toString(),
    assetDecimals: 18,
    shareDecimals: 18,
    borrowApy,
    yieldApy,
    spread,
  }
  return validateUsdeExactSpread({ ...body, documentSha256: sha256(JSON.stringify(body)) })
}

/** Check physical SHA separately; this validates identity, time, arithmetic, and internal seal. */
export function validateUsdeExactSpread(document) {
  const { documentSha256, ...body } = document ?? {}
  if (
    !/^[a-f0-9]{64}$/.test(documentSha256 || '') ||
    sha256(JSON.stringify(body)) !== documentSha256
  )
    fail('document_hash_mismatch')
  if (
    body.schemaVersion !== 1 ||
    JSON.stringify(body.leg) !== JSON.stringify(USDE_LEG) ||
    body.measurement !==
      'current_aave_variable_borrow_apy_vs_trailing_seven_day_susde_share_growth_apy' ||
    body.claim !== 'modeled_two_leg_spread_not_cohort_realized_return' ||
    !isAddress(body.variableDebtToken || '', { strict: false }) ||
    /^0x0+$/.test(body.variableDebtToken) ||
    body.rateConvention !==
      'effective APY as decimal fraction; incentives, gas, and exit costs excluded' ||
    !RAW.test(body.currentBlockNumber || '') ||
    !HEX32.test(body.currentBlockHash || '') ||
    !RAW.test(body.priorBlockNumber || '') ||
    !HEX32.test(body.priorBlockHash || '') ||
    !RAW.test(body.currentVariableBorrowRateRayRaw || '') ||
    !RAW.test(body.shareUnitRaw || '') ||
    !RAW.test(body.currentAssetsPerShareUnitRaw || '') ||
    !RAW.test(body.priorAssetsPerShareUnitRaw || '') ||
    body.shareUnitRaw !== SHARE_UNIT.toString() ||
    body.assetDecimals !== 18 ||
    body.shareDecimals !== 18 ||
    !Number.isSafeInteger(body.lookbackSeconds) ||
    body.lookbackSeconds < LOOKBACK_SECONDS ||
    body.lookbackSeconds > LOOKBACK_SECONDS + 3600 ||
    !Number.isSafeInteger(body.collectionElapsedMs) ||
    body.collectionElapsedMs < 0 ||
    !Number.isSafeInteger(body.ageSecondsAtCapture) ||
    body.ageSecondsAtCapture < 0 ||
    body.ageSecondsAtCapture > MAX_BLOCK_AGE_MS / 1000 ||
    ![body.borrowApy, body.yieldApy, body.spread].every(Number.isFinite)
  )
    fail('document_identity_invalid')
  const currentAt = Date.parse(body.currentBlockTimestamp)
  const priorAt = Date.parse(body.priorBlockTimestamp)
  const startedAt = Date.parse(body.collectionStartedAt)
  const completedAt = Date.parse(body.capturedAt)
  if (
    ![currentAt, priorAt, startedAt, completedAt].every(Number.isSafeInteger) ||
    BigInt(body.priorBlockNumber) >= BigInt(body.currentBlockNumber) ||
    (currentAt - priorAt) / 1000 !== body.lookbackSeconds ||
    completedAt - startedAt !== body.collectionElapsedMs ||
    completedAt - currentAt < -120_000 ||
    completedAt - currentAt > MAX_BLOCK_AGE_MS ||
    body.ageSecondsAtCapture !== Math.max(0, Math.floor((completedAt - currentAt) / 1000))
  )
    fail('document_time_invalid')
  const borrowApy = aaveNominalAprToEffectiveApy(BigInt(body.currentVariableBorrowRateRayRaw))
  const yieldApy = annualizeShareGrowth(
    body.currentAssetsPerShareUnitRaw,
    body.priorAssetsPerShareUnitRaw,
    body.lookbackSeconds,
  )
  if (
    body.borrowApy !== borrowApy ||
    body.yieldApy !== yieldApy ||
    body.spread !== yieldApy - borrowApy
  )
    fail('document_rate_invalid')
  return document
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (options.mode) fail('cli_invalid')
      options.mode = token
    } else if (['--out', '--out-sha256'].includes(token)) {
      if (options[token] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('cli_invalid')
      options[token] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !options.mode ||
    !options['--out'] ||
    !resolve(options['--out']).endsWith('.json') ||
    (options.mode === '--verify' && !/^[a-f0-9]{64}$/.test(options['--out-sha256'] || '')) ||
    (options.mode === '--run' && options['--out-sha256'])
  )
    fail('cli_invalid')
  return {
    mode: options.mode,
    out: resolve(options['--out']),
    expectedSha: options['--out-sha256'],
  }
}

async function writeSealed(out, bytes) {
  const stats = await statfs(dirname(out))
  if (Number(stats.bavail) * Number(stats.bsize) - bytes.length < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
  const temp = `${out}.tmp-${randomUUID()}`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await link(temp, out)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await unlink(temp).catch(() => {})
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  if (args.mode === '--verify') {
    const bytes = await readFile(args.out)
    if (sha256(bytes) !== args.expectedSha) fail('output_hash_mismatch')
    const document = validateUsdeExactSpread(JSON.parse(bytes))
    return {
      status: 'verified',
      currentBlockNumber: document.currentBlockNumber,
      outputSha256: sha256(bytes),
    }
  }
  const env = dependencies.env ?? readEnv()
  const rpc = env.get('RECORDER_RPC_URLS') || env.get('RECORDER_RPC_URL')
  if (!rpc) fail('rpc_unavailable')
  const client = dependencies.client ?? makeClient(rpc.split(',')[0].trim())
  const document = await collectUsdeExactSpread(
    client,
    dependencies.clock ?? (() => Date.now()),
    dependencies.anchor ?? null,
  )
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  await writeSealed(args.out, bytes)
  return {
    status: 'sealed',
    currentBlockNumber: document.currentBlockNumber,
    borrowApy: document.borrowApy,
    yieldApy: document.yieldApy,
    spread: document.spread,
    outputSha256: sha256(bytes),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      // Provider errors may embed credential-bearing URLs; never print them.
      process.stderr.write(
        `${/^usde_spread_[a-z_]+$/.test(error?.message) ? error.message : 'usde_spread_collection_failed'}\n`,
      )
      process.exitCode = 1
    },
  )
}
