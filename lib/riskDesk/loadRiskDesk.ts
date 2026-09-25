// Chain reads for the risk desk. Read-only; one snapshot pinned to one block
// so every section's "block N" stamp is the same, true block.
import { createPublicClient, http, type PublicClient } from 'viem'
import { anvil } from 'viem/chains'

import addresses from '@/config/evm/addresses.json'
import { auctionAbi, collateralAbi, liqQueueAbi, ltvDiscoAbi, revenueDistributorAbi, transmuterAbi } from './abis'
import {
  decodeDenom,
  historyRows,
  waterfallRows,
  type Glide,
  type GlideLog,
  type HistoryRow,
  type WaterfallRow,
} from './riskLogic'

export const LOCAL_CHAIN_ID = 31337
export const LOCAL_RPC_URL = process.env.NEXT_PUBLIC_LOCAL_RPC_URL || 'http://127.0.0.1:8545'

type Addr = `0x${string}`
export type RiskDeskAddresses = {
  collateral: Addr
  ltvDisco: Addr
  revenueDistributor: Addr
  transmuter: Addr
  liqQueue: Addr
  auction: Addr
}

export function localAddresses(): RiskDeskAddresses {
  const a = (addresses as Record<string, Record<string, string>>)[String(LOCAL_CHAIN_ID)]
  if (!a) throw new Error('config/evm/addresses.json has no 31337 entry')
  const pick = (k: keyof RiskDeskAddresses) => {
    const v = a[k]
    if (!v) throw new Error(`addresses.json[31337].${k} missing`)
    return v as Addr
  }
  return {
    collateral: pick('collateral'),
    ltvDisco: pick('ltvDisco'),
    revenueDistributor: pick('revenueDistributor'),
    transmuter: pick('transmuter'),
    liqQueue: pick('liqQueue'),
    auction: pick('auction'),
  }
}

let _client: PublicClient | null = null
export function riskDeskClient(rpcUrl = LOCAL_RPC_URL): PublicClient {
  // No multicall: a fresh anvil has no Multicall3. JSON-RPC batching instead.
  if (!_client) _client = createPublicClient({ chain: anvil, transport: http(rpcUrl, { batch: true }) }) as PublicClient
  return _client
}

export type AssetDesk = {
  denom: `0x${string}`
  symbol: string
  cap: bigint
  tempLtv: bigint
  onboardingWindowEnd: bigint
  current: bigint
  target: bigint
  pendingMove: bigint
  glide: Glide
  disco: { totalMbrn: bigint; totalVt: bigint; assetFloor: bigint; average: bigint }
  history: HistoryRow[]
  waterfall: WaterfallRow[]
  split: { disco: bigint; junior: bigint; senior: bigint; reserve: bigint }
  pendingRevenue: bigint
  liqQueueBids: bigint
  auction: { active: boolean; mbrnAllocated: bigint; mbrnUsed: bigint; cdtBadDebt: bigint; cdtFulfilled: bigint }
}

export type RiskDeskSnapshot = {
  chainId: number
  block: bigint
  blockTime: bigint
  addresses: RiskDeskAddresses
  discoOracle: Addr
  assets: AssetDesk[]
}

