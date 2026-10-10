import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { ChakraProvider } from '@chakra-ui/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { localHistoricalSampledCashTimeline } from '../../lib/carry/localHistoricalSampledCashTimeline'
import {
  buildConditionalSampledCashPathProjection,
  conditionalSampledCashHistoryFromVerifiedTimeline,
} from '../../lib/carry/conditionalSampledCashPathProjection'
import {
  matchingRouteForecastResponse,
  holderTimeProcessIssueFromResponse,
  eventImpactCurrentForWorkbench,
  loadRouteForecastWithLiveCurrent,
} from '../../components/Carry/ForecastWorkbench'
import {
  ExitPressureCard,
  formatExitPressureSignedRaw,
  type ExitPressureCardProps,
} from '../../components/Carry/ExitPressureCard'
import { selectedMorphoV2JointHolderForecastFromIssue } from '../../lib/carry/morphoV2JointHolderForecastBinding'
import { createMorphoV2JointHolderForecastFixture } from './fixtures/morphoV2JointHolderForecastFixture'
import {
  buildConditionalEventImpact,
  selectedConditionalEventImpact,
} from '../../lib/carry/conditionalEventImpact'

// Controlled unsigned native-cash claims; no original capture/native authority.
const sourceAt = '2026-10-08T10:00:00.000Z'
function fixture() {
  const identity = {
    routeKey: 'USDC → VaultV2 [USDC]',
    destination: '0x0026038a7fefef439d94bd99b4a10017e839d3a7',
    asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    assetDecimals: 6,
  }
  return {
    question: {
      ...identity,
      requestedRaw: '100',
      horizonHours: 24,
      issuedAtUtc: '2026-10-08T10:10:00.000Z',
    },
    currentSource: {
      ...identity,
      chainId: 1 as const,
      cashRaw: '1000',
      block: '1000',
      blockHash: `0x${'a'.repeat(64)}`,
      blockTime: sourceAt,
      readAt: '2026-10-08T10:01:00.000Z',
      sourceKind: 'live_read_only_two_origin_finalized' as const,
    },
    history: {
      identity: { ...identity },
      coverage: {
        gridAnchorCount: 120,
        observedAnchorCount: 3,
        leadingPredeploymentAnchorCount: 117,
        interiorUnavailableAnchorCount: 0,
        trailingUnavailableAnchorCount: 0,
        observedFromAnchorAt: '2026-10-03T00:00:00.000Z',
        observedToAnchorAt: '2026-10-05T00:00:00.000Z',
        gridFromAnchorAt: '2026-06-08T00:00:00.000Z',
        gridToAnchorAt: '2026-10-05T00:00:00.000Z',
        observedFromAt: '2026-10-02T23:59:59.000Z',
        observedToAt: '2026-10-04T23:59:59.000Z',
      },
      witness: {
        manifestSha256: '1'.repeat(64),
        lastDailyReceiptSha256: '2'.repeat(64),
        availableAt: '2026-10-07T00:00:00.000Z',
      },
      points: [
        [117, '100', `0x${'1'.repeat(64)}`, '2026-10-02T23:59:59.000Z', '10000'],
        [118, '200', `0x${'2'.repeat(64)}`, '2026-10-03T23:59:59.000Z', '9900'],
        [119, '300', `0x${'3'.repeat(64)}`, '2026-10-04T23:59:59.000Z', '9700'],
      ],
    },
  }
}
function model() {
  const f = fixture()
  const result = buildConditionalEventImpact(f)
  expect(result).not.toBeNull()
  return result!
}
describe('conditional historical NET cash context', () => {
  it('replaces NET once, applies source age once and Q once without a news delta', () => {
    const r = model()
    expect(r.sourceAgeMs).toBe(600000)
    expect(r.projectionElapsedMs).toBe(87000000)
    expect(r.scenarios.map((s) => s.targetCashRaw)).toEqual(['899', '798'])
    expect(r.target.minimumCashAfterQRaw).toBe('698')
    expect(r.target.netImpactRange).toEqual({ minimumRaw: '-202', maximumRaw: '-101' })
    expect(r.targetAtUtc).toBe('2026-10-09T10:10:00.000Z')
    expect(r.competingMRaw).toBeNull()
    expect(r.onsetAtUtc).toBeNull()
    expect(r.crossingAtUtc).toBeNull()
    expect(r.causalNewsEffect).toBe(false)
  })
  it('changing Q keeps all funding and NET identical', () => {
    const a = model(),
      f = fixture()
    f.question.requestedRaw = '500'
    const b = buildConditionalEventImpact(f)!
    expect(b.scenarios.map((s) => s.targetCashRaw)).toEqual(a.scenarios.map((s) => s.targetCashRaw))
    expect(b.target.minimumCashAfterQRaw).toBe('298')
  })
  it('uses arbitrary selected H and exact fractional source-age milliseconds', () => {
    const f = fixture()
    f.question.horizonHours = 3
    f.question.issuedAtUtc = '2026-10-08T10:10:00.501Z'
    const r = buildConditionalEventImpact(f)!
    expect(r.sourceAgeMs).toBe(600501)
    expect(r.projectionElapsedMs).toBe(11400501)
    expect(r.scenarios[0].targetNetImpactRaw).toBe('-14')
  })
  it('retains negative stocks censored with no complete numeric cash band', () => {
    const f = fixture()
    f.currentSource.cashRaw = '1'
    const r = buildConditionalEventImpact(f)!
    expect(r.scenarios.every((s) => s.status === 'censored')).toBe(true)
    expect(r.target.cashRange).toBeNull()
    expect(r.target.minimumCashAfterQRaw).toBeNull()
    expect(r.target.complete).toBe(false)
    expect(r.scenarios[0].targetCashRaw).toBe('-100')
  })
  it('never averages away a censored adverse scenario', () => {
    const f = fixture()
    f.currentSource.cashRaw = '150'
    const r = buildConditionalEventImpact(f)!
    expect(r.scenarios.map((s) => s.status)).toEqual(['usable', 'censored'])
    expect(r.target.cashRange).toBeNull()
    expect(r.target.netImpactRange).toBeNull()
    expect(r.scenarios[1].targetNetImpactRaw).toBe('-202')
  })
  it('does not invent adjacency across missing anchors or model positive NET', () => {
    const f = fixture()
    f.history.points[1][0] = 119
    f.history.points.pop()
    expect(buildConditionalEventImpact(f)).toBeNull()
    const p = fixture()
    p.history.points[1][4] = '11000'
    p.history.points[2][4] = '12000'
    expect(buildConditionalEventImpact(p)).toBeNull()
  })
  it('changing actual prior adverse flow changes the band', () => {
    const f = fixture()
    f.history.points[2][4] = '9800'
    expect(buildConditionalEventImpact(f)!.target.cashRange!.minimumRaw).toBe('899')
  })
  it.each([
    'route',
    'destination',
    'asset',
    'units',
    'Q',
    'H',
    'hash',
    'futureSource',
    'futureRead',
    'stale',
    'futureHistoryAvailability',
    'historicalSourceAfterCurrent',
  ] as const)('rejects %s mismatch', (kind) => {
    const f = fixture()
    switch (kind) {
      case 'route':
        f.question.routeKey = 'unknown'
        break
      case 'destination':
        f.question.destination = `0x${'f'.repeat(40)}`
        break
      case 'asset':
        f.question.asset = `0x${'f'.repeat(40)}`
        break
      case 'units':
        f.question.assetDecimals = 18
        break
      case 'Q':
        f.question.requestedRaw = '0'
        break
      case 'H':
        f.question.horizonHours = 1.5
        break
      case 'hash':
        f.currentSource.blockHash = '0x01'
        break
      case 'futureSource':
        f.currentSource.blockTime = '2026-10-08T11:00:00.000Z'
        break
      case 'futureRead':
        f.currentSource.readAt = '2026-10-08T11:00:00.000Z'
        break
      case 'stale':
        f.question.issuedAtUtc = '2026-10-08T10:30:00.001Z'
        break
      case 'futureHistoryAvailability':
        f.history.witness.availableAt = '2026-10-08T11:00:00.000Z'
        break
      case 'historicalSourceAfterCurrent':
        f.history.points[2][3] = '2026-10-08T11:00:00.000Z'
        break
    }
    expect(buildConditionalEventImpact(f)).toBeNull()
  })
  it('rejects sparse arrays, accessors and cycles without invoking getters', () => {
    const f = fixture()
    delete (f.history.points as any)[1]
    expect(buildConditionalEventImpact(f)).toBeNull()
    let calls = 0
    const a = fixture()
    Object.defineProperty(a.question, 'requestedRaw', {
      enumerable: true,
      get() {
        calls++
        return '1'
      },
    })
    expect(buildConditionalEventImpact(a)).toBeNull()
    expect(calls).toBe(0)
    const c = fixture()
    ;(c as any).cycle = c
    expect(buildConditionalEventImpact(c)).toBeNull()
  })
  it('snapshots repeated acyclic identities and isolates caller mutations', () => {
    const f = fixture()
    const r = buildConditionalEventImpact(f)!
    f.history.points[2][4] = '0'
    f.currentSource.cashRaw = '0'
    expect(r.scenarios[1].targetCashRaw).toBe('798')
    expect(Object.isFrozen(r.input.history.points)).toBe(true)
  })
  it('replays unsigned transport while rejecting authored outputs/rebinding/expiry', () => {
    const r = model(),
      at = Date.parse(r.input.question.issuedAtUtc) + 1
    expect(
      selectedConditionalEventImpact(
        JSON.parse(JSON.stringify(r)),
        r.input.question,
        r.input.currentSource,
        at,
      ),
    ).not.toBeNull()
    const forged = JSON.parse(JSON.stringify(r))
    forged.scenarios[0].targetCashRaw = '999'
    expect(
      selectedConditionalEventImpact(forged, r.input.question, r.input.currentSource, at),
    ).toBeNull()
    expect(
      selectedConditionalEventImpact(
        r,
        { ...r.input.question, requestedRaw: '101' },
        r.input.currentSource,
        at,
      ),
    ).toBeNull()
    expect(
      selectedConditionalEventImpact(
        r,
        r.input.question,
        { ...r.input.currentSource, blockHash: `0x${'b'.repeat(64)}` },
        at,
      ),
    ).toBeNull()
    expect(
      selectedConditionalEventImpact(
        r,
        r.input.question,
        r.input.currentSource,
        Date.parse(sourceAt) + 1800001,
      ),
    ).toBeNull()
    expect(
      selectedConditionalEventImpact(r, r.input.question, r.input.currentSource, at - 2),
    ).toBeNull()
  })
  it('preserves uint256-scale precision and censors unbounded impact instead of truncating', () => {
    const f = fixture()
    f.currentSource.cashRaw = String((1n << 256n) - 1n)
    f.history.points[0][4] = f.currentSource.cashRaw
    f.history.points[1][4] = '1'
    f.history.points[2][4] = '0'
    f.question.horizonHours = 8760
    const r = buildConditionalEventImpact(f)!
    expect(r.scenarios[0].status).toBe('censored')
    expect(r.target.netImpactRange).toBeNull()
    expect(r.scenarios[0].targetCashRaw.startsWith('-')).toBe(true)
  })
  it('rejects every changed displayed-source field even with unchanged cash', () => {
    const r = model(),
      at = Date.parse(r.input.question.issuedAtUtc) + 1
    for (const changed of [
      { readAt: '2026-10-08T10:02:00.000Z' },
      { sourceKind: 'manifest_bound_ledger' },
      { receiptSha256: 'f'.repeat(64) },
    ])
      expect(
        selectedConditionalEventImpact(
          r,
          r.input.question,
          { ...r.input.currentSource, ...changed } as any,
          at,
        ),
      ).toBeNull()
  })
  it('charges property keys and rejects huge input/output coverage before canonical hashing', () => {
    const key = 'k'.repeat(512 * 1024),
      f = fixture()
    ;(f.history.coverage as any)[key] = 1
    let calls = 0
    Object.defineProperty(f.history.coverage, 'blocked', {
      enumerable: true,
      get() {
        calls++
        return 1
      },
    })
    expect(buildConditionalEventImpact(f)).toBeNull()
    expect(calls).toBe(0)
    const r = model(),
      forged = JSON.parse(JSON.stringify(r))
    forged.input.history.coverage[key] = 1
    expect(
      selectedConditionalEventImpact(
        forged,
        r.input.question,
        r.input.currentSource,
        Date.parse(r.input.question.issuedAtUtc),
      ),
    ).toBeNull()
    const keys = fixture()
    for (let i = 0; i < 1100; i++) (keys.history.coverage as any)['key' + i] = 1
    expect(buildConditionalEventImpact(keys)).toBeNull()
  })
  it('never grants holder/native/execution/receipt or causal authority', () => {
    const r = model()
    expect(r.scope).toBe('aggregate_native_cash_proxy_only')
    expect(r.originalAuthority).toBe(false)
    expect(r.authenticated).toBe(false)
    expect(r.holderExitForecast).toBe(false)
    expect(r.holderExecutableExit).toBe(false)
    expect(r.fullCashAllocatedToHolder).toBe(false)
    expect(r.reservedReceiptDeduction).toBe(false)
    expect(r.calibrated).toBe(false)
    expect(r.publicationIsFirstKnown).toBe(false)
  })
})

