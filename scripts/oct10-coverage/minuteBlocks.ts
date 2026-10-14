/**
 * Step 1: minute -> block, per chain. For minute start t_i the block in force is the HIGHEST block
 * with timestamp <= t_i (its post-state is the chain state at t_i; Arbitrum blocks share
 * timestamps, and "highest" picks the last of them). Each minute is found independently from a
 * linear guess between the window's end blocks, by bracket expansion then interpolation search
 * (alternating with bisection so it always converges), and is accepted only with both headers in
 * hand: ts(b) <= t_i < ts(b+1).
 */
import { join } from 'path'
import {
  header,
  headerNorm,
  minuteTs,
  putHeader,
  STEPS,
  START_TS,
  STEP_SEC,
  type Ctx,
  type Header,
} from './ctx'
import { toHex, type ChainKey } from './rpc'
import { JsonlStore, pmap, progress, writeJson } from './store'
import { inSample } from './verify'

/** Nominal seconds per block, for the first guess only. */
const BLOCK_SEC: Record<ChainKey, number> = { mainnet: 12, arbitrum: 0.25, optimism: 2, base: 2 }

export interface MinuteBlock {
  b: number
  ts: number
  nextTs: number
  hash: string
}

async function findLastLE(
  ctx: Ctx,
  chain: ChainKey,
  t: number,
  guess: number,
  rate: number,
): Promise<{ lo: Header; hi: Header }> {
  let g = await header(ctx, chain, Math.max(1, Math.round(guess)))
  let lo: Header
  let hi: Header
  if (g.ts <= t) {
    lo = g
    let step = Math.max(1, Math.ceil((t - g.ts) * rate))
    for (;;) {
      const h = await header(ctx, chain, lo.n + step)
      if (h.ts > t) {
        hi = h
        break
      }
      lo = h
      step *= 2
    }
  } else {
    hi = g
    let step = Math.max(1, Math.ceil((g.ts - t) * rate) + 1)
    for (;;) {
      const l = await header(ctx, chain, Math.max(1, hi.n - step))
      if (l.ts <= t) {
        lo = l
        break
      }
      hi = l
      step *= 2
    }
  }
  for (let k = 0; hi.n - lo.n > 1; k++) {
    let m: number
    if (k % 3 !== 2 && hi.ts > lo.ts) {
      // Estimated first block with ts >= t+1, minus one.
      m = lo.n + Math.ceil(((t + 1 - lo.ts) * (hi.n - lo.n)) / (hi.ts - lo.ts)) - 1
    } else m = Math.floor((lo.n + hi.n) / 2)
    m = Math.min(hi.n - 1, Math.max(lo.n + 1, m))
    const h = await header(ctx, chain, m)
    if (h.ts <= t) lo = h
    else hi = h
  }
  return { lo, hi }
}

