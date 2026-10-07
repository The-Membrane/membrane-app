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
  /**
   * The asset the venue token is a receipt for.
   *
   * Load-bearing, not decoration: an Aave aToken balance IS the holder's Aave supply,
   * so for a borrower ON Aave the same dollars are both "detected in a venue" and
   * "collateral backing the loan". Counting them twice would credit a borrower with
   * deploying money it has not borrowed. carryCost() uses this symbol to drop any
   * detected balance that already appears as a collateral leg of the position.
   */
  underlying: string
  /** How the venue's exit works — shown to the user so the rates are auditable. */
  exit: string
  recallRate: number
  fastRate: number
}

export const KNOWN_VENUES: KnownVenue[] = [
  {
    // Cooldown: StakedUSDeV2 cooldownDuration() reads 604,800 s at block 24,669,808 and
    // 86,400 s at 24,669,809 — CooldownDurationUpdated(604800, 86400), tx
    // 0x05856199ceddbfb1b8231c8bfa3bf4c967e5156122b2f1eb11a473fdf5f2d9f9. Still 86,400 s
    // in the exit-queue ledger's keyed re-run (finalized block 26,129,440): request →
    // claimable 24.0 h at p50 and p90 over 979 requests (docs/research/exit-queue-ledger.md,
    // feat/exit-queue-ledger). Measured history, not a forecast: the admin can set it
    // again and a change applies to new requests at once.
    //
    // The rates are NOT derived from the cooldown length. 0.3 / 0 first appear in the
    // Builder sUSDe tile ported from the proto (a96a2590, hours before this file landed
    // in 66e16ad1): `liq: 0.3, spd: 0`, where "liq = share recallable at liquidation"
    // (public/proto/builder.html). No comment or formula ties 0.3 to seven days. fastRate
    // stays 0 because a 24 h gate still exceeds the 8 h cure window. Whether a 1-day gate
    // should move recallRate is an open modelling call for the owner, not a copy fix.
    symbol: 'sUSDe', underlying: 'USDe', name: 'Ethena sUSDe', address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', decimals: 18,
    exit: 'a 1-day cooldown (86,400 s) must elapse before staked USDe can be redeemed — set at block 24,669,809, tx 0x05856199…f2d9f9 (was 7 days); the admin can change it',
    recallRate: 0.3, fastRate: 0,
  },
  {
    symbol: 'sDAI', underlying: 'DAI', name: 'Savings DAI', address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', decimals: 18,
    exit: 'redeemable on demand against the DSR pot',
    recallRate: 0.97, fastRate: 0.97,
  },
  {
    symbol: 'sUSDS', underlying: 'USDS', name: 'Savings USDS', address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', decimals: 18,
    exit: 'redeemable on demand against the Sky savings rate',
    recallRate: 0.97, fastRate: 0.97,
  },
  {
    symbol: 'aEthUSDC', underlying: 'USDC', name: 'Aave V3 USDC', address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', decimals: 6,
    exit: 'withdrawable up to the unborrowed reserve — capped by utilisation',
    recallRate: 0.9, fastRate: 0.9,
  },
  {
    symbol: 'aEthUSDT', underlying: 'USDT', name: 'Aave V3 USDT', address: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', decimals: 6,
    exit: 'withdrawable up to the unborrowed reserve — capped by utilisation',
    recallRate: 0.9, fastRate: 0.9,
  },
  {
    symbol: 'sfrxUSD', underlying: 'frxUSD', name: 'Staked frxUSD', address: '0xcF62F305562bA0170A4fa456be9BcB6fa6Ca6A70', decimals: 18,
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
    let failures = 0
    res.forEach((r, i) => {
      if (r.status !== 'success') {
        failures++
        return
      }
      const v = KNOWN_VENUES[i]
      const amount = toNumber(r.result as bigint, v.decimals)
      if (amount <= 0) return
      // Every venue in the list is a dollar-denominated savings token, so $1 per unit
      // understates a share price above par. It is an assumption and it is stated.
      detected.push({ venue: v, amount, valueUsd: amount })
    })
    // A READ THAT FAILED IS NOT AN EMPTY WALLET. viem's `allowFailure` multicall never
    // throws: an invalid address, a reverting call or a rate-limited endpoint comes
    // back as a per-entry failure, so "every entry failed" used to render as the
    // reassuring sentence "no deployment was detected". It measured nothing.
    //
    // This is not hypothetical — it was live: the sfrxUSD entry carried a mis-cased
    // (checksum-invalid) address, viem rejected the whole aggregate3 before it left
    // the process, and venue detection returned 'none' for EVERY address on mainnet.
    // Found 2026-09-11 while snapshotting the real demo wallet.
    if (failures === KNOWN_VENUES.length) {
      const first = res.find((r) => r.status !== 'success') as { error?: Error } | undefined
      return {
        status: 'error',
        detected: [],
        totalUsd: 0,
        message: `Venue scan failed: every one of the ${KNOWN_VENUES.length} balance reads failed${first?.error ? ` — ${first.error.message.split('\n')[0]}` : ''}. This is a failed read, not an empty wallet.`,
        provenance: stamp('onchain', `venue scan · ${rpcLabel()}`, undefined, at),
      }
    }
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

/**
 * Drops any detected balance that is ALREADY a collateral leg of `position`.
 *
 * The same money cannot be both the collateral backing a loan and the venue capital
 * recalled to save it. An Aave aToken balance IS the holder's Aave supply, so for a
 * borrower on Aave the venue scan reports their own collateral back to them: measured
 * 2026-09-11, every one of the 40 real Aave borrowers the demo-wallet search examined
 * had a "detected deployment" that was nothing but their own aEthUSDC/aEthUSDT.
 *
 * Left unfiltered this is not a cosmetic error — it hands the Membrane engine a
 * phantom recall worth the whole collateral leg and manufactures a survival. Both the
 * cost model (carryCost) and the recall input (toVenueRecall) must see the filtered
 * detection.
 */
export function excludeOwnCollateral(
  detection: VenueDetection,
  position: { collateral: { symbol: string }[] } | null | undefined,
): VenueDetection {
  if (!position || detection.status !== 'detected') return detection
  const owned = new Set(position.collateral.map((c) => c.symbol.toUpperCase()))
  const kept = detection.detected.filter(
    (d) => !owned.has(d.venue.underlying.toUpperCase()) && !owned.has(d.venue.symbol.toUpperCase()),
  )
  if (kept.length === detection.detected.length) return detection
  const totalUsd = kept.reduce((a, d) => a + d.valueUsd, 0)
  return {
    ...detection,
    status: kept.length ? 'detected' : 'none',
    detected: kept,
    totalUsd,
    message: kept.length
      ? detection.message
      : 'The only venue balances found for this address are the same assets it has pledged as collateral on the source protocol. Collateral is not deployed debt, so no deployment is counted.',
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
