import type { EvmCall } from '@/services/chain/types'

/**
 * Render a human-readable summary of the EVM tx units (EvmCall) that make up a
 * transaction. Was: decodeMsgs, which base64-decoded CosmWasm MsgExecuteContract
 * payloads. The EVM tx unit is EvmCall { address, abi, functionName, args } — there is
 * no base64 envelope, so we surface the target contract + function + args directly.
 *
 * @param calls EvmCall[] making up the tx
 * @returns per-call display summaries
 *
 * TODO(evm-migration): richer decoding — resolve `address` to a known contract label
 * and format `args` against the function's ABI input types (named params, decimals,
 * bytes32→denom) instead of the raw stringified values below.
 */

export type DecodedEvmCall = {
  address: string
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

export const decodeMsgs = (calls: EvmCall[] = []): DecodedEvmCall[] => {
  return [...calls].map((call) => ({
    address: call.address,
    functionName: call.functionName,
    args: call.args ?? [],
    value: call.value,
  }))
}
