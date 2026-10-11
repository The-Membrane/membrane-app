/**
 * Display status of a feed action against a clock. Pure.
 *
 *   pending     a submitted change still inside its timelock window      → amber
 *   executable  window elapsed, not yet accepted or revoked              → amber
 *   accepted    a submit that was later executed                         → grey
 *   revoked     a submit that was revoked                                → grey
 *   cleared     contract shows nothing pending, outcome event not found  → grey
 *   executed    every non-submit action (it happened in its block)       → grey
 * Red is not a status: it marks membership of an exit cluster (clusters.ts).
 */

import { isSubmitKind } from './classify'
import type { ActionStatus, FeedAction } from './types'

export function statusOf(a: FeedAction, nowS: number): ActionStatus {
  if (!isSubmitKind(a.kind)) return 'executed'
  if (a.resolution) return a.resolution.how
  if (a.headPending === false) return 'cleared'
  if (a.validAt !== undefined && a.validAt > nowS) return 'pending'
  return 'executable'
}

export type Tone = 'amber' | 'grey' | 'red'

export const toneOf = (status: ActionStatus, inCluster: boolean): Tone =>
  inCluster ? 'red' : status === 'pending' || status === 'executable' ? 'amber' : 'grey'

/** Seconds left in the timelock window, or 0. */
export const secondsLeft = (a: FeedAction, nowS: number): number =>
  a.validAt !== undefined && !a.resolution ? Math.max(0, a.validAt - nowS) : 0
