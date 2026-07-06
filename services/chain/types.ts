import type { Abi } from 'viem'
import type { Address } from '@/config/evm/contracts'

/**
 * The EVM transaction unit — replaces MsgExecuteContractEncodeObject as the currency
 * of the CTA-hook pipeline (build msgs → simulate → broadcast).
 *
 * NOTE: unlike Cosmos multi-msg txs, an EvmCall[] of length > 1 is NOT atomic — each
 * call is a separate wallet signature. Multi-step flows (loop/unloop) need a router or
 * multicall contract (docs/audits/01-cosmos-callsite-ledger.md §3.1). Until then keep
 * CTA hooks to a single call where possible (approve + action is the accepted 2-step).
 */
export type EvmCall = {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
  /** native value to send, in wei */
  value?: bigint
}

/** Display-oriented fee estimate produced by simulation (EIP-1559). */
export type EvmFeeEstimate = {
  /** total estimated gas across all calls */
  gas: bigint
  /** maxFeePerGas used for the estimate, in wei */
  maxFeePerGas: bigint
  /** gas * maxFeePerGas, in wei — the display ceiling */
  totalWei: bigint
  /** formatted ETH string for UI display */
  totalFormatted: string
}
