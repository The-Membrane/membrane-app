import type { HolderExitAssessment } from './holderExitAssessment'
import type { HolderExitMechanicalRequest } from './holderExitMechanicalProjection'

const ROUTE = 'AUSD → Staked USDat [USDat]'
const VAULT = '0xd166337499e176bbc38a1fbd113ab144e5bd2df7'
const AUSD = '0x00000000efe302beaa2b3e6e1b18d08d69a9012a'
const MAX = (1n << 256n) - 1n
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) <= MAX
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Two-origin caller qualifies original assessment before cloning. This is a discrete
 * mechanism scenario, not a future-price bound or a forecast of ticket release. */
export function buildSaturnOwnedTicketConditionalMechanism(
  assessment: HolderExitAssessment,
  request: HolderExitMechanicalRequest,
  qualifyOriginal: (assessment: HolderExitAssessment, request: HolderExitMechanicalRequest) => boolean,
) {
  try {
    if (!qualifyOriginal(assessment, request)) return null
    assessment = structuredClone(assessment); request = structuredClone(request)
    const s = assessment.source, c = assessment.stakedUsdatCondition, quote = c?.existingTicketConversionQuote
    const sourceAt = Date.parse(s.blockTime), targetMs = request.nowMs + request.horizonSeconds * 1000
    if (assessment.status === 'unsupported' || assessment.routeKey !== ROUTE || request.routeKey !== ROUTE ||
        !same(assessment.destinationAddress, VAULT) || !same(request.destinationAddress, VAULT) ||
        !same(assessment.owner, request.owner) || !/^0x[0-9a-f]{40}$/i.test(request.owner) ||
        !same(request.assetAddress, AUSD) || !same(assessment.request.assetAddress, AUSD) ||
        !same(assessment.finalPayout.assetAddress, AUSD) || assessment.request.assetsRaw !== request.assetsRaw ||
        assessment.request.horizonHours * 3600 !== request.horizonSeconds ||
        !uint(request.assetsRaw) || request.assetsRaw === '0' ||
        s.chainId !== 1 || s.originValidation !== 'two_provider' || !Number.isSafeInteger(s.blockNumber) || s.blockNumber <= 0 ||
        !/^0x[0-9a-f]{64}$/i.test(s.blockHash) || !Number.isFinite(sourceAt) ||
        !Number.isSafeInteger(request.nowMs) || request.nowMs < sourceAt || request.nowMs - sourceAt > 1800000 ||
        !Number.isSafeInteger(request.horizonSeconds) || request.horizonSeconds <= 0 || request.horizonSeconds > 720 * 3600 ||
        !Number.isSafeInteger(targetMs) || !c || c.existingTicketOwnership !== 'holder' ||
        !uint(c.existingTicketId) || !uint(c.existingTicketRequestedAtUnix) || c.existingTicketRequestedAtUnix === '0' ||
        BigInt(c.existingTicketRequestedAtUnix) * 1000n > BigInt(sourceAt) ||
        !quote || quote.status !== 'conditional_quote' || quote.execution !== 'unassessed' ||
        ![quote.usdatInputRaw, quote.usdcQuotedRaw, quote.ausdQuotedRaw, quote.curveCashUsdcRaw,
          quote.curveCashUsdatRaw, quote.uniswapActiveLiquidityRaw].every(uint) ||
        quote.usdatInputRaw === '0' || quote.ausdQuotedRaw === '0' ||
        !Number.isSafeInteger(quote.initializedTicksCrossed) || quote.initializedTicksCrossed < 0) return null
    const claim = assessment.stages.find(stage => stage.name === 'existing_ticket_claim')
    const record = c.existingTicketRecordedRequest
    if (c.existingTicketConversionBasis === 'claim_return') {
      if (c.existingTicketClaimStatus !== 'success' || claim?.status !== 'simulated' ||
          claim.amountRaw !== quote.usdatInputRaw ||
          c.existingTicketConversionFeeStatus !== 'included_in_claim_return') return null
    } else if (c.existingTicketConversionBasis === 'recorded_owed_if_delivered') {
      if (!record || !uint(record.usdatOwedRaw6) || record.usdatOwedRaw6 !== quote.usdatInputRaw ||
          !uint(record.sharesRaw18) || record.sharesRaw18 === '0' ||
          record.requestedAtUnix !== c.existingTicketRequestedAtUnix || !uint(record.minSharePriceRaw) ||
          !Number.isSafeInteger(record.rawStatus) || record.rawStatus < 0 || record.rawStatus > 255 ||
          c.existingTicketClaimStatus === 'success' || c.existingTicketConversionFeeStatus !== 'unknown') return null
    } else return null
    const q = BigInt(request.assetsRaw)
    return {
      schema: 'saturn_owned_ticket_conditional_mechanism_v1' as const,
      question: { routeKey: ROUTE, destination: VAULT, owner: request.owner.toLowerCase(), requestedRaw: request.assetsRaw,
        asset: AUSD, assetDecimals: 6 as const, horizonSeconds: request.horizonSeconds,
        issuedAtUtc: new Date(request.nowMs).toISOString(), targetAtUtc: new Date(targetMs).toISOString(),
        currentSource: structuredClone(s), ticketId: c.existingTicketId },
      sourceProofValidUntil: new Date(sourceAt + 1800000).toISOString(),
      scope: 'whole_owned_ticket_independent_of_new_requested_Q' as const,
      amountBasis: c.existingTicketConversionBasis,
      exactConversionInputUsdatRaw: quote.usdatInputRaw,
      currentExactSizeAusdQuoteRaw: quote.ausdQuotedRaw,
      claimFeeBasis: c.existingTicketConversionFeeStatus,
      scenarios: [
        { state: 'ticket_not_released_or_funded' as const, finalAusdRaw: '0', requestedHeadroomRaw: String(-q) },
        { state: 'if_ticket_delivered_and_exact_size_conversion_quote_unchanged' as const,
          finalAusdRaw: quote.ausdQuotedRaw, requestedHeadroomRaw: String(BigInt(quote.ausdQuotedRaw) - q) },
      ],
      deliveryAmountsReferOnlyToOwnedTicket: true as const,
      futureReleaseAtUtc: null, futureReleaseTiming: 'unknown_censored' as const,
      aggregateCashIsTicketFunding: false as const, currentSimulationIsMinedPayment: false as const,
      assumptions: ['owned_ticket_delivered', 'recorded_owed_amount_subject_to_unknown_claim_fee_if_not_simulated',
        'exact_size_pool_quote_unchanged', 'conversion_approvals_slippage_and_route_execution_not_modeled'],
      futurePriceBounded: false as const, scenarioRangeIsCapacityBound: false as const,
      historicalReplayValidated: false as const, calibratedProbability: false as const,
      holderExecutableExit: false as const, minedFinalPayout: false as const,
    }
  } catch { return null }
}
export type SaturnOwnedTicketConditionalMechanism = NonNullable<ReturnType<typeof buildSaturnOwnedTicketConditionalMechanism>>
