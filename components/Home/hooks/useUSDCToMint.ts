import { useQuery } from '@tanstack/react-query'

import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import { getPublicClient } from '@/services/chain/client'
import { getCurrentPositionId } from '@/services/chain/cdp'
import { assetKey } from '@/services/chain/liquidation'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useQuickActionState from './useQuickActionState'
import type { EvmCall } from '@/services/chain/types'

/**
 * Deposit USDC into the CDP then mint CDT against it. This is the clean approve + action
 * EVM mapping of the Cosmos `deposit` + `increase_debt` flow.
 *
 * Migration notes:
 * - CDT is 18 decimals on EVM (config/evm/tokens.ts), so the mint amount is shifted by
 *   cdtAsset.decimal (was a hardcoded 6 on Cosmos).
 * - deposit funds pull the USDC ERC20 via transferFrom, so we prepend an approve. Not atomic
 *   (two signatures) — see services/chain/types.ts.
 * - The old flow's step 3 (enter the RangeBound LP vault with the minted CDT) is dropped:
 *   the RBLP vault has no ported EVM contract. TODO(evm-migration) re-add once it exists.
 */
const useUSDCToMint = ({ onSuccess, run }: { onSuccess: () => void; run: boolean }) => {
  const { quickActionState } = useQuickActionState()
  const { address, chain } = useWallet()
  const usdcAsset = useAssetBySymbol('USDC')
  const cdtAsset = useAssetBySymbol('CDT')

  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'home_page_mint',
      address,
      cdpAddr,
      usdcAsset?.base,
      cdtAsset?.base,
      quickActionState?.usdcMint,
      run,
    ],
    queryFn: async () => {
      if (
        !address ||
        !cdpAddr ||
        !usdcAsset ||
        !cdtAsset ||
        !run ||
        quickActionState?.usdcMint.deposit === 0 ||
        quickActionState?.usdcMint.mint < 21
      )
        return undefined

      // TODO(evm-migration): Cdp.sol has no aggregate basket view (useBasket is stubbed), so
      // the "next position id" is read directly from currentPositionId. Confirm against
      // Cdp.sol.deposit whether passing 0 opens a new position and whether the resulting id
      // equals the pre-deposit currentPositionId.
      const nextId = await getCurrentPositionId(getPublicClient(), cdpAddr)
      if (nextId === null) return undefined

      const depositAmount = BigInt(
        shiftDigits(quickActionState.usdcMint.deposit, usdcAsset.decimal).dp(0).toString(),
      )
      const mintAmount = BigInt(
        shiftDigits(quickActionState.usdcMint.mint, cdtAsset.decimal).dp(0).toString(),
      )
      if (depositAmount <= 0n || mintAmount <= 0n) return undefined

      // TODO(evm-migration): the bytes32 asset-key convention is deployment-defined and
      // opaque on-chain (services/chain/liquidation.ts assetKey). Confirm the USDC collateral
      // key and the CDT borrow-asset key against the actual deployment before relying on this.
      const usdcDenom = assetKey('USDC')
      const cdtDenom = assetKey('CDT')

      // Approve gated on the standing allowance (services/chain/allowance.ts).
      return [
        ...(await buildApproveIfNeeded(getPublicClient(), {
          token: usdcAsset.base as Address,
          owner: address as Address,
          spender: cdpAddr as Address,
          amount: depositAmount,
        })),
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'deposit',
          // deposit(positionId=0 -> new position, positionOwner, funds[])
          args: [0n, address as `0x${string}`, [{ denom: usdcDenom, amount: depositAmount }]],
        },
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'increaseDebt',
          // increaseDebt(positionId, borrowAsset, amount)
          args: [nextId, cdtDenom, mintAmount],
        },
      ] as EvmCall[]
    },
    enabled: !!address && !!cdpAddr && !!usdcAsset && !!cdtAsset,
  })

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    // Allowance read inside the msg builder changed with this tx — rebuild msgs.
    queryClient.invalidateQueries({ queryKey: ['home_page_mint'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_mint_sim', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useUSDCToMint
