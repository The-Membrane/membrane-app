/**
 * Low-volume reads (addresses, reserve lists, market params, decimals, sources): every one is
 * verified on a second backend group (100%, not a sample) and cached on disk once verified.
 */
import { join } from 'path'
import type { Hex } from 'viem'
import { callParams, ethCall, load, save, type Ctx, type SavedAnswer } from './ctx'
import type { ChainKey } from './rpc'
import { JsonlStore } from './store'
import type { Stored } from './verify'
import { decMulticall, encMulticall, MULTICALL3, type SubCall, type SubResult } from './abi'

let store: JsonlStore<SavedAnswer> | null = null

export async function setupCall(
  ctx: Ctx,
  output: string,
  chain: ChainKey,
  to: string,
  data: Hex,
  block: number,
): Promise<Stored> {
  if (!store) store = new JsonlStore<SavedAnswer>(join(ctx.stateDir, 'setup-calls.jsonl'))
  const k = `${chain}|${block}|${to.toLowerCase()}|${data}`
  const got = store.get(k)
  if (got && !ctx.pool.isQuarantined(chain, got.host)) return load(got)
  const s = await ethCall(ctx, chain, to, data, block)
  const { keep } = await ctx.verifier.check(
    output,
    chain,
    `setup:${k}`,
    'eth_call',
    callParams(to, data, block),
    s,
    'sample',
  )
  store.put(k, save(keep))
  return keep
}

/** Multicall3 aggregate3 (allowFailure) through setupCall. */
export async function setupMulticall(
  ctx: Ctx,
  output: string,
  chain: ChainKey,
  calls: SubCall[],
  block: number,
): Promise<SubResult[]> {
  const s = await setupCall(ctx, output, chain, MULTICALL3, encMulticall(calls), block)
  if (s.ans.revert)
    throw new Error(`${chain} multicall reverted at ${block}: ${s.ans.revert.message}`)
  return decMulticall(calls, s.ans.result as Hex)
}
