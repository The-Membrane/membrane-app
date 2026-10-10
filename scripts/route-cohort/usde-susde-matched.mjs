// Current debt/holding overlap for the 25 August receipt-attested USDe borrowers.
// Fungible balances cannot establish that borrowed proceeds entered sUSDe.
import { createHash, randomUUID } from 'node:crypto'
import { link, open, readFile, statfs, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatUnits, isAddress } from 'viem'

import { makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  COHORT_SIZE,
  MIN_FREE_BYTES,
  POOL,
  ROUTE,
  SOURCE_SHA256,
  SUSDE,
  USDE,
  validateAttestation,
  validateSourceAndSeed,
} from './usde-susde-receipts.mjs'

export const RECEIPT_SHA256 = '413d45d1b560752e0c14e089341cc72b7565c5ec90aa73bb625d1c4fc2c64751'
export const MAX_BLOCK_AGE_MS = 2 * 60 * 60 * 1000
const SEED_PATH = fileURLToPath(new URL('./aug-2026-ab-vault-seed.json', import.meta.url))
const HEX32 = /^0x[0-9a-f]{64}$/i
const RAW = /^(0|[1-9]\d*)$/
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const min = (a, b) => (a < b ? a : b)
const fail = (code) => {
  throw new Error(`usde_overlap_${code}`)
}

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'convertToAssets',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]

function nonnegative(value) {
  if (typeof value !== 'bigint' || value < 0n) fail('reading_invalid')
  return value
}

function checkedHeader(block, now) {
  if (
    typeof block?.number !== 'bigint' ||
    block.number <= 0n ||
    !HEX32.test(block.hash || '') ||
    typeof block.timestamp !== 'bigint'
  )
    fail('finalized_header_invalid')
  const timestampMs = Number(block.timestamp) * 1000
  const ageMs = now - timestampMs
  if (
    !Number.isSafeInteger(timestampMs) ||
    !Number.isFinite(ageMs) ||
    ageMs < -120_000 ||
    ageMs > MAX_BLOCK_AGE_MS
  )
    fail('finalized_header_stale')
  return {
    blockNumber: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
    blockTimestamp: new Date(timestampMs).toISOString(),
    ageSecondsAtCapture: Math.max(0, Math.floor(ageMs / 1000)),
  }
}

/** Aave V3 getReserveData: word 10 is variableDebtTokenAddress. */
export async function readVariableDebtToken(client, blockNumber) {
  const encoded = `0x35ea6a75${USDE.slice(2).padStart(64, '0')}`
  const data = await client.request({
    method: 'eth_call',
    params: [{ to: POOL, data: encoded }, `0x${blockNumber.toString(16)}`],
  })
  const words = /^0x(?:[0-9a-f]{64})+$/i.test(data || '') ? data.slice(2).match(/.{64}/g) : null
  if (!words || words.length < 11) fail('reserve_data_unavailable')
  const debtToken = `0x${words[10].slice(24)}`.toLowerCase()
  if (!isAddress(debtToken, { strict: false }) || /^0x0+$/.test(debtToken))
    fail('debt_token_invalid')
  const [underlying, pool, debtDecimals, assetDecimals] = await Promise.all([
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
    client.readContract({ address: USDE, abi: erc20Abi, functionName: 'decimals', blockNumber }),
  ])
  if (
    !eq(underlying, USDE) ||
    !eq(pool, POOL) ||
    Number(debtDecimals) !== 18 ||
    Number(assetDecimals) !== 18
  )
    fail('debt_token_identity_mismatch')
  return debtToken
}

