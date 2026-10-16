/**
 * THE LEVER RUNNER. Signs the slip's batch from the owner and watches it to an outcome,
 * reporting every step. It replaces services/chain/txRunner.ts for the levers only (that
 * runner is shared by the app and left as it is) because a lever needs four things it
 * does not give:
 *
 *   - A slow receipt is not a failure. viem stops waiting after a timeout (180s for a
 *     receipt, 60s for a batch); here that is a 'waiting' event and the watch goes on, on
 *     the same hash or batch id, until it resolves. The slip never invites a second
 *     signature while the first can still land.
 *   - A replaced transaction is named. 'repriced' (same call, new gas) is the same
 *     transaction; 'cancelled' or 'replaced' means the call did not happen.
 *   - EIP-5792 atomic batching only when the wallet reports it 'supported'. 'ready' means
 *     the wallet would first upgrade the owner's account to a smart account (EIP-7702),
 *     which the slip does not disclose, so the batch runs one call at a time instead.
 *   - Which calls landed is known, so a standing approval left by a partial run is said.
 *
 * Pure of React; the clients are passed in. tests/unit/positionExecRun.test.ts.
 */

import {
  WaitForCallsStatusTimeoutError,
  WaitForTransactionReceiptTimeoutError,
  encodeFunctionData,
  type Hash,
} from 'viem'

import type { EvmCall } from '@/services/chain/types'

import type { Address } from './builders'

export type RunEvent =
  /** The path is chosen: `total` signatures will be asked for. */
  | { type: 'path'; atomic: boolean; total: number }
  /** A signature was given; its call is on its way. */
  | { type: 'signed'; hash: Hash | null; batchId?: string }
  /** viem stopped waiting; the watch continues on the same hash / batch. */
  | { type: 'waiting'; hash: Hash | null; batchId?: string }
  /** Call `index` landed (status success). */
  | { type: 'landed'; index: number; hash: Hash }

export type RunOutcome =
  | { kind: 'settled'; hash: Hash }
  /** A call was mined and reverted. `landed` calls before it went through. */
  | { kind: 'reverted'; hash: Hash | null; index: number; landed: number; gasSpent: boolean }
  /** The wallet replaced or cancelled call `index`: it did not happen. */
  | { kind: 'replaced'; hash: Hash; index: number; landed: number }

/** Thrown when the run stops before an outcome (declined, wallet error); carries what landed. */
export class RunStopped extends Error {
  constructor(
    readonly cause: unknown,
    readonly landed: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RunStopped'
  }
}

/** The wallet client surface the runner uses (viem WalletClient). */
export interface RunWallet {
  chain?: { id: number } | undefined
  writeContract: (args: Record<string, unknown>) => Promise<Hash>
  sendCalls?: (args: Record<string, unknown>) => Promise<{ id: string }>
  waitForCallsStatus?: (args: { id: string; timeout?: number }) => Promise<{
    status?: string
    receipts?: { transactionHash: Hash; status?: string }[]
  }>
}

export interface RunPublic {
  waitForTransactionReceipt: (args: {
    hash: Hash
    onReplaced?: (r: {
      reason: 'cancelled' | 'replaced' | 'repriced'
      transaction: { hash: Hash }
    }) => void
  }) => Promise<{ status: 'success' | 'reverted'; transactionHash: Hash }>
}

export interface RunInput {
  calls: readonly EvmCall[]
  owner: Address
  wallet: RunWallet
  client: RunPublic
  /** The wallet's EIP-5792 'atomic' status for chain 1 (services/chain/atomicBatch.ts). */
  atomicStatus: 'supported' | 'ready' | 'unsupported'
  emit: (e: RunEvent) => void
  /** False once the slip is gone: the watch stops. */
  alive?: () => boolean
}

const isTimeout = (err: unknown) =>
  err instanceof WaitForTransactionReceiptTimeoutError ||
  err instanceof WaitForCallsStatusTimeoutError

/** Only 'supported' batches atomically; 'ready' would upgrade the account first. */
export const batchesAtomically = (status: RunInput['atomicStatus'], calls: number): boolean =>
  calls > 1 && status === 'supported'

