import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import { projectHolderExitMechanicalOutlook } from '@/lib/carry/holderExitMechanicalOutlook'
import {
  holderMechanicalRow,
  matchingHolderExitViewAssessment,
  selectedHolderExitMechanicalOutlook,
  type HolderExitMechanicalEnvelope,
} from '@/lib/carry/holderExitMechanicalOutlookView'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitSubjectRegistry'
import { resolveMorphoExitTarget } from '@/lib/carry/morphoExitQuote'
import { resolveTrackedDirectVaultExitTarget } from '@/lib/carry/trackedDirectVaultExit'
import { DIRECT_SUPPLY_MARKETS } from '@/lib/carry/directSupplyMarketConstants'
import morphoIdentities from '@/lib/carry/morpho-v2-asset-identities.json'
import cohort from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import { APYUSD_ROUTE, APYUSD_VAULT, APXUSD_ASSET } from '@/lib/carry/apyUsdExit'
import { ORIGINAL_GHO, UMBRELLA_GHO_ROUTE, UMBRELLA_STKGHO } from '@/lib/carry/umbrellaGhoExit'

const now = Date.parse('2026-10-07T12:00:00.000Z')
const owner = `0x${'b'.repeat(40)}` as const
function fixture() {
  const assessment: HolderExitAssessment = {
    status: 'partial',
    routeKey: APYUSD_ROUTE,
    destinationAddress: APYUSD_VAULT,
    owner,
    request: {
      assetsRaw: '100',
      assetAddress: APXUSD_ASSET,
      horizonHours: 24,
      receiptTokenId: '3',
    },
    source: {
      chainId: 1,
      blockNumber: 1,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(now).toISOString(),
      originValidation: 'two_provider',
    },
    stages: [
      {
        name: 'receipt_initiation',
        relatedToRequest: true,
        status: 'simulated',
        assetAddress: APXUSD_ASSET,
        amountRaw: '100',
      },
    ],
    finalPayout: { assetAddress: APXUSD_ASSET, status: 'unassessed', amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
    apyUsdCondition: {
      currentFeeCurve: null,
      existingReceipt: null,
      currentMinimumClaimDelaySeconds: 600,
      ifInitiatedAtCheckedBlockClaimableAt: now / 1000 + 613,
      ifInitiatedAtCheckedBlockEarliestNetRaw: '95',
      ifInitiatedAtCheckedBlockMinimumFeeAt: now / 1000 + 1247,
      ifInitiatedAtCheckedBlockMinimumFeeNetRaw: '99',
      ifInitiatedAtCheckedBlockHorizonNetRaw: '99',
    },
  }
  return bound(assessment)
}
function bound(assessment: HolderExitAssessment) {
  const question = {
    routeKey: assessment.routeKey,
    destination: assessment.destinationAddress,
    owner,
    requestedRaw: assessment.request.assetsRaw,
    payoutAsset: assessment.request.assetAddress,
    horizonHours: 24,
    asOfMs: now,
  }
  const envelope: HolderExitMechanicalEnvelope = {
    issuedAt: new Date(now).toISOString(),
    horizonSeconds: 86400,
    assessmentRequest: { ...assessment.request },
    outlook: projectHolderExitMechanicalOutlook(assessment, {
      routeKey: assessment.routeKey,
      destinationAddress: assessment.destinationAddress,
      owner,
      assetsRaw: assessment.request.assetsRaw,
      assetAddress: assessment.request.assetAddress,
      horizonSeconds: 86400,
      nowMs: now,
    }),
  }
  return { assessment, question, envelope }
}

describe('holder mechanical view binding', () => {
  it('preserves known new-request timing without treating stage eligibility as full payout', () => {
    const { assessment, question, envelope } = fixture()
    expect(selectedHolderExitMechanicalOutlook(envelope, assessment, question)).toBe(envelope)
    expect(envelope.outlook.requestedQ.fullRouteEarliestAt).toBeNull()
    expect(holderMechanicalRow(envelope, APXUSD_ASSET, 2, 'apxUSD', now)).toEqual({
      label: 'If started at checked block',
      value: 'Not before 2026-10-07 12:10:13 UTC',
      detail: 'Min fee 2026-10-07 12:20:47 UTC · net 0.99 apxUSD',
      warning: true,
    })
  })
  it.each([
    { owner: `0x${'c'.repeat(40)}` },
    { owner: null },
    { requestedRaw: '101' },
    { payoutAsset: `0x${'c'.repeat(40)}` },
    { horizonHours: 1 },
    { asOfMs: now + 1800001 },
    { asOfMs: now - 1 },
  ])('rejects the changed current question %j', (changed) => {
    const { assessment, question, envelope } = fixture()
    expect(
      selectedHolderExitMechanicalOutlook(envelope, assessment, { ...question, ...changed }),
    ).toBeNull()
  })
  it('binds auxiliary receipt IDs and exact source separately from Q', () => {
    const { assessment, question, envelope } = fixture()
    expect(
      selectedHolderExitMechanicalOutlook(
        { ...envelope, assessmentRequest: { ...envelope.assessmentRequest, receiptTokenId: '4' } },
        assessment,
        question,
      ),
    ).toBeNull()
    const changed = structuredClone(envelope)
    changed.outlook.source.blockHash = `0x${'c'.repeat(64)}`
    expect(selectedHolderExitMechanicalOutlook(changed, assessment, question)).toBeNull()
    changed.outlook.source = { ...envelope.outlook.source }
    changed.outlook.requestedQ.stageEarliestAt = new Date(now).toISOString()
    expect(selectedHolderExitMechanicalOutlook(changed, assessment, question)).toBeNull()
  })
  it.each(['requestedQ', 'prongs', 'source', 'subject'] as const)(
    'rejects object facts replaced with sorted pair arrays: %s',
    (field) => {
      const { assessment, question, envelope } = fixture()
      const pairs = (value: object) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      const changed = structuredClone(envelope) as unknown as {
        outlook: Record<string, unknown>
      }
      changed.outlook[field] =
        field === 'prongs' ? envelope.outlook.prongs.map(pairs) : pairs(envelope.outlook[field])
      expect(selectedHolderExitMechanicalOutlook(changed, assessment, question)).toBeNull()
      expect(matchingHolderExitViewAssessment(assessment, question)).toBe(assessment)
    },
  )
  it.each(['missing', 'undefined'] as const)(
    'rejects a %s nullable fact instead of explicit null',
    (replacement) => {
      const { assessment, question, envelope } = fixture()
      expect(envelope.outlook.requestedQ.fullRouteEarliestAt).toBeNull()
      const changed = structuredClone(envelope)
      const facts = changed.outlook.requestedQ as unknown as Record<string, unknown>
      if (replacement === 'missing') delete facts.fullRouteEarliestAt
      else facts.fullRouteEarliestAt = undefined
      expect(selectedHolderExitMechanicalOutlook(changed, assessment, question)).toBeNull()
    },
  )
  it('accepts valid objects with recursively reordered keys', () => {
    const { assessment, question, envelope } = fixture()
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder)
      if (value !== null && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, fact]) => [key, reorder(fact)]),
        )
      return value
    }
    const changed = reorder(envelope)
    expect(selectedHolderExitMechanicalOutlook(changed, assessment, question)).toBe(changed)
  })
  it('rejects coerced enum/boolean fields and tampered issuance/horizon metadata', () => {
    const { assessment, question, envelope } = fixture()
    for (const change of [
      { issuedAt: 'not-a-date' },
      { horizonSeconds: '86400' },
      { outlook: { ...envelope.outlook, prospectiveValidated: true } },
      { outlook: { ...envelope.outlook, mechanismFamily: ['receipt_fee'] } },
      { outlook: { ...envelope.outlook, targetAt: new Date(now + 1).toISOString() } },
      {
        outlook: {
          ...envelope.outlook,
          prongs: [{ ...envelope.outlook.prongs[0], scope: ['requested_q'] }],
        },
      },
    ])
      expect(
        selectedHolderExitMechanicalOutlook({ ...envelope, ...change }, assessment, question),
      ).toBeNull()
    expect(
      matchingHolderExitViewAssessment({ ...assessment, status: ['partial'] }, question),
    ).toBeNull()
    expect(
      matchingHolderExitViewAssessment(
        { ...assessment, finalPayout: { ...assessment.finalPayout, status: ['simulated'] } },
        question,
      ),
    ).toBeNull()
    for (const changed of [
      { status: {} },
      { status: undefined },
      { status: 'foreign' },
      { amountRaw: 'bad' },
      { amountRaw: 100 },
      { amountRaw: (1n << 256n).toString() },
    ])
      expect(
        matchingHolderExitViewAssessment(
          { ...assessment, finalPayout: { ...assessment.finalPayout, ...changed } },
          question,
        ),
      ).toBeNull()
  })
  it('shows a known inclusive window as closed only after its final second', () => {
    const a = fixture().assessment
    a.routeKey = UMBRELLA_GHO_ROUTE
    a.destinationAddress = UMBRELLA_STKGHO
    a.request = { assetsRaw: '100', assetAddress: ORIGINAL_GHO, horizonHours: 24 }
    a.finalPayout.assetAddress = ORIGINAL_GHO
    a.stages = [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'unassessed',
        amountRaw: null,
        assetAddress: ORIGINAL_GHO,
      },
    ]
    a.condition = {
      gate: 'waiting',
      cooldownEnd: now / 1000 + 613,
      windowEndInclusive: now / 1000 + 937,
      currentCooldownSeconds: 600,
      currentUnstakeWindowSeconds: 300,
      slashExposure: 'no_slashable_assets',
    }
    const { question, envelope } = bound(a)
    expect(
      selectedHolderExitMechanicalOutlook(envelope, a, { ...question, asOfMs: now + 938000 }),
    ).toBe(envelope)
    expect(holderMechanicalRow(envelope, ORIGINAL_GHO, 18, 'GHO', now + 937999)?.value).toContain(
      'Not before 2026-10-07 12:10:13 UTC',
    )
    expect(holderMechanicalRow(envelope, ORIGINAL_GHO, 18, 'GHO', now + 938000)).toMatchObject({
      label: 'Holder window',
      value: 'Closed',
      detail: 'Ended 2026-10-07 12:15:37 UTC',
    })
  })
  it('rejects omitted required window prongs and altered assessment clocks or fees', () => {
    const a = fixture().assessment
    a.routeKey = UMBRELLA_GHO_ROUTE
    a.destinationAddress = UMBRELLA_STKGHO
    a.request = { assetsRaw: '100', assetAddress: ORIGINAL_GHO, horizonHours: 24 }
    a.finalPayout = { assetAddress: ORIGINAL_GHO, status: 'simulated', amountRaw: '100' }
    a.stages = [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'simulated',
        amountRaw: '100',
        assetAddress: ORIGINAL_GHO,
      },
    ]
    a.condition = {
      gate: 'window_open',
      cooldownEnd: now / 1000,
      windowEndInclusive: now / 1000 + 600,
      currentCooldownSeconds: 600,
      currentUnstakeWindowSeconds: 600,
      slashExposure: 'no_slashable_assets',
    }
    const { question, envelope } = bound(a)
    expect(selectedHolderExitMechanicalOutlook(envelope, a, question)).toBe(envelope)
    const forged = structuredClone(envelope)
    const window = forged.outlook.prongs.find((p) => p.id === 'cooldown_window')!
    window.id = 'fake_wait'
    window.earliestAt = new Date(now + 613000).toISOString()
    window.windowEndInclusiveAt = null
    window.atTarget = 'conditional_by_target'
    forged.outlook.requestedQ = {
      ...forged.outlook.requestedQ,
      stageEarliestAt: window.earliestAt,
      fullRouteEarliestAt: window.earliestAt,
      windowEndInclusiveAt: null,
      atTarget: 'conditional_by_target',
    }
    expect(selectedHolderExitMechanicalOutlook(forged, a, question)).toBeNull()
    const missing = structuredClone(envelope)
    missing.outlook.prongs = missing.outlook.prongs.filter((p) => p.id !== 'cooldown_window')
    missing.outlook.requestedQ = {
      ...missing.outlook.requestedQ,
      stageEarliestAt: new Date(now).toISOString(),
      fullRouteEarliestAt: new Date(now).toISOString(),
      windowEndInclusiveAt: null,
      atTarget: 'conditional_by_target',
    }
    expect(selectedHolderExitMechanicalOutlook(missing, a, question)).toBeNull()
    for (const id of ['withdrawal', 'final_asset_delivery']) {
      const changed = structuredClone(envelope)
      changed.outlook.prongs = changed.outlook.prongs.filter((p) => p.id !== id)
      expect(selectedHolderExitMechanicalOutlook(changed, a, question)).toBeNull()
    }
    const wrongFamily = structuredClone(envelope)
    wrongFamily.outlook.mechanismFamily = 'atomic'
    expect(selectedHolderExitMechanicalOutlook(wrongFamily, a, question)).toBeNull()
    const apy = fixture()
    expect(selectedHolderExitMechanicalOutlook(apy.envelope, apy.assessment, apy.question)).toBe(
      apy.envelope,
    )
    for (const facts of [
      { earliestAt: new Date(now + 612000).toISOString() },
      { feeMinimumAt: new Date(now + 1246000).toISOString() },
      { feeMinimumAt: null },
      { feeMinimumNetRaw: null },
      { feeMinimumNetRaw: '100' },
      { feeRaw: '0' },
    ]) {
      const changed = structuredClone(apy.envelope)
      Object.assign(changed.outlook.prongs.find((p) => p.id === 'new_q_receipt_claim')!, facts)
      // Keep the forged aggregate consistent to test the assessment binding itself.
      if ('earliestAt' in facts) changed.outlook.requestedQ.stageEarliestAt = facts.earliestAt!
      expect(selectedHolderExitMechanicalOutlook(changed, apy.assessment, apy.question)).toBeNull()
    }
    const reset = structuredClone(apy.envelope)
    reset.outlook.pendingReset = true
    expect(selectedHolderExitMechanicalOutlook(reset, apy.assessment, apy.question)).toBeNull()
    const unknown = { ...apy.assessment, routeKey: 'unregistered supplemental route' }
    expect(
      selectedHolderExitMechanicalOutlook(apy.envelope, unknown, {
        ...apy.question,
        routeKey: unknown.routeKey,
      }),
    ).toBeNull()
  })

  it('does not format a fee endpoint in another token or guessed decimals', () => {
    const { envelope } = fixture()
    expect(holderMechanicalRow(envelope, `0x${'c'.repeat(40)}`, 2, 'USDC', now)?.detail).toBeNull()
    expect(holderMechanicalRow(envelope, APXUSD_ASSET, null, 'apxUSD', now)?.detail).toBeNull()
  })
})

