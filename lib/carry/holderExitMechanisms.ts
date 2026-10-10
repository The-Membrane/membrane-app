import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry, type CarryForecastRegistry } from './forecastRegistry'
import { verifiedDirectSupplyDestinations } from './forecastRegistryMarkets'
import { DIRECT_SUPPLY_MARKETS } from './directSupplyMarketConstants'
import { resolveHolderExitSubject } from './holderExitSubjectRegistry'

/** Frozen August board only. A separately verified market needs its own onboarding. */
export const HOLDER_EXIT_SPEC_VERSION = 'august-2026-frozen25-v1' as const

type StageKind =
  | 'atomic_exit'
  | 'request'
  | 'queue_wait'
  | 'cooldown_wait'
  | 'claim'
  | 'bridge_first_leg'
  | 'staking_first_leg'
  | 'wylds_intermediate'
  | 'usdc_intermediate'
  | 'unresolved_conversion'
  | 'pt_first_leg'
  | 'final_asset_delivery'

export type AssetRole = {
  /** Display hint only; no contract address may be inferred from a ticker. */
  symbolHint: string | null
  address: null
  identity: 'requires_verified_address'
}

export type HolderExitMechanism = {
  routeKey: string
  mechanism: 'atomic' | 'staged'
  /** The token the holder must receive after every required leg. */
  routeInputAsset: AssetRole
  requiredFinalAsset: AssetRole
  /** Ordered required actions; observations of an early step never prove final payout. */
  stages: readonly StageKind[]
  evidence: {
    baselineAndDatedTarget: 'same_holder_route_destination_exact_q_finalized'
    terminal:
      | 'simulated_exact_holder_final_asset_payout'
      | 'receipt_bound_same_episode_same_holder_final_asset_transfer'
  }
  forecastValidation: 'not_validated'
}
const VERIFIED_SUBJECT = Symbol('verified_frozen_holder_exit_subject')
const ISSUED_SUBJECTS = new WeakSet<object>()
export type HolderExitSubjectSpec = HolderExitMechanism & {
  destinationAddress: string
  /** Exact terminal payout identity, resolved before issuance; unknown units stay unsupported. */
  canonicalFinalAsset: Readonly<{ chainId: 1; address: string; decimals: number }> | null
  readonly [VERIFIED_SUBJECT]: true
}

// Token units from the independently frozen PAYOUTS catalog in
// scripts/lib/localCarryExitV2HistoricalRoster.mjs. That server module imports
// node:crypto, so keep this bounded address-keyed catalog browser-safe. These
// are original payout units, never intermediate tokens or vault/share units.
const CANONICAL_PAYOUT_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  '0x98a878b1cd98131b271883b390f68d2c90674665': 18, // apxUSD
  '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': 6, // AUSD
  '0x5f7827fdeb7c20b443265fc2f40845b715385ff2': 18, // EURCV
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 18, // GHO
  '0x514910771af9ca656af840dff83e8264ecf986ca': 18, // LINK
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 6, // PYUSD
  '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 18, // RLUSD
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 18, // USDe
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f': 18, // USDS
  '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, // USDT
})

function canonicalFinalAsset(
  routeKey: string,
  destinationAddress: string,
): HolderExitSubjectSpec['canonicalFinalAsset'] {
  try {
    const address = resolveHolderExitSubject(
      routeKey,
      destinationAddress as `0x${string}`,
    ).payoutAsset.toLowerCase()
    const decimals = CANONICAL_PAYOUT_DECIMALS[address]
    if (
      !/^0x[0-9a-f]{40}$/.test(address) ||
      !Object.hasOwn(CANONICAL_PAYOUT_DECIMALS, address) ||
      !Number.isSafeInteger(decimals)
    )
      return null
    return Object.freeze({ chainId: 1, address, decimals })
  } catch {
    return null
  }
}

/** Evidence gate for a future exact route×destination; it never validates a forecast. */
export type HolderExitOnboardingEvidence = {
  routeAndContractIdentityVerified: boolean
  inputAndFinalAssetAddressesVerified: boolean
  sameHolderExactQFinalizedBaseline: boolean
  sameHolderExactQFinalizedDatedTarget: boolean
  sameEpisodeFinalAssetReceipt: boolean
}