export async function loadRiskDesk(client: PublicClient = riskDeskClient(), addrs = localAddresses()): Promise<RiskDeskSnapshot> {
  const head = await client.getBlock()
  const blockNumber = head.number
  const at = { blockNumber } as const
  const rd = <T>(p: Promise<T>) => p

  const [denoms, discoOracle, reserve, split, hole] = await Promise.all([
    client.readContract({ address: addrs.collateral, abi: collateralAbi, functionName: 'assetList', ...at }),
    client.readContract({ address: addrs.collateral, abi: collateralAbi, functionName: 'discoOracle', ...at }),
    client.readContract({ address: addrs.revenueDistributor, abi: revenueDistributorAbi, functionName: 'reserveAccumulation', ...at }),
    client.readContract({ address: addrs.revenueDistributor, abi: revenueDistributorAbi, functionName: 'revenueSplit', ...at }),
    client.readContract({ address: addrs.transmuter, abi: transmuterAbi, functionName: 'totalOutstandingHole', ...at }),
  ])
  const splitObj = { disco: split[0], junior: split[1], senior: split[2], reserve: split[3] }

  const logs = await client.getContractEvents({
    address: addrs.collateral,
    abi: collateralAbi,
    eventName: 'LtvGlideUpdated',
    fromBlock: 0n,
    toBlock: blockNumber,
  })
  const blockTimes = new Map<bigint, bigint>()
  await Promise.all(
    [...new Set(logs.map((l) => l.blockNumber!))].map(async (bn) => {
      const b = await client.getBlock({ blockNumber: bn })
      blockTimes.set(bn, b.timestamp)
    }),
  )

  const assets = await Promise.all(
    denoms.map(async (denom): Promise<AssetDesk> => {
      const c = { address: addrs.collateral, abi: collateralAbi, args: [denom] as const, ...at }
      const d = { address: addrs.ltvDisco, abi: ltvDiscoAbi, args: [denom] as const, ...at }
      const [params, current, target, pendingMove, glide, totalMbrn, totalVt, assetFloor, average, pendingRevenue, junior, senior, bids, alloc, active] =
        await Promise.all([
          rd(client.readContract({ ...c, functionName: 'assets' })),
          rd(client.readContract({ ...c, functionName: 'currentMaxLTV' })),
          rd(client.readContract({ ...c, functionName: 'targetMaxLTV' })),
          rd(client.readContract({ ...c, functionName: 'pendingLtvMove' })),
          rd(client.readContract({ ...c, functionName: 'ltvGlideOf' })),
          rd(client.readContract({ ...d, functionName: 'assetTotalMbrn' })),
          rd(client.readContract({ ...d, functionName: 'assetTotalVT' })),
          rd(client.readContract({ ...d, functionName: 'assetLtvSupplyFloor' })),
          rd(client.readContract({ ...d, functionName: 'queryAverageLTV' })),
          rd(client.readContract({ address: addrs.revenueDistributor, abi: revenueDistributorAbi, functionName: 'epochRevenueAccumulation', args: [denom], ...at })),
          rd(client.readContract({ address: addrs.transmuter, abi: transmuterAbi, functionName: 'trancheStates', args: [denom, true], ...at })),
          rd(client.readContract({ address: addrs.transmuter, abi: transmuterAbi, functionName: 'trancheStates', args: [denom, false], ...at })),
          rd(client.readContract({ address: addrs.liqQueue, abi: liqQueueAbi, functionName: 'totalBidSupply', args: [denom], ...at })),
          rd(client.readContract({ address: addrs.auction, abi: auctionAbi, functionName: 'getAllocation', args: [denom], ...at })),
          rd(client.readContract({ address: addrs.auction, abi: auctionAbi, functionName: 'isAllocationActive', args: [denom], ...at })),
        ])

      const assetLogs: GlideLog[] = logs
        .filter((l) => l.args.denom?.toLowerCase() === denom.toLowerCase())
        .map((l) => ({
          blockNumber: l.blockNumber!,
          logIndex: l.logIndex!,
          txHash: l.transactionHash!,
          applied: l.args.applied!,
          committed: l.args.committed!,
          windowStart: l.args.windowStart!,
        }))

      return {
        denom,
        symbol: decodeDenom(denom),
        cap: params[6],
        tempLtv: params[1],
        onboardingWindowEnd: params[5],
        current,
        target,
        pendingMove,
        glide: { applied: glide.applied, committed: glide.committed, windowStart: glide.windowStart, seeded: glide.seeded },
        disco: { totalMbrn, totalVt, assetFloor, average },
        history: historyRows(assetLogs, blockTimes),
        waterfall: waterfallRows({
          reserve,
          pendingRevenue,
          split: splitObj,
          discoMbrn: totalMbrn,
          juniorStaked: junior[1],
          seniorStaked: senior[1],
          outstandingHole: hole,
        }),
        split: splitObj,
        pendingRevenue,
        liqQueueBids: bids,
        auction: { active, mbrnAllocated: alloc.mbrnAllocated, mbrnUsed: alloc.mbrnUsed, cdtBadDebt: alloc.cdtBadDebt, cdtFulfilled: alloc.cdtFulfilled },
      }
    }),
  )

  return { chainId: LOCAL_CHAIN_ID, block: blockNumber, blockTime: head.timestamp, addresses: addrs, discoOracle, assets }
}
