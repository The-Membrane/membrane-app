import { describe, it, expect } from 'vitest'
import { ROUTES } from '@/components/Carry/fixtures'
import seed from '@/scripts/route-cohort/aug-2026-ab-vault-seed.json'
import config from '@/tools/venue-recorder.config.json'
import { buildCarryForecastRegistry } from '@/lib/carry/forecastRegistry'
import { verifiedDirectSupplyDestinations } from '@/lib/carry/forecastRegistryMarkets'
import {
  buildCanonicalAtomicHolderExitSubjects,
  type HolderExitConditionalProjectionEvidence,
} from '@/lib/carry/holderExitMechanisms'
import { resolveHolderExitSubject } from '@/lib/carry/holderExitSubjectRegistry'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
  selectedHolderExitCapacity,
  type HolderExitCapacityFacts,
} from '@/lib/carry/holderExitCapacity'
const subjects = buildCanonicalAtomicHolderExitSubjects(
  buildCarryForecastRegistry(
    ROUTES,
    seed,
    config.venues,
    '0xe1753f2e00940cc31213dd92013cf019dfe4ca1d',
    verifiedDirectSupplyDestinations(),
  ),
)
const NOW = Date.parse('2026-10-07T12:00:00.000Z'),
  owner = `0x${'b'.repeat(40)}` as `0x${string}`
