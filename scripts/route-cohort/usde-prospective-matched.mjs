// Complete same-block debt/share overlap for event-observed USDe/sUSDe candidates.
// Event activity is not a borrower census; fungible balances do not attribute a route.
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { formatUnits, isAddress } from 'viem'

import { ROOT, makeClient, readEnv } from '../lib/venue-reads.mjs'
import {
  MAX_BLOCK_AGE_MS,
  readVariableDebtToken,
  writeSealedOutput,
} from './usde-susde-matched.mjs'
import { POOL, SUSDE, USDE, verify as verifySegments } from './usde-prospective-entrants.mjs'

export const MAX_CANDIDATES = 250
export const MAX_SOURCE_SEGMENTS = 32
export const MAX_SOURCE_AGE_MS = 36 * 60 * 60 * 1000
export const PRIVATE_OUTPUT_DIR = resolve(ROOT, 'scripts/route-cohort/.cache')
const HEX32 = /^0x[0-9a-f]{64}$/i
const SHA256 = /^[0-9a-f]{64}$/
const RAW = /^(0|[1-9]\d*)$/
const CLAIM = 'event_observed_same_wallet_overlap_not_route_attributed_tvl_or_borrower_census'
const MEASUREMENT =
  'lesser_of_current_aave_usde_variable_debt_and_susde_assets_per_complete_event_candidate'
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const min = (a, b) => (a < b ? a : b)
const fail = (code) => {
  throw new Error(`usde_prospective_match_${code}`)
}

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
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
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
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
    !Number.isSafeInteger(now) ||
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

function sourceOutcome(source, now) {
  if (!Number.isSafeInteger(now)) fail('clock_invalid')
  const { candidates, coverage } = source
  const capturedAt = Date.parse(coverage.sourceLatestFirstObservedAt)
  const frontierAt = Date.parse(coverage.sourceThroughBlockTimestamp)
  if (!Number.isFinite(capturedAt) || !Number.isFinite(frontierAt)) fail('source_time_invalid')
  const window = {
    fromBlock: coverage.fromBlock,
    throughBlock: coverage.throughBlock,
    sourceLatestFirstObservedAt: coverage.sourceLatestFirstObservedAt,
    sourceThroughBlockTimestamp: coverage.sourceThroughBlockTimestamp,
    sourceManifestSha256: coverage.sourceManifestSha256,
    sourceCaptureAgeSeconds: Math.floor((now - capturedAt) / 1000),
    sourceFrontierAgeSeconds: Math.floor((now - frontierAt) / 1000),
  }
  if (
    now < capturedAt ||
    now < frontierAt ||
    now - capturedAt > MAX_SOURCE_AGE_MS ||
    now - frontierAt > MAX_SOURCE_AGE_MS
  )
    return { status: 'source_stale', candidateWalletCount: candidates.length, window, data: null }
  if (candidates.length === 0) return { status: 'none_observed', window, data: null }
  if (candidates.length > MAX_CANDIDATES)
    return {
      status: 'over_capacity',
      candidateWalletCount: candidates.length,
      cap: MAX_CANDIDATES,
      window,
      data: null,
    }
  return null
}

