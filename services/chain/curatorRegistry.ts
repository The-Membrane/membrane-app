import type { PublicClient } from 'viem'

import { getContractAddress, type Address } from '@/config/evm/contracts'
import { curatorRegistryAbi, CURATOR_HISTORY_EVENTS } from '@/lib/evm/abis/curatorRegistry'
import {
  eventToHistoryRow,
  logsForVault,
  slashCounts,
  sortNewestFirst,
  sumBig,
  type CuratorEventName,
  type CuratorLog,
  type HistoryRow,
} from '@/lib/curators/curatorLogic'

/**
 * CuratorRegistry.sol read service. Service contract (services/chain/README.md):
 * return null on failure, never throw; works with no wallet. Every read is pinned to
 * one block so a table row and its stamp describe the same chain state.
 *
 * Event history scans from NEXT_PUBLIC_CURATOR_REGISTRY_FROM_BLOCK (default 0 — a
 * local anvil deploy). Set it to the deploy block before pointing at mainnet.
 */

const FROM_BLOCK = BigInt(process.env.NEXT_PUBLIC_CURATOR_REGISTRY_FROM_BLOCK ?? '0')

export function curatorRegistryAddress(client: PublicClient, override?: Address): Address | undefined {
  return override ?? (client.chain ? getContractAddress(client.chain.id, 'curatorRegistry') : undefined)
}

export interface CuratorVaultRow {
  vault: Address
  /** CDT wei. */
  bond: bigint
  /** CDT wei. */
  aumCap: bigint
  /** WAD fraction of the 90-day clock. */
  ramp: bigint
  /** WAD per year. */
  realizedRate: bigint
  bucket: bigint
  /** CDT wei, trailing 30 days. */
  trailingPayments: bigint
  /** CDT wei. */
  trackedAum: bigint
  pendingUnbond: { active: boolean; newCap: bigint; readyTime: bigint }
  slashCount: number
}

export interface CuratorSnapshot {
  chainId: number
  registry: Address
  blockNumber: bigint
  /** Read directly: CuratorRegistry.totalBonded. */
  totalBonded: bigint
  /** Σ trackedAum over allVaults (the registry keeps no running total). */
  totalTrackedAum: bigint
  rows: CuratorVaultRow[]
  logs: CuratorLog[]
}

async function readRow(
  client: PublicClient,
  registry: Address,
  vault: Address,
  blockNumber: bigint,
  slashes: Map<string, number>,
): Promise<CuratorVaultRow> {
  const call = <T>(functionName: string) =>
    client.readContract({
      address: registry,
      abi: curatorRegistryAbi,
      functionName: functionName as never,
      args: [vault] as never,
      blockNumber,
    }) as Promise<T>
  const [bond, aumCap, ramp, realizedRate, bucket, trailingPayments, trackedAum, pending] = await Promise.all([
    call<bigint>('bondOf'),
    call<bigint>('aumCap'),
    call<bigint>('rampOf'),
    call<bigint>('realizedRate'),
    call<bigint>('bucketOf'),
    call<bigint>('trailingPayments'),
    call<bigint>('trackedAum'),
    call<readonly [boolean, bigint, bigint]>('pendingUnbond'),
  ])
  return {
    vault,
    bond,
    aumCap,
    ramp,
    realizedRate,
    bucket,
    trailingPayments,
    trackedAum,
    pendingUnbond: { active: pending[0], newCap: pending[1], readyTime: BigInt(pending[2]) },
    slashCount: slashes.get(vault.toLowerCase()) ?? 0,
  }
}

async function readLogs(client: PublicClient, registry: Address, toBlock: bigint): Promise<CuratorLog[]> {
  const events = curatorRegistryAbi.filter(
    (e) => e.type === 'event' && (CURATOR_HISTORY_EVENTS as readonly string[]).includes(e.name),
  )
  const logs = await client.getLogs({ address: registry, events: events as never, fromBlock: FROM_BLOCK, toBlock })
  return (logs as unknown as Array<{
    eventName: CuratorEventName
    args: Record<string, unknown>
    blockNumber: bigint
    logIndex: number
    transactionHash?: string
  }>).map((l) => ({
    eventName: l.eventName,
    args: l.args,
    blockNumber: l.blockNumber,
    logIndex: l.logIndex,
    txHash: l.transactionHash,
  }))
}

