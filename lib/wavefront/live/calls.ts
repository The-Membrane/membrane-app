/** eth_call and Multicall3 at a block, through the engine's RPC seam. */
import type { Hex } from 'viem'
import {
  decMulticall,
  encMulticall,
  MULTICALL3,
  type SubCall,
  type SubResult,
} from '../../../scripts/oct10-coverage/abi'
import { toHex, type CallOpts, type ChainKey } from '../../../scripts/oct10-coverage/rpc'
import type { LiveRpc, RpcAnswer } from './rpc'

export async function ethCall(
  rpc: LiveRpc,
  chain: ChainKey,
  to: string,
  data: Hex,
  block: number,
  opts?: CallOpts,
): Promise<RpcAnswer> {
  return rpc.request(chain, 'eth_call', [{ to, data }, toHex(block)], opts)
}

/** Multicall3 aggregate3 (allowFailure) at `block`. A revert of the multicall itself throws. */
export async function multicall(
  rpc: LiveRpc,
  chain: ChainKey,
  calls: SubCall[],
  block: number,
  opts?: CallOpts,
  meta?: { host?: string; group?: string },
): Promise<SubResult[]> {
  if (!calls.length) return []
  const a = await ethCall(rpc, chain, MULTICALL3, encMulticall(calls), block, opts)
  if (meta) {
    meta.host = a.host
    meta.group = a.group
  }
  if (a.revert) throw new Error(`${chain} multicall reverted at ${block}: ${a.revert.message}`)
  if (typeof a.result !== 'string' || a.result === '0x')
    throw new Error(`${chain} multicall at ${block}: empty answer from ${a.host}`)
  return decMulticall(calls, a.result as Hex)
}

/** Run `fn` over items with at most `n` in flight (order of results = order of items). */
export async function pmap<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}