/** Source hashes are independently retained, one per sorted sealed scanner segment. */
export async function loadSource({ dir, fromBlock, segmentSha256s }) {
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fail('explicit_scan_start_required')
  if (
    !Array.isArray(segmentSha256s) ||
    !segmentSha256s.length ||
    segmentSha256s.length > MAX_SOURCE_SEGMENTS ||
    segmentSha256s.some((value) => !SHA256.test(value))
  )
    fail('source_hashes_required')
  const before = (await readdir(dir)).sort()
  if (before.length !== segmentSha256s.length) fail('source_set_mismatch')
  let coverage
  try {
    coverage = verifySegments({ out: dir, fromBlock })
  } catch {
    fail('source_verification_failed')
  }
  if (coverage.segmentCount !== before.length) fail('source_set_mismatch')
  const after = (await readdir(dir)).sort()
  if (after.length !== before.length || after.some((name, index) => name !== before[index]))
    fail('source_changed')
  const segments = []
  for (let i = 0; i < after.length; i += 1) {
    const bytes = await readFile(join(dir, after[i]))
    if (sha256(bytes) !== segmentSha256s[i] || !after[i].endsWith(`-${segmentSha256s[i]}.json`))
      fail('source_hash_mismatch')
    segments.push(JSON.parse(bytes))
  }
  const labels = new Map()
  let variableBorrowEvents = 0,
    vaultActivityEvents = 0,
    twoReaderSegments = 0
  for (const segment of segments) {
    if (segment.peerWitness.hostCount === 2) twoReaderSegments++
    for (const log of segment.logs) {
      if (log.kind === 'borrow' && log.args.interestRateMode === 2) {
        variableBorrowEvents++
        const owner = log.args.onBehalfOf.toLowerCase()
        labels.set(owner, { ...(labels.get(owner) ?? {}), borrow: true })
      } else if (log.kind === 'deposit' && BigInt(log.args.sharesRaw) > 0n) {
        vaultActivityEvents++
        const owner = log.args.owner.toLowerCase()
        labels.set(owner, { ...(labels.get(owner) ?? {}), vault: true })
      } else if (log.kind === 'transfer' && BigInt(log.args.sharesRaw) > 0n) {
        vaultActivityEvents++
        for (const owner of [log.args.from, log.args.to]) {
          if (owner === '0x0000000000000000000000000000000000000000') continue
          labels.set(owner, { ...(labels.get(owner) ?? {}), vault: true })
        }
      }
    }
  }
  const candidates = [...labels]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([owner, flags]) => {
      if (!isAddress(owner, { strict: false })) fail('candidate_invalid')
      return {
        owner,
        sourceLabel: flags.borrow && flags.vault ? 'both' : flags.borrow ? 'borrow' : 'vault',
      }
    })
  const last = segments.at(-1)
  return {
    candidates,
    coverage: {
      fromBlock,
      throughBlock: coverage.throughBlock,
      sourceFrontierHash: coverage.frontierHash,
      segmentCount: segments.length,
      segmentSha256s,
      sourceManifestSha256: sha256(JSON.stringify({ fromBlock, segmentSha256s })),
      sourceLatestFirstObservedAt: last.firstObservedAt,
      sourceThroughBlockTimestamp: new Date(last.toHeader.timestamp * 1000).toISOString(),
      variableBorrowEvents,
      vaultActivityEvents,
      variableBorrowCandidateCount: candidates.filter((entry) => entry.sourceLabel !== 'vault')
        .length,
      vaultActivityCandidateCount: candidates.filter((entry) => entry.sourceLabel !== 'borrow')
        .length,
      twoReaderSegments,
      qualification:
        'Complete event-observed candidate union in this explicit scan window; not a borrower census, route attribution, or provider-independence proof.',
    },
  }
}

/** All-or-nothing: no aggregate is emitted for an empty, over-cap, or failed candidate set. */
export async function collectMatched(client, source, clock = () => Date.now()) {
  const { candidates, coverage } = source ?? {}
  if (
    !Array.isArray(candidates) ||
    !coverage ||
    coverage.segmentCount < 1 ||
    candidates.some((entry) => !isAddress(entry.owner, { strict: false }))
  )
    fail('source_unverified')
  const terminal = sourceOutcome(source, clock())
  if (terminal) return terminal
  if ((await client.getChainId()) !== 1) fail('wrong_chain')
  const block = await client.getBlock({ blockTag: 'finalized' })
  const startedAt = clock()
  const initial = checkedHeader(block, startedAt)
  if (block.number < BigInt(coverage.throughBlock)) fail('block_before_source')
  const sourceCapturedAt = Date.parse(coverage.sourceLatestFirstObservedAt)
  const sourceBlockAt = Date.parse(coverage.sourceThroughBlockTimestamp)
  const blockAt = Number(block.timestamp) * 1000
  if (
    !Number.isFinite(sourceCapturedAt) ||
    !Number.isFinite(sourceBlockAt) ||
    sourceCapturedAt > startedAt ||
    sourceBlockAt > blockAt ||
    startedAt - sourceCapturedAt > MAX_SOURCE_AGE_MS ||
    blockAt - sourceBlockAt > MAX_SOURCE_AGE_MS
  )
    fail('source_stale')
  const blockNumber = block.number
  const debtToken = await readVariableDebtToken(client, blockNumber)
  const [asset, shareDecimals, totalAssets] = await Promise.all([
    client.readContract({ address: SUSDE, abi: vaultAbi, functionName: 'asset', blockNumber }),
    client.readContract({ address: SUSDE, abi: vaultAbi, functionName: 'decimals', blockNumber }),
    client.readContract({
      address: SUSDE,
      abi: vaultAbi,
      functionName: 'totalAssets',
      blockNumber,
    }),
  ])
  if (!eq(asset, USDE) || Number(shareDecimals) !== 18) fail('vault_identity_mismatch')
  nonnegative(totalAssets)
  const rows = []
  for (const { owner, sourceLabel } of candidates) {
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
      sourceLabel,
      debtRaw: debt.toString(),
      sharesRaw: shares.toString(),
      holdingRaw: holding.toString(),
      matchedRaw: min(debt, holding).toString(),
    })
  }
  const after = await client.getBlock({ blockNumber })
  if (
    after?.number !== blockNumber ||
    !eq(after.hash, initial.blockHash) ||
    after.timestamp !== block.timestamp
  )
    fail('block_changed')
  const completedAt = clock()
  if (
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < startedAt
  )
    fail('clock_invalid')
  const header = checkedHeader(block, completedAt)
  if (completedAt - sourceCapturedAt > MAX_SOURCE_AGE_MS) fail('source_stale')
  const body = {
    schemaVersion: 1,
    measurement: MEASUREMENT,
    claim: CLAIM,
    borrowMarket: POOL,
    borrowAsset: USDE,
    destination: SUSDE,
    variableDebtToken: debtToken,
    ...coverage,
    ...header,
    collectionStartedAt: new Date(startedAt).toISOString(),
    capturedAt: new Date(completedAt).toISOString(),
    collectionElapsedMs: completedAt - startedAt,
    candidateWalletCount: candidates.length,
    completeWalletCount: rows.length,
    unknownWalletCount: 0,
    assetDecimals: 18,
    shareDecimals: 18,
    matchedRaw: rows.reduce((sum, row) => sum + BigInt(row.matchedRaw), 0n).toString(),
    destinationVaultTotalAssetsRaw: totalAssets.toString(),
    destinationVaultTotalAssetsMeaning: 'all depositors; not candidate or route capital',
    rows,
  }
  return {
    status: 'ok',
    document: validateMatched({ ...body, documentSha256: sha256(JSON.stringify(body)) }, source),
  }
}

