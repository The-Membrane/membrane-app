import { Asset } from '@/helpers/chain'
import { useMemo } from 'react'

export type AssetWithBalance = Asset & {
  sliderValue?: number
  walletBalance: number
  walletsdValue: number
  deposited: number
  depositUsdValue: number
  combinBalance: number
  combinUsdValue: number
  price: number
  amount?: string | number
  inputAmount?: number
  maxBorrowLTV?: number
}

/**
 * Combined wallet + deposited collateral balances — EVM migration.
 *
 * TODO(evm-migration): building this list needs the collateral roster (getBasketAssets, a
 * documented stub → [] in hooks/useCDP because Cdp.sol has no aggregate basket view) plus the
 * CosmWasm-shape getPositions transform. useUserPositions now returns EvmUserPosition[] which
 * getPositions cannot consume, and there is no per-asset supply-cap→symbol mapping without the
 * basket. Return [] until a Collateral service backs the roster; do not invent per-asset
 * wallet/deposit balances. (Wallet balances via useBalance and prices via useOraclePrice do
 * exist on EVM, but without the collateral roster we cannot decide which assets to list.)
 */
const useCombinBalance = (positionIndex: number = 0) => {
  return useMemo<AssetWithBalance[]>(() => {
    return []
  }, [positionIndex])
}

export default useCombinBalance