/** Every listed vault with its figures, pinned to the latest block. */
export async function getCuratorSnapshot(
  client: PublicClient | null,
  registryOverride?: Address,
): Promise<CuratorSnapshot | null> {
  if (!client) return null
  const registry = curatorRegistryAddress(client, registryOverride)
  if (!registry) return null
  try {
    const blockNumber = await client.getBlockNumber()
    const base = { address: registry, abi: curatorRegistryAbi, blockNumber } as const
    const [length, totalBonded, logs] = await Promise.all([
      client.readContract({ ...base, functionName: 'allVaultsLength' }),
      client.readContract({ ...base, functionName: 'totalBonded' }),
      readLogs(client, registry, blockNumber),
    ])
    const vaults = await Promise.all(
      Array.from({ length: Number(length) }, (_, i) =>
        client.readContract({ ...base, functionName: 'allVaults', args: [BigInt(i)] }),
      ),
    )
    const slashes = slashCounts(logs)
    const rows = await Promise.all(vaults.map((v) => readRow(client, registry, v, blockNumber, slashes)))
    return {
      chainId: client.chain?.id ?? 0,
      registry,
      blockNumber,
      totalBonded,
      totalTrackedAum: sumBig(rows.map((r) => r.trackedAum)),
      rows,
      logs,
    }
  } catch (err) {
    console.error('[curatorRegistry] snapshot read failed', err)
    return null
  }
}

export interface CuratorProfile {
  chainId: number
  registry: Address
  blockNumber: bigint
  row: CuratorVaultRow
  /** False when the address is not in allVaults. */
  listed: boolean
  history: HistoryRow[]
}

/** One vault's figures + its event history (newest first), each with block time. */
export async function getCuratorProfile(
  client: PublicClient | null,
  vault: Address,
  registryOverride?: Address,
): Promise<CuratorProfile | null> {
  const snap = await getCuratorSnapshot(client, registryOverride)
  if (!snap || !client) return null
  try {
    const own = logsForVault(snap.logs, vault)
    const slashes = slashCounts(own)
    const listedRow = snap.rows.find((r) => r.vault.toLowerCase() === vault.toLowerCase())
    const row = listedRow ?? (await readRow(client, snap.registry, vault, snap.blockNumber, slashes))
    const blocks = [...new Set(own.map((l) => l.blockNumber))]
    const times = new Map<bigint, bigint>()
    await Promise.all(
      blocks.map(async (b) => {
        const blk = await client.getBlock({ blockNumber: b })
        times.set(b, blk.timestamp)
      }),
    )
    const history = sortNewestFirst(own.map((l) => eventToHistoryRow(l, times.get(l.blockNumber) ?? null)))
    return {
      chainId: snap.chainId,
      registry: snap.registry,
      blockNumber: snap.blockNumber,
      row,
      listed: Boolean(listedRow),
      history,
    }
  } catch (err) {
    console.error('[curatorRegistry] profile read failed', err)
    return null
  }
}

/** The two inputs BondCoverage's `live` seam takes. */
export async function getBondCoverageInputs(
  client: PublicClient | null,
  registryOverride?: Address,
): Promise<{ totalBonded: bigint; totalAum: bigint; blockNumber: bigint; registry: Address } | null> {
  if (!client) return null
  const registry = curatorRegistryAddress(client, registryOverride)
  if (!registry) return null
  try {
    const blockNumber = await client.getBlockNumber()
    const base = { address: registry, abi: curatorRegistryAbi, blockNumber } as const
    const [length, totalBonded] = await Promise.all([
      client.readContract({ ...base, functionName: 'allVaultsLength' }),
      client.readContract({ ...base, functionName: 'totalBonded' }),
    ])
    const vaults = await Promise.all(
      Array.from({ length: Number(length) }, (_, i) =>
        client.readContract({ ...base, functionName: 'allVaults', args: [BigInt(i)] }),
      ),
    )
    const aums = await Promise.all(
      vaults.map((v) => client.readContract({ ...base, functionName: 'trackedAum', args: [v] })),
    )
    return { totalBonded, totalAum: sumBig(aums), blockNumber, registry }
  } catch (err) {
    console.error('[curatorRegistry] bond coverage read failed', err)
    return null
  }
}
