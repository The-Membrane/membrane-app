import contracts from '@/config/contracts.json'
import { VestingMsgComposer } from '@/contracts/codegen/vesting/Vesting.message-composer'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

const useClaimFees = (sim: boolean = true) => {
  const { address } = useWallet()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[] | undefined
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: ['allocation claim fees', 'msgs', address],
    queryFn: () => {
      if (!address) return { msgs: undefined }
      const messageComposer = new VestingMsgComposer(address, contracts.vesting)

      const claimFeeMsg = messageComposer.claimFeesforContract()
      const claimReceipientMsg = messageComposer.claimFeesforRecipient()
      return { msgs: [claimFeeMsg, claimReceipientMsg] }
    },
    enabled: !!address,
  })

  
  const { msgs }: QueryData = useMemo(() => {
    if (!queryData) return { msgs: undefined }
    else return queryData
  }, [queryData])

  const onSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['allocations'] })
    queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })
  }

  return {action: useSimulateAndBroadcast({
    msgs,
    onSuccess,
    enabled: sim
  }), msgs}
}

export default useClaimFees
