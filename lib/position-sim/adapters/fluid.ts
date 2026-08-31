/**
 * Fluid — DELIBERATE STUB. This adapter reads nothing and returns nothing.
 *
 * WHY IT IS NOT IMPLEMENTED YET: Fluid does not expose positions the way the other
 * three do. Debt and collateral live in per-vault NFT positions, and enumerating them
 * for an address means going through the VaultResolver (`positionsByUser`, plus the
 * per-vault `VaultT1`/`VaultT2` resolvers for the tick/branch accounting that turns a
 * raw position into a collateral amount, a debt amount and a liquidation threshold).
 * That is a materially different read path from Aave/Morpho/Comet, and the resolver
 * addresses are versioned per vault type.
 *
 * WHY IT IS A STUB RATHER THAN AN OMISSION: showing "Fluid: not implemented" is a
 * true statement. Leaving Fluid out of the registry entirely would let a user with a
 * real Fluid position believe the simulator found everything they hold. The registry
 * maps the UnsupportedError below to status 'unsupported', which the UI must render
 * as a gap in coverage — not as an empty wallet and not as a failure.
 *
 * DO NOT "temporarily" make this return fabricated legs to unblock the UI.
 */

import { UnsupportedError, type LendingAdapter } from './types'

export const FLUID_UNSUPPORTED_MESSAGE =
  'Fluid is not implemented. Enumerating a user\'s Fluid positions requires the Fluid VaultResolver (positionsByUser) plus per-vault-type resolvers to decode tick-based collateral and debt; that read path has not been built. No Fluid position is included in this simulation, so treat this protocol as unchecked rather than empty.'

export const fluidAdapter: LendingAdapter = {
  id: 'fluid',
  label: 'Fluid',
  async read(): Promise<never> {
    throw new UnsupportedError(FLUID_UNSUPPORTED_MESSAGE)
  },
}
