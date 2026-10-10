// Frozen historical denominator, independent of the larger prospective tuple registry.
import { createHash } from 'node:crypto'

import { CARRY_EXIT_V2_FROZEN_ROUTES } from './carry-exit-v2-rpc-proof.mjs'

export const LOCAL_CARRY_EXIT_V2_HISTORICAL_SCHEMA = 'local_carry_exit_v2_historical_roster_v1'
const FROZEN_MANIFEST_SHA256 = '9242f3b4178a8bffb68ac5c6a209bab844fe6fe0516690771a82b42bb0da8cb3'
const FROZEN_TUPLES = [
  [
    'apxUSD → ApyUSD [apxUSD]',
    '0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a',
    '0x98a878b1cd98131b271883b390f68d2c90674665',
  ],
  [
    'AUSD → Staked USDat [USDat]',
    '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    '0x23238f20b894f29041f48d88ee91131c395aaa71',
  ],
  [
    'AUSD → VaultV2 [AUSD]',
    '0x32401b9fb79065bc15949de0bd43927492f02f0c',
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  ],
  [
    'AUSD → VaultV2 [AUSD]',
    '0xbeeff0d672ab7f5018dfb614c93981045d4aa98a',
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  ],
  [
    'AUSD → VaultV2 [AUSD]',
    '0xbeeff0deac1aba71ef0d88c4291354eb92ef4589',
    '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
  ],
  [
    'EURCV → VaultV2 [EURCV]',
    '0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f',
    '0x5f7827fdeb7c20b443265fc2f40845b715385ff2',
  ],
  [
    'GHO → fToken [GHO]',
    '0x6a29a46e21c730dca1d8b23d637c101cec605c5b',
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  ],
  [
    'GHO → sGho [GHO]',
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  ],
  [
    'GHO → UmbrellaStakeToken [GHO]',
    '0x4f827a63755855cdf3e8f3bcd20265c833f15033',
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  ],
  [
    'LINK → VaultV2 [LINK]',
    '0x610f5b68bd1eed68af649a3fd3dc2caa1ee4ae7e',
    '0x514910771af9ca656af840dff83e8264ecf986ca',
  ],
  [
    'PYUSD → StakingVault [wYLDS]',
    '0x19ebb35279a16207ec4ba82799cc64715065f7f6',
    '0x6ad038ca6c04e885630851278ca0a856ad9a66cc',
  ],
  [
    'PYUSD → VaultV2 [PYUSD]',
    '0xb576765fb15505433af24fee2c0325895c559fb2',
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  ],
  [
    'PYUSD → VaultV2 [PYUSD]',
    '0xbeef00b5d83c1188f07a5184230a805639c39f04',
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  ],
  [
    'PYUSD → VaultV2 [PYUSD]',
    '0xc21b08c16458202593d4d9b26b9984ee67b38bbd',
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  ],
  [
    'RLUSD → VaultV2 [RLUSD]',
    '0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf',
    '0x8292bb45bf1ee4d140127049757c2e0ff06317ed',
  ],
  [
    'USDC → Fluid USD Coin [USDC]',
    '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → FluidBridgeAggregatorProxy [USDC]',
    '0x273da948aca9261043fbdb2a857bc255ecc29012',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → supply on Aave V3',
    '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → supply on Compound v3',
    '0xc3d688b66703497daa19211eedff47f25384cdc3',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → USD3 [USDC]',
    '0x056b269eb1f75477a8666ae8c7fe01b64dd55ecc',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x069662d2588fcac24b5c209456db965d151556f0',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x093272c07700d3ca5301c3bf9b3a392624179e2f',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x0bf0164d17469241b6e086da4016dcc54feaa334',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x153bd1abe60104bd46aa05a27fa12d1346d64a57',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x35cbe8542e70fa2f7f9cdf129f19e593f4b4f560',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x36cfe1568461e499391ef0a555300f1ae2da2439',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x56bfa6f53669b836d1e0dfa5e99706b12c373ecf',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x5dc53a23adc9f2bed98de6f59f7f309a7c71ff2b',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x69a238ae7ebeb3c53ff3b544e48b96a2142fc284',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x7ceb0f01cb7187a2ebed5661ecc4d5701d8f2350',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x8c106eedad96553e64287a5a6839c3cc78afa3d0',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x8edcc305e633d29bfb383872e79401c506ce9e6f',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x9480034d908989b006d78bdbbd7bd509c92e8bbc',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x951a9f4a2ce19b9dea6b37e691d076a345b6c0f8',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x9a1d6bd5b8642c41f25e0958129b85f8e1176f3e',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0x9f39b13bb472126d6937bf25a39338e664eefa82',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xa1b096268d200d0ecfd57015700f6a0da9c494e2',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xabe418cc8c06d265e4eb009c02ea4b265eca7240',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xb885f6d448da7e2c642ec31190b629e40e87b069',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xbeef088055857739c12cd3765f20b7679def0f51',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xbeeff047c03714965a54b671a37c18bef6b96210',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xbeeff75262b2ec16a3c62a807f02ee7627654931',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xbeefff4716a49418d69c251cab8759bb107e57c8',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xd1e9242e075db4bdd3f3c721d7d5fd4180a94a7e',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xd95fe7adf5075fad9d6bf853e0f9fe53369e8d96',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xe0181090c22579b6a217f1522cbf8c9f1f0c1965',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xe05fadf242331808f504661bea65972594869826',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xebbae8cfabb0092d5b32f00ebee0c8139d24ddcd',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDC → VaultV2 [USDC]',
    '0xf1ca44eea3a4effcb195a970a2f1d8553f76f9a1',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]',
    '0x0af56afbddcb140323445bd7211ba90e54e5fd1c',
    '0x59bc9fae5d62b19d4f8d07d758047acb9ee19d34',
  ],
  [
    'USDe → Staked USDe [USDe]',
    '0x9d39a5de30e57443bff2a8307a4256c8797a3497',
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  ],
  [
    'USDS → StUsds [USDS]',
    '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  ],
  [
    'USDS → SUsds [USDS]',
    '0xa3931d71877c0e7a3148cb7eb4463524fec27fbd',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  ],
  [
    'USDT → FluidBridgeAggregatorProxy [USDC]',
    '0x273da948aca9261043fbdb2a857bc255ecc29012',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  ],
  [
    'USDT → fToken [USDT]',
    '0x5c20b550819128074fd538edf79791733ccedd18',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → supply on Spark',
    '0xe7df13b8e3d6740fe17cbe928c7334243d86c92f',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0x2bd3a43863c07b6a01581fada0e1614ca5df0e3d',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0x85f3d81a39df458e45d5ea20f9eb937faafd282f',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0xbeef003c68896c7d2c3c60d363e8d71a49ab2bf9',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0xbeeff07d991c04cd640de9f15c08ba59c4fedeb7',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0xe571b648569619566cf6ce1060c97b621cb635d3',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDT → VaultV2 [USDT]',
    '0xf3557ad5e984211ac8a0874a670344f2c3376471',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
  ],
  [
    'USDe → supply on Aave V3',
    '0x4f5923fc5fd4a93352581b38b7cd26943012decf',
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  ],
]

