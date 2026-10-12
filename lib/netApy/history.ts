/**
 * CHANGE HISTORY for net-APY-at-size: what moved between two recorder ticks.
 *
 * Campaigns are the reason this exists. A Merkl stream that ends early (budget spent,
 * creator pulled it) or quietly gets its end date moved is exactly the "incentive
 * ended without warning" failure from the DeFi Dojo research. One snapshot cannot show
 * that; two consecutive ones can. IRM and fee parameters are diffed too, because a
 * governance change to a slope or a reserve factor moves every rate at every size.
 *
 * Pure: no I/O. scripts/record-net-apy.ts feeds it the previous and current state.
 */

import type { IncentiveCampaign, IncentiveSide } from './incentives'
import type { VenueSnapshot } from './types'

interface CampaignRef {
  venueKey: string
  side: IncentiveSide
  campaignId: string
  name: string
}

export type NetApyEvent =
  | ({ kind: 'campaign_new'; at: number; aprReported: number; endTs: number; plainDepositEligible: boolean } & CampaignRef)
  | ({ kind: 'campaign_end_changed'; at: number; fromEndTs: number; toEndTs: number } & CampaignRef)
  /** Gone from Merkl while its end date was still in the future: the stream lapsed early. */
  | ({ kind: 'campaign_gone_early'; at: number; endTs: number } & CampaignRef)
  | ({ kind: 'campaign_ended'; at: number; endTs: number } & CampaignRef)
  | { kind: 'param_changed'; at: number; venueKey: string; block: string; field: string; from: string; to: string }

const ref = (c: IncentiveCampaign): CampaignRef => ({ venueKey: c.venueKey, side: c.side, campaignId: c.campaignId, name: c.name })

/**
 * Campaign events between two Merkl observations. Only call this with two SUCCESSFUL
 * pulls: diffing against a failed (empty) pull would report every campaign as gone.
 */
export function diffCampaigns(prev: readonly IncentiveCampaign[], next: readonly IncentiveCampaign[], nowTs: number): NetApyEvent[] {
  const out: NetApyEvent[] = []
  const before = new Map(prev.map((c) => [c.campaignId, c]))
  const after = new Map(next.map((c) => [c.campaignId, c]))
  for (const c of next) {
    const p = before.get(c.campaignId)
    if (!p) {
      out.push({ kind: 'campaign_new', at: nowTs, ...ref(c), aprReported: c.aprReported, endTs: c.endTs, plainDepositEligible: c.plainDepositEligible })
    } else if (p.endTs !== c.endTs) {
      out.push({ kind: 'campaign_end_changed', at: nowTs, ...ref(c), fromEndTs: p.endTs, toEndTs: c.endTs })
    }
  }
  for (const p of prev) {
    if (after.has(p.campaignId)) continue
    out.push(p.endTs > nowTs ? { kind: 'campaign_gone_early', at: nowTs, ...ref(p), endTs: p.endTs } : { kind: 'campaign_ended', at: nowTs, ...ref(p), endTs: p.endTs })
  }
  return out
}

/**
 * The parameters a governance or curator action changes. Continuously moving state
 * (balances, debt, Morpho's rateAtTarget, stored rates) is left out: it moves every
 * block and would turn the history into noise.
 */
export function paramFields(s: VenueSnapshot): Record<string, string> {
  const f: Record<string, string | bigint> = {}
  const { irm, state } = s
  if (irm.model === 'aave-rate-strategy-v2') {
    Object.assign(f, {
      strategy: irm.strategy,
      optimalUsageRatioBps: irm.optimalUsageRatioBps,
      baseVariableBorrowRateBps: irm.baseVariableBorrowRateBps,
      variableRateSlope1Bps: irm.variableRateSlope1Bps,
      variableRateSlope2Bps: irm.variableRateSlope2Bps,
    })
  } else if (irm.model === 'spark-variable-borrow') {
    // slope1 follows Spark's rate source (e.g. the savings rate): a change here is a
    // real rate change for every borrower, not noise.
    Object.assign(f, {
      strategy: irm.strategy,
      optimalUsageRatioRay: irm.optimalUsageRatioRay,
      baseVariableBorrowRateRay: irm.baseVariableBorrowRateRay,
      variableRateSlope1Ray: irm.variableRateSlope1Ray,
      variableRateSlope2Ray: irm.variableRateSlope2Ray,
    })
  } else if (irm.model === 'morpho-adaptive-curve') {
    f.irm = irm.irm
  } else {
    Object.assign(f, { irm: irm.irm, baseRate: irm.baseRate, slope1: irm.slope1, slope2: irm.slope2, kink: irm.kink })
  }
  if (state.kind === 'aave-virtual' || state.kind === 'spark') {
    Object.assign(f, { reserveFactorBps: state.reserveFactorBps, supplyCapWhole: state.supplyCapWhole, borrowCapWhole: state.borrowCapWhole })
  } else if (state.kind === 'morpho-market') {
    f.fee = state.fee
  } else {
    f.interestFee = state.interestFee
  }
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)]))
}

/** Parameter changes per venue between two snapshot sets. A venue missing from either
 *  side (a failed read) is skipped, never reported as a change. */
export function diffParams(prev: readonly VenueSnapshot[], next: readonly VenueSnapshot[], nowTs: number): NetApyEvent[] {
  const out: NetApyEvent[] = []
  const before = new Map(prev.map((s) => [s.venueKey, s]))
  for (const s of next) {
    const p = before.get(s.venueKey)
    if (!p) continue
    const a = paramFields(p)
    const b = paramFields(s)
    for (const field of Object.keys(b)) {
      if (a[field] !== undefined && a[field] !== b[field]) {
        out.push({ kind: 'param_changed', at: nowTs, venueKey: s.venueKey, block: String(s.anchor.blockNumber), field, from: a[field], to: b[field] })
      }
    }
  }
  return out
}
