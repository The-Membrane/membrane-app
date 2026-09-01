import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import { shiftDigits } from '@/helpers/math'
import { useAssetBySymbol } from '@/hooks/useAssets'
import { coin } from '@cosmjs/stargate'
import { useAffiliateAddress, useAffiliateLabel } from '@/hooks/useAffiliate'

/**
 * Parameters for depositing USDC in the acquisition contract
 */
interface UseAcquisitionDepositParams {
  /** Number of days to lock */
  lockDays: number
  /** Amount of USDC to lock (human-readable) */
  amount: string
  /** Optional: most profitable slot 5 asset denom for setting MBRN claim intent */
  intentAsset?: string
  /** Optional: slot number for the intent (defaults to 5) */
  intentSlot?: number
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to deposit USDC in the acquisition contract.
 * 
 * @example
 * ```typescript
 * const lock = useAcquisitionDeposit({
 *   lockDays: 30,
 *   amount: '1000',
 *   txSuccess: () => console.log('Lock successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(lock.action, <Details />, { label: 'Lock', actionType: 'lock' })
 * ```
 */
const useAcquisitionDeposit = ({
  lockDays,
  amount,
  intentAsset,
  intentSlot = 5,
  txSuccess,
}: UseAcquisitionDepositParams) => {
  const { address } = useWallet()
  const usdcAsset = useAssetBySymbol('USDC')
  const lockdropContract = (contracts as any).acquisition
  const affiliateAddress = useAffiliateAddress()
  const affiliateLabel = useAffiliateLabel()

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['acquisition_deposit', 'msgs', address, lockDays, amount, affiliateAddress, intentAsset, intentSlot],
    queryFn: () => {
      if (!address || !lockDays || !amount || !usdcAsset) {
        return { msgs: undefined }
      }
      if (!lockdropContract || lockdropContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const funds = [coin(microAmount, usdcAsset.base)]

      // Build MBRN claim intent for the most profitable slot 5 asset
      const mbrnIntent = intentAsset ? {
        apply_now: false,
        set_ongoing: true,
        intents: [{
          intent_type: {
            deposit_via_mars_mirror: {
              asset: intentAsset,
              slot: intentSlot,
            },
          },
          ratio: "1.0",
          lock: null,
        }],
      } : undefined

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: lockdropContract,
          msg: toUtf8(JSON.stringify({
            lock: {
              lock_days: lockDays,
              ...(affiliateAddress && { affiliate_address: affiliateAddress }),
              ...(affiliateLabel && { affiliate_label: affiliateLabel }),
              ...(mbrnIntent && { mbrn_intent: mbrnIntent }),
            }
          })),
          funds,
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!lockDays && !!amount && !!usdcAsset,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['acquisition_user'] })
    queryClient.invalidateQueries({ queryKey: ['acquisition_pending'] })
    queryClient.invalidateQueries({ queryKey: ['user_acquisition_intents'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['acquisition_deposit_sim', (msgs?.toString() ?? '0')],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useAcquisitionDeposit


























