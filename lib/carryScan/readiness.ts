/**
 * READINESS — can a Membrane vault actually reach this venue, and how (vault-ready
 * findings, membrane-solidity master 10626e40).
 *
 *   ready-cv        USDC ERC-4626 vault with a working maxWithdraw. A CuratorVault's curator
 *                   calls submitCap (CuratorVault.sol:1196); after the vault's 1–14 day
 *                   timelock (:154-155) anyone calls acceptCap. At most 10 venues per vault (:150).
 *   ready-dv        Aave v3 / Spark USDC reserve: a DeploymentVault from the `aave-v3`
 *                   implementation (script/DeployFullSystem.s.sol:868-869) with
 *                   venueData = abi.encode(pool, aToken) (DeploymentVaultAaveV3.sol:27).
 *                   One DV per venue (DeploymentVaultFactory.sol:327).
 *   needs-adapter   Morpho Vault V2 (maxWithdraw returns 0 per Morpho's docs), Compound v3,
 *                   stable LPs, LlamaLend, anything not ERC-4626.
 *   not-deployable  the asset is not USDC — "not deployable yet (vaults hold USDC)":
 *                   DeploymentVaultFactory.sol:322 and CuratorAllocator.sol:92 accept only
 *                   USDC/CDT. A vault-swap contract task is open (owner, 2026-10-10).
 *   unresolved      the scan found no deposit contract, so the venue type is unknown:
 *                   "address not resolved", never a guess at the type.
 *
 * An Unverified row has no segue and no CTA (design: "not ranked, not NEW, and gets no
 * CTA"); scoutReadiness and ctaFor enforce it. Otherwise the CTA is enabled only when
 * Membrane has launched, the factory addresses exist in config/evm/addresses.json (none do
 * today), the tier is ready-*, and there are no blockers. Before that the row reads
 * "After launch: <route>".
 */

import { encodeAbiParameters, getAddress } from 'viem'

import type { Readiness, ReadinessTier, ScoutKind, ScoutList, Segue } from './types'

/** Global blockers that apply to every USDC route today (static config). */
export const READINESS_BLOCKERS = {
  G1: 'G1: CuratorAllocator requires an 18-decimal paired asset (CuratorAllocator.sol:69-70), so 6-decimal USDC reverts',
  G3: 'G3: no per-venue fork conformance test exists yet (IExternalVenue4626.sol:7-13 requires one)',
} as const

export const NOT_DEPLOYABLE_LABEL = 'not deployable yet (vaults hold USDC)'
export const UNRESOLVED_ROUTE =
  'address not resolved: the scan found no deposit contract for this pool, so its venue type is unknown'

/** Membrane is not launched; flip only with the launch, together with config/evm/addresses.json. */
export const CARRY_SCOUT_LAUNCHED = false

const CV_KINDS: ScoutKind[] = ['metamorpho', 'erc4626', 'euler']
const DV_KINDS: ScoutKind[] = ['aave-reserve', 'spark-reserve']

