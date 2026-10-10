import { createHash } from 'node:crypto'
import { formatUnits, isAddress } from 'viem'

const erc4626Abi = [
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
    name: 'asset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
]

const erc20Abi = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
]

const DEFAULT_MAX_POSITIONS = 5_000
const DEFAULT_CONCURRENCY = 4

const positionId = ({ owner, vault }) => `${owner.toLowerCase()}:${vault.toLowerCase()}`

export function normalizeSeed(seed, maxPositions = DEFAULT_MAX_POSITIONS) {
  if (seed?.schemaVersion !== 1 || typeof seed.cohortId !== 'string' || !seed.cohortId.trim()) {
    throw new Error('Seed must have schemaVersion: 1 and a nonempty cohortId')
  }
  if (
    !Array.isArray(seed.positions) ||
    seed.positions.length === 0 ||
    seed.positions.length > maxPositions
  ) {
    throw new Error(`Seed must contain 1–${maxPositions} positions`)
  }

  const seen = new Set()
  const positions = seed.positions.map((position, index) => {
    if (
      !isAddress(position?.owner, { strict: false }) ||
      !isAddress(position?.vault, { strict: false })
    ) {
      throw new Error(`Invalid owner or vault address at position ${index}`)
    }
    if (
      !Array.isArray(position.routeIds) ||
      position.routeIds.length === 0 ||
      position.routeIds.some((route) => typeof route !== 'string' || !route.trim())
    ) {
      throw new Error(`Invalid routeIds at position ${index}`)
    }
    const normalized = {
      owner: position.owner.toLowerCase(),
      vault: position.vault.toLowerCase(),
      routeIds: [...new Set(position.routeIds)].sort(),
    }
    const id = positionId(normalized)
    if (seen.has(id)) throw new Error(`Duplicate owner+vault at position ${index}`)
    seen.add(id)
    return { id, ...normalized }
  })

  const source = seed.source
  if (
    source !== undefined &&
    (typeof source.name !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256))
  ) {
    throw new Error('Seed source must have a name and SHA-256')
  }
  const normalized = {
    schemaVersion: 1,
    cohortId: seed.cohortId,
    ...(source === undefined ? {} : { source: { name: source.name, sha256: source.sha256 } }),
    ...(seed.selection === undefined ? {} : { selection: seed.selection }),
    positions,
  }
  if (
    seed.selection !== undefined &&
    (typeof seed.selection?.routeId !== 'string' || !seed.selection.routeId.trim())
  ) {
    throw new Error('Seed selection must specify a routeId')
  }
  const seedHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
  return { ...normalized, seedHash }
}

async function readField(client, call, field, errors) {
  try {
    return await client.readContract(call)
  } catch {
    errors.push(`${field}_read_failed`)
    return null
  }
}

function isUint(value) {
  return typeof value === 'bigint' && value >= 0n
}

/** A current holder-stock read, not proof that the original borrow remains invested. */
export async function readHolding(client, position, blockNumber, assetMetadata) {
  const errors = []
  const block = { blockNumber }
  const shares = await readField(
    client,
    {
      address: position.vault,
      abi: erc4626Abi,
      functionName: 'balanceOf',
      args: [position.owner],
      ...block,
    },
    'balance',
    errors,
  )
  if (shares !== null && !isUint(shares)) errors.push('balance_invalid')

  const metadata = await assetMetadata(position.vault, blockNumber)
  errors.push(...metadata.errors)

  let assets = null
  if (isUint(shares)) {
    assets = await readField(
      client,
      {
        address: position.vault,
        abi: erc4626Abi,
        functionName: 'convertToAssets',
        args: [shares],
        ...block,
      },
      'convert_to_assets',
      errors,
    )
    if (assets !== null && !isUint(assets)) {
      errors.push('convert_to_assets_invalid')
      assets = null
    }
  }

  return {
    ...position,
    status: errors.length === 0 ? 'ok' : 'unknown',
    shareBalanceRaw: isUint(shares) ? shares.toString() : null,
    assetAddress: metadata.assetAddress,
    assetDecimals: metadata.assetDecimals,
    assetBalanceRaw: isUint(assets) ? assets.toString() : null,
    assetBalance:
      isUint(assets) && metadata.assetDecimals !== null
        ? formatUnits(assets, metadata.assetDecimals)
        : null,
    errors,
  }
}