export async function collectMatched(
  client,
  cohort,
  attestation,
  sourceArtifactSha256,
  clock = () => Date.now(),
  anchor = null,
) {
  if (
    cohort?.observations?.length !== COHORT_SIZE ||
    attestation?.checked !== COHORT_SIZE ||
    sourceArtifactSha256 !== RECEIPT_SHA256
  )
    fail('cohort_invalid')
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const block = anchor
    ? await client.getBlock({ blockNumber: BigInt(anchor.blockNumber) })
    : await client.getBlock({ blockTag: 'finalized' })
  const startedAt = clock()
  const initialHeader = checkedHeader(block, startedAt)
  if (
    anchor &&
    (initialHeader.blockNumber !== anchor.blockNumber ||
      initialHeader.blockHash !== anchor.blockHash ||
      initialHeader.blockTimestamp !== anchor.blockTimestamp)
  )
    fail('anchor_mismatch')
  const blockNumber = block.number
  const debtToken = await readVariableDebtToken(client, blockNumber)
  const [vaultAsset, shareDecimals, totalAssets] = await Promise.all([
    client.readContract({ address: SUSDE, abi: vaultAbi, functionName: 'asset', blockNumber }),
    client.readContract({ address: SUSDE, abi: vaultAbi, functionName: 'decimals', blockNumber }),
    client.readContract({
      address: SUSDE,
      abi: vaultAbi,
      functionName: 'totalAssets',
      blockNumber,
    }),
  ])
  if (!eq(vaultAsset, USDE) || Number(shareDecimals) !== 18) fail('vault_identity_mismatch')
  nonnegative(totalAssets)
  const rows = []
  for (const { owner } of cohort.observations) {
    const [debt, shares] = await Promise.all([
      client.readContract({
        address: debtToken,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
        blockNumber,
      }),
      client.readContract({
        address: SUSDE,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [owner],
        blockNumber,
      }),
    ])
    nonnegative(debt)
    nonnegative(shares)
    const holding = nonnegative(
      await client.readContract({
        address: SUSDE,
        abi: vaultAbi,
        functionName: 'convertToAssets',
        args: [shares],
        blockNumber,
      }),
    )
    if (holding > totalAssets || (shares === 0n && holding !== 0n)) fail('holding_bounds_invalid')
    rows.push({
      owner,
      debtRaw: debt.toString(),
      sharesRaw: shares.toString(),
      holdingRaw: holding.toString(),
      matchedRaw: min(debt, holding).toString(),
    })
  }
  const after = await client.getBlock({ blockNumber })
  if (
    after?.number !== blockNumber ||
    !eq(after?.hash, initialHeader.blockHash) ||
    after?.timestamp !== block.timestamp
  )
    fail('block_changed')
  const completedAt = clock()
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt
  )
    fail('clock_invalid')
  // A long sequential read must not inherit the fresh age it had at start.
  const header = checkedHeader(block, completedAt)
  const body = {
    schemaVersion: 1,
    route: ROUTE,
    measurement:
      'lesser_of_current_aave_usde_variable_debt_and_susde_holding_per_august_receipt_attested_wallet',
    claim: 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit',
    sourceSha256: SOURCE_SHA256,
    sourceArtifactSha256,
    receiptProofCount: attestation.checked,
    borrowMarket: POOL,
    borrowAsset: USDE,
    variableDebtToken: debtToken,
    destination: SUSDE,
    ...header,
    collectionStartedAt: new Date(startedAt).toISOString(),
    capturedAt: new Date(completedAt).toISOString(),
    collectionElapsedMs: completedAt - startedAt,
    observedWalletCount: rows.length,
    completeWalletCount: rows.length,
    unknownWalletCount: 0,
    assetDecimals: 18,
    shareDecimals: 18,
    matchedRaw: rows.reduce((n, row) => n + BigInt(row.matchedRaw), 0n).toString(),
    destinationVaultTotalAssetsRaw: totalAssets.toString(),
    destinationVaultTotalAssetsMeaning: 'all depositors; not cohort capital',
    rows,
  }
  return validateMatched({ ...body, documentSha256: sha256(JSON.stringify(body)) }, cohort)
}

