import { resolveRouteNewsSource } from './routeNewsSources'

/** Mechanism names describe route families. They never verify deployed code versions.
 * The frozen group counts exclude supplemental Aave USDe, which stays separate. */
const native = [
  ['AUSD → VaultV2 [AUSD]', 'morpho_v2'], ['EURCV → VaultV2 [EURCV]', 'morpho_v2'],
  ['LINK → VaultV2 [LINK]', 'morpho_v2'], ['PYUSD → VaultV2 [PYUSD]', 'morpho_v2'],
  ['RLUSD → VaultV2 [RLUSD]', 'morpho_v2'], ['USDC → VaultV2 [USDC]', 'morpho_v2'],
  ['USDT → VaultV2 [USDT]', 'morpho_v2'], ['GHO → UmbrellaStakeToken [GHO]', 'umbrella_stake'],
  ['GHO → fToken [GHO]', 'fluid_lending'], ['GHO → sGho [GHO]', 'aave_savings'],
  ['USDC → Fluid USD Coin [USDC]', 'fluid_vault'], ['USDC → FluidBridgeAggregatorProxy [USDC]', 'fluid_bridge'],
  ['USDC → USD3 [USDC]', 'usd3_savings'], ['USDC → supply on Aave V3', 'aave_v3_ethereum_core'],
  ['USDC → supply on Compound v3', 'compound_v3'], ['USDS → SUsds [USDS]', 'sky_savings'],
  ['USDS → StUsds [USDS]', 'sky_stusds'], ['USDT → fToken [USDT]', 'fluid_lending'],
  ['USDT → supply on Spark', 'spark_lending'], ['USDe → Staked USDe [USDe]', 'ethena_staking'],
  ['apxUSD → ApyUSD [apxUSD]', 'apyusd_savings'],
] as const
const foreign = [
  ['AUSD → Staked USDat [USDat]', 'saturn_staked_usdat', 'USDat', 'AUSD'],
  ['PYUSD → StakingVault [wYLDS]', 'hastra_staking', 'wYLDS', 'PYUSD'],
  ['USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]', 'twyne_pt_wrapper', 'PT-srUSDe-22OCT2026', 'USDe'],
  ['USDT → FluidBridgeAggregatorProxy [USDC]', 'fluid_bridge_conversion', 'USDC', 'USDT'],
] as const
export const PRIMARY_MEASURED_ROUTE_LINKS = [
  ...native.map(([routeKey, mechanism]) => ({ routeKey, mechanism, supplemental: false, lane: 'native_cash' as const })),
  ...foreign.map(([routeKey, mechanism, intermediateUnit, requestedPayoutUnit]) => ({ routeKey, mechanism,
    supplemental: false, lane: 'foreign_intermediate' as const, intermediateUnit, requestedPayoutUnit })),
  { routeKey: 'USDe → supply on Aave V3', mechanism: 'aave_v3_ethereum_core', supplemental: true, lane: 'native_cash' as const },
]
export function primaryMeasuredSourceLink(routeKey: string, destination: string) {
  const source = resolveRouteNewsSource(routeKey, destination), route = PRIMARY_MEASURED_ROUTE_LINKS.find(r => r.routeKey === routeKey)
  if (!source || !route) return null
  return { ...route, destination, newsSourceId: source.id,
    versionEvidence: 'route_mechanism_label_not_verified_deployed_code_version' as const,
    primaryFactLayer: 'native_measurements_separate_from_raw_headlines' as const,
    causalNewsEffect: false as const,
    conversionRequirements: route.lane === 'foreign_intermediate' ? [
      'qualified_original_native_entitlement_and_intermediate_asset_units',
      'same_source_typed_conversion_to_requested_payout_asset',
      'joint_gates_fees_pullability_and_competing_capacity',
    ] : [],
    holderHeadroomFromIntermediateRawAllowed: false as const }
}
