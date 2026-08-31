/**
 * The adapter registry.
 *
 * ISOLATION IS THE POINT. Every adapter runs concurrently and is individually wrapped,
 * so a reverting Comet, a rate-limited RPC or an unimplemented protocol can never
 * blank the page or poison another protocol's result. `runAdapters` therefore NEVER
 * rejects — every outcome, including failure, comes back as an `AdapterResult` the UI
 * can render verbatim.
 *
 * STATUS MEANINGS (they are four different claims — do not collapse them):
 *   'ok'          we read this protocol and found at least one position
 *   'empty'       we read this protocol successfully; the address holds nothing
 *   'error'       the read failed; `message` is the real error, shown as-is
 *   'unsupported' we never looked — this protocol has no reader yet (Fluid)
 */

import type { AdapterResult } from '../types'
import { aaveV3Adapter, sparkAdapter } from './aaveV3'
import { compoundV3Adapter } from './compoundV3'
import { fluidAdapter } from './fluid'
import { morphoBlueAdapter } from './morphoBlue'
import { UnsupportedError, type LendingAdapter } from './types'

export * from './types'
export {
  aaveV3Adapter,
  sparkAdapter,
  createAaveV3Adapter,
  aaveOracleUsdPrices,
  AAVE_V3_MAINNET_ADDRESSES_PROVIDER,
  SPARK_MAINNET_ADDRESSES_PROVIDER,
} from './aaveV3'
export { morphoBlueAdapter, MORPHO_BLUE_MAINNET, MORPHO_DOLLAR_ASSUMPTION_NOTE } from './morphoBlue'
export { compoundV3Adapter, COMET_MAINNET_MARKETS } from './compoundV3'
export { fluidAdapter, FLUID_UNSUPPORTED_MESSAGE } from './fluid'

/** Read order is display order. Aave first because it is the deepest market. */
export const ADAPTERS: readonly LendingAdapter[] = [
  aaveV3Adapter,
  sparkAdapter,
  morphoBlueAdapter,
  compoundV3Adapter,
  fluidAdapter,
] as const

/** Runs one adapter and converts every outcome — including a throw — into a result. */
export async function runAdapter(
  adapter: LendingAdapter,
  address: `0x${string}`,
): Promise<AdapterResult> {
  const startedAt = Date.now()
  try {
    const positions = await adapter.read(address)
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