export function assessHolderExitOnboarding(
  subject: HolderExitSubjectSpec,
  evidence: HolderExitOnboardingEvidence,
): 'unsupported' | 'stage_only' | 'eligible_for_validation' {
  if (
    !subject ||
    !ISSUED_SUBJECTS.has(subject) ||
    subject[VERIFIED_SUBJECT] !== true ||
    !ROUTE_KEYS.includes(subject.routeKey) ||
    subject.mechanism !== (Object.hasOwn(STAGED, subject.routeKey) ? 'staged' : 'atomic') ||
    !/^0x[0-9a-f]{40}$/.test(subject.destinationAddress)
  )
    return 'unsupported'
  if (!evidence.routeAndContractIdentityVerified || !evidence.inputAndFinalAssetAddressesVerified) {
    return 'unsupported'
  }
  if (
    !evidence.sameHolderExactQFinalizedBaseline ||
    !evidence.sameHolderExactQFinalizedDatedTarget
  ) {
    return 'stage_only'
  }
  if (subject.mechanism === 'staged' && !evidence.sameEpisodeFinalAssetReceipt) return 'stage_only'
  return 'eligible_for_validation'
}

export type HolderExitProjectionQuestion = {
  routeKey: string
  destinationAddress: string
  owner: string
  finalAssetAddress: string
  finalAssetDecimals: number
  assetsRaw: string
}

/** Attestations supplied by an independent full-route execution verifier, never quotes/getters. */
export type HolderExitFinalAssetSimulation = {
  question: HolderExitProjectionQuestion
  originHost: string
  source: {
    chainId: 1
    blockNumber: number
    blockHash: string
    blockTime: string
    finalized: true
  }
  kind: 'full_route_execution'
  execution: 'single_call' | 'stateful_sequence'
  fullRouteExecutionVerified: boolean
  requiredStages: readonly { name: StageKind; status: 'executed' | 'condition_satisfied' }[]
  finalAssetAmountRaw: string
  status: 'simulated'
}
export type HolderExitConditionalProjectionEvidence = {
  question: HolderExitProjectionQuestion
  routeAndContractIdentityVerified: boolean
  inputAndFinalAssetAddressesVerified: boolean
  simulations: readonly HolderExitFinalAssetSimulation[]
}
export type HolderExitConditionalProjectionCapability = {
  minedPayoutObserved: false
  prospectiveValidated: false
} & (
  | { tier: 'conditional_projection'; executionEvidence: 'simulated' }
  | { tier: 'unsupported' | 'stage_only'; executionEvidence: null }
)