export async function minuteBlocks(ctx: Ctx, chains: ChainKey[]) {
  const store = new JsonlStore<MinuteBlock>(join(ctx.stateDir, 'minute-blocks.jsonl'))
  const OUT = 'minute-blocks'
  await Promise.all(
    chains.map(async (chain) => {
      const head = Number(
        BigInt((await ctx.pool.request(chain, 'eth_blockNumber', [])).result as string),
      )
      const headH = await header(ctx, chain, head)
      const tEnd = minuteTs(STEPS - 1)
      const r0 = 1 / BLOCK_SEC[chain]
      const first = store.get(`${chain}:0`) ?? null
      const last = store.get(`${chain}:${STEPS - 1}`) ?? null
      const a =
        first ??
        (await (async () => {
          const { lo, hi } = await findLastLE(
            ctx,
            chain,
            START_TS,
            headH.n - (headH.ts - START_TS) * r0,
            r0,
          )
          const v = { b: lo.n, ts: lo.ts, nextTs: hi.ts, hash: lo.hash }
          store.put(`${chain}:0`, v)
          return v
        })())
      const z =
        last ??
        (await (async () => {
          const { lo, hi } = await findLastLE(ctx, chain, tEnd, a.b + (tEnd - START_TS) * r0, r0)
          const v = { b: lo.n, ts: lo.ts, nextTs: hi.ts, hash: lo.hash }
          store.put(`${chain}:${STEPS - 1}`, v)
          return v
        })())
      const rate = (z.b - a.b) / (tEnd - START_TS)
      const todo = [...Array(STEPS).keys()].filter((i) => !store.get(`${chain}:${i}`))
      const prog = progress(`blocks ${chain}`)
      let done = STEPS - todo.length
      await pmap(todo, 10, async (i) => {
        const t = minuteTs(i)
        const guess = a.b + (t - START_TS) * rate
        const { lo, hi } = await findLastLE(ctx, chain, t, guess, rate)
        if (!(lo.ts <= t && t < hi.ts && hi.n === lo.n + 1))
          throw new Error(`${chain} minute ${i}: bracket check failed`)
        store.put(`${chain}:${i}`, { b: lo.n, ts: lo.ts, nextTs: hi.ts, hash: lo.hash })
        prog(++done, STEPS)
      })
    }),
  )

  // Verification: a deterministic >= 4% sample of minutes, plus every minute whose block does not
  // advance monotonically, re-fetches b and b+1 on another backend group (number|hash|timestamp).
  for (const chain of chains) {
    const rows = [...Array(STEPS).keys()].map((i) => store.get(`${chain}:${i}`)!)
    const anomalies = new Set<number>()
    for (let i = 1; i < STEPS; i++) if (rows[i].b < rows[i - 1].b) anomalies.add(i)
    const picks = [...Array(STEPS).keys()].filter(
      (i) => inSample(`${chain}:minute:${i}`) || anomalies.has(i) || i === 0 || i === STEPS - 1,
    )
    await pmap(picks, 6, async (i) => {
      for (const n of [rows[i].b, rows[i].b + 1]) {
        const h = await header(ctx, chain, n)
        const stored = {
          norm: `${h.n}|${h.hash}|${h.ts}`,
          host: h.host,
          group: h.group,
          ans: { host: h.host, group: h.group },
        }
        const { keep, record } = await ctx.verifier.check(
          OUT,
          chain,
          `${chain}:${i}:${n}`,
          'eth_getBlockByNumber',
          [toHex(n), false],
          stored,
          anomalies.has(i) ? 'anomaly' : 'sample',
          headerNorm,
        )
        if (record.resolution === 'check') {
          const [nn, hash, ts] = keep.norm.split('|')
          putHeader(ctx, chain, {
            n: Number(nn),
            hash,
            ts: Number(ts),
            host: keep.host,
            group: keep.group,
          })
          store.put(`${chain}:${i}`, null as never) // force recompute on next run
          throw new Error(
            `${chain} minute ${i}: header ${n} replaced after a 2-of-3 vote; re-run to recompute`,
          )
        }
      }
    })
  }

  const out: Record<string, unknown> = {
    startTs: START_TS,
    stepSeconds: STEP_SEC,
    count: STEPS,
    rule: 'block = highest block with timestamp <= minute start t_i; verified ts(b) <= t_i < ts(b+1)',
    chains: {},
  }
  for (const chain of chains) {
    const rows = [...Array(STEPS).keys()].map((i) => store.get(`${chain}:${i}`)!)
    for (let i = 0; i < STEPS; i++) {
      const r = rows[i]
      if (!r || !(r.ts <= minuteTs(i) && minuteTs(i) < r.nextTs))
        throw new Error(`${chain} minute ${i}: invalid row`)
    }
    ;(out.chains as Record<string, unknown>)[chain] = {
      blocks: rows.map((r) => r.b),
      blockTs: rows.map((r) => r.ts),
      nextBlockTs: rows.map((r) => r.nextTs),
      hashes: rows.map((r) => r.hash),
    }
  }
  out.verification = ctx.verifier.stats(OUT)
  writeJson(join(ctx.outDir, 'minute-blocks.json'), out)
  return out
}

/** Load the minute -> block table (after step 1). */
export function loadMinuteBlocks(ctx: Ctx, chain: ChainKey): number[] {
  const store = new JsonlStore<MinuteBlock>(join(ctx.stateDir, 'minute-blocks.jsonl'))
  const rows = [...Array(STEPS).keys()].map((i) => store.get(`${chain}:${i}`))
  if (rows.some((r) => !r))
    throw new Error(`${chain}: minute blocks incomplete; run step blocks first`)
  return rows.map((r) => r!.b)
}
