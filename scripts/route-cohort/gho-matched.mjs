import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeEventLog, formatUnits, isAddress, parseAbiItem } from 'viem'

import { GHO_SGHO } from '../route-rates/exact-leg-spread.mjs'

export const PILOT_ROUTE = 'GHO → sGho [GHO]'
export const PILOT_SOURCE_SHA256 =
  'a0aee85535cb4c96f09d2f3bce3af3d2bcc9d1e2ee0156e24265111263c4cf63'
export const PILOT_MANIFEST_SHA256 =
  '356a0fb2d8f9762d706423a051ed3a8fcf2c2d81f2718e71c36f634f0a534280'
export const PILOT_MANIFEST_FILE_SHA256 =
  '6d02cfdf3b29419897fc580417794efa9e0e69e3b2a3fb456ef95c03aea30d29'
export const PILOT_CADENCE_MS = 24 * 60 * 60 * 1000
export const MAX_PINNED_BLOCK_AGE_MS = 2 * 60 * 60 * 1000
const GHO = GHO_SGHO.borrowAsset.toLowerCase()
const POOL = GHO_SGHO.borrowMarket.toLowerCase()
const VAULT = GHO_SGHO.destination.toLowerCase()
const BORROW_EVENT = parseAbiItem(
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
)
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
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
]

const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
const wordAddress = (word) => `0x${word.slice(24)}`
const blockTag = (block) => `0x${BigInt(block).toString(16)}`
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function isPilotKindDue(rows, kind, now = Date.now()) {
  if (
    !['matched_capital', 'destination_tvl', 'prospective_overlap'].includes(kind) ||
    !Number.isFinite(now)
  ) {
    throw new Error('pilot_cadence_invalid')
  }
  const row = rows.find((entry) => entry.kind === kind && entry.route_key === PILOT_ROUTE)
  const recorded = row ? new Date(row.recorded_at).getTime() : NaN
  return !Number.isFinite(recorded) || now - recorded >= PILOT_CADENCE_MS
}

export function isRecentPinnedBlock(timestampSeconds, now = Date.now()) {
  const sampled = Number(timestampSeconds) * 1000
  const age = now - sampled
  return (
    Number.isFinite(sampled) &&
    Number.isFinite(age) &&
    age >= -120_000 &&
    age <= MAX_PINNED_BLOCK_AGE_MS
  )
}

/** The archived rows have market:null. Borrow receipt logs are required to prove the Pool. */
export function validateObservedGhoSeed(raw, seed, expectedSourceSha256 = PILOT_SOURCE_SHA256) {
  const hash = createHash('sha256').update(raw).digest('hex')
  if (
    hash !== expectedSourceSha256 ||
    seed.source?.sha256 !== hash ||
    seed.source.name !== 'routes_ab.json'
  ) {
    throw new Error('pilot_source_hash_mismatch')
  }
  const routes = JSON.parse(raw)
  if (!Array.isArray(routes)) throw new Error('pilot_source_invalid')
  const observed = routes.filter((row) => row.route === PILOT_ROUTE)
  if (observed.length !== 20 || seed.positions.length !== 20)
    throw new Error('pilot_cohort_count_mismatch')
  const expected = new Set(
    seed.positions.map(
      (position) => `${position.owner.toLowerCase()}:${position.vault.toLowerCase()}`,
    ),
  )
  const seen = new Set()
  for (const row of observed) {
    if (
      row.proto !== 'Aave V3' ||
      !eq(row.asset, GHO) ||
      !eq(row.dest, VAULT) ||
      row.destKind !== 'vault' ||
      row.market !== null ||
      !isAddress(row.borrower, { strict: false }) ||
      !/^0x[0-9a-fA-F]{64}$/.test(row.tx || '') ||
      !Number.isSafeInteger(row.block)
    )
      throw new Error('pilot_route_identity_mismatch')
    const key = `${row.borrower.toLowerCase()}:${row.dest.toLowerCase()}`
    if (!expected.has(key) || seen.has(key)) throw new Error('pilot_seed_identity_mismatch')
    seen.add(key)
  }
  if (seen.size !== expected.size) throw new Error('pilot_seed_identity_mismatch')
  return observed
}