/** Separate simulation capability: leaves the legacy mined-receipt validation gate unchanged. */
export function assessHolderExitConditionalProjection(
  subject: HolderExitSubjectSpec,
  evidence: HolderExitConditionalProjectionEvidence,
): HolderExitConditionalProjectionCapability {
  const result = (
    tier: HolderExitConditionalProjectionCapability['tier'],
  ): HolderExitConditionalProjectionCapability =>
    tier === 'conditional_projection'
      ? {
          tier,
          executionEvidence: 'simulated',
          minedPayoutObserved: false,
          prospectiveValidated: false,
        }
      : { tier, executionEvidence: null, minedPayoutObserved: false, prospectiveValidated: false }
  const address = (v: unknown): v is string =>
    typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)
  const record = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const quantity = (v: unknown): v is string =>
    typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n
  try {
    const q = evidence.question
    if (
      !subject ||
      !ISSUED_SUBJECTS.has(subject) ||
      subject[VERIFIED_SUBJECT] !== true ||
      !record(evidence) ||
      !record(q) ||
      evidence.routeAndContractIdentityVerified !== true ||
      evidence.inputAndFinalAssetAddressesVerified !== true ||
      q.routeKey !== subject.routeKey ||
      !address(q.destinationAddress) ||
      q.destinationAddress.toLowerCase() !== subject.destinationAddress ||
      !address(q.owner) ||
      !subject.canonicalFinalAsset ||
      !address(q.finalAssetAddress) ||
      q.finalAssetAddress.toLowerCase() !== subject.canonicalFinalAsset.address ||
      q.finalAssetDecimals !== subject.canonicalFinalAsset.decimals ||
      !Number.isSafeInteger(q.finalAssetDecimals) ||
      q.finalAssetDecimals < 0 ||
      q.finalAssetDecimals > 255 ||
      !quantity(q.assetsRaw) ||
      BigInt(q.assetsRaw) === 0n
    )
      return result('unsupported')
    const matchesQuestion = (other: HolderExitProjectionQuestion) =>
      record(other) &&
      other.routeKey === q.routeKey &&
      address(other.destinationAddress) &&
      other.destinationAddress.toLowerCase() === q.destinationAddress.toLowerCase() &&
      address(other.owner) &&
      other.owner.toLowerCase() === q.owner.toLowerCase() &&
      address(other.finalAssetAddress) &&
      other.finalAssetAddress.toLowerCase() === q.finalAssetAddress.toLowerCase() &&
      other.finalAssetDecimals === q.finalAssetDecimals &&
      quantity(other.assetsRaw) &&
      other.assetsRaw === q.assetsRaw
    const proofs = evidence.simulations
    if (!Array.isArray(proofs) || proofs.length !== 2) return result('stage_only')
    for (const proof of proofs) {
      const s = proof.source
      if (
        !record(proof) ||
        !record(s) ||
        !matchesQuestion(proof.question) ||
        typeof proof.originHost !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(proof.originHost) ||
        s.chainId !== 1 ||
        s.finalized !== true ||
        !Number.isSafeInteger(s.blockNumber) ||
        s.blockNumber < 0 ||
        typeof s.blockHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(s.blockHash) ||
        typeof s.blockTime !== 'string' ||
        !Number.isSafeInteger(Date.parse(s.blockTime)) ||
        new Date(Date.parse(s.blockTime)).toISOString() !== s.blockTime ||
        proof.kind !== 'full_route_execution' ||
        !['single_call', 'stateful_sequence'].includes(proof.execution) ||
        proof.fullRouteExecutionVerified !== true ||
        proof.status !== 'simulated' ||
        !quantity(proof.finalAssetAmountRaw) ||
        BigInt(proof.finalAssetAmountRaw) < BigInt(q.assetsRaw) ||
        !Array.isArray(proof.requiredStages) ||
        proof.requiredStages.length !== subject.stages.length ||
        !subject.stages.every(
          (name, i) =>
            record(proof.requiredStages[i]) &&
            proof.requiredStages[i]?.name === name &&
            proof.requiredStages[i]?.status ===
              (name === 'queue_wait' || name === 'cooldown_wait'
                ? 'condition_satisfied'
                : 'executed'),
        )
      )
        return result('stage_only')
    }
    const [a, b] = proofs
    if (
      a.originHost.toLowerCase() === b.originHost.toLowerCase() ||
      a.source.blockNumber !== b.source.blockNumber ||
      a.source.blockHash.toLowerCase() !== b.source.blockHash.toLowerCase() ||
      a.source.blockTime !== b.source.blockTime ||
      a.finalAssetAmountRaw !== b.finalAssetAmountRaw ||
      a.execution !== b.execution
    )
      return result('stage_only')
    return result('conditional_projection')
  } catch {
    return result('unsupported')
  }
}

const role = (symbolHint: string | null): AssetRole => ({
  symbolHint,
  address: null,
  identity: 'requires_verified_address',
})

const ATOMIC = [
  'USDC → VaultV2 [USDC]',
  'EURCV → VaultV2 [EURCV]',
  'USDT → VaultV2 [USDT]',
  'AUSD → VaultV2 [AUSD]',
  'RLUSD → VaultV2 [RLUSD]',
  'LINK → VaultV2 [LINK]',
  'PYUSD → VaultV2 [PYUSD]',
  'USDT → supply on Spark',
  'USDC → supply on Aave V3',
  'USDC → supply on Compound v3',
  'USDC → Fluid USD Coin [USDC]',
  'USDT → fToken [USDT]',
  'GHO → fToken [GHO]',
  'USDS → StUsds [USDS]',
  'USDC → USD3 [USDC]',
  'USDS → SUsds [USDS]',
  'GHO → sGho [GHO]',
] as const