const PAYOUTS = Object.freeze({
  apxUSD: ['0x98a878b1cd98131b271883b390f68d2c90674665', 18],
  AUSD: ['0x00000000efe302beaa2b3e6e1b18d08d69a9012a', 6],
  EURCV: ['0x5f7827fdeb7c20b443265fc2f40845b715385ff2', 18],
  GHO: ['0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f', 18],
  LINK: ['0x514910771af9ca656af840dff83e8264ecf986ca', 18],
  PYUSD: ['0x6c3ea9036406852006290770bedfcaba0e23a0e8', 6],
  RLUSD: ['0x8292bb45bf1ee4d140127049757c2e0ff06317ed', 18],
  USDC: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6],
  USDe: ['0x4c9edd5852cd905f086c759e8383e09bff1e68b3', 18],
  USDS: ['0xdc035d45d973e3ec169d2276ddab16f1e407384f', 18],
  USDT: ['0xdac17f958d2ee523a2206206994597c13d831ec7', 6],
})

export const LOCAL_CARRY_EXIT_V2_MISSING_REASONS = Object.freeze({
  'apxUSD → ApyUSD [apxUSD]': 'apyusd_receipt_claim_semantics_missing',
  'AUSD → Staked USDat [USDat]': 'saturn_final_ausd_delivery_semantics_missing',
  'PYUSD → StakingVault [wYLDS]': 'pyusd_final_payout_semantics_missing',
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]': 'pt_to_usde_final_delivery_semantics_missing',
  'USDe → Staked USDe [USDe]': 'susde_arbitrary_q_initiation_claim_semantics_missing',
  'USDT → FluidBridgeAggregatorProxy [USDC]': 'fluid_usdc_to_usdt_conversion_semantics_missing',
})

