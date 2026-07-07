import { useQuery } from '@tanstack/react-query'

import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress } from '@/config/evm/contracts'
import { assetKey } from '@/services/chain/liquidation'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useNeuroState from './useNeuroState'
import type { EvmCall } from '@/services/chain/types'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'

/** @deprecated CosmWasm RBLP intent shape — kept for legacy type imports. */
export type UserIntentData = {
  vault_tokens: string
  intents: {
    user: string
    last_conversion_rate: string
    purchase_intents: {
      desired_asset: string
      route: any | undefined
      yield_percent: string
      position_id: number | undefined
      slippage: string | undefined
    }[]
  }
}

/**
 * NeuroGuard "close": partially/fully close a guarded CDP position.
 *
 * Partial EVM migration: the position close is the real cdp.closePosition action.
 * TODO(evm-migration): the Cosmos flow also (1) repaid debt via the RangeBound LP vault's
 * intented vault tokens (`rangeboundLP.repay_user_debt`) and (2) redistributed/cleared the
 * RBLP purchase intents (`set_user_intents`). Neither the RBLP vault nor its intent system
 * is ported to EVM, so those steps are omitted here.
 *
 * CONSUMER BREAKAGE: `position` is still the CosmWasm PositionResponse shape.
 */
const useNeuroClose = ({
  position,
  onSuccess,
  ledger: _ledger,
  run,
}: { position: PositionResponse; onSuccess: () => void; ledger: boolean; run: boolean }) => {
  const { address, chain } = useWallet()
  const { neuroState } = useNeuroState()
  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'neuroClose_msg_creation',
      address,
      cdpAddr,
      position.position_id,
      neuroState.withdrawSelectedAsset?.sliderValue,
      run,
    ],
    queryFn: () => {
      const slider = neuroState.withdrawSelectedAsset?.sliderValue ?? 0
      if (
        !run ||
        !address ||
        !cdpAddr ||
        !position ||
        position.position_id === '0' ||
        slider === 0
      )
        return undefined

      // Only debted positions use the close flow (mirrors the Cosmos guard).
      if (Number(position.credit_amount) <= 0) return undefined

      const collateralAsset: any = position.collateral_assets?.[0]?.asset
      const decimals = neuroState.withdrawSelectedAsset?.decimal ?? 6
      const maxAmount = num(shiftDigits(collateralAsset?.amount ?? '0', -decimals)).toNumber()

      // Preserve the Cosmos percent formula, clamped to [0, 1].
      let fraction = num(maxAmount).dividedBy(slider)
      if (!fraction.isFinite() || fraction.isGreaterThan(1)) fraction = num(1)
      if (fraction.isLessThan(0)) fraction = num(0)
      const closePercentage = BigInt(shiftDigits(fraction.toString(), 18).dp(0).toString())

      // TODO(evm-migration): CDT borrow-asset bytes32 key is deployment-defined.
      const cdtDenom = assetKey('CDT')

      return [
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'closePosition',
          args: [BigInt(position.position_id), closePercentage, cdtDenom],
        },
      ] as EvmCall[]
    },
    enabled: !!address && !!cdpAddr,
  })

  const onInitialSuccess = () => {
    onSuccess()
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    queryClient.invalidateQueries({ queryKey: ['positions'] })
  }

  return {
    action: useSimulateAndBroadcast({
      msgs,
      queryKey: ['home_page_neuroClose', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useNeuroClose
