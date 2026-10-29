import type { NextApiRequest, NextApiResponse } from 'next'

import { isStable } from '@/components/LiquidationMap/xrayLogic'
import {
  borrowRate,
  feedBase,
  feedKind,
  kinkHeadroom,
  loopReturn,
  ratioYield,
} from '@/components/LiquidationMap/marketsLogic'
import {
  BINANCE_SYMBOL,
  readMarket,
  readPastPrices,
  readReserveDetails,
  readSpot,
} from '@/pages/api/_lib/aaveReads'

// GET /api/aave-markets — per-reserve market sheet for Aave V3 Ethereum
// (board Q26-TERMINAL-APP): oracle feed and its gap to Binance spot, feed age,
// supplied vs withdrawable now, utilization, rates, and the rate-curve kink.
// LIVE reads; protocol-scoped (no wallet). Cached 60 s at the edge.

export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const m = await readMarket()
    const det = await readReserveDetails(m)
    const spot = await readSpot(
      m.reserves.map((r) => BINANCE_SYMBOL[r.symbol]).filter((s): s is string => !!s),
    )
    const now = Math.floor(Date.now() / 1000)
    const rows = m.reserves.flatMap((r) => {
      const d = det.get(r.asset)
      if (!d || d.supplied === null) return []
      const unit = 10 ** r.decimals
      const px = Number(r.price) / 1e8
      const suppliedUsd = (Number(d.supplied) / unit) * px
      if (suppliedUsd < 1_000_000) return [] // dust reserves add rows, not information
      const availableUsd = Math.min(suppliedUsd, (Number(d.available ?? 0n) / unit) * px)
      const debtUnits = Number(d.debt ?? 0n) / unit
      const sp = BINANCE_SYMBOL[r.symbol] ? spot[BINANCE_SYMBOL[r.symbol]] : undefined
      // Utilization from balances (debt / (debt + available)) and the distance to the kink.
      const k = kinkHeadroom(debtUnits, Number(d.available ?? 0n) / unit, d.rate?.opt ?? 0)
      return [
        {
          symbol: r.symbol,
          stable: isStable(r.symbol),
          feed: d.feed,
          feedKind: feedKind(d.feed),
          oracleUsd: px,
          spotUsd: sp ?? null,
          gapPct: sp ? px / sp - 1 : null,
          feedAgeS: d.feedUpdatedAt ? now - d.feedUpdatedAt : null,
          suppliedUsd,
          withdrawableUsd: availableUsd,
          utilization: k.utilization,
          supplyApr: r.supplyApr,
          borrowApr: r.borrowApr,
          kink: d.rate?.opt ?? null,
          rateAtKink: d.rate ? d.rate.base + d.rate.s1 : null,
          rateAt95: d.rate ? borrowRate(0.95, d.rate) : null,
          borrowsToKinkUsd: d.rate && k.borrowsToKink !== null ? k.borrowsToKink * px : null,
          withdrawalsToKinkUsd:
            d.rate && k.withdrawalsToKink !== null ? k.withdrawalsToKink * px : null,
        },
      ]
    })
    rows.sort((a, b) => b.suppliedUsd - a.suppliedUsd)

    // Loop carry board: yield-bearing collateral (exchange-rate feeds) against its base asset's
    // borrow rate. Yield = 30 d growth of the oracle ratio to the base (archive read).
    const WINDOW_D = 30
    let carry: unknown[] = []
    try {
      const past = await readPastPrices(m, WINDOW_D)
      const bySym = new Map(m.reserves.map((r) => [r.symbol, r]))
      carry = rows
        .filter((row) => row.feedKind === 'exchange-rate (capped)')
        .flatMap((row) => {
          const r = bySym.get(row.symbol)
          const base = bySym.get(feedBase(row.feed) ?? '')
          if (!r || !base) return []
          const y = ratioYield(
            Number(r.price),
            Number(base.price),
            Number(past.get(r.asset) ?? 0n),
            Number(past.get(base.asset) ?? 0n),
            WINDOW_D,
          )
          if (y === null) return []
          const yieldApr = y + r.supplyApr
          return [
            {
              collateral: row.symbol,
              borrow: base.symbol,
              yieldApr,
              borrowApr: base.borrowApr,
              spread: yieldApr - base.borrowApr,
              at3x: loopReturn(yieldApr, base.borrowApr, 3),
              at5x: loopReturn(yieldApr, base.borrowApr, 5),
              collateralSuppliedUsd: row.suppliedUsd,
            },
          ]
        })
        .sort((a, b) => b.collateralSuppliedUsd - a.collateralSuppliedUsd)
    } catch {
      carry = []
    }
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120')
    return res.status(200).json({
      chain: 'ethereum',
      block: Number(m.block),
      readAt: new Date().toISOString(),
      kind: 'measured',
      source: 'Aave V3 Ethereum Pool, AaveOracle, feeds and rate strategies; Binance spot',
      rows,
      carry,
      carryWindowDays: 30,
    })
  } catch {
    return res.status(502).json({ error: 'chain read failed' })
  }
}