function fixture(s = subjects.find((s) => s.routeKey === 'USDC → Fluid USD Coin [USDC]')!) {
  const asset = s.canonicalFinalAsset!.address as `0x${string}`,
    kind = resolveHolderExitSubject(s.routeKey, s.destinationAddress as `0x${string}`).kind
  const assessment: HolderExitAssessment = {
    status: 'assessed',
    routeKey: s.routeKey,
    destinationAddress: s.destinationAddress as `0x${string}`,
    owner,
    request: { assetsRaw: '100', assetAddress: asset, horizonHours: 24 },
    source: {
      chainId: 1,
      blockNumber: 26000000,
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: new Date(NOW - 60000).toISOString(),
      originValidation: 'single_provider',
    },
    stages: [
      {
        name: 'withdrawal',
        assetAddress: asset,
        amountRaw: '100',
        relatedToRequest: true,
        status: 'simulated',
      },
    ],
    finalPayout: { status: 'simulated', assetAddress: asset, amountRaw: '100' },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  }
  const getter = ['morpho', 'tracked', 'sgho', 'susds', 'usd3'].includes(kind)
  const facts: HolderExitCapacityFacts = {
    entitlementRaw: '1000',
    quotedMaxWithdrawRaw: getter ? '500' : null,
    quotedMaxWithdrawStatus: getter ? 'quoted' : 'not_read',
    effectiveLimitRaw: kind === 'sgho' ? '500' : null,
    withdrawalsPaused: kind === 'sgho' ? false : null,
  }
  const quote = buildHolderExitCapacityQuote(assessment, facts, NOW)!
  const agreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const question = {
    routeKey: s.routeKey,
    destinationAddress: s.destinationAddress,
    owner,
    assetsRaw: '100',
    finalAssetAddress: asset,
    finalAssetDecimals: s.canonicalFinalAsset!.decimals,
  }
  const executionAgreement: HolderExitConditionalProjectionEvidence = {
    question,
    routeAndContractIdentityVerified: true,
    inputAndFinalAssetAddressesVerified: true,
    simulations: ['one.example', 'two.example'].map((originHost) => ({
      question,
      originHost,
      source: quote.source,
      kind: 'full_route_execution',
      execution: 'single_call',
      fullRouteExecutionVerified: true,
      requiredStages: [{ name: 'atomic_exit', status: 'executed' }],
      finalAssetAmountRaw: '100',
      status: 'simulated',
    })),
  }
  const binding = {
    routeKey: s.routeKey,
    destination: s.destinationAddress,
    owner,
    requestedRaw: '100',
    asset,
    assetDecimals: s.canonicalFinalAsset!.decimals,
    currentSource: quote.source,
    asOfMs: NOW,
    executionAgreement,
  }
  return { assessment, facts, quote, agreement, binding }
}
describe('native holder capacity facts', () => {
  it('reverting-Q quotes remain selectable but forged successful lower bounds require external execution evidence', () => {
    const f = fixture()
    f.assessment.stages[0].status = 'reverted'
    f.assessment.finalPayout.status = 'unassessed'
    f.assessment.finalPayout.amountRaw = null
    const quote = buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)!
    const agreement = agreeHolderExitCapacityQuotes(
      { host: 'one.example', quote },
      { host: 'two.example', quote },
      NOW,
    )!
    const { executionAgreement: _proof, ...binding } = f.binding
    expect(selectedHolderExitCapacity(agreement, binding)).toEqual(agreement)
    agreement.quote.successfulRequestedRawLowerBound = '100'
    for (const origin of agreement.origins) origin.quote.successfulRequestedRawLowerBound = '100'
    expect(selectedHolderExitCapacity(agreement, binding)).toBeNull()
    expect(selectedHolderExitCapacity(f.agreement, f.binding)).toEqual(f.agreement)
    expect(selectedHolderExitCapacity(f.agreement, binding)).toBeNull()
  })
  it('matching E/M with asymmetric Q execution remains selectable with every unauthenticated lower bound cleared', () => {
    const f = fixture()
    f.assessment.stages[0].status = 'reverted'
    f.assessment.finalPayout.status = 'unassessed'
    f.assessment.finalPayout.amountRaw = null
    const reverted = buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)!
    const { executionAgreement: _proof, ...binding } = f.binding
    for (const quotes of [
      [f.quote, reverted],
      [reverted, f.quote],
    ]) {
      const agreement = agreeHolderExitCapacityQuotes(
        { host: 'one.example', quote: quotes[0] },
        { host: 'two.example', quote: quotes[1] },
        NOW,
      )!
      const before = structuredClone(agreement)
      const selected = selectedHolderExitCapacity(agreement, binding)!
      expect(selected).not.toBeNull()
      expect(selected.quote.successfulRequestedRawLowerBound).toBeNull()
      expect(
        selected.origins.every((origin) => origin.quote.successfulRequestedRawLowerBound === null),
      ).toBe(true)
      expect(selected.quote.entitlementRaw).toBe('1000')
      expect(selected.quote.quotedMaxWithdrawRaw).toBe('500')
      expect(agreement).toEqual(before)
    }
  })
  for (const mutation of [
    'units',
    'source',
    'Q',
    'owner',
    'hosts',
    'foreign_host',
    'stage',
    'payout',
  ]) {
    it(`rejects a successful lower bound with mismatched external execution ${mutation}`, () => {
      const f = fixture(),
        binding = structuredClone(f.binding),
        proof = binding.executionAgreement
      if (mutation === 'units') proof.question.finalAssetDecimals = 18
      if (mutation === 'source') proof.simulations[0].source.blockHash = `0x${'c'.repeat(64)}`
      if (mutation === 'Q') proof.question.assetsRaw = '101'
      if (mutation === 'owner') proof.question.owner = `0x${'c'.repeat(40)}`
      if (mutation === 'hosts') proof.simulations[1].originHost = proof.simulations[0].originHost
      if (mutation === 'foreign_host') proof.simulations[1].originHost = 'other.example'
      if (mutation === 'stage') proof.simulations[0].requiredStages = []
      if (mutation === 'payout') proof.simulations[0].finalAssetAmountRaw = '101'
      expect(selectedHolderExitCapacity(f.agreement, binding)).toBeNull()
    })
  }
  it('all60 issued atomics retain native E and quoted limits without inventing aggregate or predeposit capacity', () => {
    expect(subjects).toHaveLength(60)
    for (const s of subjects) {
      const f = fixture(s)
      expect(f.quote, s.routeKey).not.toBeNull()
      expect(selectedHolderExitCapacity(f.agreement, f.binding)).toEqual(f.agreement)
      expect(f.quote.aggregateAccessibleLiquidityRaw).toBeNull()
      expect(f.quote.hypotheticalDepositCapacityRaw).toBeNull()
      expect(f.quote.successfulRequestedRawLowerBound).toBe('100')
      expect(f.quote.holderExecutableExit).toBe(false)
    }
  })
  it('a reverting Q retains E/M while dropping successful-Q lower bound', () => {
    const f = fixture()
    f.assessment.stages[0].status = 'reverted'
    f.assessment.finalPayout.status = 'unassessed'
    f.assessment.finalPayout.amountRaw = null
    const q = buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)!
    expect(q.quotedMaxWithdrawRaw).toBe('500')
    expect(q.entitlementRaw).toBe('1000')
    expect(q.successfulRequestedRawLowerBound).toBeNull()
    expect(
      agreeHolderExitCapacityQuotes(
        { host: 'one.example', quote: f.quote },
        { host: 'two.example', quote: q },
        NOW,
      )?.quote.successfulRequestedRawLowerBound,
    ).toBeNull()
  })
  it('unavailable optional Morpho maxWithdraw remains null, never fabricated zero', () => {
    const f = fixture(
      subjects.find(
        (s) =>
          resolveHolderExitSubject(s.routeKey, s.destinationAddress as `0x${string}`).kind ===
          'morpho',
      ),
    )
    f.facts.quotedMaxWithdrawRaw = null
    f.facts.quotedMaxWithdrawStatus = 'unsupported'
    const q = buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)!
    expect(q.quotedMaxWithdrawStatus).toBe('unsupported')
    expect(q.quotedLimitMethod).toBe('unavailable')
    expect(q.successfulRequestedRawLowerBound).toBe('100')
  })
  it('sGHO effective quote derives pause and minimum independently', () => {
    const f = fixture(subjects.find((s) => s.routeKey === 'GHO → sGho [GHO]'))
    f.facts.withdrawalsPaused = true
    f.facts.effectiveLimitRaw = '0'
    expect(buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)?.effectiveLimitRaw).toBe('0')
    f.facts.effectiveLimitRaw = '500'
    expect(buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)).toBeNull()
  })
  it('inclusive30min expiry and one millisecond over', () => {
    const f = fixture(),
      expiry = Date.parse(f.quote.source.blockTime) + 1800000
    expect(selectedHolderExitCapacity(f.agreement, { ...f.binding, asOfMs: expiry })).not.toBeNull()
    expect(selectedHolderExitCapacity(f.agreement, { ...f.binding, asOfMs: expiry + 1 })).toBeNull()
  })
  for (const [key, bad] of [
    ['entitlementRaw', ['1000']],
    ['quotedMaxWithdrawRaw', { toString: () => '500' }],
    ['withdrawalsPaused', []],
    ['quotedMaxWithdrawStatus', ['quoted']],
  ] as const)
    it(`rejects malformed primitive ${key}`, () => {
      const f = fixture()
      ;(f.facts as any)[key] = bad
      expect(buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)).toBeNull()
    })
  for (const [key, bad] of [
    ['blockTime', ['2026-10-07T11:59:00.000Z']],
    ['blockHash', [`0x${'a'.repeat(64)}`]],
    ['blockNumber', [26000000]],
    ['blockTime', '2026-10-07T12:00:01.000Z'],
  ] as const)
    it(`rejects invalid source ${key}`, () => {
      const f = fixture()
      ;(f.assessment.source as any)[key] = bad
      expect(buildHolderExitCapacityQuote(f.assessment, f.facts, NOW)).toBeNull()
    })
  for (const key of [
    'owner',
    'requestedRaw',
    'assetDecimals',
    'asset',
    'destination',
    'routeKey',
  ] as const)
    it(`externally binds ${key}`, () => {
      const f = fixture()
      ;(f.binding as any)[key] =
        key === 'assetDecimals' ? 18 : key === 'requestedRaw' ? '101' : 'foreign'
      expect(selectedHolderExitCapacity(f.agreement, f.binding)).toBeNull()
    })
  it('duplicate/trailing-dot origins and differing limits cannot agree', () => {
    const f = fixture()
    for (const host of ['one.example', 'two.example.'])
      expect(
        agreeHolderExitCapacityQuotes(
          { host: 'one.example', quote: f.quote },
          { host, quote: f.quote },
          NOW,
        ),
      ).toBeNull()
    const q = { ...f.quote, quotedMaxWithdrawRaw: '501' }
    expect(
      agreeHolderExitCapacityQuotes(
        { host: 'one.example', quote: f.quote },
        { host: 'two.example', quote: q },
        NOW,
      ),
    ).toBeNull()
  })
  it('rejects cross-family methods, array records, forged flags and aggregate values', () => {
    const f = fixture()
    for (const patch of [
      { entitlementMethod: 'supplied_balance' },
      { forecastValidated: true },
      { aggregateAccessibleLiquidityRaw: '500' },
      { hypotheticalDepositCapacityRaw: '500' },
    ]) {
      const a = structuredClone(f.agreement)
      Object.assign(a.quote, patch)
      expect(selectedHolderExitCapacity(a, f.binding)).toBeNull()
    }
    expect(selectedHolderExitCapacity(Object.entries(f.agreement), f.binding)).toBeNull()
  })
  it('clones all nested facts and leaves inputs unchanged', () => {
    const f = fixture(),
      before = structuredClone(f.agreement),
      s = selectedHolderExitCapacity(f.agreement, f.binding)!
    s.origins[0].quote.source.blockHash = 'changed'
    expect(f.agreement).toEqual(before)
  })
})

