import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import contracts from '@/config/contracts.json'
import useAppState from '@/persisted-state/useAppState'

interface UseDiscoMoveDepositParams {
  /** The asset denom */
  asset: string
  /** Deposit ID to move */
  depositId: string
  /** Source slot number (1-9) */
  fromSlot: number
  /** Target slot number (1-9) */
  toSlot: number
  /** Amount of vault tokens to move (human-readable). If undefined, moves all. */
  amount?: string
  /** Optional callback on successful transaction */
  txSuccess?: () => void
}

/**
 * Hook to move a Disco deposit between slots.
 * Follows three-layer pattern: build msgs → simulate → broadcast.
 */
const useDiscoMoveDeposit = ({
  asset,
  depositId,
  fromSlot,
  toSlot,
  amount,
  txSuccess,
}: UseDiscoMoveDepositParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()
  const discoContract = (contracts as any).ltv_disco

  type QueryData = { msgs: MsgExecuteContractEncodeObject[] | undefined }

  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['disco_move', 'msgs', address, asset, depositId, fromSlot, toSlot, amount, appState.rpcUrl],
    staleTime: 1000 * 60 * 5,
    queryFn: () => {
      if (!address || !asset || !depositId) {
        return { msgs: undefined }
      }
      if (!discoContract || discoContract === '') {
        return { msgs: undefined }
      }
      if (fromSlot < 1 || fromSlot > 9 || toSlot < 1 || toSlot > 9 || fromSlot === toSlot) {
        return { msgs: undefined }
      }

      const msg: MsgExecuteContractEncodeObject = {
        typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: discoContract,
          msg: toUtf8(JSON.stringify({
            move_deposit: {
              asset,
              deposit_id: depositId,
              from_slot: fromSlot,
              to_slot: toSlot,
              ...(amount ? { amount } : {}),
            }
          })),
          funds: [],
        }),
      }

      return { msgs: [msg] }
    },
    enabled: !!address && !!asset && !!depositId && fromSlot >= 1 && fromSlot <= 9 && toSlot >= 1 && toSlot <= 9 && fromSlot !== toSlot,
  })

  const msgs = queryData?.msgs ?? []

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['disco'] })
    queryClient.invalidateQueries({ queryKey: ['balances'] })
    txSuccess?.()
  }

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['disco_move_sim', address, asset, depositId, fromSlot, toSlot, amount],
    enabled: !!msgs?.length,
    onSuccess,
  })

  return {
    action,
    msgs,
  }
}

export default useDiscoMoveDeposit
