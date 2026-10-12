import {saturnTicketFixture as fixture} from './fixtures/saturnTicketMechanismFixture'
import { describe, expect, it } from 'vitest'
import { buildSaturnOwnedTicketConditionalMechanism } from '@/lib/carry/saturnOwnedTicketConditionalMechanism'
import type { HolderExitAssessment } from '@/lib/carry/holderExitAssessment'
import type { HolderExitMechanicalRequest } from '@/lib/carry/holderExitMechanicalProjection'

// Synthetic current assays verify mechanism accounting and bindings, not live qualification.
const now = Date.parse('2026-10-12T12:00:00.000Z')

describe('owned Saturn ticket discrete conditional final-asset mechanism', () => {
  it('projects exact owned-ticket conversion without mined payment or scaled Q quotes', () => {
    const { assessment: a, request: q } = fixture()
    const model = buildSaturnOwnedTicketConditionalMechanism(a, q, (x, y) => x === a && y === q)!
    expect(model.scenarios.map(s => s.finalAusdRaw)).toEqual(['0', '1999990'])
    expect(model.scenarios.map(s => s.requestedHeadroomRaw)).toEqual(['-1000000', '999990'])
    expect(model.futureReleaseAtUtc).toBeNull(); expect(model.futureReleaseTiming).toBe('unknown_censored')
    expect(model.holderExecutableExit).toBe(false); expect(model.minedFinalPayout).toBe(false)
    expect(model.scenarioRangeIsCapacityBound).toBe(false); expect(model.futurePriceBounded).toBe(false)
    a.request.assetsRaw = q.assetsRaw = '3000000'
    const larger = buildSaturnOwnedTicketConditionalMechanism(a, q, () => true)!
    expect(larger.currentExactSizeAusdQuoteRaw).toBe('1999990')
    expect(larger.scenarios[1].requestedHeadroomRaw).toBe('-1000010')
  })
  it('requires original qualification and rejects rebound source, owner, horizon, amount basis and ticket', () => {
    const { assessment: a, request: q } = fixture()
    expect(buildSaturnOwnedTicketConditionalMechanism(a, q, () => false)).toBeNull()
    for (const mutate of [
      (v: HolderExitAssessment) => { v.source.originValidation = 'single_provider' },
      (v: HolderExitAssessment) => { v.source.blockTime = new Date(now - 1800001).toISOString() },
      (v: HolderExitAssessment) => { v.owner = '0x0000000000000000000000000000000000000002' },
      (v: HolderExitAssessment) => { v.request.horizonHours = 24 },
      (v: HolderExitAssessment) => { v.stakedUsdatCondition!.existingTicketOwnership = 'other_owner' },
      (v: HolderExitAssessment) => { v.stakedUsdatCondition!.existingTicketConversionQuote!.usdatInputRaw = '1000000' },
      (v: HolderExitAssessment) => { v.stakedUsdatCondition!.existingTicketConversionBasis = 'claim_return' },
      (v: HolderExitAssessment) => { v.stakedUsdatCondition!.existingTicketRecordedRequest!.usdatOwedRaw6 = '1' },
    ]) { const bad = structuredClone(a); mutate(bad); expect(buildSaturnOwnedTicketConditionalMechanism(bad, q, () => true)).toBeNull() }
  })
  it('uses successful simulated net claim once, with included fee and still no execution assertion', () => {
    const { assessment: a, request: q } = fixture(), c = a.stakedUsdatCondition!
    c.existingTicketClaimStatus = 'success'; c.existingTicketConversionBasis = 'claim_return'; c.existingTicketConversionFeeStatus = 'included_in_claim_return'
    a.stages[0].status = 'simulated'; a.stages[0].amountRaw = c.existingTicketConversionQuote!.usdatInputRaw
    const model = buildSaturnOwnedTicketConditionalMechanism(a, q, () => true)!
    expect(model.currentExactSizeAusdQuoteRaw).toBe('1999990'); expect(model.currentSimulationIsMinedPayment).toBe(false)
    expect(model.claimFeeBasis).toBe('included_in_claim_return')
  })
})
