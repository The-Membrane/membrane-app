// DESIGN STATES for the collect-dust slip (pages/dev/slip-states.tsx, dust-* keys). Every
// state is a REAL read captured by scripts/position/capture-slip-fixtures.ts --dust
// (dustFixtures.json): every supply position of a real address on Morpho Blue and Aave V3
// at one block, and the sweep's batch simulated from that address. The sheet comes from
// the real state machine (lib/position-exec/sheet.ts). Dev only: nothing is signed.
//
//   dust-ready                 a recent Aave borrower's priced dust: the sweep returns
//                              more than its gas at today's fee
//   dust-nothing-to-receive    the lender's zero-asset Morpho supplies alone: every row
//                              pays 0 (its own simulation)
//   dust-gas-exceeds-value     the lender's every dust position, one worth a fraction of
//                              a cent: the gas costs more than what comes back

import {
  defaultPicks,
  dustSheet,
  picked,
  pickedSim,
  splitDust,
  type DustCandidate,
} from '@/lib/position-exec/dust'
import type { DustRead } from '@/lib/position-exec/dustRead'
import { TX_IDLE, type SheetView, type WalletState } from '@/lib/position-exec/sheet'
import type { SimResult } from '@/lib/position-exec/simulate'

import raw from './dustFixtures.json'

const revive = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$bigint' in (v as Record<string, unknown>)
    ? BigInt((v as { $bigint: string }).$bigint)
    : v

interface Capture {
  read: DustRead
  sim: SimResult | null
}
const FIX = JSON.parse(JSON.stringify(raw), revive) as {
  capturedAt: string
  lender: Capture
  simZero: SimResult | null
  ready: Capture
}

export interface DustDesignState {
  key: string
  title: string
  forced: string | null
  owner: `0x${string}`
  dust: DustCandidate[]
  kept: { c: DustCandidate; why: 'unpriced' | 'worth' }[]
  sim: SimResult | null
  ethUsd: number | null
  block: number
  at: number
  source: string
  /** The sheet at the opening ticks (a row that pays nothing starts unticked). */
  sheet: SheetView
  /** The sheet for any ticks, as the slip recomputes it on a toggle. */
  sheetFor: (chosen: DustCandidate[], sim: SimResult | null) => SheetView
}

function state(
  key: string,
  title: string,
  cap: Capture,
  o: { only?: (c: DustCandidate) => boolean; sim?: SimResult | null; forced?: string } = {},
): DustDesignState {
  const split = splitDust(cap.read.candidates)
  const dust = o.only ? split.dust.filter(o.only) : split.dust
  const sim = o.sim !== undefined ? o.sim : cap.sim
  const owner = cap.read.owner
  const wallet: WalletState = { connected: true, address: owner, chainId: 1 }
  const sheetFor = (chosen: DustCandidate[], s: SimResult | null) =>
    dustSheet(chosen, s, wallet, TX_IDLE, owner)
  const picks = defaultPicks(dust)
  return {
    key,
    title,
    forced: o.forced ?? null,
    owner,
    dust,
    kept: split.kept,
    sim,
    ethUsd: cap.read.ethUsd,
    block: cap.read.block,
    at: Date.parse(FIX.capturedAt),
    source: cap.read.source,
    sheet: sheetFor(picked(dust, picks), pickedSim(sim, picks)),
    sheetFor,
  }
}

export const DUST_STATES: DustDesignState[] = [
  state('dust-ready', 'Collect dust: ready, returns more than its gas', FIX.ready),
  state('dust-nothing-to-receive', 'Collect dust: nothing to receive, clears the positions', FIX.lender, {
    only: (c) => c.assets === 0n,
    sim: FIX.simZero,
    forced: "the lender's read with the one position that has assets left out; the zero-asset rest simulated on its own",
  }),
  state('dust-gas-exceeds-value', 'Collect dust: gas costs more than it returns; zero rows start unticked', FIX.lender),
]
export const DUST_CAPTURED_AT = FIX.capturedAt
