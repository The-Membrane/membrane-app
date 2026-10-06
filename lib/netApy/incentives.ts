/**
 * INCENTIVES — reward APR and END DATE per venue, from Merkl; the decay calendar; and
 * the incentive-free rate kept separate.
 *
 * Why the end date leads: in the DeFi Dojo research, incentive streams that lapsed
 * without warning (Merkl streams ending) ended several loops. A reward APR without its
 * end date is half a number.
 *
 * MATCHING IS BY ON-CHAIN ADDRESS, never by name. A campaign belongs to a venue when its
 * params name that venue's own token or market, read on-chain at the anchor:
 *   Aave / Spark   targetToken | lendingToken  == aToken            → supply side
 *                  targetToken | borrowingToken == variableDebtToken → borrow side
 *   Morpho Blue    params.market == market id (MORPHOSUPPLY / MORPHOBORROW)
 *   Euler v2       evkAddress | targetToken == vault (action LEND / BORROW)
 * Morpho collateral campaigns and MetaMorpho vault campaigns are other venues.
 *
 * SIZE DILUTES SOME CAMPAIGNS AND NOT OTHERS (Merkl `distributionType`):
 *   fixed-budget   (default, DUTCH_AUCTION, *_NET_APR): a fixed reward stream shared
 *                  pro rata, so your deposit dilutes it: apr × tvl / (tvl + size).
 *   rate-fixed     (FIX_*_PER_LIQUIDITY_VALUE): a set APR per dollar; does not dilute,
 *                  but the budget can run out before the end date.
 *   rate-capped    (MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE): a ceiling APR; shown as
 *                  reported, may fall as TVL grows.
 *   rate-targeted  (TARGET_APR_WITH_MERKL): tops the venue's own rate up to a target;
 *                  shown as reported.
 *
 * CONDITIONS ARE CARRIED, NOT HIDDEN. Some campaigns pay only positions that loop
 * (health-factor hooks), borrow, or hold a token. A plain deposit — which is what a
 * Membrane deployment is — does not qualify, so such a campaign is kept out of the
 * default net figure and listed as conditional.
 *
 * Everything here is label class 'reported': Merkl's API, not verified on-chain.
 */

import type { Address, VenueSnapshot } from './types'

export const MERKL_API = 'https://api.merkl.xyz/v4/opportunities'
export const MERKL_PROTOCOLS = ['aave', 'spark', 'morpho', 'euler'] as const

export type Dilution = 'fixed-budget' | 'rate-fixed' | 'rate-capped' | 'rate-targeted'
export type IncentiveSide = 'supply' | 'borrow'

export interface IncentiveCampaign {
  source: 'merkl'
  campaignId: string
  venueKey: string
  side: IncentiveSide
  name: string
  rewardSymbol: string | null
  /** Merkl's reported APR as a fraction (Merkl publishes percent). */
  aprReported: number
  distributionType: string
  dilution: Dilution
  /** Opportunity TVL in USD, the denominator of a fixed-budget campaign. */
  tvlUsd: number | null
  startTs: number
  endTs: number
  /** Plain-language eligibility conditions. Empty = any position qualifies. */
  conditions: string[]
  /** False when a condition excludes a plain deposit (loop, borrow, hold, whitelist). */
  plainDepositEligible: boolean
}

export interface IncentiveCoverage {
  source: string
  status: 'covered' | 'not-covered'
  note: string
}

/** What is and is not looked at. A source that is not covered shows nothing, and
 *  nothing is NOT a claim that no incentive exists there. */
export const INCENTIVE_COVERAGE: IncentiveCoverage[] = [
  { source: 'Merkl', status: 'covered', note: 'live campaigns on Ethereum for Aave, Spark, Morpho and Euler' },
  { source: 'Royco', status: 'not-covered', note: 'no verified public API endpoint (checked 2026-10-05)' },
  { source: 'protocol-native programs', status: 'not-covered', note: 'programs paid outside Merkl are not read' },
]

// ------------------------------------------------------------- Merkl payloads

/** The slice of Merkl's v4 opportunity payload this module reads. */
export interface MerklOpportunity {
  chainId: number
  type: string
  identifier: string
  name: string
  action?: string
  tvl?: number | null
  explorerAddress?: string | null
  campaigns?: MerklCampaign[] | null
}
export interface MerklCampaign {
  campaignId: string
  startTimestamp: number
  endTimestamp: number
  apr?: number | null
  distributionType?: string | null
  params?: Record<string, unknown> | null
  rewardToken?: { symbol?: string | null } | null
}

export function dilutionOf(distributionType: string | null | undefined): Dilution {
  const t = String(distributionType ?? '')
  if (t.startsWith('FIX_')) return 'rate-fixed'
  if (t.startsWith('MAX_')) return 'rate-capped'
  if (t.startsWith('TARGET_')) return 'rate-targeted'
  return 'fixed-budget'
}

