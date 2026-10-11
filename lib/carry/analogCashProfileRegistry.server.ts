import morphoIdentities from './morpho-v2-asset-identities.json'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import type { AnalogCashProfile } from './venueForecastAnalogPrior'
import type { ConditionalSampledCashIdentity } from './conditionalSampledCashPathProjection'

// Deliberately reviewed assets. Unknown addresses never inherit a stable label.
const assets: Record<string, { decimals: number; risk: 'stable' | 'volatile' }> = {
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': { decimals: 6, risk: 'stable' },
  '0x514910771af9ca656af840dff83e8264ecf986ca': { decimals: 18, risk: 'volatile' },
  '0x5f7827fdeb7c20b443265fc2f40845b715385ff2': { decimals: 18, risk: 'stable' },
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': { decimals: 6, risk: 'stable' },
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': { decimals: 18, risk: 'stable' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { decimals: 6, risk: 'stable' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { decimals: 6, risk: 'stable' },
}
const profiles: AnalogCashProfile[] = Object.entries(DIRECT_SUPPLY_MARKETS).map(([name, m]) => ({
  identity: {
    routeKey: m.routeKey,
    destination: m.destination.toLowerCase(),
    asset: m.underlying.toLowerCase(),
    assetDecimals: m.decimals,
  },
  mechanismFamily: name === 'compoundV3Usdc' ? 'shared_bank_lending' : 'reserve_lending',
  cashMeaning: name === 'compoundV3Usdc' ? 'shared_bank_cash' : 'underlying_reserve',
  assetRiskClass: 'stable',
  mechanismVersion:
    name === 'compoundV3Usdc' ? 'comet_base_bank_balance_v1' : 'aave_v3_atoken_reserve_balance_v1',
  reviewedProfileRef: 'scripts/backfill-carry-cash-archive.mjs:readDirectCash/' + name,
}))
// A factory creation receipt establishes the deployed Morpho V2 mechanism;
// the exact cohort routes establish membership. Generic asset()/ERC4626 is insufficient.
for (const entry of morphoIdentities.entries) {
  const asset = assets[entry.asset]
  if (!asset) continue
  const routes = new Set(
    seed.positions
      .filter((position) => position.vault.toLowerCase() === entry.vault)
      .flatMap((position) => position.routeIds),
  )
  for (const routeKey of routes)
    profiles.push({
      identity: {
        routeKey,
        destination: entry.vault,
        asset: entry.asset,
        assetDecimals: asset.decimals,
      },
      mechanismFamily: 'allocated_vault',
      cashMeaning: 'unallocated_vault_cash',
      assetRiskClass: asset.risk,
      mechanismVersion: 'morpho_v2_idle_underlying_balance_v1',
      reviewedProfileRef: 'morpho-v2-factory-census:' + morphoIdentities.sourceArtifact.sha256,
    })
}
/** Returns an isolated profile only for an exact reviewed subject and native unit. */
export function reviewedAnalogCashProfile(subject: ConditionalSampledCashIdentity) {
  const profile = profiles.find(
    (p) =>
      p.identity.routeKey === subject.routeKey &&
      p.identity.destination === subject.destination &&
      p.identity.asset === subject.asset &&
      p.identity.assetDecimals === subject.assetDecimals,
  )
  return profile ? structuredClone(profile) : null
}
export function reviewedAnalogCashSubject(subject: {
  route_key: string
  destination: string
  asset: string
}) {
  const profile = profiles.find(
    (p) =>
      p.identity.routeKey === subject.route_key &&
      p.identity.destination === subject.destination &&
      p.identity.asset === subject.asset,
  )
  return profile ? structuredClone(profile) : null
}
export function compatibleAnalogCashProfiles(a: AnalogCashProfile, b: AnalogCashProfile) {
  return (
    a.mechanismFamily === b.mechanismFamily &&
    a.cashMeaning === b.cashMeaning &&
    a.assetRiskClass === b.assetRiskClass &&
    a.mechanismVersion === b.mechanismVersion
  )
}
