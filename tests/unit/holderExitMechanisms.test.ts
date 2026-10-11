import { describe, expect, it, vi } from 'vitest'

import { ROUTES } from '@/components/Carry/fixtures'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  assessHolderExitOnboarding,
  assessHolderExitConditionalProjection,
  buildFrozenHolderExitMechanisms,
  type HolderExitConditionalProjectionEvidence,
} from '@/lib/carry/holderExitMechanisms'
import * as subjectRegistry from '@/lib/carry/holderExitSubjectRegistry'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitSubjectRegistry'
import { GHO_SGHO } from '@/scripts/route-rates/exact-leg-spread.mjs'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import recorderConfig from '@/tools/venue-recorder.config.json'

const registry = () =>
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    recorderConfig.venues,
    GHO_SGHO.destination,
    verifiedDirectSupplyDestinations(),
  )

function projectionFixture(routeKey = 'PYUSD → StakingVault [wYLDS]') {
  const subject = buildFrozenHolderExitMechanisms(registry()).subjectSpecs.find(
    (s) => s.routeKey === routeKey,
  )!
  const question = {
    routeKey,
    destinationAddress: subject.destinationAddress,
    owner: `0x${'b'.repeat(40)}`,
    finalAssetAddress: subject.canonicalFinalAsset!.address,
    finalAssetDecimals: subject.canonicalFinalAsset!.decimals,
    assetsRaw: '1000000',
  }
  const evidence: HolderExitConditionalProjectionEvidence = {
    question,
    routeAndContractIdentityVerified: true,
    inputAndFinalAssetAddressesVerified: true,
    simulations: ['one.example', 'two.example'].map((originHost) => ({
      question: { ...question },
      originHost,
      source: {
        chainId: 1,
        blockNumber: 26139032,
        blockHash: `0x${'a'.repeat(64)}`,
        blockTime: '2026-10-07T07:31:35.000Z',
        finalized: true,
      },
      kind: 'full_route_execution',
      execution: 'stateful_sequence',
      fullRouteExecutionVerified: true,
      requiredStages: subject.stages.map((name) => ({
        name,
        status:
          name === 'queue_wait' || name === 'cooldown_wait' ? 'condition_satisfied' : 'executed',
      })),
      finalAssetAmountRaw: '1000000',
      status: 'simulated',
    })),
  }
  return { subject, evidence }
}

