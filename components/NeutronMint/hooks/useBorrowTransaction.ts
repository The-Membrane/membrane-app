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
  positionIndex?: number
  enabled?: boolean
  onSuccess?: () => void
}

/** DECIMAL_FRACTIONAL — a full 1e18-scaled fraction (== 100%). */
const ONE_FRACTION = 10n ** 18n

/** DebtSplit tuple for the 5-arg increaseDebt overload (CdpFixedRate.DebtSplit). */
type DebtSplit = {
  variable: bigint
  oneM: bigint
  threeM: bigint
  sixM: bigint
  pegVariable: bigint
  pegOneM: bigint
  pegThreeM: bigint
  pegSixM: bigint
  rolloverFlags: number
}

const EMPTY_SPLIT: DebtSplit = {
  variable: 0n,
  oneM: 0n,
  threeM: 0n,
  sixM: 0n,
  pegVariable: 0n,
  pegOneM: 0n,
  pegThreeM: 0n,
  pegSixM: 0n,
  rolloverFlags: 0,
}

/**
 * Build the DebtSplit for a single-tranche borrow. Fractions sum to 1e18 in exactly one
 * non-empty pool (regular OR peg); rollover disabled. `pegDebt` selects the pool: the peg
 * pool mints CDT and transmutes it to USDC for the owner (single atomic call), the regular
 * pool mints CDT to the owner.
 */
const buildSplit = (selectedRate: BorrowRate, pegDebt: boolean): DebtSplit => {
  const split = { ...EMPTY_SPLIT }
  if (pegDebt) {
    switch (selectedRate) {
      case 'fixed-1m': split.pegOneM = ONE_FRACTION; break
      case 'fixed-3m': split.pegThreeM = ONE_FRACTION; break
      case 'fixed-6m': split.pegSixM = ONE_FRACTION; break
      default: split.pegVariable = ONE_FRACTION; break
    }
  } else {
    switch (selectedRate) {
      case 'fixed-1m': split.oneM = ONE_FRACTION; break
      case 'fixed-3m': split.threeM = ONE_FRACTION; break
      case 'fixed-6m': split.sixM = ONE_FRACTION; break
      default: split.variable = ONE_FRACTION; break
    }
  }
  return split
}

/**
 * Borrow (mint) CTA — EVM port. Migration counterpart: CosmWasm `increase_debt`.
 *
 * The debt is always denominated in CDT (borrowAsset = bytes32("CDT"), amount in CDT base
 * units); `pegDebt` chooses whether the minted CDT is handed over as-is or transmuted to
 * USDC. Paths:
 *   - CDT + variable → 3-arg increaseDebt(positionId, borrowAsset, amount) (atomic, simplest).
 *   - CDT + fixed-1m/3m/6m → 5-arg with pegDebt=false and the fraction in oneM/threeM/sixM.
 *   - USDC (peg) any tranche → 5-arg with pegDebt=true and the fraction in the peg pool;
 *     the contract mints CDT and transmutes to USDC to the owner in ONE call.
 *
 * Borrowed funds always mint to the position OWNER — there is no recipient arg, so no
 * "receive to wallet" choice exists on-chain.
 */
export const useBorrowTransaction = ({
  asset,
  borrowAmount,
  selectedRate,
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

      // Debt is always CDT-denominated (amount in CDT base units); the peg path transmutes
      // the minted CDT to USDC in-contract. USDC ≈ CDT 1:1, so the entered amount maps to
      // the same CDT debt figure either way.
      const amount = BigInt(shiftDigits(borrowAmount, cdtAsset?.decimal ?? 18).dp(0).toString())
      const borrowAsset = assetKey('CDT')
      const pegDebt = asset.symbol === 'USDC'

      // CDT + variable → the 3-arg overload (already-atomic, minimal calldata).
      if (!pegDebt && selectedRate === 'variable') {
        return [
          {
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'increaseDebt',
            args: [positionId, borrowAsset, amount],
          },
        ]
      }

      // Everything else (CDT fixed tranches, and all USDC/peg tranches) → the 5-arg overload
      // with a single-tranche DebtSplit. viem resolves the overload by arg count/shape.
      const split = buildSplit(selectedRate, pegDebt)
      return [
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'increaseDebt',
          args: [positionId, borrowAsset, amount, pegDebt, split],
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
