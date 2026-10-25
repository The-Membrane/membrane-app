/**
 * THE TWO DOORS (framework "Reveal"): "Migrate this position" and "Deploy fresh", equal
 * weight, both prefilled from the replay's position.
 *
 * This is the typed seam the migrate agent (feat/migrate-flow) plugs into. The landing
 * builds a `PositionIntent` from whatever is on screen and calls `onMigrate(intent)` or
 * `onDeployFresh(intent)`; the handler opens a sheet. Until the migrate flow lands, the
 * page's own sheet (components/Landing/DoorSheet.tsx) renders the same rows with a
 * "Not live yet" note and the V20 intent-preserving connect.
 */

import type { ProtocolPosition } from '@/lib/position-sim'

export type Door = 'migrate' | 'fresh'

export interface IntentLeg {
  symbol: string
  /** Token address on the source chain, '' when entered by hand. */
  address: string
  amount: number
  valueUsd: number
}

export interface PositionIntent {
  /** Where the position on screen came from. */
  source: 'demo' | 'address' | 'manual'
  /** The wallet the replay read. Absent for a hand-entered position. */
  address?: `0x${string}`
  protocol: ProtocolPosition['protocol']
  venueLabel: string
  /** Morpho market id / Comet address. */
  marketId?: string
  collateral: IntentLeg[]
  debt: IntentLeg[]
  ltv: number
  /** The source venue's liquidation line. */
  venueLine: number
  /** The modelled Membrane line the replay used (no mainnet deployment exists). */
  membraneLine: number
  scenarioId: string
  /**
   * The raw position, unchanged. feat/migrate-flow's sheets take
   * `{ ...position, owner: address }` (lib/migrate/types.ts MigrateSource), so the
   * migrate agent mounts `<MigrateSheet position={{ ...intent.position, owner: intent.address }} />`
   * straight off this seam.
   */
  position: ProtocolPosition
}

export type DoorHandler = (intent: PositionIntent) => void

export interface DoorHandlers {
  onMigrate: DoorHandler
  /** Null when there is no position to prefill (a wallet with no borrow): a blank sheet. */
  onDeployFresh: (intent: PositionIntent | null) => void
}

export function intentFrom(
  p: ProtocolPosition,
  opts: { source: PositionIntent['source']; address?: `0x${string}`; membraneLine: number; scenarioId: string },
): PositionIntent {
  return {
    source: opts.source,
    address: opts.address,
    protocol: p.protocol,
    venueLabel: p.label,
    marketId: p.marketId,
    collateral: p.collateral.map((c) => ({ symbol: c.symbol, address: c.address, amount: c.amount, valueUsd: c.valueUsd })),
    debt: p.debt.map((d) => ({ symbol: d.symbol, address: d.address, amount: d.amount, valueUsd: d.valueUsd })),
    ltv: p.ltv,
    venueLine: p.liquidationLtv,
    membraneLine: opts.membraneLine,
    scenarioId: opts.scenarioId,
    position: p,
  }
}

// -------------------------------------------------------------- which doors

export type DoorAction = 'focus-input' | 'migrate' | 'fresh'

export interface DoorButton {
  action: DoorAction
  label: string
  /** Solid, first. At most one per set. */
  primary: boolean
}

/**
 * WHICH DOORS SHOW (owner ruling 2026-10-25). "Migrate this position" exists only when a
 * real wallet with a detected borrow is on screen: there is nothing to migrate from the
 * demo wallet, a hand-entered position, or a wallet with no borrow.
 */
export function doorSet(mode: 'demo' | 'address' | 'manual', hasBorrow: boolean): DoorButton[] {
  if (mode === 'demo')
    return [
      { action: 'focus-input', label: 'Paste your wallet', primary: true },
      { action: 'fresh', label: 'Open a position', primary: false },
    ]
  if (mode === 'manual') return [{ action: 'fresh', label: 'Open a position with these numbers', primary: true }]
  if (hasBorrow)
    return [
      { action: 'migrate', label: 'Migrate this position', primary: true },
      { action: 'fresh', label: 'Open a position', primary: false },
    ]
  return [{ action: 'fresh', label: 'Open a position', primary: true }]
}
