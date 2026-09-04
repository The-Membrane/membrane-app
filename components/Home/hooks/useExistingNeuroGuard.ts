import { useQuery } from '@tanstack/react-query'

import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress, type Address } from '@/config/evm/contracts'
import { assetKey } from '@/services/chain/liquidation'
import { buildApproveIfNeeded } from '@/services/chain/allowance'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useNeuroState from './useNeuroState'
import type { EvmCall } from '@/services/chain/types'

/**
 * NeuroGuard "deposit to existing position": add collateral to an existing CDP position and
 * (on Cosmos) re-fulfil the mint intent.
 *
 * Partial EVM migration: the collateral deposit is the real approve + cdp.deposit action.
 * TODO(evm-migration): the follow-up `fulfill_intents` step has no Cdp.sol equivalent (RBLP
 * intent system not ported) and is omitted.
 */
const useExistingNeuroGuard = ({
  position_id,
  onSuccess,
  run,
}: { position_id: string; onSuccess: () => void; run: boolean }) => {
  const { address, chain, publicClient } = useWallet()
  const { neuroState } = useNeuroState()
  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'existing_neuroGuard_msg_creation',
      address,
      cdpAddr,
      neuroState.depositSelectedAsset,
      position_id,
      run,
    ],
    queryFn: async () => {
      const asset = neuroState.depositSelectedAsset
      if (
        !run ||
        !address ||
        !cdpAddr ||
        !asset ||
        num(asset?.sliderValue).isZero() ||
        !position_id ||
        position_id === '0'
      )
        return undefined

      const amount = BigInt(shiftDigits(asset.sliderValue ?? 0, asset.decimal).dp(0).toString())
      if (amount <= 0n) return undefined

      // TODO(evm-migration): collateral denom bytes32 key is deployment-defined.
      const denom = assetKey(asset.symbol)

      // Approve gated on the standing allowance (services/chain/allowance.ts).
      return [
        ...(await buildApproveIfNeeded(publicClient ?? null, {
          token: asset.base as Address,
          owner: address as Address,
          spender: cdpAddr as Address,
          amount,
        })),
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'deposit',
          args: [BigInt(position_id), address as `0x${string}`, [{ denom, amount }]],
        },
        // TODO(evm-migration): fulfill_intents has no Cdp.sol equivalent — omitted.
      ] as EvmCall[]
    },
    enabled: !!address && !!cdpAddr,
  })

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    // Allowance read inside the msg builder changed with this tx — rebuild msgs.
    queryClient.invalidateQueries({ queryKey: ['existing_neuroGuard_msg_creation'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_existing_neuroGuard', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useExistingNeuroGuard
