import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import useWallet from './useWallet'
import useToaster from './useToaster'
import type { EvmCall, EvmFeeEstimate } from '@/services/chain/types'

/**
 * Sign + broadcast — EVM internals behind the same hook shape (was cosmos-kit
 * sign/broadcast returning DeliverTxResponse).
 *
 * Result keeps the { transactionHash, code } surface the toaster and CTA hooks read
 * (code 0 = success, matching the Cosmos convention).
 *
 * NOTE: EvmCall[] with length > 1 is signed call-by-call (one wallet prompt each) and
 * is NOT atomic — see services/chain/types.ts. isApproved flips after the first
 * signature, matching the old sign→broadcast split.
 */

export type TxResult = {
  transactionHash: string
  code: number
}

type Transaction = {
  msgs: EvmCall[] | undefined | null
  onSuccess?: () => void
  fee?: EvmFeeEstimate | undefined
  /** legacy param, ignored — chain comes from the wagmi account context */
  chain_id?: string
  shrinkMessage?: boolean
  // When true, suppress the toaster notification (Ditto will show acknowledgement)
  suppressToaster?: boolean
}

const useTransaction = ({ msgs, onSuccess, fee, shrinkMessage, suppressToaster = false }: Transaction) => {
  const [isApproved, setIsApproved] = useState(false)
  const toaster = useToaster()

  const { isWalletConnected, address, walletClient, publicClient } = useWallet()

  const tx = useMutation<TxResult, Error>({
    mutationFn: async () => {
      if (!address || !msgs || !msgs.length || !isWalletConnected || !walletClient || !publicClient)
        throw new Error('Missing transaction parameters')

      setIsApproved(false)

      let lastHash: `0x${string}` | undefined
      let code = 0
      for (const call of msgs) {
        const hash = await walletClient.writeContract({
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args as any,
          value: call.value,
          account: address,
          chain: walletClient.chain,
          // simulation's buffered gas, when a single call owns the whole budget
          ...(fee && msgs.length === 1 ? { gas: fee.gas } : {}),
        })
        setIsApproved(true)
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        lastHash = hash
        if (receipt.status !== 'success') {
          code = 1
          break
        }
      }

      return { transactionHash: lastHash ?? '', code }
    },
    onSuccess: (res: TxResult) => {
      const { transactionHash, code } = res

      // Only show toaster if not suppressed (Ditto will handle acknowledgement)
      if (!suppressToaster) {
        toaster.success({
          message: `Transaction ${code === 0 ? 'Successful' : 'Failed'}`,
          txHash: transactionHash,
          shrinkMessage: shrinkMessage ?? false,
        })
      }

      onSuccess?.()
    },
    onError: (error: any) => {
      console.log('tx error', error)
      const message: string = error?.shortMessage ?? error?.message ?? 'Transaction Failed'
      // Always show error toaster
      toaster.error({
        message,
      })
    },
  })

  return {
    ...tx,
    isApproved,
  }
}
export default useTransaction