describe('frozen holder exit mechanisms', () => {
  it('pins 25 groups and 67 exact subjects while excluding supplemental Aave USDe', () => {
    const result = buildFrozenHolderExitMechanisms(registry())
    expect(result).toMatchObject({ subjects: 67, atomicGroups: 17, stagedGroups: 8 })
    expect(result.routes).toHaveLength(25)
    expect(result.subjectSpecs).toHaveLength(67)
    expect(
      new Set(result.subjectSpecs.map((spec) => `${spec.routeKey}\0${spec.destinationAddress}`))
        .size,
    ).toBe(67)
    expect(result.routes.every((route) => route.forecastValidation === 'not_validated')).toBe(true)
    expect(result.routes.every((route) => route.requiredFinalAsset.address === null)).toBe(true)
    expect(result.routes.every((route) => route.requiredFinalAsset.symbolHint === null)).toBe(true)
    expect(
      result.routes
        .filter((route) => route.mechanism === 'staged')
        .every((route) => route.stages.at(-1) === 'final_asset_delivery'),
    ).toBe(true)
    expect(
      result.routes.find((route) => route.routeKey === 'PYUSD → StakingVault [wYLDS]')!.stages,
    ).toEqual([
      'staking_first_leg',
      'wylds_intermediate',
      'usdc_intermediate',
      'unresolved_conversion',
      'final_asset_delivery',
    ])
    expect(result.routes.map((route) => route.routeKey)).not.toContain('USDe → supply on Aave V3')
  })

  it('preserves distinct route inputs and ordered stages at shared destinations', () => {
    const result = buildFrozenHolderExitMechanisms(registry())
    const usdc = result.routes.find(
      (route) => route.routeKey === 'USDC → FluidBridgeAggregatorProxy [USDC]',
    )!
    const usdt = result.routes.find(
      (route) => route.routeKey === 'USDT → FluidBridgeAggregatorProxy [USDC]',
    )!
    expect(usdc.routeInputAsset.symbolHint).toBe('USDC')
    expect(usdt.routeInputAsset.symbolHint).toBe('USDT')
    expect(usdc.stages).toEqual(['bridge_first_leg', 'final_asset_delivery'])
    expect(usdt.stages).toEqual(usdc.stages)
  })

  it('fails closed when the frozen route or exact subject identity changes', () => {
    const changedRoute = registry()
    changedRoute.routeGroups[0].routeKey = 'new route'
    expect(() => buildFrozenHolderExitMechanisms(changedRoute)).toThrow(
      'holder_exit_spec_frozen_groups_changed',
    )
    const changedSubject = registry()
    changedSubject.routeGroups[0].contractSubjects[0].destinationAddress = '0x' + '1'.repeat(40)
    expect(() => buildFrozenHolderExitMechanisms(changedSubject)).toThrow(
      'holder_exit_spec_frozen_subjects_changed',
    )
    const changedInput = registry()
    changedInput.routeGroups[0].borrowAsset = 'WRONG'
    expect(() => buildFrozenHolderExitMechanisms(changedInput)).toThrow(
      'holder_exit_spec_frozen_subjects_changed',
    )
    const addedRoute = registry()
    addedRoute.routeGroups.push({ ...addedRoute.routeGroups[0], routeKey: 'new venue' })
    expect(() => buildFrozenHolderExitMechanisms(addedRoute)).toThrow(
      'holder_exit_spec_frozen_groups_changed',
    )
  })

  it('requires same-episode final asset payment before staged onboarding can be validated', () => {
    const specs = buildFrozenHolderExitMechanisms(registry()).subjectSpecs
    const staged = specs.find((spec) => spec.routeKey === 'USDe → Staked USDe [USDe]')!
    const atomic = specs.find((spec) => spec.routeKey === 'USDC → supply on Aave V3')!
    const evidence = {
      routeAndContractIdentityVerified: true,
      inputAndFinalAssetAddressesVerified: true,
      sameHolderExactQFinalizedBaseline: true,
      sameHolderExactQFinalizedDatedTarget: true,
      sameEpisodeFinalAssetReceipt: false,
    }
    expect(assessHolderExitOnboarding(staged, evidence)).toBe('stage_only')
    expect(assessHolderExitOnboarding(atomic, evidence)).toBe('eligible_for_validation')
    expect(
      assessHolderExitOnboarding(staged, { ...evidence, sameEpisodeFinalAssetReceipt: true }),
    ).toBe('eligible_for_validation')
    expect(
      assessHolderExitOnboarding(staged, {
        ...evidence,
        inputAndFinalAssetAddressesVerified: false,
      }),
    ).toBe('unsupported')
    expect(assessHolderExitOnboarding({ ...staged, mechanism: 'atomic' }, evidence)).toBe(
      'unsupported',
    )
    const inherited = Object.create(staged) as typeof staged
    Object.defineProperties(inherited, {
      routeKey: { value: atomic.routeKey },
      mechanism: { value: 'atomic' },
    })
    expect(assessHolderExitOnboarding(inherited, evidence)).toBe('unsupported')
    expect(Object.isFrozen(staged.stages)).toBe(true)
  })

  it('freezes canonical terminal token and units for all original 25 routes and 67 destinations', () => {
    const result = buildFrozenHolderExitMechanisms(registry())
    const units: Record<string, number> = {
      '0x98a878b1cd98131b271883b390f68d2c90674665': 18,
      '0x00000000efe302beaa2b3e6e1b18d08d69a9012a': 6,
      '0x5f7827fdeb7c20b443265fc2f40845b715385ff2': 18,
      '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': 18,
      '0x514910771af9ca656af840dff83e8264ecf986ca': 18,
      '0x6c3ea9036406852006290770bedfcaba0e23a0e8': 6,
      '0x8292bb45bf1ee4d140127049757c2e0ff06317ed': 18,
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
      '0x4c9edd5852cd905f086c759e8383e09bff1e68b3': 18,
      '0xdc035d45d973e3ec169d2276ddab16f1e407384f': 18,
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
    }
    expect(new Set(result.subjectSpecs.map((subject) => subject.routeKey)).size).toBe(25)
    expect(result.subjectSpecs).toHaveLength(67)
    for (const subject of result.subjectSpecs) {
      const asset = resolveHolderExitSubject(
        subject.routeKey,
        subject.destinationAddress as `0x${string}`,
      ).payoutAsset.toLowerCase()
      expect(subject.canonicalFinalAsset).toEqual({
        chainId: 1,
        address: asset,
        decimals: units[asset],
      })
      expect(Number.isSafeInteger(subject.canonicalFinalAsset!.decimals)).toBe(true)
      expect(Object.isFrozen(subject.canonicalFinalAsset)).toBe(true)
    }
    const payout = (routeKey: string) =>
      result.subjectSpecs.find((subject) => subject.routeKey === routeKey)!.canonicalFinalAsset
    expect(payout('AUSD → Staked USDat [USDat]')).toMatchObject({
      address: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
      decimals: 6,
    })
    expect(payout('USDe → AaveV3ATokenWrapper [PT-srUSDe-22OCT2026]')).toMatchObject({
      address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
      decimals: 18,
    })
    expect(payout('USDT → FluidBridgeAggregatorProxy [USDC]')).toMatchObject({
      address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      decimals: 6,
    })
  })
  it('keeps an issued subject with unknown canonical payout units unsupported without changing the legacy gate', () => {
    const { evidence } = projectionFixture()
    const original = subjectRegistry.resolveHolderExitSubject
    const spy = vi
      .spyOn(subjectRegistry, 'resolveHolderExitSubject')
      .mockImplementation((routeKey, destination) =>
        routeKey === 'PYUSD → StakingVault [wYLDS]'
          ? { kind: 'pyusd_staking' as const, payoutAsset: `0x${'c'.repeat(40)}` as `0x${string}` }
          : original(routeKey, destination),
      )
    try {
      const subject = buildFrozenHolderExitMechanisms(registry()).subjectSpecs.find(
        (entry) => entry.routeKey === evidence.question.routeKey,
      )!
      expect(subject.canonicalFinalAsset).toBeNull()
      expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('unsupported')
      expect(
        assessHolderExitOnboarding(subject, {
          routeAndContractIdentityVerified: true,
          inputAndFinalAssetAddressesVerified: true,
          sameHolderExactQFinalizedBaseline: true,
          sameHolderExactQFinalizedDatedTarget: true,
          sameEpisodeFinalAssetReceipt: true,
        }),
      ).toBe('eligible_for_validation')
    } finally {
      spy.mockRestore()
    }
  })
  it.each([
    { finalAssetAddress: `0x${'c'.repeat(40)}` },
    { finalAssetDecimals: 18 },
    { finalAssetAddress: `0x${'c'.repeat(40)}`, finalAssetDecimals: 18 },
    { finalAssetAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', finalAssetDecimals: 6 },
  ])('rejects mutually consistent incorrect canonical payout binding %j', (change) => {
    const { subject, evidence } = projectionFixture()
    Object.assign(evidence.question, change)
    for (const proof of evidence.simulations) Object.assign(proof.question, change)
    expect(
      evidence.simulations.every(
        (proof) => JSON.stringify(proof.question) === JSON.stringify(evidence.question),
      ),
    ).toBe(true)
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('unsupported')
  })
  it.each([
    'PYUSD → StakingVault [wYLDS]',
    'USDe → Staked USDe [USDe]',
    'USDC → supply on Aave V3',
  ])(
    'admits complete independently bound simulations only to the conditional tier: %s',
    (routeKey) => {
      const { subject, evidence } = projectionFixture(routeKey)
      const before = structuredClone(evidence)
      expect(assessHolderExitConditionalProjection(subject, evidence)).toEqual({
        tier: 'conditional_projection',
        executionEvidence: 'simulated',
        minedPayoutObserved: false,
        prospectiveValidated: false,
      })
      expect(evidence).toEqual(before)
      if (subject.mechanism === 'staged')
        expect(
          assessHolderExitOnboarding(subject, {
            routeAndContractIdentityVerified: true,
            inputAndFinalAssetAddressesVerified: true,
            sameHolderExactQFinalizedBaseline: true,
            sameHolderExactQFinalizedDatedTarget: true,
            sameEpisodeFinalAssetReceipt: false,
          }),
        ).toBe('stage_only')
    },
  )
  it.each([
    'owner',
    'assetsRaw',
    'finalAssetAddress',
    'finalAssetDecimals',
    'destinationAddress',
    'routeKey',
  ] as const)('rejects drift in independently bound simulation %s', (field) => {
    const { subject, evidence } = projectionFixture()
    const q = evidence.simulations[1].question
    if (field === 'finalAssetDecimals') q[field] = 18
    else q[field] = field === 'assetsRaw' ? '1000001' : `0x${'d'.repeat(40)}`
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('stage_only')
  })
  it.each([
    'quote',
    'getter',
    'independent_calls',
    'missing_conversion',
    'short_payout',
    'same_origin',
    'different_block',
  ])('keeps incomplete or incompatible execution proof stage-only: %s', (change) => {
    const { subject, evidence } = projectionFixture()
    const proof = evidence.simulations[1]
    if (change === 'quote' || change === 'getter') Object.assign(proof, { kind: change })
    if (change === 'independent_calls') Object.assign(proof, { execution: 'independent_calls' })
    if (change === 'missing_conversion')
      Object.assign(proof, {
        requiredStages: proof.requiredStages.filter((s) => s.name !== 'unresolved_conversion'),
      })
    if (change === 'short_payout') proof.finalAssetAmountRaw = '999999'
    if (change === 'same_origin')
      proof.originHost = evidence.simulations[0].originHost.toUpperCase()
    if (change === 'different_block') proof.source.blockNumber += 1
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('stage_only')
  })
  it.each([
    { assetsRaw: ['1000000'] },
    { assetsRaw: {} },
    { assetsRaw: '01000000' },
    { assetsRaw: (1n << 256n).toString() },
    { owner: [`0x${'b'.repeat(40)}`] },
    { finalAssetDecimals: '6' },
  ])('rejects malformed native binding %j', (change) => {
    const { subject, evidence } = projectionFixture()
    Object.assign(evidence.question, change)
    Object.assign(evidence.simulations[0].question, change)
    Object.assign(evidence.simulations[1].question, change)
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('unsupported')
  })
  it.each([
    { blockTime: ['2026-10-07T07:31:35.000Z'] },
    { blockHash: [`0x${'a'.repeat(64)}`] },
    { blockNumber: '26139032' },
    { finalized: 'true' },
  ])('rejects malformed finalized source %j', (change) => {
    const { subject, evidence } = projectionFixture()
    for (const proof of evidence.simulations) Object.assign(proof.source, change)
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('stage_only')
  })
  it('accepts canonical identity case differences and a complete single-call assay', () => {
    const { subject, evidence } = projectionFixture()
    for (const proof of evidence.simulations) {
      proof.execution = 'single_call'
      proof.question.owner = `0x${proof.question.owner.slice(2).toUpperCase()}`
      proof.question.finalAssetAddress = `0x${proof.question.finalAssetAddress.slice(2).toUpperCase()}`
      proof.source.blockHash = `0x${proof.source.blockHash.slice(2).toUpperCase()}`
    }
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe(
      'conditional_projection',
    )
  })
  it.each([
    'conversion_not_executed',
    'stage_order',
    'unverified_execution',
    'unfinalized',
    'array_amount',
  ])('requires execution and source proof despite matching final amounts: %s', (change) => {
    const { subject, evidence } = projectionFixture()
    for (const proof of evidence.simulations) {
      if (change === 'conversion_not_executed')
        Object.assign(proof, {
          requiredStages: proof.requiredStages.map((stage) =>
            stage.name === 'unresolved_conversion'
              ? { ...stage, status: 'condition_satisfied' }
              : stage,
          ),
        })
      if (change === 'stage_order')
        Object.assign(proof, { requiredStages: [...proof.requiredStages].reverse() })
      if (change === 'unverified_execution') proof.fullRouteExecutionVerified = false
      if (change === 'unfinalized') Object.assign(proof.source, { finalized: false })
      if (change === 'array_amount') Object.assign(proof, { finalAssetAmountRaw: ['1000000'] })
    }
    expect(assessHolderExitConditionalProjection(subject, evidence).tier).toBe('stage_only')
  })
})
