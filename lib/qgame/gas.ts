// Gas → USD estimation for the burner-signed gameplay actions. Each TrainRace control
// shows a live "≈ $X gas" figure before it sends, computed from the current gasPrice and
// an ETH/USD reference. On anvil the reference is a documented constant; on mainnet it is
// a stub to be wired to a real feed.

import { formatEther, type Address, type PublicClient } from 'viem'
import type { EvmCall } from '@/services/chain/types'

/**
 * ETH/USD on anvil. Derived from the seeded swap pools this repo stands up:
 * CDT/USDC is 1:1 (1 CDT ≈ $1) and CDT/WETH is 1,000,000:250 (1 CDT ≈ 0.00025 ETH),
 * so ETH ≈ $1 / 0.00025 = $4,000. A constant is fine here — anvil has no live oracle.
 */
export const ETH_USD_ANVIL = 4000

/**
 * ETH/USD reference. On anvil (31337) returns the documented constant. On any other
 * chain this is a STUB: wire it to a real feed (Chainlink ETH/USD, or derive from the
 * quotes adapter's USDC↔WETH path) before shipping gas-cost UI to mainnet.
 */
export function getEthUsd(chainId: number): number {
  if (chainId === 31337) return ETH_USD_ANVIL
  // TODO(mainnet): read Chainlink ETH/USD or the quotes adapter here.
  return ETH_USD_ANVIL
}

export type GasCostEstimate = {
  gas: bigint
  gasPriceWei: bigint
  ethWei: bigint
  eth: string
  usd: number
}

/**
 * Estimate what a burner-signed call will cost, in ETH and USD, using current gasPrice.
 * Returns null when estimation fails (e.g. the call would revert with current state) so
 * the UI can fall back to a neutral label instead of throwing.
 */
export async function estimateActionGasCost(params: {
  publicClient: PublicClient
  call: EvmCall
  account: Address
  chainId: number
}): Promise<GasCostEstimate | null> {
  const { publicClient, call, account, chainId } = params
  try {
    const gas = await publicClient.estimateContractGas({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args as any,
      value: call.value,
      account,
    })
    const gasPriceWei = await publicClient.getGasPrice()
    const ethWei = gas * gasPriceWei
    const eth = formatEther(ethWei)
    const usd = Number(eth) * getEthUsd(chainId)
    return { gas, gasPriceWei, ethWei, eth, usd }
  } catch {
    return null
  }
}
