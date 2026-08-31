/**
 * The shared adapter contract for the position simulator.
 *
 * Every adapter is READ-ONLY and INDEPENDENT. An adapter throws on any failure it
 * cannot honestly recover from; the registry (./index.ts) catches that and turns it
 * into an `AdapterResult` so one broken protocol never blanks the page.
 *
 * DATA HONESTY RULE (enforced by convention, not by the compiler):
 *   an adapter NEVER returns a number it did not read. No default prices, no
 *   placeholder LTVs, no silent zeros. If a value is missing, `throw` with a message
 *   that names exactly which call failed — the message is rendered verbatim.
 */

import type { PublicClient } from 'viem'
import type { ProtocolId, ProtocolPosition } from '../types'

export interface LendingAdapter {
  id: ProtocolId
  label: string
  /** Reads every position this address holds on this protocol. Throws on failure —
   *  the registry catches and converts to an AdapterResult. */
  read(address: `0x${string}`): Promise<ProtocolPosition[]>
}

/**
 * Thrown by an adapter that is a deliberate, declared stub rather than a broken read.
 * The registry maps this to status 'unsupported' instead of 'error' so the UI can say
 * "we have not built this yet" rather than "this failed", which are different claims.
 */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedError'
  }
}

// ------------------------------------------------------------------ multicall

/** One entry of a viem `multicall({ allowFailure: true })` response. */
export type MulticallEntry<T> =
  | { status: 'success'; result: T; error?: undefined }
  | { status: 'failure'; result?: undefined; error: Error }

/** A single multicall leg. Kept structurally loose because the fan-outs below are
 *  built dynamically (per reserve / per market), which defeats viem's literal-type
 *  inference — the cast lives in `mc()` alone rather than at every call site. */
export interface Call {
  address: `0x${string}`
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

/**
 * Thin typed wrapper over `client.multicall({ contracts, allowFailure: true })`.
 *
 * `allowFailure: true` is deliberate everywhere: a single reverting reserve or market
 * must not take down the whole fan-out. Callers then decide, per leg, whether the
 * failure is fatal (`unwrap`) or tolerable (borrow APR → null).
 */
export async function mc<T>(client: PublicClient, contracts: Call[]): Promise<MulticallEntry<T>[]> {
  if (contracts.length === 0) return []
  const res = await client.multicall({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: contracts as any,
    allowFailure: true,
  })
  return res as unknown as MulticallEntry<T>[]
}

/** Reads a multicall leg or throws naming what failed. Never substitutes a default. */
export function unwrap<T>(entry: MulticallEntry<T> | undefined, what: string): T {
  if (!entry) throw new Error(`${what}: multicall returned no result for this leg`)
  if (entry.status === 'failure') {
    throw new Error(`${what}: ${entry.error?.message ?? 'call reverted'}`)
  }
  return entry.result
}

/** Reads a multicall leg, or null when it failed. Only for genuinely optional data
 *  (e.g. a borrow APR, which `DebtLeg.borrowApr` is allowed to report as null). */
export function optional<T>(entry: MulticallEntry<T> | undefined): T | null {
  if (!entry || entry.status === 'failure') return null
  return entry.result
}

// -------------------------------------------------------------------- numbers

/**
 * `numer / denom` with the degenerate cases spelled out rather than producing NaN:
 *   - denom > 0            → the real ratio
 *   - denom == 0, numer >0 → Infinity (an LTV with no collateral, or an HF with no
 *                            debt — both are genuinely unbounded, not zero)
 *   - denom == 0, numer==0 → 0
 * Callers render Infinity as '∞' / 'no debt'; they must not print it as a number.
 */
export function ratio(numer: number, denom: number): number {
  if (denom > 0) return numer / denom
  return numer > 0 ? Number.POSITIVE_INFINITY : 0
}

/**
 * Number of decimals encoded by a power-of-ten scale factor (Aave's
 * `BASE_CURRENCY_UNIT`, Compound's `AssetInfo.scale`). Throws rather than guessing
 * when the value is not a clean power of ten — that would mean our assumption about
 * the protocol's scaling is wrong, and silently rounding it would corrupt every
 * number downstream.
 */
export function decimalsFromScale(scale: bigint, what: string): number {
  if (scale <= 0n) throw new Error(`${what}: scale is ${scale}, expected a positive power of ten`)
  let d = 0
  let u = scale
  while (u > 1n) {
    if (u % 10n !== 0n) throw new Error(`${what}: scale ${scale} is not a power of ten`)
    u /= 10n
    d++
  }
  return d
}

/** Ceiling division for bigints. Morpho's share→asset conversion rounds debt UP,
 *  in the protocol's favour; reproducing that exactly matters at the margin. */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new Error('mulDivUp: division by zero')
  return (x * y + (d - 1n)) / d
}
