import { num } from '@/helpers/num'
import { AssetWithBalance } from './hooks/useCombinBalance'

export const getAssetWithNonZeroValues = (combinBalance: AssetWithBalance[], transactionType: string) => {
  return combinBalance
    ?.flatMap((asset) => {
      if (!asset) return []
      if (!num(transactionType === "deposit" ? asset.walletsdValue : asset.depositUsdValue).isGreaterThan(0.01)) return []
      return [{
        ...asset,
        sliderValue: asset.depositUsdValue || 0,
        amount: 0,
        amountValue: 0,
      }]
    })
}
