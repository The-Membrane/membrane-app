// A Morpho market's oracle against the market price, daily for 30 days and now
// (lib/position/oracleGap.ts has the definition and the rules). Reads: the head block and
// one anchor 30 days of slots back; the oracle's price() at each daily block (archive
// reads, on the browser RPCs that serve them); DefiLlama's daily prices of both tokens.
// Reported market prices, on-chain oracle prices; a point either source misses is
// unobserved, never filled.

import { useQuery } from '@tanstack/react-query'

import { createMainnetClient } from '@/lib/position-sim/rpc'
import {
  GAP_DAYS,
  LLAMA_COINS_CHART_URL,
  SLOT_SECONDS,
  dailyBlocks,
  gapPoint,
  oraclePriceOf,
  parseCoinsChart,
  type GapPoint,
} from '@/lib/position/oracleGap'
import type { MorphoMarketParams } from '@/lib/position-sim/types'

/** Browser RPCs that answer past-block calls (publicnode wants a token for archive reads). */
const ARCHIVE_RPCS = ['https://eth.drpc.org', 'https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io'] as const

const oracleAbi = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const
const decimalsAbi = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const

export interface OracleGapRead {
  points: GapPoint[]
  fetchedAt: number
  /** Points whose oracle read failed (an endpoint without archive state, or a revert). */
  failedReads: number
}

let client: ReturnType<typeof createMainnetClient> | null = null
const archive = () => (client ??= createMainnetClient(ARCHIVE_RPCS))

export function useOracleGap(m: MorphoMarketParams | null) {
  return useQuery<OracleGapRead>({
    queryKey: ['position-oracle-gap', m?.oracle, m?.collateralToken, m?.loanToken],
    enabled: !!m && m.collateralToken !== null,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      const p = m as MorphoMarketParams
      const coll = p.collateralToken as `0x${string}`
      const c = archive()
      const head = await c.getBlock()
      const anchorGuess = head.number - BigInt(Math.round((GAP_DAYS * 86_400) / SLOT_SECONDS))
      const [anchor, collDecimals] = await Promise.all([
        c.getBlock({ blockNumber: anchorGuess }),
        c.readContract({ address: coll, abi: decimalsAbi, functionName: 'decimals' }),
      ])
      const days = dailyBlocks({ number: head.number, ts: Number(head.timestamp) }, { number: anchor.number, ts: Number(anchor.timestamp) })
      const start = days[0].ts - 86_400
      const chart = fetch(
        `${LLAMA_COINS_CHART_URL}ethereum:${coll},ethereum:${p.loanToken}?start=${start}&span=${GAP_DAYS + 3}&period=1d&searchWidth=600`,
      ).then(async (r) => {
        if (!r.ok) throw new Error(`DefiLlama HTTP ${r.status}`)
        return parseCoinsChart(await r.json())
      })
      // Today's point reads DefiLlama's current price (its chart's last day is midnight).
      const current = fetch(`https://coins.llama.fi/prices/current/ethereum:${coll},ethereum:${p.loanToken}`).then(async (r) => {
        if (!r.ok) throw new Error(`DefiLlama HTTP ${r.status}`)
        const b = (await r.json()) as { coins?: Record<string, { price?: number; timestamp?: number; confidence?: number }> }
        const out: Record<string, { price: number; timestamp: number; confidence: number | null }> = {}
        for (const [k, v] of Object.entries(b.coins ?? {})) {
          const a = k.split(':')[1]?.toLowerCase()
          if (a && typeof v.price === 'number' && typeof v.timestamp === 'number') out[a] = { price: v.price, timestamp: v.timestamp, confidence: v.confidence ?? null }
        }
        return out
      })
      const reads = await Promise.allSettled(
        days.map((d) => c.readContract({ address: p.oracle, abi: oracleAbi, functionName: 'price', blockNumber: d.block })),
      )
      const [prices, now] = await Promise.all([chart, current.catch(() => ({}) as Record<string, never>)])
      const key = (a: string) => a.toLowerCase()
      const withNow = (a: string) => {
        const base = prices[key(a)] ?? { confidence: null, prices: [] }
        const cur = (now as Record<string, { price: number; timestamp: number; confidence: number | null }>)[key(a)]
        return cur ? { confidence: cur.confidence ?? base.confidence, prices: [...base.prices, { timestamp: cur.timestamp, price: cur.price }] } : base
      }
      const loan = withNow(p.loanToken)
      const collateral = withNow(coll)
      const points = days.map((d, i) => {
        const r = reads[i]
        const price = r.status === 'fulfilled' ? oraclePriceOf(r.value as bigint, Number(collDecimals), p.loanDecimals) : null
        return gapPoint({ ts: d.ts, block: d.block, oraclePrice: price, loan, collateral })
      })
      return { points, fetchedAt: Date.now(), failedReads: reads.filter((r) => r.status === 'rejected').length }
    },
  })
}