const DISPATCH_KINDS = new Set([
  'umbrella_gho',
  'morpho',
  'aave',
  'spark',
  'comet',
  'susds',
  'usd3',
  'stusds',
  'sgho',
])
const identity = (routeKey, destination, manifestAsset) =>
  [routeKey, destination, manifestAsset].join('\u001f')

/** Match historical manifest identities, never add prospective-only tuples. */
export function buildLocalCarryExitV2HistoricalRoster(registry = CARRY_EXIT_V2_FROZEN_ROUTES) {
  if (!Array.isArray(registry)) throw Error('historical_roster_registry_invalid')
  const registryByKey = new Map()
  for (const route of registry) {
    const key = identity(route.routeKey, route.destination, route.asset)
    if (registryByKey.has(key)) throw Error('historical_roster_registry_duplicate')
    registryByKey.set(key, route)
  }
  return Object.freeze(
    FROZEN_TUPLES.map(([routeKey, destination, manifestAsset], index) => {
      const originalPayoutSymbol = routeKey.split(' → ')[0]
      const [originalPayoutAsset, originalPayoutDecimals] = PAYOUTS[originalPayoutSymbol] ?? []
      if (!originalPayoutAsset) throw Error('historical_roster_payout_unknown')
      const subjectId = identity(routeKey, destination, manifestAsset)
      const matched = registryByKey.get(subjectId)
      const missingReason = LOCAL_CARRY_EXIT_V2_MISSING_REASONS[routeKey]
      // A registry entry alone cannot supply the missing staged final delivery.
      const dispatchSupported = !missingReason && matched && DISPATCH_KINDS.has(matched.kind)
      const coverageStatus =
        missingReason || !matched
          ? 'missing_final_delivery_semantics'
          : dispatchSupported
            ? 'prospective_registry_supported'
            : 'registry_present_dispatch_unproven'
      return Object.freeze({
        schema: LOCAL_CARRY_EXIT_V2_HISTORICAL_SCHEMA,
        subjectId,
        routeKey,
        destination,
        manifestAsset,
        originalPayoutSymbol,
        originalPayoutAsset,
        originalPayoutDecimals,
        manifestAssetIsOriginalPayout: manifestAsset === originalPayoutAsset,
        manifestAssetScope:
          manifestAsset === originalPayoutAsset ? 'original_payout_asset' : 'intermediate_asset',
        manifestIdentityDoesNotProveFinalDelivery: true,
        frozenManifestSha256: FROZEN_MANIFEST_SHA256,
        cohortId: index === 67 ? 'supplemental-aave-v3-usde-2026-09' : 'aug-2026-ab-vault-routes',
        supplemental: index === 67,
        registryPresent: Boolean(matched),
        registryKind: matched?.kind ?? null,
        coverageStatus,
        unavailableReason:
          missingReason ??
          (dispatchSupported
            ? null
            : matched?.kind === 'fluid'
              ? 'fluid_delivery_unproven'
              : matched
                ? 'registry_kind_dispatch_unproven'
                : 'historical_subject_registry_missing'),
        forecastValidated: false,
        holderExecutableExit: false,
      })
    }),
  )
}

