import { erc20Abi } from 'viem'
import type { PublicClient } from 'viem'
import type { Address } from '@/config/evm/contracts'
import type { EvmCall } from '@/services/chain/types'

/**
 * ERC-20 allowance gating for the CTA-hook pipeline.
 *
 * Every CTA used to prepend a fresh erc20.approve unconditionally, so repeat
 * actions cost an extra signature + tx even with a standing allowance. These
 * helpers read the live allowance and emit the approve ONLY when the standing
 * allowance is short of the required amount (the DeFi Saver model: approvals
 * are persistent grants, checked before every flow, never re-sent).
 *
 * Failure contract: readAllowance is null-on-failure (never throws), matching
 * services/chain/README.md. buildApproveIfNeeded treats a failed read as
 * "allowance unknown" and emits the approve — the safe default is one extra
 * prompt, never a broadcast that reverts on transferFrom.
 */

export function buildApprove(token: Address, spender: Address, amount: bigint): EvmCall {
  return {
    address: token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amount],
  }
}

/** allowance(owner, spender) — wallet-independent read, null on failure. */
export async function readAllowance(
  client: PublicClient | null,
  token: Address,
  owner: Address,
  spender: Address,
): Promise<bigint | null> {
  if (!client) return null
  try {
    return await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    })
  } catch (error) {
    console.error('Error querying ERC-20 allowance:', error)
    return null
  }
}

/**
 * [] when the standing allowance already covers `amount`, [approve] otherwise
 * (including when the allowance read fails). Zero/negative amounts need no
 * approval at all.
 */
export async function buildApproveIfNeeded(
  client: PublicClient | null,
  params: { token: Address; owner: Address; spender: Address; amount: bigint },
): Promise<EvmCall[]> {
  const { token, owner, spender, amount } = params
  if (amount <= 0n) return []
  const allowance = await readAllowance(client, token, owner, spender)
  if (allowance !== null && allowance >= amount) return []
  return [buildApprove(token, spender, amount)]
}
