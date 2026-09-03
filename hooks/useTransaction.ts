import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import useWallet from './useWallet'
import useToaster from './useToaster'
import type { EvmCall, EvmFeeEstimate } from '@/services/chain/types'
import { runEvmCalls, TxRevertedError } from '@/services/chain/txRunner'
import type { TxResult } from '@/services/chain/txRunner'

/**
 * Sign + broadcast — EVM internals behind the same hook shape (was cosmos-kit
 * sign/broadcast returning DeliverTxResponse).
 *
 * Result keeps the { transactionHash, code } surface the toaster and CTA hooks read
 * (code 0 = success, matching the Cosmos convention).
 *
 * The runner itself (revert => throw TxRevertedError, never a code:1 return) lives in
 * services/chain/txRunner.ts so it stays unit-testable without React.
 *
 * NOTE: EvmCall[] with length > 1 is signed call-by-call (one wallet prompt each) and
 * is NOT atomic — see services/chain/types.ts. isApproved flips after the first
 * signature, matching the old sign→broadcast split.
 */

export { runEvmCalls, TxRevertedError }
export type { TxResult }

type Transaction = {
  msgs: EvmCall[] | undefined | null
  onSuccess?: () => void
  fee?: EvmFeeEstimate | undefined
  /** legacy param, ignored — chain comes from the wagmi account context */
  chain_id?: string
  shrinkMessage?: boolean
  // When true, suppress the toaster notification (Ditto will show acknowledgement)
  suppressToaster?: boolean
  /** Rendered consequence of THIS tx for the success toast (e.g. the position
   *  delta the user just previewed). Falls back to 'Transaction Successful'. */
  successMessage?: JSX.Element | string
}

const useTransaction = ({ msgs, onSuccess, fee, shrinkMessage, suppressToaster = false, successMessage }: Transaction) => {
  const [isApproved, setIsApproved] = useState(false)
  const toaster = useToaster()

  const { isWalletConnected, address, walletClient, publicClient } = useWallet()

  const tx = useMutation<TxResult, Error>({
    mutationFn: async () => {
      if (!address || !msgs || !msgs.length || !isWalletConnected || !walletClient || !publicClient)
        throw new Error('Missing transaction parameters')

      setIsApproved(false)

      return runEvmCalls({
        msgs,
        address,
        walletClient,
        publicClient,
        fee,
        onApproved: () => setIsApproved(true),
      })
    },
    onSuccess: (res: TxResult) => {
      // Reaching here means every call landed — runEvmCalls throws otherwise.
      const { transactionHash } = res

      // Only show toaster if not suppressed (Ditto will handle acknowledgement)
      if (!suppressToaster) {
        toaster.success({
          message: successMessage ?? 'Transaction Successful',
          txHash: transactionHash,
          shrinkMessage: shrinkMessage ?? false,
        })
      }

      onSuccess?.()
    },
    onError: (error: any) => {
      console.log('tx error', error)
      const message: string = error?.shortMessage ?? error?.message ?? 'Transaction Failed'
      // Always show error toaster. A revert carries its hash so the user can look it up.
      toaster.error({
        message,
        txHash: error instanceof TxRevertedError ? error.transactionHash : undefined,
      })
    },
  })

  return {
    ...tx,
    isApproved,
  }
}
export default useTransaction
