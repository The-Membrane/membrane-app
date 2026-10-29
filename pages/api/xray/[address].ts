import type { NextApiRequest, NextApiResponse } from 'next'
import { isAddress, type Address } from 'viem'

import { effectiveLt, isStable, xrayMetrics } from '@/components/LiquidationMap/xrayLogic'
import { sameBand } from '@/components/LiquidationMap/liqmapLogic'
import {
  breachCurve,
  carryGap,
  historyBreaches,
  replayCrash,
} from '@/components/LiquidationMap/marketsLogic'
import {
  BINANCE_SYMBOL,
  ERC20_ABI,
  POOL,
  POOL_ABI,
  getClient,
  readDailyBars,
  readHourBars,
  readLayers,
  readMarket,
  readPastPrices,
} from '@/pages/api/_lib/aaveReads'

// GET /api/xray/[address] — Position X-ray for one Aave V3 Ethereum account
// (board Q26-TERMINAL-MAP). LIVE chain reads at request time; nothing modelled.
// The address is used for the read only: it is never logged or stored.

const YIELD_WINDOW_D = 30

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = String(req.query.address ?? '')
  if (!isAddress(raw)) return res.status(400).json({ error: 'not an address' })
  const user = raw as Address
  try {
    const c = getClient()
    const m = await readMarket(c)
    const [cfg, emode, acct] = await Promise.all([
      c.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: 'getUserConfiguration',
        args: [user],
      }),
      c.readContract({ address: POOL, abi: POOL_ABI, functionName: 'getUserEMode', args: [user] }),
      c.readContract({
        address: POOL,
        abi: POOL_ABI,
        functionName: 'getUserAccountData',
        args: [user],
      }),
    ])
    const used = m.reserves.filter((r) => ((cfg >> BigInt(2 * r.id)) & 3n) !== 0n)
    let em: { ltBps: number; bitmap: bigint } | null = null
    if (emode > 0n) {
      const [conf, bm] = await Promise.all([
        c.readContract({
          address: POOL,
          abi: POOL_ABI,
          functionName: 'getEModeCategoryCollateralConfig',
          args: [Number(emode)],
        }),
        c.readContract({
          address: POOL,
          abi: POOL_ABI,
          functionName: 'getEModeCategoryCollateralBitmap',
          args: [Number(emode)],
        }),
      ])
      em = { ltBps: Number(conf[1]), bitmap: bm }
    }
    const bals = await c.multicall({
      contracts: used.flatMap((r) => [
        { address: r.aToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] } as const,
        { address: r.vDebt, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] } as const,
      ]),
    })
    const reserves = used.map((r, j) => {
      const isColl = ((cfg >> BigInt(2 * r.id + 1)) & 1n) === 1n
      const a = bals[2 * j].status === 'success' ? (bals[2 * j].result as bigint) : 0n
      const d = bals[2 * j + 1].status === 'success' ? (bals[2 * j + 1].result as bigint) : 0n
      const px = Number(r.price) / 1e8
      const unit = 10 ** r.decimals
      return {
        symbol: r.symbol,
        priceUsd: px,
        lt: effectiveLt(r.ltBps, r.id, em),
        collateralUsd: isColl ? (Number(a) / unit) * px : 0,
        debtUsd: (Number(d) / unit) * px,
        stable: isStable(r.symbol),
        asset: r.asset,
        supplyApr: r.supplyApr,
        borrowApr: r.borrowApr,
      }
    })
    const x = xrayMetrics(reserves)
    const doc = readLayers()
    const crowd =
      doc && x.bandIndex !== null
        ? sameBand(doc, 'ethereum', x.riskType, x.mainCollateral, x.bandIndex)
        : null

    // Price risk: past windows that crossed this distance (Binance daily history).
    let history = null
    const sym = BINANCE_SYMBOL[x.mainCollateral]
    if (x.riskType === 'price' && sym && x.distance) {
      try {
        const bars = await readDailyBars(sym)
        if (bars.length > 60) {
          const h = historyBreaches(bars, x.distance, [1, 7, 30], 5)
          // Replay the worst distinct 7-day crashes that crossed this distance, opening the
          // same position (same distance) at the close before each crash.
          const d = x.distance
          const events = h['7d'].worst.filter((e) => e.drop >= d)
          const replays = await Promise.all(
            events.map(async (e) => {
              const start = Date.parse(e.start) - 86_400_000
              const prior = bars.find((b) => b.t === start)
              if (!prior) return null
              const hours = await readHourBars(sym, start + 86_400_000, 8 * 24)
              const r = replayCrash(hours, prior.close * (1 - d))
              return { start: e.start, drop: e.drop, ...r }
            }),
          )
          history = {
            source: `Binance ${sym} 1d since ${new Date(bars[0].t).toISOString().slice(0, 10)}`,
            '1d': { ...h['1d'], worst: h['1d'].worst.slice(0, 3) },
            '7d': { ...h['7d'], worst: h['7d'].worst.slice(0, 3) },
            '30d': { ...h['30d'], worst: h['30d'].worst.slice(0, 3) },
            replays: replays.filter(Boolean),
            // Past 7-day crossing share by distance (1–60 %), for the rules panel's safe size.
            curve: breachCurve(
              bars,
              Array.from({ length: 60 }, (_, i) => (i + 1) / 100),
            ),
          }
        }
      } catch {
        history = null
      }
    }

    // Ratio loops: carry gap at today's rates (30 d oracle-ratio growth vs WETH as the yield).
    let carry = null
    if (x.riskType === 'pair') {
      try {
        const past = await readPastPrices(m, YIELD_WINDOW_D)
        const weth = m.reserves.find((r) => r.symbol === 'WETH')
        const wNow = weth ? Number(weth.price) : 0
        const wOld = weth ? Number(past.get(weth.asset) ?? 0n) : 0
        const yieldApr = (asset: Address, stable: boolean) => {
          const now = Number(m.reserves.find((r) => r.asset === asset)?.price ?? 0n)
          const old = Number(past.get(asset) ?? 0n)
          if (stable || !now || !old || !wNow || !wOld) return 0
          return (Math.log(now / wNow / (old / wOld)) * 365) / YIELD_WINDOW_D
        }
        carry = {
          ...carryGap(
            reserves.map((r) => ({
              collateralUsd: r.collateralUsd,
              debtUsd: r.debtUsd,
              yieldApr: yieldApr(r.asset, r.stable),
              supplyApr: r.supplyApr,
              borrowApr: r.borrowApr,
            })),
            x.healthFactor,
          ),
          note: `collateral: ${YIELD_WINDOW_D} d oracle-ratio growth vs WETH + supply APR; debt: borrow APR; today's rates held constant`,
        }
      } catch {
        carry = null
      }
    }

    const aaveHf = acct[5] >= 2n ** 255n ? null : Number(acct[5]) / 1e18
    res.setHeader('Cache-Control', 'private, max-age=30')
    return res.status(200).json({
      chain: 'ethereum',
      readAt: new Date().toISOString(),
      marketBlock: Number(m.block),
      source: 'Aave V3 Ethereum Pool + AaveOracle, live reads',
      kind: 'measured',
      ...x,
      healthFactorAave: aaveHf,
      eMode: Number(emode),
      sameBand: crowd
        ? { ...crowd, asOf: doc?.chains.find((ch) => ch.chain === 'ethereum')?.readAt }
        : null,
      history,
      carry,
      reserves: reserves.map((r) => ({
        symbol: r.symbol,
        priceUsd: r.priceUsd,
        collateralUsd: r.collateralUsd,
        debtUsd: r.debtUsd,
        lt: r.lt,
        stable: r.stable,
        borrowApr: r.borrowApr,
      })),
    })
  } catch {
    return res.status(502).json({ error: 'chain read failed' })
  }
}