export function validateMatched(document, source) {
  const { documentSha256, ...body } = document ?? {}
  if (!SHA256.test(documentSha256 || '') || sha256(JSON.stringify(body)) !== documentSha256)
    fail('document_hash_mismatch')
  const { candidates, coverage } = source ?? {}
  if (
    !Array.isArray(candidates) ||
    !coverage ||
    candidates.length < 1 ||
    candidates.length > MAX_CANDIDATES ||
    body.schemaVersion !== 1 ||
    body.measurement !== MEASUREMENT ||
    body.claim !== CLAIM ||
    body.borrowMarket !== POOL ||
    body.borrowAsset !== USDE ||
    body.destination !== SUSDE ||
    !isAddress(body.variableDebtToken || '', { strict: false }) ||
    Object.entries(coverage).some(
      ([key, value]) => JSON.stringify(body[key]) !== JSON.stringify(value),
    ) ||
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
    BigInt(body.blockNumber || 0) < BigInt(coverage.throughBlock) ||
    body.candidateWalletCount !== candidates.length ||
    body.completeWalletCount !== candidates.length ||
    body.unknownWalletCount !== 0 ||
    body.assetDecimals !== 18 ||
    body.shareDecimals !== 18 ||
    body.destinationVaultTotalAssetsMeaning !== 'all depositors; not candidate or route capital' ||
    !RAW.test(body.destinationVaultTotalAssetsRaw || '') ||
    !RAW.test(body.matchedRaw || '') ||
    !Array.isArray(body.rows) ||
    body.rows.length !== candidates.length
  )
    fail('document_identity_invalid')
  const startedAt = Date.parse(body.collectionStartedAt)
  const completedAt = Date.parse(body.capturedAt)
  const blockAt = Date.parse(body.blockTimestamp)
  const sourceCapturedAt = Date.parse(coverage.sourceLatestFirstObservedAt)
  const sourceBlockAt = Date.parse(coverage.sourceThroughBlockTimestamp)
  if (
    completedAt - startedAt !== body.collectionElapsedMs ||
    body.ageSecondsAtCapture !== Math.max(0, Math.floor((completedAt - blockAt) / 1000)) ||
    completedAt - blockAt > MAX_BLOCK_AGE_MS ||
    completedAt - blockAt < -120_000 ||
    sourceCapturedAt > startedAt ||
    completedAt - sourceCapturedAt > MAX_SOURCE_AGE_MS ||
    sourceBlockAt > blockAt ||
    blockAt - sourceBlockAt > MAX_SOURCE_AGE_MS
  )
    fail('document_time_invalid')
  const total = BigInt(body.destinationVaultTotalAssetsRaw)
  let aggregate = 0n,
    holdings = 0n
  for (let i = 0; i < candidates.length; i += 1) {
    const row = body.rows[i]
    if (
      !eq(row?.owner, candidates[i].owner) ||
      row.sourceLabel !== candidates[i].sourceLabel ||
      !RAW.test(row?.debtRaw || '') ||
      !RAW.test(row?.sharesRaw || '') ||
      !RAW.test(row?.holdingRaw || '') ||
      !RAW.test(row?.matchedRaw || '')
    )
      fail('row_invalid')
    const debt = BigInt(row.debtRaw),
      shares = BigInt(row.sharesRaw),
      holding = BigInt(row.holdingRaw)
    if (
      holding > total ||
      (shares === 0n && holding !== 0n) ||
      BigInt(row.matchedRaw) !== min(debt, holding)
    )
      fail('row_bounds_invalid')
    holdings += holding
    aggregate += BigInt(row.matchedRaw)
  }
  if (holdings > total || aggregate !== BigInt(body.matchedRaw)) fail('aggregate_bounds_invalid')
  return document
}

