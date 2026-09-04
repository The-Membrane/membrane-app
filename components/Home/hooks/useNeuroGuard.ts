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
import type { EvmCall } from '@/services/chain/types'

/**
 * NeuroGuard "open": deposit collateral into a new CDP position, then set an RBLP mint
 * intent and fulfil it so the vault mints CDT to the target LTV.
 *
 * Partial EVM migration: the collateral deposit is the real approve + cdp.deposit action.
 * TODO(evm-migration): the two follow-up steps — `set_user_intents` (mint intent) and
 * `fulfill_intents` — have NO Cdp.sol equivalent (the RangeBound LP vault + intent system is
 * not ported to EVM). They are omitted; this hook therefore only opens the collateral
 * position without the automated mint until an RBLP-vault/intent service exists.
 */
const useNeuroGuard = ({
  onSuccess,
  run,
  asset,
}: { onSuccess: () => void; run: boolean; asset: any }) => {
  const { address, chain, publicClient } = useWallet()
  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: ['neuroGuard_msg_creation', address, cdpAddr, asset, run],
    queryFn: async () => {
      if (!run || !address || !cdpAddr || !asset || num(asset?.sliderValue).isZero()) return undefined

      const amount = BigInt(shiftDigits(asset.sliderValue, asset.decimal).dp(0).toString())
      if (amount <= 0n) return undefined

      // TODO(evm-migration): collateral denom bytes32 key is deployment-defined
      // (services/chain/liquidation.ts assetKey); confirm against the deployment.
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
          // deposit(positionId=0 -> new position, positionOwner, funds[])
          args: [0n, address as `0x${string}`, [{ denom, amount }]],
        },
        // TODO(evm-migration): set_user_intents (mint intent) + fulfill_intents have no
        // Cdp.sol equivalent — the RBLP intent system is not ported. Omitted.
      ] as EvmCall[]
    },
    enabled: !!address && !!cdpAddr,
  })

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
    // Allowance read inside the msg builder changed with this tx — rebuild msgs.
    queryClient.invalidateQueries({ queryKey: ['neuroGuard_msg_creation'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_neuroGuard', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useNeuroGuard
