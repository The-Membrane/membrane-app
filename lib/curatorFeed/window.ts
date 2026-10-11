/**
 * The rolling window. Pure.
 *
 * An incremental run appends new blocks; the window then starts at
 * max(previous start, head − MAX_DAYS × 7,200 blocks). Rows from before the start are
 * dropped — except submits still open at the head, which stay until they resolve (a
 * timelock can outlast the window, and an open amber row must never disappear).
 */

import { utcDay, type UnitFlow } from './flows'
import { isSubmitKind } from './classify'
import type { FeedFile } from './store'

export const BLOCKS_PER_DAY = 7_200

export const windowStart = (toBlock: number, maxDays: number, prevFrom?: number): number =>
  Math.max(prevFrom ?? 0, toBlock - maxDays * BLOCKS_PER_DAY)

export interface TrimResult {
  feed: Omit<FeedFile, 'meta'>
  dropped: { actions: number; attribution: number; spikes: number }
}

export function trimFeed(feed: Omit<FeedFile, 'meta'>, fromBlock: number): TrimResult {
  const keep = (b: number) => b >= fromBlock
  const actions = feed.actions.filter(
    (a) => keep(a.block) || (isSubmitKind(a.kind) && !a.resolution),
  )
  const attribution = feed.attribution.filter((c) => keep(c.block))
  const spikes = feed.spikes.filter((c) => keep(c.block))
  return {
    feed: { ...feed, actions, attribution, spikes },
    dropped: {
      actions: feed.actions.length - actions.length,
      attribution: feed.attribution.length - attribution.length,
      spikes: feed.spikes.length - spikes.length,
    },
  }
}

/** Keep daily rows from the window's first UTC day on (`fromTs` = the start block's time). */
export const trimFlows = (rows: UnitFlow[], fromTs: number): UnitFlow[] => {
  const first = utcDay(fromTs)
  return rows.filter((r) => r.day >= first)
}
