import { parseError } from '@/helpers/parseError'
import { queryClient } from '@/pages/_app'
import { DeliverTxResponse, ExecuteResult } from '@cosmjs/cosmwasm-stargate'
import { useMutation } from '@tanstack/react-query'
import useToaster from './useToaster'

type Transaction = {
  onSubmit: () => Promise<ExecuteResult>
  onSuccess?: () => void
  // When true, suppress the toaster notification (Ditto will show acknowledgement)
  suppressToaster?: boolean
}

const mock = {
  transactionHash: '455C577EBCACEA50D9E8E9A0E621B1121E05D97974DFD9EDFFFB367B2F13BC24',
} as DeliverTxResponse

const useExecute = ({ onSubmit, onSuccess, suppressToaster = false }: Transaction) => {
  const toaster = useToaster()

  const tx = useMutation<ExecuteResult, Error>({
    mutationFn: onSubmit,
    onSuccess: (res: ExecuteResult) => {
      const { transactionHash } = res
      
      // Only show toaster if not suppressed (Ditto will handle acknowledgement)
      if (!suppressToaster) {
      toaster.success({
        message: 'Transaction Successful',
        txHash: transactionHash,
      })
      }
      
      queryClient.invalidateQueries({ queryKey: ['balances'] })
      queryClient.invalidateQueries({ queryKey: ['staked'] })
      onSuccess?.()
    },
    onError: (error) => {
      const parsedError = parseError(error?.message ?? "")
      // Always show error toaster
      toaster.error({
        message: parsedError || 'Transaction Failed',
      })
    },
  })

  return tx
}
export default useExecute