function parseArgs(argv) {
  const options = { segmentSha256s: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--run' || token === '--verify') {
      if (options.mode) fail('cli_invalid')
      options.mode = token
    } else if (token === '--segment-sha256') {
      const value = argv[++i]
      if (!SHA256.test(value || '')) fail('cli_invalid')
      options.segmentSha256s.push(value)
    } else if (['--source-dir', '--from-block', '--out', '--out-sha256'].includes(token)) {
      if (options[token] || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('cli_invalid')
      options[token] = argv[++i]
    } else fail('cli_invalid')
  }
  const fromBlock = Number(options['--from-block'])
  if (
    !options.mode ||
    !options['--source-dir'] ||
    !Number.isSafeInteger(fromBlock) ||
    fromBlock < 0 ||
    !options['--out'] ||
    !resolve(options['--out']).endsWith('.json') ||
    !options.segmentSha256s.length ||
    options.segmentSha256s.length > MAX_SOURCE_SEGMENTS ||
    (options.mode === '--run' && options['--out-sha256']) ||
    (options.mode === '--verify' && !SHA256.test(options['--out-sha256'] || ''))
  )
    fail('cli_invalid')
  return {
    mode: options.mode,
    dir: resolve(options['--source-dir']),
    fromBlock,
    segmentSha256s: options.segmentSha256s,
    out: resolve(options['--out']),
    expectedOutputSha256: options['--out-sha256'],
  }
}

async function assertPrivateOutput(out) {
  if (dirname(out) !== PRIVATE_OUTPUT_DIR) fail('output_path_not_private')
  const directory = await lstat(PRIVATE_OUTPUT_DIR)
  if (!directory.isDirectory() || directory.isSymbolicLink()) fail('output_path_not_private')
  try {
    const target = await lstat(out)
    if (target.isSymbolicLink()) fail('output_path_not_private')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv)
  await assertPrivateOutput(args.out)
  const source = await loadSource(args)
  if (args.mode === '--verify') {
    const bytes = await readFile(args.out)
    if (sha256(bytes) !== args.expectedOutputSha256) fail('output_hash_mismatch')
    const document = validateMatched(JSON.parse(bytes), source)
    return {
      status: 'verified',
      matchedRaw: document.matchedRaw,
      matchedUsde: formatUnits(BigInt(document.matchedRaw), 18),
      completeWalletCount: document.completeWalletCount,
      outputSha256: sha256(bytes),
    }
  }
  const clock = dependencies.clock ?? (() => Date.now())
  const terminal = sourceOutcome(source, clock())
  if (terminal) return terminal
  const env = dependencies.env ?? readEnv()
  const raw = env.get('RECORDER_RPC_URLS') || env.get('RECORDER_RPC_URL')
  if (!raw && !dependencies.client) fail('rpc_unavailable')
  const client = dependencies.client ?? makeClient(raw.split(',')[0].trim())
  const result = await collectMatched(client, source, clock)
  if (result.status !== 'ok') fail('collection_incomplete')
  const bytes = Buffer.from(`${JSON.stringify(result.document, null, 2)}\n`)
  await writeSealedOutput(args.out, bytes)
  return {
    status: 'sealed',
    matchedRaw: result.document.matchedRaw,
    matchedUsde: formatUnits(BigInt(result.document.matchedRaw), 18),
    completeWalletCount: result.document.completeWalletCount,
    outputSha256: sha256(bytes),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      // Provider errors may contain a credential-bearing URL.
      process.stderr.write(
        `${/^usde_prospective_match_[a-z_]+$/.test(error?.message) ? error.message : 'usde_prospective_match_collection_failed'}\n`,
      )
      process.exitCode = 1
    },
  )
}
