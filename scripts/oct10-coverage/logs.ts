/**
 * A complete eth_getLogs scan of one block range on ONE host, chunked with a span that adapts
 * to what the host accepts (it reads the cap out of the refusal: "maximum 1000 blocks",
 * "limited to 1024 block range", "only 30000 are allowed"), cached on disk per host.
 *
 * One host's answer is never a fact on its own (board R33: a free endpoint can answer `[]` over
 * a range that holds logs). Callers scan the same range on two independent backend groups and
 * compare: ./scope.ts confirms every empty chunk of one host against the other's full scan.
 */
import { join } from 'path'
import type { Ctx } from './ctx'
import { toHex, type ChainKey } from './rpc'
import { JsonlStore } from './store'

export interface RawLog {
  address: string
  topics: string[]
  data: string
  block: number
  logIndex: number
  tx: string
}
export interface LogFilter {
  address?: string[]
  topics: (string | string[] | null)[]
}
export interface ScanResult {
  logs: RawLog[]
  calls: number
  /** [from, to, logs] per chunk, in order. */
  chunks: [number, number, number][]
  span: number
}

let store: JsonlStore<ScanResult> | null = null
/** Progress of an unfinished scan (a slow, rate-limited host resumes where it stopped). */
let partial: JsonlStore<ScanResult & { next: number }> | null = null

const lc = (s: string) => s.toLowerCase()

/** The cap a refusal names: the largest integer in the message below the span tried. */
function capFromError(msg: string, span: number): number | null {
  const nums = (msg.match(/\d[\d,]*/g) ?? []).map((x) => Number(x.replace(/,/g, '')))
  const ok = nums.filter((n) => n >= 10 && n < span)
  return ok.length ? Math.max(...ok) : null
}

export async function scanLogs(
  ctx: Ctx,
  chain: ChainKey,
  host: string,
  filter: LogFilter,
  from: number,
  to: number,
  opts: { maxCalls?: number; rateStrikes?: number } = {},
): Promise<ScanResult | { error: string }> {
  store ??= new JsonlStore<ScanResult>(join(ctx.stateDir, 'logs-scan.jsonl'))
  partial ??= new JsonlStore<ScanResult & { next: number }>(
    join(ctx.stateDir, 'logs-scan-partial.jsonl'),
  )
  const key = `${chain}|${host}|${JSON.stringify(filter)}|${from}|${to}`
  const got = store.get(key)
  if (got) return got
  const maxCalls = opts.maxCalls ?? 400
  const p0 = partial.get(key)
  const logs: RawLog[] = p0 ? [...p0.logs] : []
  const chunks: [number, number, number][] = p0 ? [...p0.chunks] : []
  let span = p0 ? p0.span : to - from + 1
  let calls = p0 ? p0.calls : 0
  let strikes = 0
  let lastErr = ''
  let b = p0 ? p0.next : from
  let sinceSave = 0
  while (b <= to) {
    const e = Math.min(to, b + span - 1)
    if (++calls > maxCalls) return { error: `span ${span} needs more than ${maxCalls} calls` }
    const r = await ctx.pool.requestOn(chain, host, 'eth_getLogs', [
      {
        ...(filter.address ? { address: filter.address } : {}),
        topics: filter.topics,
        fromBlock: toHex(b),
        toBlock: toHex(e),
      },
    ])
    if (r.error) {
      if (r.rate || /timeout|timed out|abort|HTTP 5|null result|fetch failed/i.test(r.error)) {
        if (++strikes > (r.rate ? (opts.rateStrikes ?? 6) : 12))
          return {
            error: `gave up after repeated ${r.rate ? 'rate limits' : 'errors'}: ${r.error}`,
          }
        // A server-side timeout on a topic-only query usually means the range is too heavy.
        if (/timed out|timeout/i.test(r.error)) span = Math.max(100, Math.floor(span / 2))
        await new Promise((res) => setTimeout(res, (r.rate ? 4000 : 1500) * Math.min(strikes, 4)))
        continue
      }
      // A named cap is taken as is; otherwise (or when the named cap was refused too) halve it.
      const cap = r.error === lastErr ? null : capFromError(r.error, span)
      lastErr = r.error
      const next = cap ?? Math.floor(span / 2)
      if (next < 10) return { error: `refused: ${r.error}` }
      span = next
      continue
    }
    strikes = 0
    const got = r.result as {
      address: string
      topics: string[]
      data: string
      blockNumber: string
      logIndex: string
      transactionHash: string
      removed?: boolean
    }[]
    for (const l of got) {
      if (l.removed) return { error: 'removed log in answer' }
      logs.push({
        address: lc(l.address),
        topics: l.topics.map(lc),
        data: lc(l.data),
        block: Number(BigInt(l.blockNumber)),
        logIndex: Number(BigInt(l.logIndex)),
        tx: lc(l.transactionHash),
      })
    }
    chunks.push([b, e, got.length])
    b = e + 1
    if (++sinceSave >= 5 && b <= to) {
      sinceSave = 0
      partial.put(key, { logs, calls, chunks, span, next: b })
    }
  }
  logs.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
  const res: ScanResult = { logs, calls, chunks, span }
  store.put(key, res)
  return res
}

export const logKey = (l: RawLog) => `${l.block}:${l.logIndex}:${l.tx}`
export const logBody = (l: RawLog) =>
  `${l.block}:${l.logIndex}:${l.tx}:${l.address}:${l.topics.join(',')}:${l.data}`