export const LOCAL_CARRY_EXIT_V2_HISTORICAL_ROSTER = buildLocalCarryExitV2HistoricalRoster()

export function summarizeLocalCarryExitV2HistoricalRoster(
  roster = LOCAL_CARRY_EXIT_V2_HISTORICAL_ROSTER,
) {
  return Object.freeze({
    routeGroups: new Set(roster.map((row) => row.routeKey)).size,
    exactSubjects: roster.length,
    frozenRouteGroups: new Set(roster.filter((row) => !row.supplemental).map((row) => row.routeKey))
      .size,
    frozenSubjects: roster.filter((row) => !row.supplemental).length,
    supplementalSubjects: roster.filter((row) => row.supplemental).length,
    registryIntersection: roster.filter((row) => row.registryPresent).length,
    supportedDispatchSubjects: roster.filter(
      (row) => row.coverageStatus === 'prospective_registry_supported',
    ).length,
    presentDispatchUnprovenSubjects: roster.filter(
      (row) => row.coverageStatus === 'registry_present_dispatch_unproven',
    ).length,
    missingFinalDeliverySubjects: roster.filter(
      (row) => row.coverageStatus === 'missing_final_delivery_semantics',
    ).length,
    forecastValidated: false,
    holderExecutableExit: false,
  })
}

/** Slot rotation gives each historical subject a stable place in the denominator. */
export function selectLocalCarryExitV2HistoricalSubjects({ slotIndex, limit = 1 }) {
  if (
    !Number.isSafeInteger(slotIndex) ||
    slotIndex < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 68
  )
    throw Error('historical_roster_selection_invalid')
  const start = slotIndex % 68
  return Object.freeze(
    Array.from(
      { length: limit },
      (_, offset) => LOCAL_CARRY_EXIT_V2_HISTORICAL_ROSTER[(start + offset) % 68],
    ),
  )
}

/** Caller supplies original-payout Q; never reuse intermediate manifest units. */
export function buildLocalCarryExitV2HistoricalUnavailableAttempt({
  subjectId,
  slotAtUtc,
  assetsRaw,
}) {
  const subject = LOCAL_CARRY_EXIT_V2_HISTORICAL_ROSTER.find((row) => row.subjectId === subjectId)
  if (!subject || !subject.unavailableReason)
    throw Error('historical_roster_unavailable_subject_invalid')
  if (
    typeof slotAtUtc !== 'string' ||
    !Number.isFinite(Date.parse(slotAtUtc)) ||
    new Date(slotAtUtc).toISOString() !== slotAtUtc ||
    typeof assetsRaw !== 'string' ||
    !/^[1-9][0-9]*$/.test(assetsRaw) ||
    BigInt(assetsRaw) >= 1n << 256n
  )
    throw Error('historical_roster_attempt_invalid')
  const attemptId = createHash('sha256')
    .update(
      JSON.stringify([LOCAL_CARRY_EXIT_V2_HISTORICAL_SCHEMA, subjectId, slotAtUtc, assetsRaw]),
    )
    .digest('hex')
  return Object.freeze({
    attemptId: `historical-denominator-${attemptId}`,
    stage: 'historical_subject_dispatch',
    status: 'unavailable',
    routeKey: subject.routeKey,
    destination: subject.destination,
    asset: subject.originalPayoutAsset,
    decimals: subject.originalPayoutDecimals,
    assetsRaw,
    slotAtUtc,
    historicalSubjectId: subjectId,
    manifestAsset: subject.manifestAsset,
    manifestAssetScope: subject.manifestAssetScope,
    reason: subject.unavailableReason,
    authoritativeStore: 'local_carry_exit_v2',
    forecastValidated: false,
    holderExecutableExit: false,
  })
}
