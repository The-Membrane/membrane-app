/**
 * THE SIMULATION. The exact batch the wallet will sign, run from the owner's address
 * against the latest mainnet block. Nothing is sent and nothing is signed: these are
 * eth_simulateV1 / eth_call reads.
 *
 *   1. eth_simulateV1 (viem simulateCalls): every call in order, each seeing the one
 *      before, so the action runs against the approve's allowance. Gas is each call's
 *      gasUsed.
 *   2. When the RPC has no eth_simulateV1: each call alone (simulateContract, then
 *      estimateContractGas). An action whose only failure is the allowance an earlier
 *      approve in the batch will grant is accepted with its gas unknown — the same rule
 *      the app's pipeline applies (hooks/useSimulate.ts) — and the sheet says so.
 *
 * The gas shown carries the pipeline's 5% buffer; it is never forwarded to the wallet,
 * which estimates each call itself when it signs.
 */

import { BaseError, ContractFunctionRevertedError, type PublicClient } from 'viem'
import { simulateCalls } from 'viem/actions'

import type { EvmCall } from '@/services/chain/types'

import type { Address } from './builders'
import { revertReason } from './revert'

/** The pipeline's buffer (hooks/useSimulate.ts SIMULATION_CONFIG.gasBufferMultiplier). */
export const GAS_BUFFER_PCT = 105n

export type SimResult =
  | {
      ok: true
      method: 'eth_simulateV1' | 'eth_call'
      /** Per call; null for an action whose gas waits on its approve (method eth_call only). */
      gas: (bigint | null)[]
      /** Σ known gas × 1.05. */
      bufferedGas: bigint
      maxFeePerGas: bigint | null
    }
  | { ok: false; method: 'eth_simulateV1' | 'eth_call'; step: number; reason: string }

const ALLOWANCE = /insufficient allowance|erc20insufficientallowance|exceeds allowance|allowance/i

export const buffered = (gas: bigint): bigint => (gas * GAS_BUFFER_PCT) / 100n

/** A contract revert, as opposed to a transport or RPC failure (which is rethrown). */
const isRevert = (err: unknown): boolean =>
  err instanceof BaseError &&
  err.walk((e) => e instanceof ContractFunctionRevertedError) instanceof
    ContractFunctionRevertedError

async function feeCap(client: PublicClient): Promise<bigint | null> {
  try {
    return (await client.estimateFeesPerGas()).maxFeePerGas ?? null
  } catch {
    return null
  }
}

/** Is `calls[i]` preceded by an approve whose spender is `calls[i]`'s target? */
export function hasEarlierApprove(calls: readonly EvmCall[], i: number): boolean {
  const target = calls[i].address.toLowerCase()
  return calls
    .slice(0, i)
    .some((c) => c.functionName === 'approve' && String(c.args?.[0]).toLowerCase() === target)
}

async function viaSimulateV1(
  client: PublicClient,
  owner: Address,
  calls: readonly EvmCall[],
): Promise<SimResult> {
  const { results } = await simulateCalls(client, {
    account: owner,
    calls: calls.map((c) => ({
      to: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args ?? [],
    })),
  } as Parameters<typeof simulateCalls>[1])
  const failed = results.findIndex((r) => r.status !== 'success')
  if (failed >= 0) {
    return {
      ok: false,
      method: 'eth_simulateV1',
      step: failed,
      reason: revertReason(results[failed].error),
    }
  }
  const gas = results.map((r) => r.gasUsed)
  return {
    ok: true,
    method: 'eth_simulateV1',
    gas,
    bufferedGas: buffered(gas.reduce((a, b) => a + b, 0n)),
    maxFeePerGas: await feeCap(client),
  }
}

async function viaEthCall(
  client: PublicClient,
  owner: Address,
  calls: readonly EvmCall[],
): Promise<SimResult> {
  const gas: (bigint | null)[] = []
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    const req = {
      address: c.address,
      abi: c.abi,
      functionName: c.functionName,
      args: c.args ?? [],
      account: owner,
    }
    try {
      await client.simulateContract(req as Parameters<PublicClient['simulateContract']>[0])
      gas.push(
        await client.estimateContractGas(req as Parameters<PublicClient['estimateContractGas']>[0]),
      )
    } catch (err) {
      if (!isRevert(err)) throw err
      const reason = revertReason(err)
      if (ALLOWANCE.test(reason) && hasEarlierApprove(calls, i)) {
        gas.push(null)
        continue
      }
      return { ok: false, method: 'eth_call', step: i, reason }
    }
  }
  const known = gas.reduce<bigint>((a, b) => a + (b ?? 0n), 0n)
  return {
    ok: true,
    method: 'eth_call',
    gas,
    bufferedGas: buffered(known),
    maxFeePerGas: await feeCap(client),
  }
}

/**
 * Simulates the batch from `owner`. A revert is a result ({ ok: false }); only a failure
 * of every RPC path throws.
 */
export async function simulateLever(
  client: PublicClient,
  owner: Address,
  calls: readonly EvmCall[],
): Promise<SimResult> {
  if (calls.length === 0) throw new Error('simulate: no calls')
  let v1Error: unknown
  try {
    return await viaSimulateV1(client, owner, calls)
  } catch (err) {
    v1Error = err // no eth_simulateV1 on any endpoint: fall back to one call at a time
  }
  try {
    return await viaEthCall(client, owner, calls)
  } catch (err) {
    throw new Error(
      `simulation failed on every RPC path: ${revertReason(err)} (eth_simulateV1: ${revertReason(v1Error)})`,
    )
  }
}