async function watchReceipt(
  input: RunInput,
  hash: Hash,
): Promise<{
  receipt: { status: 'success' | 'reverted'; transactionHash: Hash }
  replacedBy: Hash | null
}> {
  let replacedBy: Hash | null = null
  for (;;) {
    try {
      const receipt = await input.client.waitForTransactionReceipt({
        hash,
        onReplaced: (r) => {
          // A repriced transaction is the same call; a cancel or replace is not.
          if (r.reason !== 'repriced') replacedBy = r.transaction.hash
        },
      })
      return { receipt, replacedBy }
    } catch (err) {
      if (!isTimeout(err) || (input.alive && !input.alive())) throw err
      input.emit({ type: 'waiting', hash })
    }
  }
}

async function runAtomic(input: RunInput): Promise<RunOutcome> {
  const { wallet, calls, owner } = input
  const { id } = await wallet.sendCalls!({
    account: owner,
    chain: wallet.chain,
    calls: calls.map((c) => ({
      to: c.address,
      data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args as never }),
      ...(c.value !== undefined ? { value: c.value } : {}),
    })),
    forceAtomic: true,
  })
  input.emit({ type: 'signed', hash: null, batchId: id })
  for (;;) {
    try {
      const res = await wallet.waitForCallsStatus!({ id })
      const receipts = res.receipts ?? []
      const last = receipts[receipts.length - 1]?.transactionHash ?? null
      if (res.status === 'success' && last) return { kind: 'settled', hash: last }
      // All or nothing: nothing landed. Gas was spent only if the batch was mined.
      return { kind: 'reverted', hash: last, index: 0, landed: 0, gasSpent: receipts.length > 0 }
    } catch (err) {
      if (!isTimeout(err) || (input.alive && !input.alive())) throw new RunStopped(err, 0)
      input.emit({ type: 'waiting', hash: null, batchId: id })
    }
  }
}

/** Signs and watches the batch. Resolves with an outcome; throws RunStopped otherwise. */
export async function runLever(input: RunInput): Promise<RunOutcome> {
  const { calls, wallet, owner } = input
  if (calls.length === 0) throw new Error('run: no calls')
  if (
    batchesAtomically(input.atomicStatus, calls.length) &&
    typeof wallet.sendCalls === 'function'
  ) {
    input.emit({ type: 'path', atomic: true, total: 1 })
    try {
      return await runAtomic(input)
    } catch (err) {
      if (err instanceof RunStopped) throw err
      throw new RunStopped(err, 0)
    }
  }
  input.emit({ type: 'path', atomic: false, total: calls.length })
  let landed = 0
  let lastHash: Hash | null = null
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    let hash: Hash
    try {
      hash = await wallet.writeContract({
        address: c.address,
        abi: c.abi,
        functionName: c.functionName,
        args: c.args,
        value: c.value,
        account: owner,
        chain: wallet.chain,
      })
    } catch (err) {
      throw new RunStopped(err, landed)
    }
    input.emit({ type: 'signed', hash })
    let watched: Awaited<ReturnType<typeof watchReceipt>>
    try {
      watched = await watchReceipt(input, hash)
    } catch (err) {
      throw new RunStopped(err, landed)
    }
    if (watched.replacedBy) return { kind: 'replaced', hash: watched.replacedBy, index: i, landed }
    lastHash = watched.receipt.transactionHash
    if (watched.receipt.status !== 'success') {
      return { kind: 'reverted', hash: lastHash, index: i, landed, gasSpent: true }
    }
    landed++
    input.emit({ type: 'landed', index: i, hash: lastHash })
  }
  return { kind: 'settled', hash: lastHash! }
}

/**
 * The approval a partial run leaves standing: the last approve among the calls that
 * landed, when its amount is not zero and the action after it did not land.
 */
export function standingApproval(calls: readonly EvmCall[], landed: number): bigint | null {
  if (landed >= calls.length) return null
  let standing: bigint | null = null
  for (let i = 0; i < landed; i++) {
    if (calls[i].functionName === 'approve') standing = calls[i].args?.[1] as bigint
  }
  return standing !== null && standing > 0n ? standing : null
}