const STAGED: Readonly<Record<string, readonly StageKind[]>> = {
  'apxUSD → ApyUSD [apxUSD]': ['request', 'queue_wait', 'claim', 'final_asset_delivery'],
  'AUSD → Staked USDat [USDat]': ['request', 'queue_wait', 'claim', 'final_asset_delivery'],
  'GHO → UmbrellaStakeToken [GHO]': ['request', 'cooldown_wait', 'claim', 'final_asset_delivery'],
  'USDe → Staked USDe [USDe]': ['request', 'cooldown_wait', 'claim', 'final_asset_delivery'],
  'USDC → FluidBridgeAggregatorProxy [USDC]': ['bridge_first_leg', 'final_asset_delivery'],
  'USDT → FluidBridgeAggregatorProxy [USDC]': ['bridge_first_leg', 'final_asset_delivery'],
  'PYUSD → StakingVault [wYLDS]': [
    'staking_first_leg',
    'wylds_intermediate',
    'usdc_intermediate',
    'unresolved_conversion',
    'final_asset_delivery',
  ],
  'USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]': ['pt_first_leg', 'final_asset_delivery'],
}

const ROUTE_KEYS = [...ATOMIC, ...Object.keys(STAGED)]
if (ROUTE_KEYS.length !== 25 || new Set(ROUTE_KEYS).size !== 25) {
  throw new Error('holder_exit_spec_route_catalog_invalid')
}

/** Stable change detector over the exact route×destination roster, including duplicates across routes. */
export function holderExitSubjectFingerprint(keys: readonly string[]): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode([...keys].sort().join('\n'))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

// Includes exact subjects, route input display assets, identity provenance, and seed provenance.
// A change requires reviewing those identities and explicitly updating this pin.
export const FROZEN25_SUBJECT_FINGERPRINT = '632a0772c01e5126'

/** Permit the known supplemental Aave market, but reject changes to the frozen subject set. */
export function buildFrozenHolderExitMechanisms(registry: CarryForecastRegistry): {
  version: typeof HOLDER_EXIT_SPEC_VERSION
  subjects: number
  atomicGroups: number
  stagedGroups: number
  routes: HolderExitMechanism[]
  subjectSpecs: HolderExitSubjectSpec[]
} {
  const groups = registry.routeGroups.filter((group) => ROUTE_KEYS.includes(group.routeKey))
  const supplemental = registry.routeGroups.filter((group) => !ROUTE_KEYS.includes(group.routeKey))
  if (
    registry.chainId !== 1 ||
    groups.length !== 25 ||
    supplemental.length > 1 ||
    supplemental.some((group) => group.routeKey !== 'USDe → supply on Aave V3')
  ) {
    throw new Error('holder_exit_spec_frozen_groups_changed')
  }
  const seen = new Set<string>()
  const keys: string[] = []
  for (const group of groups) {
    if (seen.has(group.routeKey) || !group.contractSubjects.length) {
      throw new Error('holder_exit_spec_duplicate_or_empty_group')
    }
    seen.add(group.routeKey)
    for (const subject of group.contractSubjects) {
      if (subject.chainId !== 1 || !/^0x[0-9a-f]{40}$/.test(subject.destinationAddress)) {
        throw new Error('holder_exit_spec_subject_identity_invalid')
      }
      keys.push(
        [
          group.routeKey,
          group.borrowAsset,
          group.destination,
          subject.destinationAddress,
          subject.identitySource.kind,
          subject.identitySource.reference,
        ].join('\0'),
      )
    }
  }
  if (
    keys.length !== 67 ||
    new Set(keys).size !== 67 ||
    holderExitSubjectFingerprint([
      registry.provenance.cohortId,
      registry.provenance.declaredSourceSha256,
      ...keys,
    ]) !== FROZEN25_SUBJECT_FINGERPRINT
  ) {
    throw new Error('holder_exit_spec_frozen_subjects_changed')
  }
  const routes = groups.map(
    (group): HolderExitMechanism => ({
      routeKey: group.routeKey,
      mechanism: Object.hasOwn(STAGED, group.routeKey) ? 'staged' : 'atomic',
      routeInputAsset: role(group.borrowAsset),
      // The borrow ticker is not proof of the asset paid by the terminal exit.
      requiredFinalAsset: role(null),
      stages: STAGED[group.routeKey] ?? ['atomic_exit'],
      evidence: {
        baselineAndDatedTarget: 'same_holder_route_destination_exact_q_finalized',
        terminal: Object.hasOwn(STAGED, group.routeKey)
          ? 'receipt_bound_same_episode_same_holder_final_asset_transfer'
          : 'simulated_exact_holder_final_asset_payout',
      },
      forecastValidation: 'not_validated',
    }),
  )
  const byRoute = new Map(routes.map((route) => [route.routeKey, route]))
  const subjectSpecs = groups.flatMap((group) =>
    group.contractSubjects.map((subject) => {
      const spec = {
        ...byRoute.get(group.routeKey)!,
        destinationAddress: subject.destinationAddress,
        canonicalFinalAsset: canonicalFinalAsset(group.routeKey, subject.destinationAddress),
      }
      spec.stages = Object.freeze([...spec.stages])
      Object.freeze(spec.routeInputAsset)
      Object.freeze(spec.requiredFinalAsset)
      Object.freeze(spec.evidence)
      Object.defineProperty(spec, VERIFIED_SUBJECT, { value: true })
      Object.freeze(spec)
      ISSUED_SUBJECTS.add(spec)
      return spec as HolderExitSubjectSpec
    }),
  )
  return {
    version: HOLDER_EXIT_SPEC_VERSION,
    subjects: keys.length,
    atomicGroups: ATOMIC.length,
    stagedGroups: Object.keys(STAGED).length,
    routes,
    subjectSpecs,
  }
}