/** Offline structural and arithmetic verification; source receipts are checked separately. */
export function validateMatched(document, cohort) {
  const { documentSha256, ...body } = document ?? {}
  if (
    !/^[a-f0-9]{64}$/.test(documentSha256 || '') ||
    sha256(JSON.stringify(body)) !== documentSha256
  )
    fail('document_hash_mismatch')
  if (
    body.schemaVersion !== 1 ||
    body.route !== ROUTE ||
    body.claim !== 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit' ||
    body.measurement !==
      'lesser_of_current_aave_usde_variable_debt_and_susde_holding_per_august_receipt_attested_wallet' ||
    body.sourceSha256 !== SOURCE_SHA256 ||
    body.sourceArtifactSha256 !== RECEIPT_SHA256 ||
    body.receiptProofCount !== COHORT_SIZE ||
    body.borrowMarket !== POOL ||
    body.borrowAsset !== USDE ||
    body.destination !== SUSDE ||
    !isAddress(body.variableDebtToken || '', { strict: false }) ||
    !RAW.test(body.blockNumber || '') ||
    !HEX32.test(body.blockHash || '') ||
    !Number.isFinite(Date.parse(body.blockTimestamp)) ||
    !Number.isFinite(Date.parse(body.collectionStartedAt)) ||
    !Number.isFinite(Date.parse(body.capturedAt)) ||
    !Number.isSafeInteger(body.collectionElapsedMs) ||
    body.collectionElapsedMs < 0 ||
    !Number.isSafeInteger(body.ageSecondsAtCapture) ||
    body.ageSecondsAtCapture < 0 ||
    body.ageSecondsAtCapture > MAX_BLOCK_AGE_MS / 1000 ||
    body.assetDecimals !== 18 ||
    body.shareDecimals !== 18 ||
    body.observedWalletCount !== COHORT_SIZE ||
    body.completeWalletCount !== COHORT_SIZE ||
    body.unknownWalletCount !== 0 ||
    body.destinationVaultTotalAssetsMeaning !== 'all depositors; not cohort capital' ||
    !RAW.test(body.destinationVaultTotalAssetsRaw || '') ||
    !RAW.test(body.matchedRaw || '') ||
    !Array.isArray(body.rows) ||
    body.rows.length !== COHORT_SIZE ||
    cohort?.observations?.length !== COHORT_SIZE
  )
    fail('document_identity_invalid')
  const startedAt = Date.parse(body.collectionStartedAt)
  const completedAt = Date.parse(body.capturedAt)
  const blockAt = Date.parse(body.blockTimestamp)
  if (
    completedAt - startedAt !== body.collectionElapsedMs ||
    body.ageSecondsAtCapture !== Math.max(0, Math.floor((completedAt - blockAt) / 1000)) ||
    completedAt - blockAt > MAX_BLOCK_AGE_MS ||
    completedAt - blockAt < -120_000
  )
    fail('document_time_invalid')
  const total = BigInt(body.destinationVaultTotalAssetsRaw)
  let matched = 0n
  let holdings = 0n
  for (let i = 0; i < COHORT_SIZE; i += 1) {
    const row = body.rows[i]
    if (
      !eq(row?.owner, cohort.observations[i].owner) ||
      !RAW.test(row?.debtRaw || '') ||
      !RAW.test(row?.sharesRaw || '') ||
      !RAW.test(row?.holdingRaw || '') ||
      !RAW.test(row?.matchedRaw || '')
    )
      fail('row_invalid')
    const debt = BigInt(row.debtRaw)
    const shares = BigInt(row.sharesRaw)
    const holding = BigInt(row.holdingRaw)
    if (
      holding > total ||
      (shares === 0n && holding !== 0n) ||
      BigInt(row.matchedRaw) !== min(debt, holding)
    )
      fail('row_bounds_invalid')
    holdings += holding
    matched += BigInt(row.matchedRaw)
  }
  if (holdings > total || matched !== BigInt(body.matchedRaw)) fail('aggregate_bounds_invalid')
  return document
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (options.mode) fail('cli_invalid')
      options.mode = token
    } else if (
      ['--source', '--source-sha256', '--receipts', '--out', '--out-sha256'].includes(token)
    ) {
      if (options[token] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('cli_invalid')
      options[token] = argv[++i]
    } else fail('cli_invalid')
  }
  if (
    !options.mode ||
    !options['--source'] ||
    options['--source-sha256'] !== SOURCE_SHA256 ||
    !options['--receipts'] ||
    !options['--out'] ||
    !resolve(options['--out']).endsWith('.json') ||
    (options['--out-sha256'] && !/^[a-f0-9]{64}$/.test(options['--out-sha256'])) ||
    (options.mode === '--run' && options['--out-sha256']) ||
    (options.mode === '--verify' && !options['--out-sha256'])
  )
    fail('cli_invalid')
  return {
    mode: options.mode,
    source: resolve(options['--source']),
    receipts: resolve(options['--receipts']),
    out: resolve(options['--out']),
    expectedOutputSha256: options['--out-sha256'],
  }
}

