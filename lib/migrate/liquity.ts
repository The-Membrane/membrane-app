/**
 * A minimal Liquity V1 trove reader (mainnet), so a trove reaches the migrate seam in the same
 * shape the simulator adapters return. READ-ONLY. Addresses checked on-chain 2026-10-25 via
 * ethereum-rpc.publicnode.com: TroveManager.borrowerOperationsAddress() == BorrowerOperations,
 * TroveManager.priceFeed() == PriceFeed, TroveManager.lusdToken() == LUSD.
 *
 * NOT READ: Liquity V2 (BOLD). V2 troves are per-branch NFTs; finding a wallet's troves needs
 * the TroveNFT ownership index per branch, which this reader does not do yet.
 *
 * Every number is read: entire debt and collateral (pending redistribution rewards included,
 * TroveManager.getEntireDebtAndColl), the price is PriceFeed.lastGoodPrice. The liquidation
 * line is Liquity V1's MCR (110%, LiquityBase.MCR = 1.1e18) expressed as an LTV: 1 / 1.1.
 * A trove has no borrow APR (one-off fee), so borrowApr is null.
 */

import { parseAbi, type PublicClient } from 'viem'

import { stamp } from '@/lib/position-sim/types'

import type { Address, MigrateSource } from './types'

export const LIQUITY_V1 = {
  troveManager: '0xA39739EF8b0231DBFA0DcdA07d7e29faAbCf4bb2',
  borrowerOperations: '0x24179CD81c9e782A4096035f7eC97fB8B783e007',
  priceFeed: '0x4c517D4e2C851CA76d7eC94B805269Df0f2201De',
  lusd: '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0',
} as const

/** LiquityBase.MCR = 1100000000000000000 (110%). */
export const LIQUITY_V1_MCR = 1.1

const troveManagerAbi = parseAbi([
  'function getTroveStatus(address borrower) view returns (uint256)',
  'function getEntireDebtAndColl(address borrower) view returns (uint256 debt, uint256 coll, uint256 pendingLUSDDebtReward, uint256 pendingETHReward)',
])
const priceFeedAbi = parseAbi(['function lastGoodPrice() view returns (uint256)'])

/** TroveManager.Status: 0 nonExistent, 1 active, 2 closedByOwner, 3 closedByLiquidation, 4 closedByRedemption. */
const ACTIVE = 1n

const wad = (v: bigint): number => Number(v / 10n ** 9n) / 1e9

export async function readLiquityV1Trove(client: PublicClient, owner: Address): Promise<MigrateSource | null> {
  const status = await client.readContract({
    address: LIQUITY_V1.troveManager,
    abi: troveManagerAbi,
    functionName: 'getTroveStatus',
    args: [owner],
  })
  if (status !== ACTIVE) return null
  const [[debt, coll], price] = await Promise.all([
    client.readContract({ address: LIQUITY_V1.troveManager, abi: troveManagerAbi, functionName: 'getEntireDebtAndColl', args: [owner] }),
    client.readContract({ address: LIQUITY_V1.priceFeed, abi: priceFeedAbi, functionName: 'lastGoodPrice' }),
  ])
  return troveToSource(owner, debt, coll, price)
}

/** Pure conversion, exported for tests. */
export function troveToSource(owner: Address, debtWei: bigint, collWei: bigint, priceWad: bigint): MigrateSource {
  const ethAmount = wad(collWei)
  const ethPrice = wad(priceWad)
  const lusd = wad(debtWei)
  const collUsd = ethAmount * ethPrice
  const liquidationLtv = 1 / LIQUITY_V1_MCR
  const ltv = collUsd > 0 ? lusd / collUsd : Number.POSITIVE_INFINITY
  return {
    protocol: 'liquity',
    label: 'Liquity V1 · ETH/LUSD',
    owner,
    collateral: [
      {
        symbol: 'ETH',
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        amount: ethAmount,
        priceUsd: ethPrice,
        valueUsd: collUsd,
        liquidationThreshold: liquidationLtv,
        maxLtv: liquidationLtv,
        liquidationBonus: null,
      },
    ],
    debt: [{ symbol: 'LUSD', address: LIQUITY_V1.lusd, decimals: 18, amount: lusd, priceUsd: 1, valueUsd: lusd, borrowApr: null }],
    totalCollateralUsd: collUsd,
    totalDebtUsd: lusd,
    ltv,
    liquidationLtv,
    healthFactor: ltv > 0 ? liquidationLtv / ltv : Number.POSITIVE_INFINITY,
    provenance: stamp('onchain', 'Liquity V1 TroveManager', 'getEntireDebtAndColl + PriceFeed.lastGoodPrice; LUSD valued at $1'),
  }
}
