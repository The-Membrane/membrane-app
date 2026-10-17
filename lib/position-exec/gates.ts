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
import type { LeverChainRead } from './read'

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
  if (v.venue === 'aave') {
    const f = v.flags
    const blocked = !f.active
      ? 'Reserve is not active'
      : f.paused
        ? 'Reserve is paused'
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
          : amount <= v.capRoom
            ? { id: 'cap', ok: true, text: `Supply cap room ${units(v.capRoom)}` }
            : { id: 'cap', ok: false, text: `Supply cap reached: room ${units(v.capRoom)}` },
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
      const room = v.capRoom ?? 0n
      gates.push(
        amount <= room
          ? { id: 'cap', ok: true, text: `Supply cap room ${units(room)}` }
          : {
              id: 'cap',
              ok: false,
              text:
                room === 0n
                  ? `Supply cap reached: no room for ${symbol}`
                  : `Supply cap reached: room ${units(room)}`,
            },
      )
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
