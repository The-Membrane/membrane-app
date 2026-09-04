import { encodeFunctionData } from 'viem'
import type { EvmCall, EvmFeeEstimate } from '@/services/chain/types'
import { getAtomicStatus } from '@/services/chain/atomicBatch'

/**
 * Pure sign-and-broadcast runner for EvmCall batches — no React imports, so the
 * revert contract is unit-testable (tests/unit/useTransaction.test.ts) without
 * dragging the toaster/JSX chain into vitest's node environment.
 *
 * Execution ladder for a multi-call batch:
 *   1. EIP-5792 atomic batch (wallet_sendCalls, forceAtomic) when the wallet
 *      reports atomic support — one confirmation, all-or-nothing, zero dangling
 *      allowance (services/chain/atomicBatch.ts).
 *   2. Sequential writeContract loop (this file's floor) — one signature per
 *      call. Permit embedding (useTransaction prepareMsgs) only applies here;
 *      an atomic batch keeps the plain exact-approve calls.
 * A pre-signature sendCalls failure falls through to the sequential loop; a
 * user rejection or an on-chain batch failure does NOT.
 *
 * The ONLY resolved outcome is every call succeeding (`code: 0`). Anything else
 * throws. Do not reintroduce a `code: 1` return — that is what made a revert
 * render as success (tools/ui-sensory/FINDINGS.md).
 */

export type TxResult = {
  transactionHash: string
  code: number
}

/**
 * A call was mined and reverted. This is a FAILURE, not a success with different copy —
 * see tools/ui-sensory/UNKNOWN-STATE-CONVENTION.md R1. Thrown so react-query takes the
 * onError path and `onSuccess` (modal close + form reset + query invalidation) never runs.
 */
export class TxRevertedError extends Error {
  readonly transactionHash: string
  /** index into the EvmCall[] that reverted — non-zero means an earlier call DID land */
  readonly callIndex: number
  readonly totalCalls: number

  constructor(transactionHash: string, callIndex: number, totalCalls: number) {
    super(
      totalCalls > 1
        ? `Transaction reverted on step ${callIndex + 1} of ${totalCalls}. Your position is unchanged.`
        : 'Transaction reverted on-chain. Your position is unchanged.',
    )
    this.name = 'TxRevertedError'
    this.transactionHash = transactionHash
    this.callIndex = callIndex
    this.totalCalls = totalCalls
  }
}

type RunEvmCallsParams = {
  msgs: EvmCall[]
  address: `0x${string}`
  walletClient: any
  publicClient: any
  fee?: EvmFeeEstimate | undefined
  /** fired after each signature is obtained, before its receipt is awaited */
  onApproved?: () => void
}

const isUserRejection = (err: any): boolean => {
  const msg: string = (err?.shortMessage ?? err?.message ?? String(err)).toLowerCase()
  return err?.code === 4001 || msg.includes('user rejected') || msg.includes('user denied')
}

/**
 * One wallet_sendCalls submission for the whole batch. Resolves only on an
 * all-success batch; an on-chain failure throws TxRevertedError with the
 * single-call copy — atomicity means the position is untouched either way.
 */
const runAtomicBatch = async ({
  msgs,
  address,
  walletClient,
  onApproved,
}: RunEvmCallsParams): Promise<TxResult> => {
  const { id } = await walletClient.sendCalls({
    account: address,
    chain: walletClient.chain,
    calls: msgs.map((call) => ({
      to: call.address,
      data: encodeFunctionData({
        abi: call.abi,
        functionName: call.functionName,
        args: call.args as any,
      }),
      ...(call.value !== undefined ? { value: call.value } : {}),
    })),
    forceAtomic: true,
  })
  onApproved?.()

  const result = await walletClient.waitForCallsStatus({ id })
  const receipts: any[] = result?.receipts ?? []
  const lastHash: `0x${string}` | '' = receipts[receipts.length - 1]?.transactionHash ?? ''
  if (result?.status !== 'success') {
    // callIndex/totalCalls 0/1 on purpose: the batch is all-or-nothing, so the
    // single-call "Your position is unchanged" copy is the accurate one.
    throw new TxRevertedError(lastHash, 0, 1)
  }
  return { transactionHash: lastHash, code: 0 }
}

export const runEvmCalls = async (params: RunEvmCallsParams): Promise<TxResult> => {
  const { msgs, address, walletClient, publicClient, fee, onApproved } = params

  if (msgs.length > 1 && typeof walletClient?.sendCalls === 'function') {
    const status = await getAtomicStatus(walletClient, walletClient?.chain?.id)
    if (status !== 'unsupported') {
      // Once the wallet ACCEPTS the submission, sequential fallback is off the
      // table — retrying calls the batch might still land would double-execute.
      let submitted = false
      try {
        return await runAtomicBatch({
          ...params,
          onApproved: () => {
            submitted = true
            onApproved?.()
          },
        })
      } catch (err) {
        // Real outcomes surface; only a pre-submission "wallet can't do this
        // after all" (e.g. 4200, declined 7702 upgrade) falls through to the
        // sequential floor.
        if (submitted || err instanceof TxRevertedError || isUserRejection(err)) throw err
        console.error('Atomic batch unavailable, falling back to sequential calls:', err)
      }
    }
  }

  let lastHash: `0x${string}` | undefined

  for (let i = 0; i < msgs.length; i++) {
    const call = msgs[i]
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
    onApproved?.()
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    lastHash = hash
    if (receipt.status !== 'success') {
      throw new TxRevertedError(hash, i, msgs.length)
    }
  }

  return { transactionHash: lastHash ?? '', code: 0 }
}

