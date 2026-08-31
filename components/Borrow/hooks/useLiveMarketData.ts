import { useEffect, useRef, useState } from 'react'

/** Live overrides keyed by symbol — merge over the WALLET fixture, never replace it. */
export interface LiveMarketOverrides {
  px: Partial<Record<string, number>>
  yld: Partial<Record<string, number>>
  vol: Partial<Record<string, number>>
}

const EMPTY: LiveMarketOverrides = { px: {}, yld: {}, vol: {} }

/**
 * Best-effort live-data overlay, ported from public/proto/borrow.html's last
 * inline <script> (lines ~462-508): WBTC/wstETH spot price from
 * coins.llama.fi, stETH/sUSDS yield from yields.llama.fi, and WBTC realized
 * vol from the local breach-surface snapshot. Every fetch fails silently and
 * leaves the WALLET fixture untouched — this only ever adds a "live:" stamp
 * on top, per the proto's own comment: "everything unstamped is mock."
 */
export function useLiveMarketData(): { overrides: LiveMarketOverrides; liveLabels: string[] } {
  const [overrides, setOverrides] = useState<LiveMarketOverrides>(EMPTY)
  const [liveLabels, setLiveLabels] = useState<string[]>([])
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    const addLabel = (label: string) => {
      if (!mounted.current) return
      setLiveLabels((prev) => (prev.includes(label) ? prev : [...prev, label]))
    }

    fetch('https://coins.llama.fi/prices/current/coingecko:wrapped-bitcoin,coingecko:wrapped-steth')
      .then((r) => r.json())
      .then((j) => {
        const coins = j?.coins ?? {}
        const wbtc = coins['coingecko:wrapped-bitcoin']
        const wsteth = coins['coingecko:wrapped-steth']
        if (!mounted.current) return
        const px: Partial<Record<string, number>> = {}
        if (wbtc?.price) px.WBTC = Math.round(wbtc.price)
        if (wsteth?.price) px.wstETH = Math.round(wsteth.price)
        if (Object.keys(px).length) {
          setOverrides((prev) => ({ ...prev, px: { ...prev.px, ...px } }))
          addLabel('WBTC/wstETH prices (coins.llama.fi)')
        }
      })
      .catch(() => {})

    fetch('https://yields.llama.fi/pools')
      .then((r) => r.json())
      .then((j) => {
        type Pool = { symbol?: string; project?: string; tvlUsd?: number; apy?: number }
        const pools: Pool[] = j?.data ?? []
        const best = (symbol: string, projects?: string[]): number | null => {
          const matches = pools.filter(
            (p) => p.symbol === symbol && (!projects?.length || (p.project && projects.indexOf(p.project) >= 0))
          )
          const top = matches.reduce<Pool | undefined>(
            (acc, p) => (!acc || (p.tvlUsd ?? 0) > (acc.tvlUsd ?? 0) ? p : acc),
            undefined
          )
          return top?.apy ?? null
        }
        if (!mounted.current) return
        const yld: Partial<Record<string, number>> = {}
        const stEthApy = best('STETH', ['lido'])
        if (stEthApy != null) yld.wstETH = stEthApy
        const sUsdsApy = best('SUSDS', ['sky-lending', 'sky-savings-rate', 'spark', 'makerdao'])
        if (sUsdsApy != null) yld.sUSDS = sUsdsApy
        if (Object.keys(yld).length) {
          setOverrides((prev) => ({ ...prev, yld: { ...prev.yld, ...yld } }))
          addLabel('collateral yields (yields.llama.fi)')
        }
      })
      .catch(() => {})

    fetch('/data/breach-surface.json')
      .then((r) => r.json())
      .then((j) => {
        const v = j?.realized_vol?.vol
        if (!mounted.current) return
        if (typeof v === 'number' && v > 0 && v < 3) {
          setOverrides((prev) => ({ ...prev, vol: { ...prev.vol, WBTC: v } }))
          addLabel(`WBTC vol ${(v * 100).toFixed(1)}% (breach-surface, ${String(j?.measured_at ?? '').slice(0, 10)})`)
        }
      })
      .catch(() => {})

    return () => {
      mounted.current = false
    }
  }, [])

  return { overrides, liveLabels }
}

export default useLiveMarketData