function makeAssetMetadataReader(client) {
  const memo = new Map()
  return (vault, blockNumber) => {
    const key = `${vault}:${blockNumber}`
    if (!memo.has(key)) {
      memo.set(
        key,
        (async () => {
          const errors = []
          const assetAddress = await readField(
            client,
            { address: vault, abi: erc4626Abi, functionName: 'asset', blockNumber },
            'asset',
            errors,
          )
          if (!isAddress(assetAddress, { strict: false })) {
            if (assetAddress !== null) errors.push('asset_invalid')
            return { assetAddress: null, assetDecimals: null, errors }
          }
          const decimals = await readField(
            client,
            { address: assetAddress, abi: erc20Abi, functionName: 'decimals', blockNumber },
            'asset_decimals',
            errors,
          )
          if (
            decimals === null ||
            !Number.isInteger(Number(decimals)) ||
            Number(decimals) < 0 ||
            Number(decimals) > 36
          ) {
            if (decimals !== null) errors.push('asset_decimals_invalid')
            return { assetAddress, assetDecimals: null, errors }
          }
          return { assetAddress, assetDecimals: Number(decimals), errors }
        })(),
      )
    }
    return memo.get(key)
  }
}

/**
 * Resume uses the saved finalized block, never a new head. Successful rows are
 * skipped; unknown rows are retried. onProgress may atomically persist after
 * each row, so an interrupted process has a restartable checkpoint.
 */
export async function collectSnapshot(client, seedInput, options = {}) {
  const seed = normalizeSeed(seedInput, options.maxPositions)
  const chainId = await client.getChainId()
  if (chainId !== 1) throw new Error(`Ethereum mainnet RPC required; received chain ID ${chainId}`)
  const existing = options.snapshot
  let snapshot
  if (existing) {
    if (
      existing.schemaVersion !== 1 ||
      existing.seedHash !== seed.seedHash ||
      existing.cohortId !== seed.cohortId ||
      !/^\d+$/.test(existing.blockNumber) ||
      existing.chainId !== 1 ||
      !Array.isArray(existing.positions)
    ) {
      throw new Error('Checkpoint does not match seed or snapshot schema')
    }
    snapshot = { ...existing, positions: [...existing.positions] }
  } else {
    const block = await client.getBlock({ blockTag: 'finalized' })
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint' || !block.hash) {
      throw new Error('Finalized block was incomplete; no snapshot written')
    }
    snapshot = {
      schemaVersion: 1,
      cohortId: seed.cohortId,
      seedHash: seed.seedHash,
      source: seed.source ?? null,
      selection: seed.selection ?? null,
      measurement: 'current_erc4626_holder_stock_not_route_attributed_tvl',
      cohortCoverage: 'fixed_seed_no_new_entrant_discovery',
      seedPositionCount: seed.positions.length,
      chainId: 1,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      asOf: new Date(Number(block.timestamp) * 1000).toISOString(),
      startedAt: new Date().toISOString(),
      positions: [],
    }
    await options.onProgress?.(snapshot)
  }

  const allowed = new Set(seed.positions.map((position) => position.id))
  if (
    snapshot.positions.some((position) => !allowed.has(position.id)) ||
    new Set(snapshot.positions.map((position) => position.id)).size !== snapshot.positions.length
  ) {
    throw new Error('Checkpoint contains unexpected or duplicate positions')
  }
  const rows = new Map(snapshot.positions.map((position) => [position.id, position]))
  const pending = seed.positions.filter((position) => rows.get(position.id)?.status !== 'ok')
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('Concurrency must be between 1 and 16')
  }
  const blockNumber = BigInt(snapshot.blockNumber)
  const assetMetadata = makeAssetMetadataReader(client)
  let next = 0
  let persist = Promise.resolve()
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (next < pending.length) {
      const position = pending[next++]
      const holding = await readHolding(client, position, blockNumber, assetMetadata)
      rows.set(position.id, holding)
      // Serialize callbacks and their snapshot views even with parallel reads.
      persist = persist.then(async () => {
        snapshot.positions = seed.positions.map((entry) => rows.get(entry.id)).filter(Boolean)
        await options.onProgress?.(snapshot)
      })
      await persist
    }
  })
  await Promise.all(workers)
  snapshot.positions = seed.positions.map((entry) => rows.get(entry.id)).filter(Boolean)
  snapshot.complete =
    snapshot.positions.length === seed.positions.length &&
    snapshot.positions.every((position) => position.status === 'ok')
  snapshot.okCount = snapshot.positions.filter((position) => position.status === 'ok').length
  snapshot.unknownCount = snapshot.positions.filter(
    (position) => position.status === 'unknown',
  ).length
  await options.onProgress?.(snapshot)
  return snapshot
}
