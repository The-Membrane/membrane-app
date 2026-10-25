/**
 * LANDING INSTRUMENTATION (framework funnel: wallets forecast → return visits → deploy
 * clicks → live positions).
 *
 * Typed events behind a sink that is a NO-OP by default. No third-party analytics: the
 * owner picks a sink. A first-party one already exists (/api/landing/event, which hashes
 * the address server-side); wiring it is one `setLandingSink` call and is the owner's
 * decision, so it is not made here.
 *
 * Event names map one-to-one onto the four funnel stages:
 *   wallet_run      a replay ran on a real wallet (paste, connect or shared link). The
 *                   framework calls the stage "wallets forecast"; the page runs a replay.
 *   return_visit    a remembered wallet came back (state 'returning' or 'changed').
 *   deploy_click    one of the two doors was opened (migrate or fresh).
 *   live_position   a position went live on Membrane. Typed now; nothing emits it until
 *                   the migrate flow (feat/migrate-flow) reports a confirmed position.
 */

import type { HeadlineKey } from './headline'
import type { VisitState } from './returnVisit'

export type LandingEvent =
  | {
      name: 'wallet_run'
      headline: HeadlineKey
      source: 'paste' | 'wallet' | 'link' | 'return' | 'manual'
      address?: string
      scenarioId: string
      protocols: string[]
    }
  | { name: 'return_visit'; headline: HeadlineKey; state: VisitState; address: string; sinceMs: number }
  | {
      name: 'deploy_click'
      headline: HeadlineKey
      door: 'migrate' | 'fresh'
      isDemo: boolean
      address?: string
      protocol: string
      debtUsd: number
    }
  | { name: 'live_position'; headline: HeadlineKey; door: 'migrate' | 'fresh'; address: string; positionId: string }

export type LandingEventName = LandingEvent['name']
export const LANDING_EVENT_NAMES: readonly LandingEventName[] = ['wallet_run', 'return_visit', 'deploy_click', 'live_position']

export type LandingSink = (e: LandingEvent & { at: number }) => void

const NOOP: LandingSink = () => {}
let sink: LandingSink = NOOP

export function setLandingSink(next: LandingSink | null): void {
  sink = next ?? NOOP
}

/** Fire-and-forget. A throwing sink never surfaces to the page. */
export function track(e: LandingEvent): void {
  try {
    sink({ ...e, at: Date.now() })
  } catch {
    /* measurement must never break the page */
  }
}
