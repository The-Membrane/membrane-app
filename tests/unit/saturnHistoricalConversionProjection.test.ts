import { describe, expect, it } from 'vitest'
import {
  buildSaturnHistoricalConversionProjection as build,
  selectedSaturnHistoricalConversionProjection as select,
  type SaturnHistoricalConversionInput,
  type SaturnConversionPoint,
  type SaturnConversionEvidenceAcceptor,
} from '@/lib/carry/saturnHistoricalConversionProjection'
const NOW = Date.parse('2026-10-07T15:00:00.000Z'),
  owner = `0x${'a'.repeat(40)}`
function fixture(adjust?: (i: SaturnHistoricalConversionInput) => void) {
  const ticket = {
    owner,
    ticketId: '1581',
    sharesRaw18: '2000000000000000000',
    usdatOwedRaw6: '2000000',
    requestedAtUnix: String(Math.floor((NOW - 20 * 86400000) / 1000)),
    minSharePriceRaw: '1000000',
    status: 3,
    vaultPaused: false,
    queuePaused: false,
  }
  const codes = {
    curve: `0x${'1'.repeat(64)}`,
    pool: `0x${'2'.repeat(64)}`,
    quoter: `0x${'3'.repeat(64)}`,
    vault: `0x${'4'.repeat(64)}`,
    queue: `0x${'5'.repeat(64)}`,
  }
  const point = (block: string, at: number, ausd: string): SaturnConversionPoint => ({
    source: {
      chainId: 1 as const,
      blockNumber: block,
      blockHash: `0x${block.padStart(64, '0')}`,
      blockTime: new Date(at).toISOString(),
      finalized: true as const,
    },
    usdcQuotedRaw: '1999999',
    ausdQuotedRaw: ausd,
    status: 'conditional_quote' as const,
    runtimeCodeHashes: codes,
    identityVerified: true,
    ticket,
    missingLegs: [],
  })
  const input: SaturnHistoricalConversionInput = {
    mode: 'current_conditional',
    routeKey: 'AUSD → Staked USDat [USDat]',
    destination: '0xd166337499e176bbc38a1fbd113ab144e5bd2df7',
    owner,
    ticketId: '1581',
    sharesRaw18: ticket.sharesRaw18,
    requestedAusdRaw: '1900000',
    payoutAsset: '0x00000000efe302beaa2b3e6e1b18d08d69a9012a',
    payoutDecimals: 6,
    horizonHours: 24,
    asOfMs: NOW,
    current: {
      captureReceiptSha256: 'a'.repeat(64),
      readAtUtc: new Date(NOW).toISOString(),
      input: {
        usdatInputRaw: '2000000',
        assetUSDat: '0x23238f20b894f29041f48d88ee91131c395aaa71',
        assetDecimals: 6,
      },
      point: point('26150000', NOW - 60000, '1950000'),
      entitlementMethod: 'recorded_usdat_owed',
      physicalPullableUsdatRaw: null,
      claimSimulation: 'evm_revert',
      claimReturnUsdatRaw: null,
    },
    history: {
      status: 'verified_two_origin_saturn_conversion_history',
      knowledgeCutoff: new Date(NOW - 1000).toISOString(),
      captureReceiptSha256: 'b'.repeat(64),
      input: {
        usdatInputRaw: '2000000',
        assetUSDat: '0x23238f20b894f29041f48d88ee91131c395aaa71',
        assetDecimals: 6,
      },
      points: [
        point('26100000', NOW - 10 * 86400000, '2000000'),
        point('26100300', NOW - 10 * 86400000 + 3600000, '2200000'),
        point('26100600', NOW - 10 * 86400000 + 7200000, '1800000'),
      ],
      elapsedSeconds: [0, 3600, 7200],
    },
  }
  adjust?.(input)
  const evidence = structuredClone({ current: input.current, history: input.history })
  const accept: SaturnConversionEvidenceAcceptor = (kind, sha, value) =>
    sha === evidence[kind].captureReceiptSha256 &&
    JSON.stringify(value) === JSON.stringify(evidence[kind])
  return { input, accept, value: build(input, accept) }
}
describe('Saturn exact-sized owned recorded-amount conversion quotes', () => {
  it('retains recorded status without inferring processed or netfees, and requires matching claimreturn for netamount', () => {
    const unproved = fixture((i) => {
      i.current.point.ticket!.status = 1
    })
    expect(unproved.value!.amountBasis).toBe('recorded_owed_amount_if_delivered')
    expect(unproved.value!.recordedStatusInterpretation).toBe('unverified')
    expect(unproved.value!.claimFeeDeduction).toBe('unknown')
    const proved = fixture((i) => {
      i.current.claimSimulation = 'success'
      i.current.claimReturnUsdatRaw = '2000000'
    })
    expect(proved.value!.amountBasis).toBe('claim_simulated_net_amount')
    expect(proved.value!.currentClaimability).toBe('simulated_current_claim_only')
    expect(
      fixture((i) => {
        i.current.claimSimulation = 'success'
        i.current.claimReturnUsdatRaw = '1999999'
      }).value,
    ).toBeNull()
  })

  it('translates paired finalAUSD quotes and subtracts finalQonce despite currentclaimrevert', () => {
    const f = fixture(),
      v = f.value!
    expect(v).not.toBeNull()
    expect(select(v, f.input, f.accept)).toEqual(v)
    expect(v.scenarios.map((s) => s.quotedFinalAusdRaw)).toEqual(['6753333', '0'])
    expect(v.scenarios.map((s) => s.requestedHeadroomAusdRaw)).toEqual(['4853333', '-1900000'])
    expect(v.currentClaimability).toBe('unassessed_or_reverted')
    expect(v.futureQueueRelease).toBe('unknown_censored')
    expect(v.physicalFunding).toBe('unknown')
    expect(v.holderCapacity).toBe(false)
    expect(v.holderExecutableExit).toBe(false)
    expect(v.integratedClaimSwapExecution).toBe(false)
    expect(v.forwardProbability).toBe(false)
    expect(v.assumption).toBe('if_released_and_funded_extrapolate_constant_exact_size_historical_final_quote_change_rate_over_source_age_plus_h_even_beyond_observed_period')
    expect(v.evaluationScope).toBe('conditional_future_exact_size_quote_rate_extrapolation')
    expect(v.retrospectiveReplay).toBe(false)
    expect(v.chronologicalBacktestValidated).toBe(false)
    expect(v.futurePoolInventoryBounded).toBe(false)
    expect(v.futureMarketPriceBounded).toBe(false)
    expect(v.predictivePlausibilityEstablished).toBe(false)
    expect(v.scenarios[0].targetAt).toBe(new Date(NOW + 24 * 3600000).toISOString())
  })
  it.each(['1000000', '0'])('preserves full2USDat ticket quote despite funding=%s', (physical) => {
    const f = fixture((i) => {
      i.current.physicalPullableUsdatRaw = physical
    })
    expect(f.value!.recordedOwnedUsdatOwedRaw).toBe('2000000')
    expect(f.value!.conversionInputUsdatRaw).toBe('2000000')
    expect(f.value!.physicalFunding).toBe('insufficient_for_recorded_amount')
    expect(f.value!.scenarios[0].quotedFinalAusdRaw).toBe('6753333')
    expect(
      fixture((i) => {
        i.current.physicalPullableUsdatRaw = physical
        i.current.input.usdatInputRaw = '1000000'
        i.history.input.usdatInputRaw = '1000000'
      }).value,
    ).toBeNull()
  })
  it('records sufficientfunding without claiming integratedexecution and respects directclaim despitevaultpause', () => {
    const f = fixture((i) => {
      i.current.physicalPullableUsdatRaw = '2000000'
      i.current.point.ticket!.vaultPaused = true
      i.current.claimSimulation = 'success'
      i.current.claimReturnUsdatRaw = '2000000'
    })
    expect(f.value!.physicalFunding).toBe('sufficient_for_recorded_amount')
    expect(f.value!.currentClaimability).toBe('simulated_current_claim_only')
    expect(f.value!.observedPauseFacts.vaultPaused).toBe(true)
    expect(f.value!.holderExecutableExit).toBe(false)
    expect(f.value!.futureQueueRelease).toBe('unknown_censored')
  })
  it('retains ifreleasedquote whenpaused withoutclaimable orcapacityclaim', () => {
    const f = fixture((i) => {
      i.current.point.ticket!.queuePaused = true
    })
    expect(f.value!.currentClaimability).toBe('pause_observed_claim_unassessed_or_reverted')
    expect(f.value!.scenarios[0].quotedFinalAusdRaw).toBe('6753333')
    expect(f.value!.futureQueueRelease).toBe('unknown_censored')
    expect(f.value!.holderExecutableExit).toBe(false)
  })
  it('gaps incomplete or changedruntime donors and never interpolates throughgap', () => {
    for (const changed of [null, 'curve', 'pool', 'quoter'] as const) {
      const f = fixture((i) => {
        if (changed)
          i.history.points[1].runtimeCodeHashes = {
            ...i.history.points[1].runtimeCodeHashes,
            [changed]: `0x${'9'.repeat(64)}`,
          }
        else {
          i.history.points[1].status = 'incomplete'
          i.history.points[1].ausdQuotedRaw = null
          i.history.points[1].missingLegs = ['uniswap_quote']
        }
      })
      expect(f.value!.scenarios.every((s) => s.status === 'gap_censored')).toBe(true)
      expect(f.value!.scenarios.every((s) => s.quotedFinalAusdRaw === null)).toBe(true)
      expect(f.value!.sourceEquivalence).toBe('unverified')
    }
  })
  it('floorsnegative translatedquote atzero and rejectsuint256overflow', () => {
    const low = fixture((i) => {
      i.current.point.ausdQuotedRaw = '1'
      i.history.points[1].ausdQuotedRaw = '1'
    })
    expect(low.value!.scenarios[0].quotedFinalAusdRaw).toBe('0')
    expect(low.value!.scenarios[0].requestedHeadroomAusdRaw).toBe('-1900000')
    expect(
      fixture((i) => {
        i.current.point.ausdQuotedRaw = ((1n << 256n) - 1n).toString()
      }).value,
    ).toBeNull()
  })
  it('requires external rawreplay authority and exactsource/nativeowner/ticket/fullshares/Q', () => {
    const f = fixture()
    expect(build(f.input, () => false)).toBeNull()
    for (const mutate of [
      (i: any) => (i.owner = `0x${'b'.repeat(40)}`),
      (i: any) => (i.ticketId = '2'),
      (i: any) => (i.sharesRaw18 = '1'),
      (i: any) => (i.payoutDecimals = 18),
      (i: any) => (i.requestedAusdRaw = ['1900000']),
      (i: any) => (i.history.input.usdatInputRaw = '1000000'),
      (i: any) => (i.current.point.source.blockHash = `0x${'9'.repeat(64)}`),
      (i: any) => (i.current.point.ticket.usdatOwedRaw6 = '1'),
    ]) {
      const i = structuredClone(f.input)
      mutate(i)
      expect(build(i, f.accept)).toBeNull()
    }
  })
  it('validates sourceordering, fullticketregime and genuineknowledgecutoff evenexternallyreplayed', () => {
    for (const mutate of [
      (i: any) => (i.history.points[1].source.blockNumber = i.history.points[0].source.blockNumber),
      (i: any) => (i.history.elapsedSeconds[1] = 1),
      (i: any) => (i.history.knowledgeCutoff = new Date(NOW + 1).toISOString()),
      (i: any) => (i.current.point.ticket.requestedAtUnix = String(NOW)),
      (i: any) => (i.current.input.assetDecimals = 18),
      (i: any) => (i.current.point.ausdQuotedRaw = ['1']),
    ])
      expect(fixture(mutate).value).toBeNull()
  })
  it('acceptsinclusive30minexpiry but rechecksrenderclock and actualfuturetarget', () => {
    const f = fixture(),
      expiry = Date.parse(f.input.current.point.source.blockTime) + 1800000
    expect(select(f.value, { ...f.input, asOfMs: expiry }, f.accept)).not.toBeNull()
    expect(select(f.value, { ...f.input, asOfMs: expiry + 1 }, f.accept)).toBeNull()
    expect(
      fixture((i) => {
        i.current.point.source.blockTime = new Date(NOW + 1).toISOString()
      }).value,
    ).toBeNull()
  })
  it('retains donor periods while projecting each scenario at issue time plus user H and historicalbacktest explicitlyold', () => {
    for (const horizonHours of [1, 24, 48]) {
      const f = fixture((i) => {
        i.horizonHours = horizonHours
      })
      expect(f.value!.scenarios.map((s) => s.elapsedSeconds)).toEqual([3600, 7200])
      expect(f.value!.scenarios.every((s) => s.targetAt === new Date(NOW + horizonHours * 3600000).toISOString())).toBe(true)
      expect(f.value!.sourceAgeMs).toBe(60000)
      expect(f.value!.projectionElapsedMs).toBe(60000 + horizonHours * 3600000)
    }
    const f = fixture((i) => {
      i.mode = 'historical_backtest'
      i.current.point = structuredClone(i.history.points[0])
    })
    expect(f.value).not.toBeNull()
    expect(f.value!.sourceProofValidUntil).toBeNull()
    expect(f.value!.retrospectiveReplay).toBe(true)
    expect(f.value!.evaluationScope).toBe('retrospective_replay_with_later_knowledge_cutoff')
    expect(f.value!.chronologicalBacktestValidated).toBe(false)
    expect(f.value!.issuedAt).toBe(new Date(NOW).toISOString())
    expect(Date.parse(f.value!.scenarios[0].targetAt)).toBeLessThan(NOW)
    expect(f.value!.input.history.knowledgeCutoff).toBe(new Date(NOW - 1000).toISOString())
  })

  it('uses public exact-size quote history without importing historical ticket ownership', () => {
    for (const historicTicket of [null, { ...fixture().input.current.point.ticket!, owner: `0x${'b'.repeat(40)}`, ticketId: '77', sharesRaw18: '1', usdatOwedRaw6: '9' }]) {
      const f = fixture((i) => { i.history.points.forEach((p) => {
        p.ticket = historicTicket
        p.runtimeCodeHashes = { ...p.runtimeCodeHashes, vault: null, queue: null }
      }) })
      expect(f.value).not.toBeNull()
      expect(f.value!.historicalOwnershipRequired).toBe(false)
      expect(f.value!.holderExecutableExit).toBe(false)
      expect(f.value!.physicalFunding).toBe('unknown')
    }
    expect(fixture((i) => { i.current.point.ticket = null }).value).toBeNull()
    expect(fixture((i) => { i.current.point.runtimeCodeHashes.queue = null }).value).toBeNull()
    expect(fixture((i) => { i.current.point.ticket!.owner = `0x${'b'.repeat(40)}` }).value).toBeNull()
  })
  it('quotes the actual net claim return at exactly that size and never rescales gross history', () => {
    const net = (i: SaturnHistoricalConversionInput) => {
      i.current.entitlementMethod = 'claim_return'
      i.current.claimSimulation = 'success'
      i.current.claimReturnUsdatRaw = '1990000'
      i.current.input.usdatInputRaw = '1990000'
      i.history.input.usdatInputRaw = '1990000'
    }
    const f = fixture(net)
    expect(f.value!.conversionInputUsdatRaw).toBe('1990000')
    expect(f.value!.recordedOwnedUsdatOwedRaw).toBe('2000000')
    expect(f.value!.claimFeeDeduction).toBe('included_in_simulated_return')
    expect(f.value!.physicalFunding).toBe('unknown')
    expect(fixture((i) => { net(i); i.history.input.usdatInputRaw = '2000000' }).value).toBeNull()
    expect(fixture((i) => { net(i); i.current.claimSimulation = 'evm_revert'; i.current.claimReturnUsdatRaw = null }).value).toBeNull()
  })
  it('counts source age once and floors negative fractional quote-rate deltas', () => {
    const f = fixture((i) => {
      i.horizonHours = 1
      i.current.point.ausdQuotedRaw = '100'
      i.history.points[0].ausdQuotedRaw = '100'
      i.history.points[1].ausdQuotedRaw = '99'
    })
    expect(f.value!.scenarios[0].quotedFinalAusdRaw).toBe('98')
    expect(f.value!.sourceAgeMs).toBe(60000)
    expect(f.value!.projectionElapsedMs).toBe(3660000)
    expect(f.value!.targetAt).toBe(new Date(NOW + 3600000).toISOString())
  })
  it('rejectstamperedscope, paidflags, math,target,missinglegs,andcallbackselfpinmutation', () => {
    const f = fixture(),
      before = structuredClone(f.input)
    for (const mutate of [
      (v: any) => (v.scope = 'full_holder_capacity'),
      (v: any) => (v.holderExecutableExit = true),
      (v: any) => (v.scenarios[0].quotedFinalAusdRaw = '1'),
      (v: any) => (v.scenarios[0].targetAt = new Date(NOW).toISOString()),
      (v: any) => (v.futureQueueRelease = 'guaranteed'),
      (v: any) => (v.input.history.captureReceiptSha256 = 'f'.repeat(64)),
    ]) {
      const v = structuredClone(f.value)
      mutate(v)
      expect(select(v, f.input, f.accept)).toBeNull()
    }
    expect(f.input).toEqual(before)
  })
})