export function buildPilotManifest(raw, seed, seedHash) {
  const observations = validateObservedGhoSeed(raw, seed)
  const body = {
    schemaVersion: 1,
    sourceSha256: PILOT_SOURCE_SHA256,
    seedHash,
    borrowMarket: POOL,
    borrowAsset: GHO,
    destination: VAULT,
    observations: observations.map(
      ({ borrower, block, tx, asset, dest, destKind, market, proto }) => ({
        borrower,
        block,
        tx,
        asset,
        dest,
        destKind,
        market,
        proto,
      }),
    ),
  }
  return { ...body, manifestSha256: sha256(JSON.stringify(body)) }
}

export function validatePilotManifest(
  manifest,
  seed,
  seedHash,
  expectedManifestSha256 = PILOT_MANIFEST_SHA256,
) {
  const { manifestSha256, ...body } = manifest ?? {}
  if (
    manifestSha256 !== expectedManifestSha256 ||
    sha256(JSON.stringify(body)) !== expectedManifestSha256 ||
    body.schemaVersion !== 1 ||
    body.sourceSha256 !== PILOT_SOURCE_SHA256 ||
    body.seedHash !== seedHash ||
    seed.source?.sha256 !== PILOT_SOURCE_SHA256 ||
    body.borrowMarket !== POOL ||
    body.borrowAsset !== GHO ||
    body.destination !== VAULT ||
    !Array.isArray(body.observations) ||
    body.observations.length !== 20 ||
    seed.positions.length !== 20
  )
    throw new Error('pilot_manifest_identity_mismatch')
  const expected = new Set(
    seed.positions.map(
      (position) => `${position.owner.toLowerCase()}:${position.vault.toLowerCase()}`,
    ),
  )
  const seen = new Set()
  for (const row of body.observations) {
    const key = `${String(row.borrower).toLowerCase()}:${String(row.dest).toLowerCase()}`
    if (
      !expected.has(key) ||
      seen.has(key) ||
      row.proto !== 'Aave V3' ||
      !eq(row.asset, GHO) ||
      !eq(row.dest, VAULT) ||
      row.destKind !== 'vault' ||
      row.market !== null ||
      !/^0x[0-9a-fA-F]{64}$/.test(row.tx || '') ||
      !Number.isSafeInteger(row.block)
    )
      throw new Error('pilot_manifest_observation_mismatch')
    seen.add(key)
  }
  if (seen.size !== expected.size) throw new Error('pilot_manifest_observation_mismatch')
  return body.observations
}

export function parsePinnedPilotManifest(raw, seed, seedHash) {
  if (sha256(raw) !== PILOT_MANIFEST_FILE_SHA256)
    throw new Error('pilot_manifest_file_hash_mismatch')
  return validatePilotManifest(JSON.parse(raw), seed, seedHash)
}

function validBorrowLog(log, row) {
  if (!eq(log.address, POOL)) return false
  try {
    const event = decodeEventLog({ abi: [BORROW_EVENT], data: log.data, topics: log.topics })
    return (
      event.eventName === 'Borrow' &&
      eq(event.args.reserve, GHO) &&
      eq(event.args.onBehalfOf, row.borrower) &&
      event.args.amount > 0n &&
      Number(event.args.interestRateMode) === 2
    )
  } catch {
    return false
  }
}

export async function attestAaveBorrowReceipts(client, observations) {
  const proofs = []
  for (const row of observations) {
    const receipt = await client.getTransactionReceipt({ hash: row.tx })
    if (receipt.status !== 'success' || BigInt(receipt.blockNumber) !== BigInt(row.block)) {
      throw new Error('pilot_borrow_receipt_mismatch')
    }
    const log = receipt.logs.find((entry) => validBorrowLog(entry, row))
    if (!log) throw new Error('pilot_aave_pool_borrow_unproved')
    proofs.push({
      tx: row.tx,
      block: row.block,
      address: log.address,
      topics: log.topics,
      data: log.data,
    })
  }
  return {
    checked: observations.length,
    borrowMarket: POOL,
    borrowAsset: GHO,
    destination: VAULT,
    proofs,
  }
}

