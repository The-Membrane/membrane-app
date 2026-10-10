import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import audit from '@/data/research/venue-signals/conditional-sampled-cash-history-v1.audit.json'
import {
  selectedConditionalSampledCashPathProjection,
  buildConditionalSampledCashPathProjection,
  type ConditionalSampledCashHistory,
} from '@/lib/carry/conditionalSampledCashPathProjection'
import {
  selectedHolderExitCapacity,
  buildHolderExitCapacityQuote,
  agreeHolderExitCapacityQuotes,
} from '@/lib/carry/holderExitCapacity'
import { agreeCometWithdrawFacts } from '@/lib/carry/cometHolderCapacityProjection'
import { DIRECT_SUPPLY_MARKETS as markets } from '@/lib/carry/directSupplyMarketConstants'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import {
  buildConditionalCashHolderTimeProcess,
  selectedConditionalCashHolderTimeProcess,
  type CashHolderTimeProcessInput,
} from '@/lib/carry/conditionalCashHolderTimeProcess'
const hash = (s: string) => createHash('sha256').update(s).digest('hex'),
  NOW = Date.parse('2026-10-08T12:00:00.000Z')
function fixture(
  market = markets.aaveV3Usdc as (typeof markets)[keyof typeof markets],
  H = 24,
  paused: boolean | null = null,
) {
  const history = structuredClone(
    Object.values(audit.histories).find((h) => h.identity.routeKey === market.routeKey)!,
  ) as ConditionalSampledCashHistory
  const currentSource = {
    ...history.identity,
    chainId: 1 as const,
    block: '26190000',
    blockHash: '0x' + 'a'.repeat(64),
    blockTime: new Date(NOW - 60000).toISOString(),
    readAt: new Date(NOW).toISOString(),
    cashRaw: '500000000',
    sourceKind: 'live_read_only_two_origin_finalized' as const,
  }
  const source = {
      chainId: 1 as const,
      blockNumber: Number(currentSource.block),
      blockHash: currentSource.blockHash,
      blockTime: currentSource.blockTime,
      finalized: true as const,
    },
    owner = ('0x' + 'b'.repeat(40)) as `0x${string}`,
    q = '20000000'
  const assessment = {
    status: 'assessed',
    routeKey: history.identity.routeKey,
    destinationAddress: history.identity.destination,
    owner,
    request: { assetsRaw: q, assetAddress: history.identity.asset, horizonHours: H },
    source: { ...source, originValidation: 'single_provider' },
    stages: [
      {
        name: 'withdrawal',
        relatedToRequest: true,
        status: 'reverted',
        amountRaw: q,
        assetAddress: history.identity.asset,
      },
    ],
    finalPayout: { status: 'unassessed', assetAddress: history.identity.asset, amountRaw: null },
    forecast: {
      status: 'unvalidated',
      futureExit: null,
      exitDurationHours: null,
      prospectiveValidated: false,
    },
  } as HolderExitAssessment
  const quote = buildHolderExitCapacityQuote(
    assessment,
    {
      entitlementRaw: '100000000',
      quotedMaxWithdrawRaw: null,
      quotedMaxWithdrawStatus: 'not_read',
      effectiveLimitRaw: null,
      withdrawalsPaused: null,
    },
    NOW,
  )!
  const capacityAgreement = agreeHolderExitCapacityQuotes(
    { host: 'one.example', quote },
    { host: 'two.example', quote },
    NOW,
  )!
  const cometFactsAgreement =
    market === markets.compoundV3Usdc
      ? agreeCometWithdrawFacts(
          {
            host: 'one.example',
            facts: {
              ...history.identity,
              status: 'comet_withdraw_getter_observed',
              source,
              withdrawalsPaused: paused,
            },
          },
          {
            host: 'two.example',
            facts: {
              ...history.identity,
              status: 'comet_withdraw_getter_observed',
              source,
              withdrawalsPaused: paused,
            },
          },
          NOW,
        )
      : undefined
  const cashProjection = buildConditionalSampledCashPathProjection(
    { history, currentSource, request: { requestedRaw: q, asOf: new Date(NOW).toISOString() } },
    hash,
  )
  const input: CashHolderTimeProcessInput = {
    cashProjection,
    capacityAgreement,
    cometFactsAgreement,
    currentSource,
    binding: { ...history.identity, owner, requestedRaw: q, currentSource: source, asOfMs: NOW },
    horizonHours: H,
    asOfMs: NOW,
  }
  return { input, history }
}
describe('cash-backed holder constant-rate time process', () => {
  it.each(Object.values(markets).flatMap((m) => [1, 24, 48].map((h) => [m, h] as const)))(
    'uses actual pinned %s history for H%s without a daily horizon label',
    (market, H) => {
      const f = fixture(market, H)
      expect(
        selectedHolderExitCapacity(f.input.capacityAgreement, f.input.binding)?.quote
          .entitlementMethod,
      ).toBe('supplied_balance')
      expect(
        selectedConditionalSampledCashPathProjection(
          f.input.cashProjection,
          {
            identity: f.history.identity,
            requestedRaw: f.input.binding.requestedRaw,
            currentSource: f.input.currentSource,
            asOfMs: NOW,
          },
          hash,
        ),
      ).not.toBeNull()
      const v = buildConditionalCashHolderTimeProcess(f.input, hash)!
      expect(v).not.toBeNull()
      expect(v.process.targetAtUtc).toBe(new Date(NOW + H * 3600000).toISOString())
      expect(v.process.scenarios).toHaveLength(f.history.points.length - 1)
      expect(v.process.input.observations[0].availableAtUtc).toBe(f.history.witness.availableAt)
      expect(v.process.minimumHistoricalResolutionSeconds).toBeGreaterThan(80000)
      expect(v.process.scenarios[0].points[0].headroomRaw).toBe('80000000')
      for (const scenario of v.process.scenarios)
        for (const p of scenario.points) {
          expect(p.capacityRaw).toBe(
            String(BigInt(p.availableRaw) < 100000000n ? BigInt(p.availableRaw) : 100000000n),
          )
          expect(p.headroomRaw).toBe(String(BigInt(p.capacityRaw) - 20000000n))
        }
      expect(
        selectedConditionalCashHolderTimeProcess(v, { input: f.input, asOfMs: NOW + 1000 }, hash),
      ).toEqual(v)
      expect(v.holderExecutableExit).toBe(false)
    },
  )
  it.each([1, 24, 48, 8760])(
    'reports full replay size for H%s without dropping donor scenarios',
    (H) => {
      const f = fixture(markets.aaveV3Usdc, H),
        v = buildConditionalCashHolderTimeProcess(f.input, hash)!
      expect(v).not.toBeNull()
      expect(v.process.scenarios).toHaveLength(119)
      expect(v.process.scenarios.every((s) => s.points.length <= 128)).toBe(true)
      writeSync(
        1,
        `cash_holder_full_replay_bytes H=${H} bytes=${Buffer.byteLength(JSON.stringify(v))}\n`,
      )
    },
  )
  it('keeps immutable issued targets while a later render revalidates source and holder', () => {
    const f = fixture(),
      v = buildConditionalCashHolderTimeProcess(f.input, hash)!
    expect(
      selectedConditionalCashHolderTimeProcess(v, { input: f.input, asOfMs: NOW + 600000 }, hash),
    ).toEqual(v)
    expect(v.process.issueAtUtc).toBe(new Date(NOW).toISOString())
    expect(
      selectedConditionalCashHolderTimeProcess(v, { input: f.input, asOfMs: NOW + 1800000 }, hash),
    ).toBeNull()
    expect(
      selectedConditionalCashHolderTimeProcess(v, { input: f.input, asOfMs: NOW - 1 }, hash),
    ).toBeNull()
  })
  it.each(['owner', 'Q', 'source', 'units', 'entitlement', 'history', 'cash', 'requestClock'])(
    'rejects external %s drift',
    (mode) => {
      const f = fixture(),
        v = buildConditionalCashHolderTimeProcess(f.input, hash)!,
        e = structuredClone(f.input)
      if (mode === 'owner') e.binding.owner = '0x' + 'c'.repeat(40)
      if (mode === 'Q') e.binding.requestedRaw = '1'
      if (mode === 'source') e.currentSource.blockHash = '0x' + 'd'.repeat(64)
      if (mode === 'units') e.currentSource.assetDecimals = 18
      if (mode === 'entitlement') (e.capacityAgreement as any).quote.entitlementRaw = '1'
      if (mode === 'history') (e.cashProjection as any).history.points[0][4] = '1'
      if (mode === 'cash') e.currentSource.cashRaw = '1'
      if (mode === 'requestClock') e.asOfMs = NOW + 1
      expect(
        selectedConditionalCashHolderTimeProcess(v, { input: e, asOfMs: NOW + 1000 }, hash),
      ).toBeNull()
    },
  )
  it('applies separately agreed Comet pause without pretending unknown pause is clear', () => {
    const paused = buildConditionalCashHolderTimeProcess(
      fixture(markets.compoundV3Usdc, 1, true).input,
      hash,
    )!
    expect(paused.withdrawalsPaused).toBe(true)
    expect(
      paused.process.scenarios.every((s) =>
        s.points.every((p) => p.capacityRaw === '0' && p.headroomRaw === '-20000000'),
      ),
    ).toBe(true)
    const unknown = buildConditionalCashHolderTimeProcess(
      fixture(markets.compoundV3Usdc, 1).input,
      hash,
    )!
    expect(unknown.withdrawalsPaused).toBeNull()
    expect(unknown.process.scenarios[0].points[0].capacityRaw).toBe('100000000')
  })
  it('snapshots approvals before hostile hash callbacks and rejects forged output facts', () => {
    const f = fixture(),
      baseline = buildConditionalCashHolderTimeProcess(f.input, hash),
      copy = structuredClone(f.input)
    const v = buildConditionalCashHolderTimeProcess(f.input, (s) => {
      f.input.binding.owner = '0x' + 'c'.repeat(40)
      f.input.currentSource.cashRaw = '1'
      return hash(s)
    })
    expect(v).toEqual(baseline)
    const forged = structuredClone(v)!
    forged.process.scenarios[0].points[0].headroomRaw = '999'
    expect(
      selectedConditionalCashHolderTimeProcess(forged, { input: copy, asOfMs: NOW }, hash),
    ).toBeNull()
  })
  it('does not enroll idle-only Morpho or Fluid as full cash-backed exit capacity', () => {
    const f = fixture()
    const foreign = Object.values(audit.histories).find(
      (h) => !Object.values(markets).some((m) => m.routeKey === h.identity.routeKey),
    )!
    f.input.currentSource = { ...f.input.currentSource, ...foreign.identity }
    expect(buildConditionalCashHolderTimeProcess(f.input, hash)).toBeNull()
  })
})
