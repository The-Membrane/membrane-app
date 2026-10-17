import { useEffect, useMemo, useState } from 'react'

import {
  anchorForRead,
  buildCostReward,
  costRewardReadKey,
  readRateAnchor,
  type RateAnchorReceipt,
} from '@/lib/position/costReward'
import { RATE_HISTORY } from '@/lib/position/rateHistory'
import { getMainnetClient } from '@/lib/position-sim/rpc'
import type { ProtocolPosition } from '@/lib/position-sim/types'

/** A pinned block's observation time, never the fetch clock, governs current-rate freshness. */
export function useCostReward(scope: string, position: ProtocolPosition) {
  const key = costRewardReadKey(scope, position)
  const [receipt, setReceipt] = useState<RateAnchorReceipt | null>(null)
  const [nowMs, setNowMs] = useState<number | null>(null)
  useEffect(() => {
    const update = () => setNowMs(Date.now())
    update()
    const timer = window.setInterval(update, 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    let current = true
    void readRateAnchor(
      key,
      position.chainId === 1 ? position.provenance.block : undefined,
      async (blockNumber) => {
        const block = await getMainnetClient().getBlock({ blockNumber })
        return { number: block.number, timestamp: block.timestamp }
      },
    ).then((next) => {
      if (current) setReceipt(next)
    })
    return () => {
      current = false
    }
  }, [key, position.provenance.block, position.chainId])
  const anchor = anchorForRead(key, receipt)
  return useMemo(
    () =>
      buildCostReward(position, RATE_HISTORY, {
        nowMs,
        observedAtMs: anchor?.observedAtMs ?? null,
        anchorState: anchor?.state ?? 'loading',
      }),
    [position, nowMs, anchor],
  )
}
