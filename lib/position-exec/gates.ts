/**
 * THE GATES. Pure: the execution-time read in, one named check per condition out. A lever
 * can be signed only when every gate passes, the wallet gates pass (sheet.ts) and the
 * simulation passes. Each failing gate says what failed and the figure behind it.
 *
 *   decimals   the token's decimals() re-read equals the leg's (the amount was converted
 *              at the leg's decimals)
 *   venue      Aave: reserve active and not paused; a supply also needs it not frozen
 *                    (ValidationLogic.validateRepay / validateSupply)
 *              Compound: supply not paused (a repay is a supply of the base)
 *              Morpho: market params hash back to the id; the token is the market's
 *   debt       Aave repay ≤ the variable-rate debt: only mode 2 is built, so legacy
 *              stable-rate debt (Spark) is named, never repaid by mistake
 *              Compound repay ≤ the borrow (any excess would become a supply)
 *              Morpho repay burns ≤ the owner's borrow shares (else it reverts)
 *   cap        a supply fits under the supply cap (Aave: cap × 10^decimals; Comet: its
 *              supplyCap, which may be 0)
 *   balance    the owner holds the amount. No native ETH is wrapped: the ERC-20 is needed.
 */

import { fmtUnits } from './amount'
import { capFigures, type LeverChainRead, type VenueRead } from './read'

export interface Gate {
  /** `dust:…` are the collect-dust slip's per-venue gates (lib/position-exec/dust.ts). */
  id: 'decimals' | 'venue' | 'debt' | 'cap' | 'balance' | `dust:${string}`
  ok: boolean
  text: string
}

export interface GateInput {
  kind: 'repay' | 'add'
  symbol: string
  /** The leg's token, from the position re-read. */
  token: `0x${string}`
  /** The leg's decimals, at which `amount` was converted. */
  legDecimals: number
  amount: bigint
  /** The lever's display decimals, for figures in the gate text. */
  shown: number
  read: LeverChainRead
  /** The venue's name in a sentence ("Aave V3", "Spark"); "Aave" when not given. */
  venueName?: string
}

/**
 * A paused reserve, in plain words (owner, Q27 round 5, asked what "Reserve paused" means).
 * Exported so the slip and its tests say the same thing.
 */
export const pausedText = (venueName: string) =>
  `${venueName} has paused this market (a governance/guardian switch). Until it is unpaused nobody can supply, withdraw, borrow or repay this asset, so this transaction would fail. Your position is unchanged.`

