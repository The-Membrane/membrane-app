/**
 * The adapter registry.
 *
 * ISOLATION IS THE POINT. Every adapter runs concurrently and is individually wrapped,
 * so a reverting Comet, a rate-limited RPC or an unimplemented protocol can never
 * blank the page or poison another protocol's result. `runAdapters` therefore NEVER
 * rejects — every outcome, including failure, comes back as an `AdapterResult` the UI
 * can render verbatim.
 *
 * STATUS MEANINGS (they are five different claims — do not collapse them):
 *   'ok'          we read this protocol and found at least one position
 *   'empty'       we read this protocol successfully; the address holds nothing
 *   'incomplete'  we read every market we could find and none held a position, but we
 *                 could not find every market (Morpho Blue discovery fell back); a
 *                 position elsewhere would not show, so this is NOT "nothing found"
 *   'error'       the read failed; `message` is the real error, shown as-is
 *   'unsupported' we never looked — this protocol has no reader yet (Fluid)
 */

import type { AdapterResult } from '../types'
import { aaveV3Adapter, sparkAdapter } from './aaveV3'
import { compoundV3Adapter } from './compoundV3'
import { fluidAdapter } from './fluid'
import { morphoBlueAdapter } from './morphoBlue'
import { PartialReadError, UnsupportedError, discoveryNote, type LendingAdapter } from './types'

export * from './types'
export {
  aaveV3Adapter,
  sparkAdapter,
  createAaveV3Adapter,
  aaveOracleUsdPrices,
  readEModeThresholds,
  inBitmap,
  type EModeThresholds,
  type EModeCollateral,
  type EModeReadInput,
  AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
  SPARK_MAINNET_ADDRESSES_PROVIDER,
} from './aaveV3'
export { morphoBlueAdapter, MORPHO_BLUE_MAINNET, MORPHO_DOLLAR_ASSUMPTION_NOTE } from './morphoBlue'
export { compoundV3Adapter, COMET_MAINNET_MARKETS, checkBaseInQuote, collectComets, cometPriceUsd, type CometMarket } from './compoundV3'
export { fluidAdapter, FLUID_UNSUPPORTED_MESSAGE } from './fluid'

/** Read order is display order. Aave first because it is the deepest market. */
export const ADAPTERS: readonly LendingAdapter[] = [
  aaveV3Adapter,
  sparkAdapter,
  morphoBlueAdapter,
  compoundV3Adapter,
  fluidAdapter,
] as const

/** A venue read that has not finished by then is reported as busy, never left "reading…". */
export const VENUE_DEADLINE_MS = 25_000

/** Thrown when a venue read passes its deadline: the public RPCs were too busy to answer. */
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`couldn't read ${label}: public RPC busy (no answer in ${ms / 1000} s)`)
    this.name = 'DeadlineError'
  }
}

/** `p`, or a DeadlineError once `ms` has passed. The read itself is abandoned, not awaited. */
function withDeadline<T>(p: Promise<T>, label: string, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new DeadlineError(label, ms)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(t))
}

/**
 * Runs one adapter and converts every outcome — including a throw, and a read past its
 * deadline (status 'error', `timedOut`) — into a result. A timed-out venue is a failed
 * venue: the page never says "No open position found" beside it.
 */
export async function runAdapter(
  adapter: LendingAdapter,
  address: `0x${string}`,
  deadlineMs: number = VENUE_DEADLINE_MS,
): Promise<AdapterResult> {
  const startedAt = Date.now()
  try {
    const positions = await withDeadline(adapter.read(address), adapter.label, deadlineMs).catch((e: unknown) => {
      // A sub-market dropped on a check, or a partial market discovery: keep what was read,
      // and name what was not. A dropped market with nothing left is still a failure.
      if (e instanceof PartialReadError && (e.positions.length > 0 || e.skipped.length === 0)) return e
      throw e
    })
    if (positions instanceof PartialReadError) {
      const { discovery, skipped } = positions
      const found = positions.positions.length > 0
      const partial = discovery !== undefined && !discovery.complete
      return {
        protocol: adapter.id,
        label: adapter.label,
        // Nothing found but not every market checked: never "empty", never "no position found".
        status: found ? 'ok' : partial ? 'incomplete' : 'empty',
        positions: positions.positions,
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(discovery ? { discovery } : {}),
        ...(found
          ? {}
          : { message: partial ? `no position in the markets checked: ${discoveryNote(discovery)}` : 'no position found' }),
        fetchedAt: Date.now(),
        tookMs: Date.now() - startedAt,
      }
    }
    return {
      protocol: adapter.id,
      label: adapter.label,
      status: positions.length > 0 ? 'ok' : 'empty',
      positions,
      message: positions.length > 0 ? undefined : 'no position found',
      fetchedAt: Date.now(),
      tookMs: Date.now() - startedAt,
    }
  } catch (e) {
    // An UnsupportedError is a declared gap in coverage, not a broken read. Keeping
    // the two apart is what lets the UI say "we did not check this" honestly.
    const unsupported = e instanceof UnsupportedError
    const message =
      e instanceof Error ? e.message : `unknown failure reading ${adapter.label}: ${String(e)}`
    return {
      protocol: adapter.id,
      label: adapter.label,
      status: unsupported ? 'unsupported' : 'error',
      positions: [],
      message,
      ...(e instanceof DeadlineError ? { timedOut: true } : {}),
      ...(e instanceof PartialReadError ? { skipped: e.skipped, ...(e.discovery ? { discovery: e.discovery } : {}) } : {}),
      fetchedAt: Date.now(),
      tookMs: Date.now() - startedAt,
    }
  }
}

/**
 * Reads every registered protocol for one address, in parallel.
 *
 * Uses Promise.all rather than allSettled deliberately: `runAdapter` already absorbs
 * every rejection, so nothing here can reject, and Promise.all keeps the return type
 * a plain `AdapterResult[]` in registry order.
 */
export async function runAdapters(address: `0x${string}`): Promise<AdapterResult[]> {
  return Promise.all(ADAPTERS.map((adapter) => runAdapter(adapter, address)))
}
