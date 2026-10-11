import type { Address } from 'viem'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from './forecastRegistry'
import { verifiedDirectSupplyDestinations } from './forecastRegistryMarkets'
import morphoIdentities from './morpho-v2-asset-identities.json'
import identities from './other-vault-asset-identities.json'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
// Canonical reader identities, without importing provider/ABI readers into the browser.
const GHO_SGHO = {
  destination: '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
  borrowAsset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
}
const APYUSD_ROUTE = 'apxUSD → ApyUSD [apxUSD]' as const
const APYUSD_VAULT = '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a' as Address
const APXUSD_ASSET = '0x98a878b1cd98131b271883b390f68d2c90674665' as Address
const STAKED_USDAT_ROUTE = 'AUSD → Staked USDat [USDat]' as const
const STAKED_USDAT_VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7' as Address
const PYUSD_STAKING_ROUTE = 'PYUSD → StakingVault [wYLDS]' as const
const HASTRA_STAKING_VAULT = '0x19ebb35279a16207ec4ba82799cc64715065f7f6' as Address
const PYUSD_TOKEN = '0x6c3ea9036406852006290770bedfcaba0e23a0e8' as Address
const SUSDS_ROUTE_KEY = 'USDS → SUsds [USDS]' as const
const SUSDS_VAULT = '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd' as Address
const USDS_ASSET = '0xdc035d45d973e3ec169d2276ddab16f1e407384f' as Address
const USD3_ROUTE_KEY = 'USDC → USD3 [USDC]' as const
const USD3_VAULT = '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc' as Address
const TWYNE_PT_ROUTE = 'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]' as const
const TWYNE_PT_WRAPPER = '0x0af56afbddcb140323445bd7211ba90e54e5fd1c' as Address
const UMBRELLA_GHO_ROUTE = 'GHO → UmbrellaStakeToken [GHO]' as const
const UMBRELLA_STKGHO = '0x4f827a63755855cdf3e8f3bcd20265c833f15033' as Address
const ORIGINAL_GHO = '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f' as Address
const FLUID_USDT_ROUTE = 'USDT → FluidBridgeAggregatorProxy [USDC]' as const
const FLUID_BRIDGE_VAULT = '0x273da948aca9261043fbdb2a857bc255ecc29012' as Address
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7' as Address
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const SGHO_ROUTE_KEY = 'GHO → sGho [GHO]' as const
const AUSD_ASSET = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a' as Address
const USDE_ASSET = '0x4c9edd5852cd905f086c759e8383e09bff1e68b3' as Address
const ROUTE_KEY = 'USDe → Staked USDe [USDe]'
const VAULT = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497' as Address
const USDE = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3' as Address
const SILO = '0x7FC7c91D556B400AFa565013E3F32055a0713425' as Address
const DECIMALS = 18
const TRACKED = [
  {
    routeKey: 'USDS → StUsds [USDS]',
    vault: '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    asset: '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    assetDecimals: 18,
    kind: 'spark_stusds',
  },
  {
    routeKey: 'USDC → Fluid USD Coin [USDC]',
    vault: '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_fusdc',
  },
  {
    routeKey: 'USDT → fToken [USDT]',
    vault: '0x5c20b550819128074fd538edf79791733ccedd18',
    asset: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    assetDecimals: 6,
    kind: 'fluid_fusdt',
  },
  {
    routeKey: 'GHO → fToken [GHO]',
    vault: '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    asset: '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
    assetDecimals: 18,
    kind: 'fluid_fgho',
  },
  {
    routeKey: 'USDC → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_bridge_usdc',
  },
  {
    routeKey: 'USDT → FluidBridgeAggregatorProxy [USDC]',
    vault: '0x273da948aca9261043fbdb2a857bc255ecc29012',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
    kind: 'fluid_bridge_usdc_first_leg',
  },
] as const

function resolveTrackedDirectVaultExitTarget(routeKey: string, destinationAddress: Address) {
  const target = TRACKED.find(
    (item) => item.routeKey === routeKey && same(item.vault, destinationAddress),
  )
  if (!target) throw new Error('tracked_direct_exit_target_unknown')
  if (
    identities.schemaVersion !== 1 ||
    identities.chainId !== 1 ||
    identities.cohortId !== 'aug-2026-ab-vault-routes' ||
    identities.entries.length !== 11
  )
    throw new Error('tracked_direct_exit_manifest_invalid')
  const identity = identities.entries.find((entry) => same(entry.vault, target.vault))
  if (
    !identity ||
    !same(identity.asset, target.asset) ||
    identity.exitMechanics !== 'unassessed' ||
    (target.kind.startsWith('fluid_bridge_usdc')
      ? identity.evidenceKind !== 'official_deployment_documentation'
      : target.kind.startsWith('fluid_') &&
        identity.evidenceKind !== 'fluid_factory_computed_and_listed')
  )
    throw new Error('tracked_direct_exit_manifest_invalid')
  return {
    ...target,
    vault: target.vault as Address,
    asset: identity.asset as Address,
  }
}

