// Event-observed variable-rate GHO borrowers, read at one finalized block.
// This is same-wallet debt/sGHO-holding overlap, not route-attributed TVL.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatUnits, isAddress } from 'viem'

import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'
import { isRecentPinnedBlock, readGhoVariableDebtToken } from './gho-matched.mjs'
import { verify } from './prospective-entrants.mjs'

export const PROSPECTIVE_FROM_BLOCK = 26_069_513 // Local instrumentation epoch, not Pool deployment.
export const MAX_PROSPECTIVE_OWNERS = 250
export const MAX_SOURCE_LAG_SECONDS = 36 * 60 * 60
const GHO = GHO_SGHO.borrowAsset.toLowerCase()
const SGHO = GHO_SGHO.destination.toLowerCase()
const hash = (value) => createHash('sha256').update(value).digest('hex')
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

/** A local, explicitly incomplete discovery window; no wallet list leaves this process. */
export function loadProspectiveBorrowers({
  out,
  excludedOwners = [],
  fromBlock = PROSPECTIVE_FROM_BLOCK,
}) {
  const before = readdirSync(out).sort()
  const coverage = verify({ out, fromBlock })
  const names = readdirSync(out).sort()
  if (
    names.length !== coverage.segmentCount ||
    names.length !== before.length ||
    names.some((name, i) => name !== before[i])
  )
    throw new Error('prospective_source_changed')
  const excluded = new Set(
    excludedOwners.map((owner) => {
      if (!isAddress(owner, { strict: false })) throw new Error('prospective_exclusion_invalid')
      return owner.toLowerCase()
    }),
  )
  const owners = new Set()
  let variableBorrowEvents = 0
  let peerWitnessedSegments = 0
  let singleProviderNoVariableBorrowSegments = 0
  let latestSourceObservedAt = null
  let throughBlockTime = null
  for (const name of names) {
    const bytes = readFileSync(join(out, name))
    if (!name.endsWith(`-${hash(bytes)}.json`)) throw new Error('prospective_source_changed')
    const segment = JSON.parse(bytes.toString('utf8'))
    if (segment.schemaVersion >= 2) peerWitnessedSegments++
    else if (segment.logs.some((log) => log.kind === 'borrow' && log.args.interestRateMode === 2))
      throw new Error('prospective_variable_borrow_unwitnessed')
    else singleProviderNoVariableBorrowSegments++
    latestSourceObservedAt = segment.firstObservedAt
    throughBlockTime = new Date(segment.toHeader.timestamp * 1000).toISOString()
    for (const log of segment.logs) {
      if (log.kind !== 'borrow' || log.args.interestRateMode !== 2) continue
      variableBorrowEvents++
      const owner = log.args.onBehalfOf.toLowerCase() // Debt owner; `user` may be a delegate.
      if (!isAddress(owner, { strict: false })) throw new Error('prospective_owner_invalid')
      if (!excluded.has(owner)) owners.add(owner)
    }
  }
  return {
    owners: [...owners].sort(),
    coverage: {
      fromBlock,
      throughBlock: coverage.throughBlock,
      segmentCount: coverage.segmentCount,
      latestSourceObservedAt,
      throughBlockTime,
      sourceManifestSha256: hash(JSON.stringify({ fromBlock, names })),
      variableBorrowEvents,
      peerWitnessedSegments,
      singleProviderNoVariableBorrowSegments,
      excludedAugustWalletCount: excluded.size,
      qualification:
        'Two distinct RPC hosts returned matching variable-rate Aave GHO Borrow onBehalfOf logs in these blocks; host independence is not established, the original quiet seed is single-host, and this is not a borrower census.',
    },
  }
}

const uint = (value) => {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('prospective_amount_invalid')
  return value
}

/** No zero-capital claim for a quiet scan, a failed wallet read, or an over-large cohort. */
export async function readProspectiveOverlap(client, cohort, now = Date.now()) {
  const { owners, coverage } = cohort
  if (!Array.isArray(owners) || !coverage || coverage.segmentCount < 1)
    throw new Error('prospective_source_unverified')
  if (owners.length === 0) return { status: 'none_observed', data: null }
  if (owners.length > MAX_PROSPECTIVE_OWNERS)
    return { status: 'over_capacity', data: { ...coverage, candidateWalletCount: owners.length } }
  if ((await client.getChainId()) !== 1) throw new Error('prospective_mainnet_required')
  const block = await client.getBlock({ blockTag: 'finalized' })
  if (!block?.number || !block?.hash || !isRecentPinnedBlock(block.timestamp, now))
    throw new Error('prospective_finalized_block_unavailable')
  if (block.number < BigInt(coverage.throughBlock))
    throw new Error('prospective_finalized_block_before_source')
  const sourceTime = Date.parse(coverage.throughBlockTime)
  if (
    !Number.isFinite(sourceTime) ||
    Number(block.timestamp) * 1000 - sourceTime > MAX_SOURCE_LAG_SECONDS * 1000
  )
    return { status: 'source_stale', data: null }
  const blockNumber = block.number
  const [asset, decimals, debtToken] = await Promise.all([
    client.readContract({ address: SGHO, abi: vaultAbi, functionName: 'asset', blockNumber }),
    client.readContract({ address: GHO, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    readGhoVariableDebtToken(client, blockNumber),
  ])
  if (String(asset).toLowerCase() !== GHO || Number(decimals) !== 18)
    throw new Error('prospective_vault_identity_mismatch')
  let next = 0
  let complete = 0
  let unknown = 0
  let sum = 0n
  async function worker() {
    while (next < owners.length) {
      const owner = owners[next++]
      try {
        const [debt, shares] = await Promise.all([
          client.readContract({
            address: debtToken,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [owner],
            blockNumber,
          }),
          client.readContract({
            address: SGHO,
            abi: vaultAbi,
            functionName: 'balanceOf',
            args: [owner],
            blockNumber,
          }),
        ])
        const holding = uint(
          await client.readContract({
            address: SGHO,
            abi: vaultAbi,
            functionName: 'convertToAssets',
            args: [uint(shares)],
            blockNumber,
          }),
        )
        const debtAmount = uint(debt)
        sum += debtAmount < holding ? debtAmount : holding
        complete++
      } catch {
        unknown++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, owners.length) }, () => worker()))
  const status = unknown === 0 ? 'ok' : 'incomplete'
  return {
    status,
    block: blockNumber.toString(),
    observedAt: new Date(Number(block.timestamp) * 1000).toISOString(),
    data: {
      measurement:
        'lesser_of_current_aave_gho_variable_debt_and_sgho_holding_per_event_observed_borrower',
      caveat:
        'Same-wallet overlap does not prove borrowed GHO was deposited in sGHO or establish route-attributed TVL.',
      ...coverage,
      blockHash: block.hash.toLowerCase(),
      borrowAsset: GHO,
      destination: SGHO,
      variableDebtToken: debtToken,
      candidateWalletCount: owners.length,
      completeWalletCount: complete,
      unknownWalletCount: unknown,
      matchedRaw: status === 'ok' ? sum.toString() : null,
      matchedGho: status === 'ok' ? Number(formatUnits(sum, 18)) : null,
    },
  }
}
