// Client-usable swap quotes for paying the CDT mint fee in a non-CDT asset.
//
// The MintClaim fee is always CDT. The mint UI lets a user pay in USDC or ETH by swapping to
// EXACTLY `mintFee` CDT first (swapTokensForExactTokens / swapETHForExactTokens). A QuoteSource
// answers "how much of the input asset, at most, will that cost?" so the sheet can show a
// `pull ≤ X` cap and pass it as amountInMax.

import type { PublicClient } from 'viem'
import { routerAbi } from './abi'

export type SellToken = 'USDC' | 'ETH'

export type Quote = {
  /** Max input asset the user will spend (getAmountsIn + slippage). Use as amountInMax. */
  pullMax: bigint
  /** Human route label, e.g. "USDC → CDT". */
  route: string
  /** Where the quote came from, for the `source · fetched HH:MM` stamp. */
  source: string
  fetchedAt: Date
}

export interface QuoteSource {
  quote(params: { sellToken: SellToken; cdtOut: bigint }): Promise<Quote>
}

export const DEFAULT_SLIPPAGE_BPS = 100 // 1%

export type RouterQuoteConfig = {
  publicClient: PublicClient
  router: `0x${string}`
  cdt: `0x${string}`
  usdc: `0x${string}`
  weth: `0x${string}`
  /** Slippage tolerance in basis points (default 100 = 1%). */
  slippageBps?: number
}

/**
 * Quotes against a UniswapV2Router02-compatible pool via `getAmountsIn` (exact-out). On anvil
 * this is the mock CDT/USDC and CDT/WETH pools stood up by DeployQRacingMint.s.sol.
 */
export class RouterQuoteSource implements QuoteSource {
  constructor(private readonly cfg: RouterQuoteConfig) {}

  async quote({ sellToken, cdtOut }: { sellToken: SellToken; cdtOut: bigint }): Promise<Quote> {
    const { publicClient, router, cdt, usdc, weth } = this.cfg
    const bps = BigInt(this.cfg.slippageBps ?? DEFAULT_SLIPPAGE_BPS)

    // ETH swaps route through WETH on-chain (swapETHForExactTokens path starts with WETH).
    const path: readonly `0x${string}`[] = sellToken === 'USDC' ? [usdc, cdt] : [weth, cdt]

    const amounts = await publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: 'getAmountsIn',
      args: [cdtOut, path],
    })
    // amounts[0] = required input; amounts[last] = cdtOut.
    const amountIn = amounts[0]
    const pullMax = (amountIn * (10_000n + bps)) / 10_000n

    return {
      pullMax,
      route: sellToken === 'USDC' ? 'USDC → CDT' : 'ETH → CDT',
      source: 'anvil pool',
      fetchedAt: new Date(),
    }
  }
}

/**
 * Production stub. Not wired: on a real chain, replace RouterQuoteSource with a call to an
 * aggregator — 0x Swap API (https://0x.org/docs/0x-swap-api) or LI.FI (https://li.fi) — which
 * returns a quote + swap calldata and a `sellAmount`; pullMax = sellAmount * (1 + slippage).
 */
export class AggregatorQuoteSource implements QuoteSource {
  async quote(): Promise<Quote> {
    throw new Error(
      'AggregatorQuoteSource not configured — use RouterQuoteSource on anvil, or wire 0x/LI.FI for production',
    )
  }
}