// Real frozen cash rows use the existing timeline decoder and compact pin check.
// The new current source/clock below is explicitly a controlled retrospective
// assertion; saved rows never establish fresh native acquisition or ownership.
const histories = new Map<
  string,
  NonNullable<ReturnType<typeof conditionalSampledCashHistoryFromVerifiedTimeline>>
>()
function savedHistory(pilot = false) {
  const id = pilot
    ? fixture().history.identity
    : {
        ...fixture().history.identity,
        routeKey: 'USDC → supply on Aave V3',
        destination: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
      }
  const previous = histories.get(id.destination)
  if (previous) return previous
  const root = join(process.cwd(), 'data/research/venue-signals/local-carry-cash-v1')
  const records = readdirSync(root)
    .filter((n) => /^\d{12}\.json$/.test(n))
    .sort()
    .map((n) => {
      const r = JSON.parse(readFileSync(join(root, n), 'utf8'))
      return {
        collectionMode: r.collectionMode,
        anchorAt: r.anchorAt,
        firstLocalReceiptAt: r.firstLocalReceiptAt,
        receiptSha256: r.sha256,
        manifestSha256: r.manifestSha256,
        source: { block: r.block, blockHash: r.blockHash, blockAt: r.blockAt },
        subjects: r.rows,
      }
    })
  const decoded = localHistoricalSampledCashTimeline(records, {
    route_key: id.routeKey,
    destination: id.destination,
    asset: id.asset,
  })
  if (decoded.status !== 'sampled_timeline') throw Error('saved native timeline unavailable')
  const retainedHistory = conditionalSampledCashHistoryFromVerifiedTimeline(records, decoded)
  if (!retainedHistory) throw Error('saved compact native history unavailable')
  histories.set(id.destination, retainedHistory)
  return retainedHistory
}
function savedInput(at = '2026-10-08T08:00:10.000Z') {
  const h = savedHistory(),
    f = fixture()
  return {
    question: { ...h.identity, requestedRaw: '1000000', horizonHours: 1, issuedAtUtc: at },
    history: h,
    currentSource: {
      ...f.currentSource,
      ...h.identity,
      cashRaw: '1000000000000000000000000000000',
      block: '26160000',
      blockHash: `0x${'d'.repeat(64)}`,
      blockTime: new Date(Date.parse(at) - 10000).toISOString(),
      readAt: at,
    },
  }
}
describe('saved native history and existing private headline integration', () => {
  it('truthfully abstains for genuine flat saved pilot cash instead of fabricating adverse donors', () => {
    const h = savedHistory(true),
      i = savedInput()
    expect(h.points.every((p) => p[4] === '0')).toBe(true)
    expect(
      buildConditionalEventImpact({
        ...i,
        history: h,
        question: { ...i.question, ...h.identity },
        currentSource: { ...i.currentSource, ...h.identity },
      }),
    ).toBeNull()
  })
  it('passes genuine saved string-block history through the existing strict pin decoder then stress builder', () => {
    const f = savedInput(),
      hash = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(f.history.points.every((p) => typeof p[1] === 'string')).toBe(true)
    const checked = buildConditionalSampledCashPathProjection(
      {
        history: f.history,
        currentSource: f.currentSource,
        request: { requestedRaw: f.question.requestedRaw, asOf: f.question.issuedAtUtc },
      },
      hash,
    )
    expect(checked.status).toBe('estimated')
    const r = buildConditionalEventImpact(f)!
    expect(r).not.toBeNull()
    expect(r.scenarios.length).toBeGreaterThan(0)
    expect(r.input.history.witness).toEqual(f.history.witness)
    expect(r.authenticated).toBe(false)
    const changed = structuredClone(f)
    changed.history.points[0][4] = '1'
    expect(
      buildConditionalSampledCashPathProjection(
        {
          history: changed.history,
          currentSource: changed.currentSource,
          request: {
            requestedRaw: changed.question.requestedRaw,
            asOf: changed.question.issuedAtUtc,
          },
        },
        hash,
      ),
    ).toMatchObject({ status: 'unavailable', reason: 'history_unverified' })
  })
  it.each([1, 168] as const)(
    'preserves original private H%s model/headline with explicitly controlled unsigned adverse claims',
    (horizon) => {
      const f = createMorphoV2JointHolderForecastFixture(
        'USDC',
        '987654321123456789',
        true,
        horizon,
      )
      const issue = holderTimeProcessIssueFromResponse(f.response, 200, f.question, null, null)
      if (!issue) throw Error('controlled original private issue missing')
      const original = selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)!
      // The real saved pilot cash is flat. These adverse claims are explicitly
      // synthetic unsigned inputs for private-headline isolation, not native evidence.
      const controlled = fixture(),
        base = savedInput(new Date(f.question.asOfMs).toISOString())
      const i = {
        ...base,
        history: controlled.history,
        question: {
          ...controlled.question,
          requestedRaw: '1000000',
          horizonHours: horizon,
          issuedAtUtc: new Date(f.question.asOfMs).toISOString(),
        },
        currentSource: { ...base.currentSource, ...controlled.history.identity },
      }
      const sidecar = buildConditionalEventImpact(i)!
      expect(sidecar.target.complete).toBe(true)
      const question = {
        routeKey: i.question.routeKey,
        destination: i.question.destination,
        amountUnits: '1',
        horizonHours: horizon,
        payoutAsset: i.question.asset,
        payoutAssetDecimals: 6,
      }
      // Receive clock is a controlled test clock, never production acquisition.
      const received = Date.now
      Date.now = () => f.question.asOfMs
      let forwarded
      try {
        forwarded = matchingRouteForecastResponse(
          {
            routeKey: question.routeKey,
            destination: question.destination,
            source: 'prospective_finalized_observations',
            forecast: { claim: 'aggregate_cash_proxy_only', amountUnits: 1, horizonHours: horizon },
            conditionalEventImpact: JSON.parse(JSON.stringify(sidecar)),
            conditionalEventImpactCurrentSource: i.currentSource,
          },
          question,
        )?.conditionalEventImpact
      } finally {
        Date.now = received
      }
      expect(forwarded).not.toBeNull()
      expect(forwarded).not.toBeUndefined()
      const props: ExitPressureCardProps = {
        routeKey: f.question.routeKey,
        destination: f.question.destination,
        requestedAmount: '1',
        requestedRaw: f.question.requestedRaw,
        requestedAssetSymbol: 'USDC',
        requestedAssetAddress: f.question.requestedAssetAddress,
        requestedAssetDecimals: 6,
        requestedHolderAddress: f.question.requestedHolderAddress,
        horizonHours: horizon,
        asOfMs: f.question.asOfMs,
        currentCash: {
          routeKey: i.question.routeKey,
          destination: i.question.destination,
          cashRaw: i.currentSource.cashRaw,
          assetDecimals: 6,
          assetSymbol: 'USDC',
          assetAddress: i.question.asset,
          observedAt: i.currentSource.blockTime,
          block: i.currentSource.block,
          blockHash: i.currentSource.blockHash,
          freshness: 'fresh',
          label: 'Vault cash',
          readAtUtc: i.currentSource.readAt,
          sourceKind: i.currentSource.sourceKind,
        },
        prospectiveCashModel: null,
        historicalScenario: null,
        grossWithdrawals: null,
        grossInflows: null,
        historicalGrossFlow: null,
        morphoPayout: null,
        holderAssessment: null,
        expectedEventEnrollment: null,
        eventContext: null,
        historicalOutlook: null,
        holderTimeProcessIssue: issue,
        holderCapacityAgreement: f.capacityAgreement,
        holderMorphoV2ProtocolCapacityEvidence: f.compactProtocol,
        holderMorphoV2CurrentHolderPositionEvidence: f.compactHolder,
        holderMorphoV2HistoricalHolderEaEvidence: f.compactHistorical,
        conditionalEventImpact: forwarded,
      }
      const render = (p: ExitPressureCardProps) =>
        renderToStaticMarkup(
          React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
        )
      const summary = original.process.descriptiveExpectedFlow.headline!
      const headline = `${formatExitPressureSignedRaw(summary.headroom.empiricalMean.floorRaw, 6)} USDC`
      const html = render(props)
      expect(html).toContain(headline)
      expect(html).toContain('exit-pressure-conditional-event-impact')
      expect(html).toContain(
        formatExitPressureSignedRaw(sidecar.target.netImpactRange!.minimumRaw, 6)!,
      )
      // Cash/read metadata can reject this unsigned sidecar without changing
      // the original private receipt's complete canonical source question.
      for (const changed of [
        { cashRaw: '1' },
        { readAtUtc: new Date(f.question.asOfMs - 1).toISOString() },
      ]) {
        const rejected = render({ ...props, currentCash: { ...props.currentCash!, ...changed } })
        expect(rejected).not.toContain('exit-pressure-conditional-event-impact')
        expect(rejected).toContain(headline)
        expect(selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)).toBe(original)
      }
      // A different canonical header is a different question: neither display
      // may rebind the old issue. Its original private model remains selectable
      // only under the unchanged original question.
      for (const changed of [
        { blockHash: `0x${'b'.repeat(64)}` },
        { observedAt: '2026-10-08T08:00:01.000Z' },
      ]) {
        const rejected = render({ ...props, currentCash: { ...props.currentCash!, ...changed } })
        expect(rejected).not.toContain('exit-pressure-conditional-event-impact')
        expect(rejected).not.toContain(headline)
        expect(selectedMorphoV2JointHolderForecastFromIssue(issue, f.question)).toBe(original)
      }
      const censored = buildConditionalEventImpact({
        ...i,
        currentSource: { ...i.currentSource, cashRaw: '0' },
      })!
      const censoredHtml = render({
        ...props,
        currentCash: { ...props.currentCash!, cashRaw: '0' },
        conditionalEventImpact: censored,
      })
      expect(censored.target.netImpactRange).toBeNull()
      expect(censoredHtml).toContain('CENSORED')
      expect(censoredHtml).toContain(headline)
    },
  )
  it.each([3, 168, 336])(
    'retains independent current metadata through non-24h H%s and rejects witness rebinding',
    async (horizon) => {
      const i = savedInput()
      i.question.horizonHours = horizon
      const hash = (s: string) => createHash('sha256').update(s).digest('hex')
      expect(
        buildConditionalSampledCashPathProjection(
          {
            history: i.history,
            currentSource: i.currentSource,
            request: { requestedRaw: i.question.requestedRaw, asOf: i.question.issuedAtUtc },
          },
          hash,
        ).status,
      ).toBe('estimated')
      const sidecar = buildConditionalEventImpact(i)!
      const question = {
        routeKey: i.question.routeKey,
        destination: i.question.destination,
        amountUnits: '1',
        horizonHours: horizon,
        payoutAsset: i.question.asset,
        payoutAssetDecimals: 6,
      }
      const at = Date.parse(i.question.issuedAtUtc),
        oldNow = Date.now
      Date.now = () => at
      const response = {
        routeKey: question.routeKey,
        destination: question.destination,
        source: 'prospective_finalized_observations',
        forecast: { claim: 'aggregate_cash_proxy_only', amountUnits: 1, horizonHours: horizon },
        sampledCashPaths: null,
        conditionalEventImpact: JSON.parse(JSON.stringify(sidecar)),
        conditionalEventImpactCurrentSource: i.currentSource,
      }
      let accepted, wrongWitness
      try {
        const requests: string[] = []
        accepted = await loadRouteForecastWithLiveCurrent(
          question as never,
          new AbortController().signal,
          (archive) => expect(archive).not.toBeNull(),
          (async (url: string) => {
            requests.push(url)
            return {
              ok: true,
              json: async () =>
                requests.length === 1
                  ? {
                      ...response,
                      conditionalEventImpact: null,
                      conditionalEventImpactCurrentSource: null,
                    }
                  : response,
            }
          }) as never,
        )
        expect(requests).toHaveLength(2)
        expect(
          new URL(requests[0], 'https://test.invalid').searchParams.has('includeLiveCurrent'),
        ).toBe(false)
        expect(
          new URL(requests[1], 'https://test.invalid').searchParams.get('includeLiveCurrent'),
        ).toBe('1')
        wrongWitness = matchingRouteForecastResponse(
          {
            ...response,
            conditionalEventImpactCurrentSource: {
              ...i.currentSource,
              readAt: new Date(at - 1).toISOString(),
            },
          },
          question as never,
        )
      } finally {
        Date.now = oldNow
      }
      expect(accepted?.conditionalEventImpact).not.toBeNull()
      expect(wrongWitness?.conditionalEventImpact).toBeNull()
      expect(accepted?.sampledCashPaths).toBeNull()
      const base = {
        routeKey: i.question.routeKey,
        destination: i.question.destination,
        cashRaw: i.currentSource.cashRaw,
        assetDecimals: 6,
        assetSymbol: 'USDC',
        assetAddress: i.question.asset,
        observedAt: i.currentSource.blockTime,
        block: i.currentSource.block,
        blockHash: i.currentSource.blockHash,
        freshness: 'fresh' as const,
        label: 'Vault cash' as const,
      }
      // The actual archived fallback differs from the fresh response witness.
      // This exercises the exact base-selection helper called by Workbench.
      const last = i.history.points.at(-1)!
      const archived = {
        ...base,
        cashRaw: last[4],
        block: last[1],
        blockHash: last[2],
        observedAt: last[3],
        freshness: 'stale' as const,
      }
      expect(archived.block).not.toBe(i.currentSource.block)
      const current = eventImpactCurrentForWorkbench(
        archived,
        accepted?.conditionalEventImpactCurrentSource,
        question as never,
        'USDC',
        'Vault cash',
        at,
      )
      expect(current?.block).toBe(i.currentSource.block)
      expect(current?.cashRaw).toBe(i.currentSource.cashRaw)
      expect(
        eventImpactCurrentForWorkbench(
          null,
          accepted?.conditionalEventImpactCurrentSource,
          question as never,
          'USDC',
          'Vault cash',
          at,
        ),
      ).toEqual(current)
      expect(current?.readAtUtc).toBe(i.currentSource.readAt)
      const props: ExitPressureCardProps = {
        routeKey: base.routeKey,
        destination: base.destination,
        requestedAmount: '1',
        requestedRaw: '1000000',
        requestedAssetSymbol: 'USDC',
        requestedAssetAddress: i.question.asset,
        requestedAssetDecimals: 6,
        horizonHours: horizon,
        asOfMs: at,
        currentCash: current,
        prospectiveCashModel: null,
        historicalScenario: null,
        grossWithdrawals: null,
        grossInflows: null,
        historicalGrossFlow: null,
        morphoPayout: null,
        holderAssessment: null,
        expectedEventEnrollment: null,
        eventContext: null,
        historicalOutlook: null,
        conditionalEventImpact: accepted?.conditionalEventImpact,
      }
      const render = (p: ExitPressureCardProps) =>
        renderToStaticMarkup(
          React.createElement(ChakraProvider, null, React.createElement(ExitPressureCard, p)),
        )
      expect(render(props)).toContain('exit-pressure-conditional-event-impact')
      for (const change of [
        { blockHash: `0x${'b'.repeat(64)}` },
        { observedAt: '2026-10-08T08:00:01.000Z' },
      ]) {
        // A separately chosen conflicting FRESH source cannot be replaced.
        const mismatched = eventImpactCurrentForWorkbench(
          { ...base, ...change },
          accepted?.conditionalEventImpactCurrentSource,
          question as never,
          'USDC',
          'Vault cash',
          at,
        )
        expect(mismatched?.readAtUtc).toBeUndefined()
        const rejected = render({ ...props, currentCash: mismatched })
        expect(rejected).not.toContain('exit-pressure-conditional-event-impact')
      }
    },
  )
})
