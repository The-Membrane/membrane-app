import { StdFee } from '@cosmjs/amino'
import { DeliverTxResponse, MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import useWallet from './useWallet'
import useToaster from './useToaster'
import { parseError } from '@/helpers/parseError'

type Transaction = {
  msgs: MsgExecuteContractEncodeObject[] | undefined | null
  onSuccess?: () => void
  fee?: StdFee | undefined
  chain_id: string
}

const mock = {
  transactionHash: '455C577EBCACEA50D9E8E9A0E621B1121E05D97974DFD9EDFFFB367B2F13BC24',
} as DeliverTxResponse

const useTransaction = ({ msgs, onSuccess, fee, chain_id }: Transaction) => {
  const [isApproved, setIsApproved] = useState(false)
  const toaster = useToaster()

  const { isWalletConnected, address, sign, broadcast } = useWallet(chain_id)

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
      const { transactionHash } = res
      toaster.success({
        message: 'Transaction Successful',
        txHash: transactionHash,
      })

      // queryClient.invalidateQueries({ queryKey: ['osmosis balances'] })

      onSuccess?.()
    },
    onError: (error) => {
      console.log("tx error", error)
      const parsedError = parseError(error?.message ?? "")
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