export function readinessFor(row: {
  kind: ScoutKind
  stables: string[]
  withdraw?: 'instant' | 'queued'
  /** false = no deposit contract was found; `kind` is then a placeholder. Default true. */
  addressResolved?: boolean
}): Readiness {
  const allUsdc = row.stables.length > 0 && row.stables.every((s) => s.toUpperCase() === 'USDC')
  const blockers = [READINESS_BLOCKERS.G1, READINESS_BLOCKERS.G3]
  let tier: ReadinessTier
  let route: string
  if (!allUsdc) {
    tier = 'not-deployable'
    route = NOT_DEPLOYABLE_LABEL
    return {
      tier,
      blockers: ['asset is not USDC (DeploymentVaultFactory.sol:322, CuratorAllocator.sol:92)'],
      route,
    }
  }
  if (row.addressResolved === false) {
    return { tier: 'unresolved', blockers: ['address not resolved'], route: UNRESOLVED_ROUTE }
  }
  if (row.withdraw === 'queued') {
    tier = 'needs-adapter'
    route =
      'needs an adapter: exits wait on a queue or cooldown, so a vault could not withdraw on demand'
    return { tier, blockers: ['no adapter for a queued-exit venue'], route }
  }
  if (CV_KINDS.includes(row.kind)) {
    tier = 'ready-cv'
    route =
      'a CuratorVault curator calls submitCap; after the vault’s 1–14 day timelock anyone calls acceptCap'
  } else if (DV_KINDS.includes(row.kind)) {
    tier = 'ready-dv'
    route = 'a DeploymentVault from the aave-v3 implementation, venueData (pool, aToken)'
  } else {
    tier = 'needs-adapter'
    route =
      row.kind === 'morpho-vault-v2'
        ? 'needs an adapter: Morpho Vault V2 reports maxWithdraw = 0, so a CuratorVault could not withdraw'
        : 'needs an adapter: not an ERC-4626 venue a vault can hold'
    return { tier, blockers: ['no adapter for this venue type'], route }
  }
  return { tier, blockers, route }
}

export function segueFor(
  row: { kind: ScoutKind; address: string | null; aavePool?: string | null },
  r: Readiness,
): Segue {
  if (!row.address || (r.tier !== 'ready-cv' && r.tier !== 'ready-dv')) return { kind: 'none' }
  const venue = getAddress(row.address)
  if (r.tier === 'ready-dv') {
    if (!row.aavePool) return { kind: 'none' }
    return {
      kind: 'dv-create',
      implId: 'aave-v3',
      venueData: encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [getAddress(row.aavePool), venue],
      ),
    }
  }
  return {
    kind: 'cv-propose',
    implId: 'erc4626',
    venueData: encodeAbiParameters([{ type: 'address' }], [venue]),
  }
}

/**
 * Readiness and segue for a listed scout row. An LP's type is known from its exposure, so
 * only a single-asset row without an address is `unresolved`. An Unverified row keeps its
 * readiness (it says what the venue is) but never gets a segue.
 */
export function scoutReadiness(row: {
  list: ScoutList
  kind: ScoutKind
  stables: string[]
  address: string | null
  aavePool?: string | null
  withdraw?: 'instant' | 'queued'
}): { readiness: Readiness; segue: Segue } {
  const readiness = readinessFor({
    kind: row.kind,
    stables: row.stables,
    withdraw: row.withdraw,
    addressResolved: row.address !== null || row.kind === 'lp',
  })
  const segue: Segue =
    row.list === 'unverified'
      ? { kind: 'none' }
      : segueFor({ kind: row.kind, address: row.address, aavePool: row.aavePool }, readiness)
  return { readiness, segue }
}

export interface LaunchEnv {
  launched: boolean
  /** The DeploymentVaultFactory / CuratorVaultFactory addresses exist for chain 1 in config/evm/addresses.json. */
  factoriesConfigured: boolean
}

export function ctaEnabled(r: Readiness, env: LaunchEnv): boolean {
  return (
    env.launched &&
    env.factoriesConfigured &&
    (r.tier === 'ready-cv' || r.tier === 'ready-dv') &&
    r.blockers.length === 0
  )
}

export function ctaLabel(r: Readiness, env: LaunchEnv): string {
  if (r.tier === 'not-deployable') return NOT_DEPLOYABLE_LABEL
  if (r.tier === 'needs-adapter' || r.tier === 'unresolved') return r.route
  return ctaEnabled(r, env)
    ? r.tier === 'ready-cv'
      ? 'Propose to a curator'
      : 'Create a DeploymentVault'
    : `After launch: ${r.route}`
}

/** The row's CTA, or null: an Unverified row gets none. */
export function ctaFor(
  row: { list: ScoutList; readiness: Readiness },
  env: LaunchEnv,
): { enabled: boolean; label: string } | null {
  if (row.list === 'unverified') return null
  return { enabled: ctaEnabled(row.readiness, env), label: ctaLabel(row.readiness, env) }
}
