// "ALERT ME AT $P" — the last "Move your line" row. Mounts the shared control
// (components/Alerts/AlertMeAt.tsx) as a price alert on the position's history asset
// (asset:ETH / asset:BTC, the Chainlink USD feeds the alert store reads), owned by the
// address on the page, prefilled halfway between now and the line (lib/position/alert.ts).
//
// The asset's live price comes from this read when the position has a WETH / WBTC leg;
// otherwise (e.g. wstETH collateral) it is one read of the Aave V3 oracle for WETH / WBTC.
// The control hides itself while alert storage is off, and so does this row.

import React from 'react'
import { Box } from '@chakra-ui/react'
import { useQuery } from '@tanstack/react-query'

import { AlertMeAt } from '@/components/Alerts/AlertMeAt'
import { useAlertsStatus } from '@/components/Alerts/useAlertsStatus'
import { aaveOracleUsdPrices } from '@/lib/position-sim/adapters'
import { ALERT_REFERENCE, alertHalfway } from '@/lib/position/alert'
import { fmtMove, fmtUsd } from '@/lib/position/format'
import { floorPct } from '@/lib/position/touch'

import { Mono, Small } from './primitives'
import type { AlertInputs, PositionView } from './viewModel'

/** The asset's USD price now and when it was read: from the page's read, or one Aave V3 oracle read. */
function useReferencePrice(a: AlertInputs | null, readAt: number): { price: number | null; at: number | null } {
  const need = a !== null && a.referencePrice === null
  const asset = a?.asset ?? 'ETH'
  const q = useQuery({
    queryKey: ['position-alert-reference', asset],
    enabled: need,
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const token = ALERT_REFERENCE[asset].token
      const prices = await aaveOracleUsdPrices([token])
      const p = prices[token]
      if (!(p > 0)) throw new Error(`no Aave V3 oracle price for ${ALERT_REFERENCE[asset].symbol}`)
      return p
    },
  })
  if (!a) return { price: null, at: null }
  if (a.referencePrice !== null) return { price: a.referencePrice, at: readAt }
  return { price: q.data ?? null, at: q.data ? q.dataUpdatedAt : null }
}

export interface AlertMeSlotProps {
  view: PositionView
  /** The address on the page: the alert's owner. */
  address: string
}

export const AlertMeSlot: React.FC<AlertMeSlotProps> = ({ view, address }) => {
  const status = useAlertsStatus()
  const a = view.alert
  const { price, at } = useReferencePrice(a, view.position.provenance.at)
  if (!a || !status.data?.storage) return null

  const prefill = alertHalfway(price, a.distance, a.direction)
  const line = fmtMove(floorPct(a.distance), a.direction)
  return (
    <Box display="grid" minW={0}>
      <Mono minH="44px" display="flex" alignItems="center">
        {prefill
          ? `Alert me at ${a.asset} ${fmtUsd(prefill.price)} · halfway to your line (${line})`
          : `Alert me at a ${a.asset} price · your line ${line}`}
      </Mono>
      <Small>
        {a.asset} price from the {a.referenceSource}; the alert reads Chainlink {a.asset}/USD.
      </Small>
      <AlertMeAt
        metric="price"
        subject={`asset:${a.asset}`}
        currentValue={price}
        asOf={at !== null ? new Date(at).toISOString() : null}
        prefillValue={prefill?.price ?? null}
        defaultDirection={a.direction === 'fall' ? 'below' : 'above'}
        ownerAddress={address}
      />
    </Box>
  )
}