/** "cap 2,700,000 · supplied 2,169,991.62 · room 530,008.37 WETH"; null with no cap. */
export function capLine(v: VenueRead, decimals: number, shown: number, symbol: string): string | null {
  const c = capFigures(v)
  if (!c) return null
  const supplied = c.supplied === null ? 'at or over it' : fmtUnits(c.supplied, decimals, shown)
  return `cap ${fmtUnits(c.cap, decimals, 0)} · supplied ${supplied} · room ${fmtUnits(c.room, decimals, shown)} ${symbol}`
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function leverGates(g: GateInput): Gate[] {
  const { read, symbol, amount } = g
  const units = (x: bigint) => `${fmtUnits(x, read.decimals, g.shown)} ${symbol}`
  const gates: Gate[] = []

  gates.push(
    read.decimals === g.legDecimals
      ? { id: 'decimals', ok: true, text: `${symbol} has ${read.decimals} decimals` }
      : {
          id: 'decimals',
          ok: false,
          text: `${symbol} reads ${read.decimals} decimals, the position ${g.legDecimals}`,
        },
  )

  const v = read.venue
  const cap = capLine(v, read.decimals, g.shown, symbol)
  const capGate = (room: bigint): Gate =>
    amount <= room
      ? { id: 'cap', ok: true, text: `Under the supply cap: ${cap ?? `room ${units(room)}`}` }
      : {
          id: 'cap',
          ok: false,
          text:
            room === 0n
              ? `Supply cap reached: ${cap ?? `no room for ${symbol}`}`
              : `Over the supply cap: ${cap ?? `room ${units(room)}`}`,
        }
  if (v.venue === 'aave') {
    const f = v.flags
    const blocked = !f.active
      ? 'Reserve is not active'
      : f.paused
        ? pausedText(g.venueName ?? 'Aave')
        : g.kind === 'add' && f.frozen
          ? 'Reserve is frozen: no new supply'
          : null
    gates.push(
      blocked
        ? { id: 'venue', ok: false, text: blocked }
        : {
            id: 'venue',
            ok: true,
            text:
              g.kind === 'add'
                ? 'Reserve active, not paused, not frozen'
                : 'Reserve active, not paused',
          },
    )
    if (g.kind === 'repay') {
      if (amount <= v.variableDebt) {
        gates.push({ id: 'debt', ok: true, text: `Variable-rate debt ${units(v.variableDebt)}` })
      } else {
        gates.push({
          id: 'debt',
          ok: false,
          text:
            v.stableDebt > 0n
              ? `Repay exceeds the variable-rate debt (${units(v.variableDebt)}); ${units(v.stableDebt)} is stable-rate, not repaid here`
              : `Repay exceeds the debt (${units(v.variableDebt)})`,
        })
      }
    } else {
      gates.push(
        v.capRoom === null
          ? { id: 'cap', ok: true, text: 'No supply cap on this reserve' }
          : capGate(v.capRoom),
      )
    }
  } else if (v.venue === 'compound') {
    gates.push(
      v.supplyPaused
        ? { id: 'venue', ok: false, text: 'Supply is paused on this Comet' }
        : { id: 'venue', ok: true, text: 'Comet supply not paused' },
    )
    if (g.kind === 'repay') {
      const isBase = same(v.baseToken, g.token)
      gates.push(
        !isBase
          ? { id: 'debt', ok: false, text: `${symbol} is not this Comet's base asset` }
          : amount <= v.borrow
            ? { id: 'debt', ok: true, text: `Borrow ${units(v.borrow)}` }
            : { id: 'debt', ok: false, text: `Repay exceeds the borrow (${units(v.borrow)})` },
      )
    } else {
      gates.push(capGate(v.capRoom ?? 0n))
    }
  } else {
    const wanted = g.kind === 'repay' ? 'loan' : 'collateral'
    const ownToken = same(
      g.kind === 'repay' ? v.params.loanToken : v.params.collateralToken,
      g.token,
    )
    gates.push(
      !v.idMatches
        ? { id: 'venue', ok: false, text: 'Market params do not hash to the market id' }
        : !ownToken
          ? { id: 'venue', ok: false, text: `${symbol} is not this market's ${wanted} token` }
          : { id: 'venue', ok: true, text: 'Market params match the market id' },
    )
    if (g.kind === 'repay') {
      gates.push(
        v.sharesForAmount <= v.borrowShares
          ? { id: 'debt', ok: true, text: 'Repay fits the borrow shares' }
          : { id: 'debt', ok: false, text: 'Repay exceeds the borrow' },
      )
    }
  }

  gates.push(
    read.balance >= amount
      ? { id: 'balance', ok: true, text: `Balance covers ${units(amount)}` }
      : {
          id: 'balance',
          ok: false,
          text: `Balance ${units(read.balance)}, short of ${units(amount)}${/^weth$/i.test(symbol) ? ' (ETH is not wrapped here)' : ''}`,
        },
  )
  return gates
}

/** The first failing gate, or null when all pass. */
export const firstBlocked = (gates: readonly Gate[]): Gate | null =>
  gates.find((x) => !x.ok) ?? null

/**
 * THE AMOUNT'S CEILING, for the slip's amount field (owner, Q27 round 5: prevent the error
 * before the reader pays): the smallest of what the wallet holds, the debt a repay can pay
 * (Aave: the variable-rate debt; Compound: the borrow) and the room under a supply cap.
 * Morpho's debt is in shares, so a Morpho repay is held to the balance here and its debt
 * gate stays the backstop.
 */
export interface AmountLimit {
  units: bigint
  why: 'balance' | 'debt' | 'cap'
  /** "Wallet holds 8.91 USDT", "Debt 243.47 USDT", "Room under the cap 0.24 WETH" */
  text: string
}

export function amountLimit(
  read: LeverChainRead,
  kind: 'repay' | 'add',
  symbol: string,
  shown: number,
): AmountLimit {
  const units = (x: bigint) => `${fmtUnits(x, read.decimals, shown)} ${symbol}`
  const all: AmountLimit[] = [
    { units: read.balance, why: 'balance', text: `Wallet holds ${units(read.balance)}` },
  ]
  const v = read.venue
  if (kind === 'repay') {
    if (v.venue === 'aave')
      all.push({ units: v.variableDebt, why: 'debt', text: `Variable-rate debt ${units(v.variableDebt)}` })
    else if (v.venue === 'compound')
      all.push({ units: v.borrow, why: 'debt', text: `Borrow ${units(v.borrow)}` })
  } else if (v.venue !== 'morpho' && v.capRoom !== null) {
    all.push({ units: v.capRoom, why: 'cap', text: `Room under the cap ${units(v.capRoom)}` })
  }
  // The first of the smallest: the balance wins a tie, it is the one the reader can change.
  return all.reduce((a, b) => (b.units < a.units ? b : a))
}