const lc = (v: unknown): string => String(v ?? '').toLowerCase()

/** Eligibility conditions from campaign hooks, lists and the opportunity's own name. */
export function conditionsOf(o: MerklOpportunity, c: MerklCampaign): { conditions: string[]; plainDepositEligible: boolean } {
  const out: string[] = []
  let plain = true
  const p = c.params ?? {}
  const hooks = Array.isArray(p.hooks) ? (p.hooks as Record<string, unknown>[]) : []
  for (const h of hooks) {
    if (h.healthFactorThreshold !== undefined) {
      out.push(`health factor ≤ ${h.healthFactorThreshold} required`)
      plain = false
    } else if (h.borrowBytesLike !== undefined) {
      out.push('an open borrow is required')
      plain = false
    } else if (h.eligibilityTokenThreshold !== undefined) {
      out.push('a minimum token holding is required')
      plain = false
    } else {
      out.push(`eligibility hook type ${String(h.hookType ?? '?')}`)
      plain = false
    }
  }
  if (Array.isArray(p.whitelist) && p.whitelist.length > 0) {
    out.push('listed addresses only')
    plain = false
  }
  const paren = /\(([^)]+)\)/.exec(o.name)
  if (paren && /requir|only|must/i.test(paren[1])) {
    out.unshift(paren[1])
    plain = false
  }
  return { conditions: [...new Set(out)], plainDepositEligible: plain }
}

/** Which venue and side a campaign pays, or null when it is not one of ours. */
export function matchCampaign(
  o: MerklOpportunity,
  c: MerklCampaign,
  snapshots: readonly VenueSnapshot[],
  vaultOf: (venueKey: string) => Address | null,
): { venueKey: string; side: IncentiveSide } | null {
  if (o.chainId !== 1) return null
  const p = c.params ?? {}
  const target = lc(p.targetToken)
  const lending = lc(p.lendingToken)
  const borrowing = lc(p.borrowingToken)
  for (const s of snapshots) {
    const st = s.state
    if (st.kind === 'aave-virtual' || st.kind === 'spark') {
      // Aave v4 / Horizon campaigns name other tokens and fall through.
      if (o.type.startsWith('AAVE_V4')) continue
      if ([target, lending].includes(lc(st.aToken))) return { venueKey: s.venueKey, side: 'supply' }
      if ([target, borrowing].includes(lc(st.variableDebtToken))) return { venueKey: s.venueKey, side: 'borrow' }
    } else if (st.kind === 'morpho-market') {
      if (lc(p.market) !== lc(st.marketId)) continue
      if (o.type === 'MORPHOSUPPLY') return { venueKey: s.venueKey, side: 'supply' }
      if (o.type === 'MORPHOBORROW') return { venueKey: s.venueKey, side: 'borrow' }
    } else if (st.kind === 'euler-vault') {
      const vault = lc(vaultOf(s.venueKey))
      if (!vault || o.type !== 'EULER') continue
      if ([lc(p.evkAddress), target, lc(o.identifier)].includes(vault)) {
        return { venueKey: s.venueKey, side: o.action === 'BORROW' ? 'borrow' : 'supply' }
      }
    }
  }
  return null
}

/**
 * THE start rule, shared by every liveness check: a campaign has started unless its
 * start is a finite time after `nowTs`. No start time counts as started.
 */
export const hasStarted = (startTs: number | null | undefined, nowTs: number): boolean =>
  !(typeof startTs === 'number' && Number.isFinite(startTs) && startTs > nowTs)

/**
 * Live campaigns: started (`hasStarted`) and not yet ended at `nowTs`, paying a covered
 * venue. One that starts later — or, on a pinned historical block, started after it —
 * is not live yet.
 */
export function extractCampaigns(
  opportunities: readonly MerklOpportunity[],
  snapshots: readonly VenueSnapshot[],
  vaultOf: (venueKey: string) => Address | null,
  nowTs: number,
): IncentiveCampaign[] {
  const out: IncentiveCampaign[] = []
  const seen = new Set<string>()
  for (const o of opportunities) {
    for (const c of o.campaigns ?? []) {
      if (!(c.endTimestamp > nowTs) || seen.has(c.campaignId)) continue
      if (!hasStarted(c.startTimestamp, nowTs)) continue
      const m = matchCampaign(o, c, snapshots, vaultOf)
      if (!m) continue
      const apr = Number(c.apr)
      if (!Number.isFinite(apr) || apr < 0) continue
      seen.add(c.campaignId)
      out.push({
        source: 'merkl',
        campaignId: c.campaignId,
        venueKey: m.venueKey,
        side: m.side,
        name: o.name,
        rewardSymbol: c.rewardToken?.symbol ?? (typeof c.params?.symbolRewardToken === 'string' ? c.params.symbolRewardToken : null),
        aprReported: apr / 100,
        distributionType: String(c.distributionType ?? 'UNSPECIFIED'),
        dilution: dilutionOf(c.distributionType),
        tvlUsd: typeof o.tvl === 'number' && Number.isFinite(o.tvl) ? o.tvl : null,
        startTs: c.startTimestamp,
        endTs: c.endTimestamp,
        ...conditionsOf(o, c),
      })
    }
  }
  return out.sort((a, b) => a.endTs - b.endTs)
}

