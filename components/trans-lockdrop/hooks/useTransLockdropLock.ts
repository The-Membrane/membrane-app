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

/**
 * Parameters for locking USDC in the transmuter lockdrop
 */
interface UseTransLockdropLockParams {
  /** Number of days to lock */
  lockDays: number
  /** Amount of USDC to lock (human-readable) */
  amount: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to lock USDC in the transmuter lockdrop.
 * 
 * @example
 * ```typescript
 * const lock = useTransLockdropLock({
 *   lockDays: 30,
 *   amount: '1000',
 *   txSuccess: () => console.log('Lock successful!'),
 * })
 * 
 * // Use with Ditto confirmation
 * openConfirmation(lock.action, <Details />, { label: 'Lock', actionType: 'lock' })
 * ```
 */
const useTransLockdropLock = ({
  lockDays,
  amount,
  txSuccess,
}: UseTransLockdropLockParams) => {
  const { address } = useWallet()
  const usdcAsset = useAssetBySymbol('USDC')
  const lockdropContract = (contracts as any).transmuter_lockdrop

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['trans_lockdrop_lock', 'msgs', address, lockDays, amount],
    queryFn: () => {
      if (!address || !lockDays || !amount || !usdcAsset) {
        return { msgs: undefined }
      }
      if (!lockdropContract || lockdropContract === '') {
        return { msgs: undefined }
      }

      const microAmount = shiftDigits(amount, 6).dp(0).toString()
      const funds = [coin(microAmount, usdcAsset.base)]

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: lockdropContract,
          msg: toUtf8(JSON.stringify({
            lock: {
              lock_days: lockDays,
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
    queryClient.invalidateQueries({ queryKey: ['transmuter_lockdrop_user'] })
    queryClient.invalidateQueries({ queryKey: ['transmuter_lockdrop_pending'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['trans_lockdrop_lock_sim', (msgs?.toString() ?? '0')],
    amount,
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useTransLockdropLock

