function resolveMorphoExitTarget(routeKey: string, destinationAddress: Address) {
  const registry = buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )
  const route = registry.routeGroups.find((group) => group.routeKey === routeKey)
  const subject = route?.contractSubjects.find(
    (entry) => entry.destinationAddress === destinationAddress.toLowerCase(),
  )
  if (!subject || subject.identitySource.kind !== 'august_observed') {
    throw new Error('morpho_route_destination_unknown')
  }
  if (
    morphoIdentities.schemaVersion !== 1 ||
    morphoIdentities.chainId !== 1 ||
    morphoIdentities.cohortId !== registry.provenance.cohortId ||
    morphoIdentities.entries.length !== 49 ||
    new Set(morphoIdentities.entries.map((entry) => entry.vault.toLowerCase())).size !== 49
  ) {
    throw new Error('morpho_identity_manifest_invalid')
  }
  const identity = morphoIdentities.entries.find((entry) => same(entry.vault, destinationAddress))
  if (!identity || !ADDRESS.test(identity.asset)) {
    throw new Error('morpho_route_destination_unknown')
  }
  return { vault: destinationAddress, asset: identity.asset as Address }
}

function resolveSusdeCooldownExitTarget(routeKey: string, destinationAddress: Address) {
  if (routeKey !== ROUTE_KEY || !same(destinationAddress, VAULT)) {
    throw new Error('susde_exit_target_unknown')
  }
  return { routeKey: ROUTE_KEY, vault: VAULT, asset: USDE, silo: SILO, decimals: DECIMALS }
}

export function resolveHolderExitSubject(routeKey: string, destinationAddress: Address) {
  const direct = Object.values(DIRECT_SUPPLY_MARKETS).find(
    (market) => market.routeKey === routeKey && same(market.destination, destinationAddress),
  )
  if (direct) return { kind: 'direct' as const, payoutAsset: direct.underlying as Address }
  if (routeKey === APYUSD_ROUTE && same(destinationAddress, APYUSD_VAULT))
    return { kind: 'apy' as const, payoutAsset: APXUSD_ASSET }
  if (routeKey === FLUID_USDT_ROUTE && same(destinationAddress, FLUID_BRIDGE_VAULT))
    return { kind: 'fluid_usdt' as const, payoutAsset: USDT }
  if (routeKey === SGHO_ROUTE_KEY && same(destinationAddress, GHO_SGHO.destination))
    return { kind: 'sgho' as const, payoutAsset: GHO_SGHO.borrowAsset as Address }
  if (routeKey === SUSDS_ROUTE_KEY && same(destinationAddress, SUSDS_VAULT))
    return { kind: 'susds' as const, payoutAsset: USDS_ASSET }
  if (routeKey === USD3_ROUTE_KEY && same(destinationAddress, USD3_VAULT))
    return { kind: 'usd3' as const, payoutAsset: USDC }
  if (routeKey === STAKED_USDAT_ROUTE && same(destinationAddress, STAKED_USDAT_VAULT))
    return { kind: 'staked_usdat' as const, payoutAsset: AUSD_ASSET }
  if (routeKey === TWYNE_PT_ROUTE && same(destinationAddress, TWYNE_PT_WRAPPER))
    return { kind: 'twyne_pt' as const, payoutAsset: USDE_ASSET }
  if (routeKey === PYUSD_STAKING_ROUTE && same(destinationAddress, HASTRA_STAKING_VAULT))
    return { kind: 'pyusd_staking' as const, payoutAsset: PYUSD_TOKEN }
  try {
    const target = resolveSusdeCooldownExitTarget(routeKey, destinationAddress)
    return { kind: 'susde' as const, payoutAsset: target.asset }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'susde_exit_target_unknown') throw error
  }
  if (routeKey === UMBRELLA_GHO_ROUTE && same(destinationAddress, UMBRELLA_STKGHO))
    return { kind: 'umbrella_gho' as const, payoutAsset: ORIGINAL_GHO }
  try {
    const target = resolveTrackedDirectVaultExitTarget(routeKey, destinationAddress)
    return { kind: 'tracked' as const, payoutAsset: target.asset }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'tracked_direct_exit_target_unknown')
      throw error
  }
  try {
    const target = resolveMorphoExitTarget(routeKey, destinationAddress)
    return { kind: 'morpho' as const, payoutAsset: target.asset }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'morpho_route_destination_unknown')
      throw error
  }
  throw new Error('holder_exit_subject_unsupported')
}