/**
 * A campaign's APR at the user's size. Only a fixed-budget campaign dilutes, and only on
 * the side the deposit lands on; with no TVL to dilute against, the reported APR is kept
 * and the caller labels it.
 */
export function aprAtSize(c: IncentiveCampaign, sizeUsd: number): number {
  if (c.dilution !== 'fixed-budget' || !(sizeUsd > 0) || c.tvlUsd === null || c.tvlUsd <= 0) return c.aprReported
  return (c.aprReported * c.tvlUsd) / (c.tvlUsd + sizeUsd)
}

export interface CalendarStep {
  /** When the step happens (a campaign's end), unix seconds. */
  ts: number
  campaignId: string
  name: string
  /** Total incentive APR for the side just before and just after this end. */
  aprBefore: number
  aprAfter: number
}

/**
 * The decay calendar for one venue side: the summed incentive APR at size today, then
 * one step down at each campaign end. `aprAfter` of the last step is the incentive-free
 * floor (0) unless a campaign runs past the horizon.
 */
export function decayCalendar(campaigns: readonly IncentiveCampaign[], sizeUsd: number, nowTs: number): { aprNow: number; steps: CalendarStep[] } {
  const live = campaigns
    .filter((c) => hasStarted(c.startTs, nowTs) && c.endTs > nowTs)
    .sort((a, b) => a.endTs - b.endTs)
  const aprs = live.map((c) => aprAtSize(c, sizeUsd))
  // Sum what is still running at each step rather than subtracting, so the floor after
  // the last end is exactly 0, not a float residue.
  const runningFrom = (i: number) => aprs.slice(i).reduce((sum, a) => sum + a, 0)
  const steps: CalendarStep[] = live.map((c, i) => ({
    ts: c.endTs,
    campaignId: c.campaignId,
    name: c.name,
    aprBefore: runningFrom(i),
    aprAfter: runningFrom(i + 1),
  }))
  return { aprNow: runningFrom(0), steps }
}

const PARAM_KEYS = ['targetToken', 'lendingToken', 'borrowingToken', 'market', 'evkAddress', 'hooks', 'whitelist', 'symbolRewardToken'] as const

/** Keep only what this module reads: the local store holds ~1/20th of the payload. */
export function trimOpportunity(o: MerklOpportunity): MerklOpportunity {
  return {
    chainId: o.chainId,
    type: o.type,
    identifier: o.identifier,
    name: o.name,
    action: o.action,
    tvl: o.tvl ?? null,
    explorerAddress: o.explorerAddress ?? null,
    campaigns: (o.campaigns ?? []).map((c) => ({
      campaignId: c.campaignId,
      startTimestamp: c.startTimestamp,
      endTimestamp: c.endTimestamp,
      apr: c.apr ?? null,
      distributionType: c.distributionType ?? null,
      params: Object.fromEntries(PARAM_KEYS.filter((k) => c.params && k in c.params).map((k) => [k, c.params![k]])),
      rewardToken: { symbol: c.rewardToken?.symbol ?? null },
    })),
  }
}

/** Fetch live Merkl opportunities with campaigns, per protocol, paged, trimmed. */
export async function fetchMerklOpportunities(fetchImpl: typeof fetch = fetch, maxPages = 5): Promise<MerklOpportunity[]> {
  const out: MerklOpportunity[] = []
  for (const protocol of MERKL_PROTOCOLS) {
    for (let page = 0; page < maxPages; page++) {
      const url = `${MERKL_API}?chainId=1&status=LIVE&campaigns=true&items=100&page=${page}&mainProtocolId=${protocol}`
      const r = await fetchImpl(url, { headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`merkl ${protocol} page ${page}: HTTP ${r.status}`)
      const body = (await r.json()) as unknown
      if (!Array.isArray(body)) throw new Error(`merkl ${protocol} page ${page}: expected an array`)
      out.push(...(body as MerklOpportunity[]).map(trimOpportunity))
      if (body.length < 100) break
    }
  }
  return out
}