/** Immutable local receipts; a new source/seed/exact leg gets a different key. */
export async function loadOrAttestAaveBorrowReceipts(client, observations, seedHash, cacheDir) {
  if (!/^[a-f0-9]{64}$/.test(seedHash)) throw new Error('pilot_seed_hash_invalid')
  const observationHash = sha256(JSON.stringify(observations))
  const key = sha256(
    `${PILOT_SOURCE_SHA256}:${seedHash}:${POOL}:${GHO}:${VAULT}:${observationHash}`,
  )
  const path = join(cacheDir, `gho-sgho-borrow-attestation-${key}.json`)
  let cached
  try {
    cached = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (!cached) {
    const attested = await attestAaveBorrowReceipts(client, observations)
    cached = {
      schemaVersion: 1,
      sourceSha256: PILOT_SOURCE_SHA256,
      seedHash,
      observationHash,
      ...attested,
    }
    await mkdir(cacheDir, { recursive: true })
    try {
      await writeFile(path, `${JSON.stringify(cached)}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      cached = JSON.parse(await readFile(path, 'utf8'))
    }
  }
  if (
    cached.schemaVersion !== 1 ||
    cached.sourceSha256 !== PILOT_SOURCE_SHA256 ||
    cached.seedHash !== seedHash ||
    cached.observationHash !== observationHash ||
    cached.borrowMarket !== POOL ||
    cached.borrowAsset !== GHO ||
    cached.destination !== VAULT ||
    cached.checked !== observations.length ||
    !Array.isArray(cached.proofs) ||
    cached.proofs.length !== observations.length ||
    cached.proofs.some(
      (proof, i) =>
        proof.tx !== observations[i].tx ||
        proof.block !== observations[i].block ||
        !validBorrowLog(proof, observations[i]),
    )
  ) {
    throw new Error('pilot_attestation_cache_mismatch')
  }
  return { checked: cached.checked, borrowMarket: POOL, borrowAsset: GHO, destination: VAULT }
}

export async function readGhoVariableDebtToken(client, blockNumber) {
  const encoded = `0x35ea6a75${GHO.slice(2).padStart(64, '0')}`
  const result = await client.request({
    method: 'eth_call',
    params: [{ to: POOL, data: encoded }, blockTag(blockNumber)],
  })
  const words = /^0x(?:[0-9a-fA-F]{64})+$/.test(result || '')
    ? result.slice(2).match(/.{64}/g)
    : null
  if (!words || words.length < 11) throw new Error('pilot_reserve_data_unavailable')
  const debtToken = wordAddress(words[10]).toLowerCase()
  if (!isAddress(debtToken, { strict: false }) || /^0x0+$/.test(debtToken)) {
    throw new Error('pilot_debt_token_invalid')
  }
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
  if (!eq(underlying, GHO) || !eq(pool, POOL) || Number(decimals) !== 18) {
    throw new Error('pilot_debt_token_identity_mismatch')
  }
  return debtToken
}

export async function readDestinationVaultTvl(client, blockNumber) {
  const [asset, decimals, assets, cash, paused] = await Promise.all([
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'asset', blockNumber }),
    client.readContract({ address: GHO, abi: erc20Abi, functionName: 'decimals', blockNumber }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'totalAssets',
      blockNumber,
    }),
    client.readContract({
      address: GHO,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [VAULT],
      blockNumber,
    }),
    client.readContract({
      address: VAULT,
      abi: vaultAbi,
      functionName: 'paused',
      blockNumber,
    }),
  ])
  if (
    !eq(asset, GHO) ||
    Number(decimals) !== 18 ||
    typeof assets !== 'bigint' ||
    assets < 0n ||
    typeof cash !== 'bigint' ||
    cash < 0n ||
    typeof paused !== 'boolean'
  ) {
    throw new Error('pilot_destination_tvl_unavailable')
  }
  return {
    measurement: 'destination_vault_total_assets_all_depositors',
    destination: VAULT,
    asset: GHO,
    assetDecimals: 18,
    totalAssetsRaw: assets.toString(),
    totalAssetsGho: Number(formatUnits(assets, 18)),
    vaultCashRaw: cash.toString(),
    vaultCashGho: Number(formatUnits(cash, 18)),
    withdrawalsPaused: paused,
    vaultCashMeaning:
      'GHO balance held by sGHO vault; a vault-side redemption bound also requires totalAssets and paused status, not any wallet maxRedeem or an execution guarantee',
    usdEstimate: Number(formatUnits(assets, 18)),
    usdAssumption: 'GHO valued at $1; estimate, not an independent USD price',
  }
}

/** Whole sGHO read from one host agreeing with the saved finalized header. */
export async function readDestinationVaultTvlWithWitness(clients, block) {
  if (!Array.isArray(clients) || !block?.number || !/^0x[0-9a-fA-F]{64}$/.test(block.hash)) {
    throw new Error('sgho_source_block_invalid')
  }
  const expectedHash = block.hash.toLowerCase()
  for (const client of clients) {
    try {
      if ((await client.getChainId()) !== 1) continue
      const before = await client.getBlock({ blockNumber: block.number })
      if (before?.hash?.toLowerCase() !== expectedHash) continue
      const data = await readDestinationVaultTvl(client, block.number)
      const after = await client.getBlock({ blockNumber: block.number })
      if (after?.hash?.toLowerCase() !== expectedHash) continue
      return data
    } catch {
      // Never forward provider errors: they can contain credential-bearing URLs.
    }
  }
  throw new Error('sgho_single_host_read_unavailable')
}

export async function readMatchedGhoCapital(client, snapshot, debtToken, attestation) {
  const blockNumber = BigInt(snapshot.blockNumber)
  const rows = await Promise.all(
    snapshot.positions.map(async (position) => {
      if (
        position.status !== 'ok' ||
        !eq(position.assetAddress, GHO) ||
        position.assetDecimals !== 18 ||
        !/^\d+$/.test(position.assetBalanceRaw || '')
      ) {
        return {
          owner: position.owner,
          status: 'unknown',
          debtRaw: null,
          holdingRaw: position.assetBalanceRaw ?? null,
          matchedRaw: null,
        }
      }
      try {
        const debt = await client.readContract({
          address: debtToken,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [position.owner],
          blockNumber,
        })
        if (typeof debt !== 'bigint' || debt < 0n) throw new Error('invalid debt')
        const holding = BigInt(position.assetBalanceRaw)
        return {
          owner: position.owner,
          status: 'ok',
          debtRaw: debt.toString(),
          holdingRaw: holding.toString(),
          matchedRaw: (debt < holding ? debt : holding).toString(),
        }
      } catch {
        return {
          owner: position.owner,
          status: 'unknown',
          debtRaw: null,
          holdingRaw: position.assetBalanceRaw,
          matchedRaw: null,
        }
      }
    }),
  )
  const complete = rows.length === 20 && rows.every((row) => row.status === 'ok')
  const sum = complete ? rows.reduce((value, row) => value + BigInt(row.matchedRaw), 0n) : null
  return {
    status: complete ? 'ok' : 'incomplete',
    data: {
      measurement: 'lesser_of_current_aave_gho_debt_and_sgho_holding_per_august_observed_wallet',
      caveat:
        'Same-wallet debt/holding overlap is not route-attributed TVL: GHO is fungible and new entrants are not discovered.',
      sourceSha256: PILOT_SOURCE_SHA256,
      seedHash: snapshot.seedHash,
      blockHash: snapshot.blockHash,
      borrowMarket: attestation.borrowMarket,
      borrowAsset: GHO,
      variableDebtToken: debtToken,
      destination: VAULT,
      receiptProofCount: attestation.checked,
      observedWalletCount: rows.length,
      completeWalletCount: rows.filter((row) => row.status === 'ok').length,
      unknownWalletCount: rows.filter((row) => row.status !== 'ok').length,
      matchedRaw: sum?.toString() ?? null,
      matchedGho: sum === null ? null : Number(formatUnits(sum, 18)),
      rows,
    },
  }
}
