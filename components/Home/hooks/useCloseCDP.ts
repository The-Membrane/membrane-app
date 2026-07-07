import { useQuery } from '@tanstack/react-query'

import { cdpAbi } from '@/contracts/abis/cdp'
import { getContractAddress } from '@/config/evm/contracts'
import { assetKey } from '@/services/chain/liquidation'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'

/**
 * Close (or partially close) a CDP position, or withdraw all collateral when it is undebted.
 * EVM mapping of the Cosmos `close_position` / `withdraw` flow.
 *
 * CONSUMER BREAKAGE: `position` is still the CosmWasm PositionResponse shape passed by the
 * caller component (it has no migrated equivalent yet). We map its string fields onto the
 * Cdp.sol calls here; the component should eventually pass the flat EvmUserPosition shape
 * (services/chain/cdp.ts) instead.
 */
const useCloseCDP = ({
  position,
  debtAmount,
  onSuccess,
  run,
  debtCloseAmount,
  maxSpread: _maxSpread,
}: {
  position: PositionResponse
  debtAmount: number
  onSuccess: () => void
  run: boolean
  debtCloseAmount: number
  maxSpread: string
}) => {
  const { address, chain } = useWallet()
  const cdpAddr = chain ? getContractAddress(chain.id, 'cdp') : undefined

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'closeCDP_msg_creation',
      address,
      cdpAddr,
      position.position_id,
      position.credit_amount,
      debtCloseAmount,
      run,
    ],
    queryFn: () => {
      if (!run || !address || !cdpAddr || !position) return undefined
      if (debtCloseAmount != null && position.credit_amount !== '0' && debtCloseAmount === 0)
        return undefined

      const positionId = BigInt(position.position_id)
      // TODO(evm-migration): CDT borrow-asset bytes32 key is deployment-defined
      // (services/chain/liquidation.ts assetKey). Confirm against the deployment.
      const cdtDenom = assetKey('CDT')

      if (Number(position.credit_amount) > 0) {
        const fraction = num(debtCloseAmount).dividedBy(debtAmount)
        const clamped = fraction.isGreaterThan(1) || !fraction.isFinite() ? num(1) : fraction
        // closePosition takes closePercentage as a 1e18-fractional uint256.
        const closePercentage = BigInt(shiftDigits(clamped.toString(), 18).dp(0).toString())
        return [
          {
            address: cdpAddr,
            abi: cdpAbi,
            functionName: 'closePosition',
            args: [positionId, closePercentage, cdtDenom],
          },
        ] as EvmCall[]
      }

      // Undebted -> withdraw all collateral.
      const funds = position.collateral_assets.map((c: any) => ({
        // TODO(evm-migration): collateral denom bytes32 key is deployment-defined; derived
        // best-effort from the CosmWasm denom string here.
        denom: assetKey(c.asset?.info?.native_token?.denom ?? c.asset?.info?.token?.contract_addr ?? ''),
        amount: BigInt(c.asset?.amount ?? '0'),
      }))
      return [
        {
          address: cdpAddr,
          abi: cdpAbi,
          functionName: 'withdraw',
          args: [positionId, funds],
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
      queryKey: ['home_page_closeCDP', (msgs?.toString() ?? '0')],
      onSuccess: onInitialSuccess,
      enabled: !!msgs?.length,
    }),
  }
}

export default useCloseCDP