async function assertDiskFloor(out, bytes) {
  const stats = await statfs(dirname(out))
  if (Number(stats.bavail) * Number(stats.bsize) - bytes < MIN_FREE_BYTES)
    fail('disk_reserve_reached')
}

/** Same-directory temp + fsync + atomic no-clobber link; a crash cannot expose partial final JSON. */
export async function writeSealedOutput(out, output) {
  await assertDiskFloor(out, output.length)
  const temporary = `${out}.tmp-${randomUUID()}`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(output)
    await handle.sync()
    await handle.close()
    handle = null
    await link(temporary, out)
  } finally {
    if (handle) await handle.close().catch(() => {})
    // Only our unique temp is removed; an existing sealed output is untouched.
    await unlink(temporary).catch(() => {})
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  const [sourceBytes, seedBytes, receiptBytes] = await Promise.all([
    readFile(args.source),
    readFile(SEED_PATH),
    readFile(args.receipts),
  ])
  const cohort = validateSourceAndSeed(sourceBytes, seedBytes)
  const receiptHash = sha256(receiptBytes)
  if (receiptHash !== RECEIPT_SHA256) fail('receipt_artifact_hash_mismatch')
  const attestation = validateAttestation(JSON.parse(receiptBytes), cohort)
  if (args.mode === '--verify') {
    const output = await readFile(args.out)
    if (sha256(output) !== args.expectedOutputSha256) fail('output_hash_mismatch')
    const document = validateMatched(JSON.parse(output), cohort)
    return {
      status: 'verified',
      completeWalletCount: document.completeWalletCount,
      matchedRaw: document.matchedRaw,
      matchedUsde: formatUnits(BigInt(document.matchedRaw), 18),
      outputSha256: sha256(output),
    }
  }
  const env = dependencies.env ?? readEnv()
  const rpc = env.get('RECORDER_RPC_URLS') || env.get('RECORDER_RPC_URL')
  if (!rpc) fail('rpc_unavailable')
  const client = dependencies.client ?? makeClient(rpc.split(',')[0].trim())
  const document = await collectMatched(
    client,
    cohort,
    attestation,
    receiptHash,
    dependencies.clock ?? (() => Date.now()),
    dependencies.anchor ?? null,
  )
  const output = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  await writeSealedOutput(args.out, output)
  return {
    status: 'sealed',
    completeWalletCount: document.completeWalletCount,
    matchedRaw: document.matchedRaw,
    matchedUsde: formatUnits(BigInt(document.matchedRaw), 18),
    destinationVaultTotalAssetsRaw: document.destinationVaultTotalAssetsRaw,
    outputSha256: sha256(output),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      // Provider errors can embed credential-bearing URLs; print only fixed codes.
      process.stderr.write(
        `${/^usde_overlap_[a-z_]+$/.test(error?.message) ? error.message : 'usde_overlap_collection_failed'}\n`,
      )
      process.exitCode = 1
    },
  )
}
