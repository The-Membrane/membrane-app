import { StdFee } from '@cosmjs/amino'
import { DeliverTxResponse, MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import useWallet from './useWallet'
import useToaster from './useToaster'
import { parseError } from '@/helpers/parseError'
import { useChainRoute } from './useChainRoute'

type Transaction = {
  msgs: MsgExecuteContractEncodeObject[] | undefined | null
  onSuccess?: () => void
  fee?: StdFee | undefined
  chain_id: string
  shrinkMessage?: boolean
  // When true, suppress the toaster notification (Ditto will show acknowledgement)
  suppressToaster?: boolean
}

const mock = {
  transactionHash: '455C577EBCACEA50D9E8E9A0E621B1121E05D97974DFD9EDFFFB367B2F13BC24',
} as DeliverTxResponse

const useTransaction = ({ msgs, onSuccess, fee, chain_id, shrinkMessage, suppressToaster = false }: Transaction) => {
  const [isApproved, setIsApproved] = useState(false)
  const toaster = useToaster()

  const { isWalletConnected, address, sign, broadcast } = useWallet()

  const tx = useMutation<DeliverTxResponse, Error>({
    mutationFn: async () => {
      if (!address || !msgs || !isWalletConnected || !fee)
        throw new Error('Missing transaction parameters')

      setIsApproved(false)
      const txRaw = await sign(msgs, fee)
      setIsApproved(true)
      const result = await broadcast(txRaw)
      console.log("broadcast result", result)


      return result as DeliverTxResponse
      // return mock
    },
    onSuccess: (res: DeliverTxResponse) => {
      console.log("tx success", res)
      const { transactionHash, code } = res
      
      // Only show toaster if not suppressed (Ditto will handle acknowledgement)
      if (!suppressToaster) {
      toaster.success({
        message: `Transaction ${code === 0 ? 'Successful' : 'Failed'}`,
        txHash: transactionHash,
        shrinkMessage: shrinkMessage ?? false
      })
      }

      // queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })

      console.log("Calling onSuccess callback...")
      onSuccess?.()
      console.log("onSuccess callback completed")
    },
    onError: (error) => {
      console.log("tx error", error)
      const parsedError = parseError(error?.message ?? "")
      // Always show error toaster
      toaster.error({
        message: parsedError || 'Transaction Failed',
      })
    },
  })

  return {
    ...tx,
    isApproved,
  }
}
export default useTransaction
