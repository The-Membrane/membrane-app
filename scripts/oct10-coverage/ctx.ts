/** Shared run context: RPC pool, verifier, paths, the window, and cached header / call helpers. */
import { join } from 'path'
import type { Hex } from 'viem'
import { RpcPool, toHex, type ChainKey, type RpcAnswer, normalizeAnswer } from './rpc'
import { JsonlStore } from './store'
import { Verifier, type Stored } from './verify'

export const START_TS = 1760054400 // 2025-10-10T00:00:00Z
export const STEPS = 2880
export const STEP_SEC = 60
export const minuteTs = (i: number) => START_TS + STEP_SEC * i

export interface Ctx {
  pool: RpcPool
  verifier: Verifier
  stateDir: string
  outDir: string
  /** membrane-datasets root, for inputs. */
  inputsDir: string
}

export interface Header {
  n: number
  ts: number
  hash: string
  host: string
  group: string
}

const headerStores = new Map<string, JsonlStore<Header>>()
function headerStore(ctx: Ctx, chain: ChainKey) {
  let s = headerStores.get(chain)
  if (!s) {
    s = new JsonlStore<Header>(join(ctx.stateDir, `headers.${chain}.jsonl`))
    headerStores.set(chain, s)
  }
  return s
}

export const headerNorm = (a: RpcAnswer) => {
  if (a.revert) return 'REVERT'
  const b = a.result as { number: string; hash: string; timestamp: string }
  return `${BigInt(b.number)}|${b.hash.toLowerCase()}|${BigInt(b.timestamp)}`
}

/** Block header (number, timestamp, hash), cached on disk. */
export async function header(ctx: Ctx, chain: ChainKey, n: number): Promise<Header> {
  const s = headerStore(ctx, chain)
  const k = String(n)
  const got = s.get(k)
  if (got && !ctx.pool.isQuarantined(chain, got.host)) return got
  const a = await ctx.pool.request(chain, 'eth_getBlockByNumber', [toHex(n), false])
  const b = a.result as { number: string; hash: string; timestamp: string }
  if (!b || BigInt(b.number) !== BigInt(n))
    throw new Error(`${chain} header ${n}: wrong block in answer`)
  const h: Header = {
    n,
    ts: Number(BigInt(b.timestamp)),
    hash: b.hash.toLowerCase(),
    host: a.host,
    group: a.group,
  }
  s.put(k, h)
  return h
}
export function putHeader(ctx: Ctx, chain: ChainKey, h: Header) {
  headerStore(ctx, chain).put(String(h.n), h)
}
export function cachedHeader(ctx: Ctx, chain: ChainKey, n: number) {
  return headerStore(ctx, chain).get(String(n))
}

/** One eth_call at a block, as a Stored answer (revert kept as an answer). */
export async function ethCall(
  ctx: Ctx,
  chain: ChainKey,
  to: string,
  data: Hex,
  block: number,
): Promise<Stored> {
  const ans = await ctx.pool.request(chain, 'eth_call', [{ to, data }, toHex(block)])
  return { norm: normalizeAnswer(ans), host: ans.host, group: ans.group, ans }
}
export const callParams = (to: string, data: Hex, block: number) => [{ to, data }, toHex(block)]

/** Serializable form of a Stored answer (what checkpoints hold). */
export interface SavedAnswer {
  r?: string
  rev?: string
  revData?: string
  host: string
  group: string
}
export function save(s: Stored): SavedAnswer {
  if (s.ans.revert)
    return { rev: s.ans.revert.message, revData: s.ans.revert.data, host: s.host, group: s.group }
  return { r: String(s.ans.result), host: s.host, group: s.group }
}
export function load(a: SavedAnswer): Stored {
  const ans: RpcAnswer =
    a.rev !== undefined
      ? { revert: { message: a.rev, data: a.revData }, host: a.host, group: a.group }
      : { result: a.r, host: a.host, group: a.group }
  return { norm: normalizeAnswer(ans), host: a.host, group: a.group, ans }
}
