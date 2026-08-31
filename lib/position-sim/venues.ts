/**
 * Detects whether an address's borrowed capital was actually deployed somewhere.
 *
 * This drives the SECONDARY simulation — what the debt would have done inside a
 * Membrane recallable deployment vault. The brief on this is strict: if deployment
 * cannot be DETECTED, the section is omitted entirely. There is no inferred, assumed
 * or illustrative deployment.
 *
 * Detection is deliberately narrow: an ERC-20 balance of a known yield-bearing token,
 * read live. A zero balance across the list means "not detected", which is reported as
 * such — it does NOT mean the address deployed nothing (it may hold an LP NFT, a
 * position on an unlisted venue, or have moved the funds to another address).
 */

import { getMainnetClient, rpcLabel, toNumber } from './rpc'
import { stamp, type Provenance } from './types'
import type { VenueRecall } from './membrane'

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

/**
 * Known yield venues we can detect by token balance.
 *
 * `recallRate` / `fastRate` are MODELLED — they are our reading of how much of a
 * position can be pulled on demand and how much can arrive inside an 8-hour window,
 * based on the venue's own withdrawal mechanics. They are exposed as editable inputs
 * because they are the dominant variable in the result. They are not measured.
 */
export interface KnownVenue {
  symbol: string
  name: string
  address: `0x${string}`
  decimals: number
  /** How the venue's exit works — shown to the user so the rates are auditable. */
  exit: string
  recallRate: number
  fastRate: number
}

export const KNOWN_VENUES: KnownVenue[] = [
  {
    symbol: 'sUSDe', name: 'Ethena sUSDe', address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', decimals: 18,
    exit: 'a 7-day cooldown must elapse before staked USDe can be redeemed',
    recallRate: 0.3, fastRate: 0,
  },
  {
    symbol: 'sDAI', name: 'Savings DAI', address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', decimals: 18,
    exit: 'redeemable on demand against the DSR pot',
    recallRate: 0.97, fastRate: 0.97,
  },
  {
    symbol: 'sUSDS', name: 'Savings USDS', address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', decimals: 18,
    exit: 'redeemable on demand against the Sky savings rate',
    recallRate: 0.97, fastRate: 0.97,
  },
  {
    symbol: 'aEthUSDC', name: 'Aave V3 USDC', address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', decimals: 6,
    exit: 'withdrawable up to the unborrowed reserve — capped by utilisation',
    recallRate: 0.9, fastRate: 0.9,
  },
  {
    symbol: 'aEthUSDT', name: 'Aave V3 USDT', address: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', decimals: 6,
    exit: 'withdrawable up to the unborrowed reserve — capped by utilisation',
    recallRate: 0.9, fastRate: 0.9,
  },
  {
    symbol: 'sfrxUSD', name: 'Staked frxUSD', address: '0xcf62F305562Ba0170a4Fa456bE9bCb6Fa6cA6a70', decimals: 18,
    exit: 'redeemable against the Frax savings vault',
    recallRate: 0.9, fastRate: 0.85,
  },
]

export interface DetectedVenue {
  venue: KnownVenue
  amount: number
  /** USD value. Stablecoin venues are valued at $1 and that is stated. */
  valueUsd: number
}

export interface VenueDetection {
  status: 'detected' | 'none' | 'error'
  detected: DetectedVenue[]
  totalUsd: number
  message?: string
  provenance: Provenance
}

export async function detectVenues(address: `0x${string}`): Promise<VenueDetection> {
  const client = getMainnetClient()
  const at = Date.now()
  try {
    const res = await client.multicall({
      contracts: KNOWN_VENUES.map((v) => ({
        address: v.address,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      })),
      allowFailure: true,
    })
    const detected: DetectedVenue[] = []
    res.forEach((r, i) => {
      if (r.status !== 'success') return
      const v = KNOWN_VENUES[i]
      const amount = toNumber(r.result as bigint, v.decimals)
      if (amount <= 0) return
      // Every venue in the list is a dollar-denominated savings token, so $1 per unit
      // understates a share price above par. It is an assumption and it is stated.
      detected.push({ venue: v, amount, valueUsd: amount })
    })
    const totalUsd = detected.reduce((a, d) => a + d.valueUsd, 0)
    return {
      status: detected.length ? 'detected' : 'none',
      detected,
      totalUsd,
      message: detected.length
        ? undefined
        : 'No deployment was detected for this address across the venues we check. That is not proof there is none — it may sit in a venue we do not scan, in an LP position, or on another address.',
      provenance: stamp(
        'onchain',
        `venue scan · ${rpcLabel()}`,
        `ERC-20 balances of ${KNOWN_VENUES.length} known yield venues. Balances are valued at $1 per unit, which understates any token trading above par.`,
        at,
      ),
    }
  } catch (e) {
    return {
      status: 'error',
      detected: [],
      totalUsd: 0,
      message: `Venue scan failed: ${(e as Error).message}`,
      provenance: stamp('onchain', `venue scan · ${rpcLabel()}`, undefined, at),
    }
  }
}

/** Collapses a detection into the single recall input the engine takes. */
export function toVenueRecall(d: VenueDetection): VenueRecall | null {
  if (d.status !== 'detected' || d.totalUsd <= 0) return null
  const recallRate = d.detected.reduce((a, x) => a + x.venue.recallRate * x.valueUsd, 0) / d.totalUsd
  const fastRate = d.detected.reduce((a, x) => a + x.venue.fastRate * x.valueUsd, 0) / d.totalUsd
  return {
    recallRate,
    fastRate,
    deployedUsd: d.totalUsd,
    provenance: stamp(
      'modelled',
      'recall rates · modelled',
      'Balances are read on-chain. The share that returns on demand, and the share that arrives inside 8 hours, are our modelling of each venue’s exit mechanics — not measured, and editable.',
    ),
  }
}