// Independently constructed canonical market metadata; callers cannot enroll
// supplemental contracts or supply a payout identity through an assessment.
const CANONICAL_ATOMIC_REGISTRY = buildCarryForecastRegistry(
  ROUTES,
  seed,
  recorderConfig.venues,
  '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
  verifiedDirectSupplyDestinations(),
)
export function buildCanonicalAtomicHolderExitSubjects(
  registry: CarryForecastRegistry,
): readonly HolderExitSubjectSpec[] {
  const frozen = buildFrozenHolderExitMechanisms(registry)
  const subjects = frozen.subjectSpecs.filter((subject) => subject.mechanism === 'atomic')
  const market = DIRECT_SUPPLY_MARKETS.aaveV3Usde
  const supplemental = registry.routeGroups.filter((group) => !ROUTE_KEYS.includes(group.routeKey))
  if (supplemental.length) {
    const canonical = CANONICAL_ATOMIC_REGISTRY.routeGroups.find(
      (group) => group.routeKey === market.routeKey,
    )
    if (
      !canonical ||
      supplemental.length !== 1 ||
      JSON.stringify(supplemental[0]) !== JSON.stringify(canonical)
    )
      throw new Error('holder_exit_spec_supplemental_identity_changed')
    const spec = {
      routeKey: market.routeKey,
      destinationAddress: market.destination.toLowerCase(),
      mechanism: 'atomic' as const,
      routeInputAsset: Object.freeze(role('USDe')),
      requiredFinalAsset: Object.freeze(role(null)),
      stages: Object.freeze(['atomic_exit'] as const),
      evidence: Object.freeze({
        baselineAndDatedTarget: 'same_holder_route_destination_exact_q_finalized' as const,
        terminal: 'simulated_exact_holder_final_asset_payout' as const,
      }),
      forecastValidation: 'not_validated' as const,
      canonicalFinalAsset: Object.freeze({
        chainId: 1 as const,
        address: market.underlying.toLowerCase(),
        decimals: market.decimals,
      }),
    }
    Object.defineProperty(spec, VERIFIED_SUBJECT, { value: true })
    Object.freeze(spec)
    ISSUED_SUBJECTS.add(spec)
    subjects.push(spec as HolderExitSubjectSpec)
  }
  return Object.freeze(subjects)
}
const ISSUED_ATOMIC_SUBJECTS = buildCanonicalAtomicHolderExitSubjects(CANONICAL_ATOMIC_REGISTRY)
/** Canonical registered native atomics only; unknown/staged inputs cannot self-issue. */
export function resolveIssuedHolderExitSubject(
  routeKey: string,
  destinationAddress: string,
): HolderExitSubjectSpec | null {
  if (
    typeof routeKey !== 'string' ||
    typeof destinationAddress !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)
  )
    return null
  return (
    ISSUED_ATOMIC_SUBJECTS.find(
      (subject) =>
        subject.routeKey === routeKey &&
        subject.destinationAddress === destinationAddress.toLowerCase(),
    ) ?? null
  )
}