describe('sGHO independent full-position agreement', () => {
  const sgho = () => fixture(subjects.find((s) => s.routeKey === 'GHO → sGho [GHO]')!)
  function agreed(first: string | null | undefined, second: string | null | undefined) {
    const f = sgho()
    const quote = (v: string | null | undefined) =>
      buildHolderExitCapacityQuote(
        f.assessment,
        { ...f.facts, ...(v === undefined ? {} : { fullPositionEntitlementRaw: v }) },
        NOW,
      )!
    return {
      ...f,
      first: quote(first),
      second: quote(second),
      agreement: agreeHolderExitCapacityQuotes(
        { host: 'one.example', quote: quote(first) },
        { host: 'two.example', quote: quote(second) },
        NOW,
      )!,
    }
  }
  it.each(['1000', '2000'])(
    'agrees exact full E %s without changing redeemable E or current limit',
    (full) => {
      const f = agreed(full, full)
      expect(f.agreement.quote).toMatchObject({
        entitlementRaw: '1000',
        effectiveLimitRaw: '500',
        fullPositionEntitlementRaw: full,
        fullPositionEntitlementMethod: 'preview_redeem_full_position',
      })
      expect(selectedHolderExitCapacity(f.agreement, f.binding)).not.toBeNull()
    },
  )
  it.each([
    ['2000', '3000'],
    ['2000', null],
    ['2000', undefined],
    [null, null],
  ] as const)('optional disagreement/miss %s/%s preserves core quote', (a, b) => {
    const f = agreed(a, b)
    expect(f.agreement.quote).toMatchObject({
      entitlementRaw: '1000',
      effectiveLimitRaw: '500',
      fullPositionEntitlementRaw: null,
      fullPositionEntitlementMethod: 'unavailable',
    })
    expect(f.agreement.origins.map((o) => o.quote)).toEqual([f.first, f.second])
    expect(selectedHolderExitCapacity(f.agreement, f.binding)).not.toBeNull()
  })
  it('both absent retain byte-for-byte old agreement shape', () => {
    const f = agreed(undefined, undefined)
    expect(f.agreement).toEqual(sgho().agreement)
    expect(f.agreement.quote).not.toHaveProperty('fullPositionEntitlementRaw')
  })
  it.each(['999', '-1', String(1n << 256n), ['2000'], undefined])(
    'rejects malformed/contradictory explicit full E %s',
    (full) => {
      const f = sgho()
      expect(
        buildHolderExitCapacityQuote(
          f.assessment,
          { ...f.facts, fullPositionEntitlementRaw: full } as any,
          NOW,
        ),
      ).toBeNull()
    },
  )
  it('rejects optional E on other subjects and summary/method tampering', () => {
    const other = fixture()
    expect(
      buildHolderExitCapacityQuote(
        other.assessment,
        { ...other.facts, fullPositionEntitlementRaw: '2000' },
        NOW,
      ),
    ).toBeNull()
    const f = agreed('2000', '2000')
    const bad = structuredClone(f.agreement)
    bad.quote.fullPositionEntitlementRaw = '3000'
    expect(selectedHolderExitCapacity(bad, f.binding)).toBeNull()
    const method = structuredClone(f.agreement)
    method.origins[0].quote.fullPositionEntitlementMethod = 'unavailable'
    expect(selectedHolderExitCapacity(method, f.binding)).toBeNull()
    for (const drift of [
      { owner: '0x' + 'c'.repeat(40) },
      { assetDecimals: 6 },
      { currentSource: { ...f.binding.currentSource, blockHash: '0x' + 'c'.repeat(64) } },
      { asOfMs: NOW + 1800000 },
    ])
      expect(selectedHolderExitCapacity(f.agreement, { ...f.binding, ...drift })).toBeNull()
  })
})
