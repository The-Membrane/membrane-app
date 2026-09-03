import { useQuery } from '@tanstack/react-query'

import useWallet from '@/hooks/useWallet'

/**
 * Wallet-scoped retrospective events for the user's positions — the data
 * contract for the "named encounter" pipeline (docs/DOPAMINE_LOOP_ROADMAP.md §2:
 * sweep price history, detect qualifying events, compute per-user outcomes,
 * persist; populate retroactively on first visit).
 *
 * HONESTY RULE: this hook returns [] until that pipeline exists. It must never
 * synthesize events for a connected wallet — demo-mode fixtures are the demo
 * layer's job (components/Position/fixtures.ts ENCOUNTERS, rendered under
 * DemoBanner), never a connected user's "record".
 */

export type PositionEventKind =
  | 'survived'            // held through a named market event; attribution-to-self payload says why
  | 'cure_save'           // the cure window fired and the position recovered without a sale
  | 'partial_liquidation' // collateral was sold to bring the position back to cap
  | 'redemption'          // debt was redeemed against: debt shrinks, collateral NEVER moves
  | 'lesson'              // any bad outcome worth naming

export interface PositionEvent {
  /** Display date, e.g. "Aug 12, 2026". */
  when: string
  kind: PositionEventKind
  /** Failure stays unambiguous: bad events render in warning color, full volume. */
  bad: boolean
  title: string
  /** Body copy; supports **bold** and {neg}…{/neg} markup (Position/utils renderEmphasis). */
  body: string
  /** Attribution to self: how close it got, and why the user's sizing sufficed. */
  headroomLowWaterHours?: number
  /** Redemption legibility, rendered not told: debt delta in USD (negative). */
  debtDeltaUsd?: number
  /** Always 0 for redemptions — the type carries the invariant the UI must render. */
  collateralDeltaUsd?: 0
  /** Provenance stamp, e.g. "price data measured 2026-08-12 · block 21,904,118". */
  stamp: string
}

export const usePositionEvents = () => {
  const { address, isWalletConnected } = useWallet()

  return useQuery<PositionEvent[]>({
    queryKey: ['position_events', address ?? ''],
    staleTime: 1000 * 60 * 5,
    enabled: isWalletConnected && !!address,
    // TODO(dopamine-loop §2): read from the events store once the backend sweep
    // lands. Until then: honest empty — the UI shows "your record starts here".
    queryFn: async () => [],
  })
}

export default usePositionEvents
