import { useQuery } from '@tanstack/react-query'
import { cdpAbi } from '@/contracts/abis/cdp'
import { assetKey } from '@/services/chain/liquidation'
import { getContractAddress } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'
import { useUserPositions } from '@/hooks/useCDP'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { queryClient } from '@/pages/_app'
import { BorrowRate } from './useBorrowModal'

interface UseBorrowTransactionProps {
  asset: {
    symbol: 'CDT' | 'USDC'
    denom: string
  }
  borrowAmount: number
  selectedRate: BorrowRate
  receiveToWallet: boolean
  positionIndex?: number
  enabled?: boolean
  onSuccess?: () => void
}

/**
 * Borrow (mint) CTA — EVM port. Migration counterpart: CosmWasm `increase_debt` via the
 * positions/marketManager contract. Here we build cdp.increaseDebt(positionId, cdtDenom,
 * amount) (contracts/abis/cdp.ts).
 *
 * TODO(evm-migration): only variable-rate CDT borrow maps cleanly to the 3-arg
 * increaseDebt(positionId, borrowAsset, amount). Fixed-rate tranches (fixed-1m/3m/6m) need
 * the 5-arg increaseDebt with a CdpFixedRate.DebtSplit, and the USDC "peg" borrow (mint CDT
 * then swap CDT→USDC via the transmuter) has no marketManager equivalent in the EVM address
 * book yet — those paths are stubbed (return undefined ⇒ CTA disabled) until modeled.
 * `receiveToWallet` also has no representation on the 3-arg entrypoint (CDT is minted to the
 * position owner); it is ignored here.
 */
export const useBorrowTransaction = ({
  asset,
  borrowAmount,
  selectedRate,
  receiveToWallet,
  positionIndex = 0,
  enabled = true,
  onSuccess,
}: UseBorrowTransactionProps) => {
  const { address, chain } = useWallet()
  const { data: positions } = useUserPositions()
  const cdtAsset = useAssetBySymbol('CDT')

  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined
  const positionId =
    positions && positions.length > positionIndex ? positions[positionIndex].positionId : 0n

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'borrow_transaction',
      'evm',
      address ?? '',
      cdpAddr ?? '',
      positionId.toString(),
      asset.symbol,
      String(borrowAmount),
      selectedRate,
      String(positionIndex),
    ],
    staleTime: 1000 * 60 * 5,
    queryFn: () => {
      if (!address || !cdpAddr || !borrowAmount || borrowAmount <= 0 || !enabled) return undefined
      // Only the variable-rate CDT path is supported on EVM (see file-level TODO).
      if (asset.symbol !== 'CDT' || selectedRate !== 'variable') return undefined

      const amount = BigInt(shiftDigits(borrowAmount, cdtAsset?.decimal ?? 18).dp(0).toString())
      return [
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'increaseDebt',
          args: [positionId, assetKey('CDT'), amount],
        },
      ]
    },
    enabled: enabled && !!address && !!cdpAddr && borrowAmount > 0,
  })

  const handleSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['vault summary'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    queryClient.invalidateQueries({ queryKey: ['credit rate'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    onSuccess?.()
  }

  return useSimulateAndBroadcast({
    msgs,
    queryKey: ['borrow', asset.symbol, String(borrowAmount)],
    amount: String(borrowAmount),
    enabled: enabled && !!msgs && msgs.length > 0,
    onSuccess: handleSuccess,
  })
}
