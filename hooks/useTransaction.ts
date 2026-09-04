import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { queryClient } from '@/pages/_app'
import useWallet from './useWallet'
import useToaster from './useToaster'
import type { EvmCall, EvmFeeEstimate } from '@/services/chain/types'
import { runEvmCalls, TxRevertedError } from '@/services/chain/txRunner'
import type { TxResult } from '@/services/chain/txRunner'
import { getAtomicStatus } from '@/services/chain/atomicBatch'

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
  /** Mutation-time rewrite of the batch, run right before signing. Used to embed
   *  a fresh ERC-2612 permit signature (services/chain/permit.ts) — something the
   *  ahead-of-time useQuery msg builders cannot do. Must return the batch to run;
   *  throwing aborts the mutation. */
  prepareMsgs?: (msgs: EvmCall[]) => Promise<EvmCall[]>
}

const useTransaction = ({ msgs, onSuccess, fee, shrinkMessage, suppressToaster = false, successMessage, prepareMsgs }: Transaction) => {
  const [isApproved, setIsApproved] = useState(false)
  const toaster = useToaster()

  const { isWalletConnected, address, walletClient, publicClient } = useWallet()

  const tx = useMutation<TxResult, Error, EvmCall[] | void>({
    // Optional mutate(msgsOverride) lets one hook instance run parametrized
    // one-off batches (allowance-panel revokes); omitted → the hook's msgs.
    mutationFn: async (msgsOverride) => {
      const active = msgsOverride ?? msgs
      if (!address || !active || !active.length || !isWalletConnected || !walletClient || !publicClient)
        throw new Error('Missing transaction parameters')

      setIsApproved(false)

      // Ladder order: an atomic 5792 batch keeps the plain exact-approve calls
      // (one confirmation, nothing dangling), so permit embedding only pays off
      // when the batch will run on the sequential floor. Detection is cached.
      const atomicStatus =
        active.length > 1 && typeof (walletClient as any).sendCalls === 'function'
          ? await getAtomicStatus(walletClient, walletClient.chain?.id)
          : 'unsupported'
      const finalMsgs =
        atomicStatus === 'unsupported' && prepareMsgs ? await prepareMsgs(active) : active
      if (!finalMsgs.length) throw new Error('Missing transaction parameters')

      return runEvmCalls({
        msgs: finalMsgs,
        address,
        walletClient,
        publicClient,
        // Simulation priced the hook's own pre-rewrite batch; a rewritten batch
        // (permit embedded) or an override re-estimates at the wallet instead.
        fee: !msgsOverride && finalMsgs === msgs ? fee : undefined,
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

      // Every landed tx can consume or create allowances — keep the wallet
      // panel honest without each CTA wiring its own invalidation.
      queryClient.invalidateQueries({ queryKey: ['allowances'] })

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