it('bundles the browser projection without provider readers or Node modules', async () => {
  // Reuse the already installed tsx dependency; no installation or app build is needed.
  const localRequire = createRequire(import.meta.url)
  const { build } = createRequire(localRequire.resolve('tsx/package.json'))('esbuild')
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL('../../lib/carry/holderExitMechanicalOutlookView.ts', import.meta.url)),
    ],
    platform: 'browser',
    format: 'esm',
    bundle: true,
    write: false,
    metafile: true,
    tsconfig: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
    logLevel: 'silent',
  })
  const inputs = Object.keys(result.metafile.inputs)
  expect(inputs).toContain('lib/carry/holderExitMechanicalProjection.ts')
  expect(inputs).toContain('lib/carry/holderExitSubjectRegistry.ts')
  expect(
    inputs.filter((name) =>
      /node_modules|holderExitAssessment\.ts|holderExitMechanicalOutlook\.ts|ExitQuote|trackedDirectVaultExit|SupplementalRegistry|apyUsdExit|umbrellaGhoExit/.test(
        name,
      ),
    ),
  ).toEqual([])
})

it('preserves canonical direct, tracked, and all 49 Morpho subject identities', () => {
  for (const market of Object.values(DIRECT_SUPPLY_MARKETS)) {
    expect(resolveHolderExitSubject(market.routeKey, market.destination as `0x${string}`)).toEqual({
      kind: 'direct',
      payoutAsset: market.underlying,
    })
  }
  for (const identity of morphoIdentities.entries) {
    const routes = [
      ...new Set(
        cohort.positions
          .filter((position) => position.vault.toLowerCase() === identity.vault)
          .flatMap((position) => position.routeIds),
      ),
    ]
    const destination = identity.vault as `0x${string}`
    let accepted = 0
    for (const routeKey of routes) {
      let legacyAsset: string | null = null
      try {
        legacyAsset = resolveMorphoExitTarget(routeKey, destination).asset
      } catch {
        /* The frozen seed also includes routes outside the current catalog. */
      }
      if (legacyAsset) {
        expect(resolveHolderExitSubject(routeKey, destination)).toEqual({
          kind: 'morpho',
          payoutAsset: legacyAsset,
        })
        accepted += 1
      } else expect(() => resolveHolderExitSubject(routeKey, destination)).toThrow()
    }
    expect(accepted).toBeGreaterThan(0)
    expect(() => resolveHolderExitSubject('unknown route', destination)).toThrow()
  }
  for (const [routeKey, destination] of [
    ['USDS → StUsds [USDS]', '0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9'],
    ['USDC → Fluid USD Coin [USDC]', '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33'],
    ['USDT → fToken [USDT]', '0x5c20b550819128074fd538edf79791733ccedd18'],
    ['GHO → fToken [GHO]', '0x6a29a46e21c730dca1d8b23d637c101cec605c5b'],
    ['USDC → FluidBridgeAggregatorProxy [USDC]', '0x273da948aca9261043fbdb2a857bc255ecc29012'],
  ])
    expect(resolveHolderExitSubject(routeKey, destination as `0x${string}`)).toEqual({
      kind: 'tracked',
      payoutAsset: resolveTrackedDirectVaultExitTarget(routeKey, destination as `0x${string}`)
        .asset,
    })
  expect(() => resolveHolderExitSubject(UMBRELLA_GHO_ROUTE, APYUSD_VAULT)).toThrow()
  expect(() => resolveHolderExitSubject(APYUSD_ROUTE, UMBRELLA_STKGHO)).toThrow()
})
