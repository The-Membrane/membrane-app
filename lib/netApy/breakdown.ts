/**
 * THE NET BREAKDOWN per (venue, size) — gross venue yield down to what reaches the user.
 *
 *   gross venue yield        borrowers' interest per unit supplied, at the user's size
 *   − venue fee              Aave/Spark reserve factor · Morpho market fee · Euler interest fee
 *   = venue supply APR       what the venue pays a depositor of this size
 *   − Membrane protocol leg  curator-set share of realized gain
 *   − curator leg            curator-set share of the same gain, capped at what is left
 *   = net to user, incentive-free
 *   + incentives at size     Merkl, diluted by the user's size where the budget is fixed
 *   = net to user, with incentives (shown only with every campaign's end date)
 *
 * MEMBRANE CHARGES THROUGH THE VENUES (owner ruling; lib/position-sim/carryCost.ts). Its
 * revenue is a curator-set share of venue yield. That share is NOT fixed pre-launch, so
 * unless a caller supplies one this module prints no number for it — the row says
 * "curator-set" and the net is an UPPER BOUND. It never prints 0%, $0 or "free".
 *
 * THE SPLIT mirrors CuratorVault.settleProtocolPayment (membrane-solidity
 * contracts/vaults/CuratorVault.sol:885): on a realized gain g,
 *   protocolPay = g × declaredRate
 *   curatorPay  = min(g × curatorFee, g − protocolPay)
 *   user        = g − protocolPay − curatorPay
 * and nothing is charged on a zero or negative gain. The user's residual can be small;
 * it is never below zero by this construction — but the venue rate itself can fall, so
 * nothing here is a promise of positive carry.
 *
 * Every figure is a projection at the anchor block (label 'projected' or narrower).
 */

import { aprToApy, WAD } from './fixedPoint'
import { aprAtSize, decayCalendar, INCENTIVE_COVERAGE, type CalendarStep, type IncentiveCampaign, type IncentiveCoverage } from './incentives'
import { kinkUtilization, ratesAtSize, ratesAtUtilization, ratesNow, SizeError } from './irm'
import { DAY_S, ratePath } from './ratePath'
import type { BlockAnchor, LabelClass, NetApyProtocol, RatePoint, VenueSnapshot } from './types'
import { usdToRaw } from './venues'

export interface MembraneShareInput {
  /** Protocol leg: CuratorRegistry.declaredRate(vault) as a fraction of realized gain. */
  protocolShare?: number
  /** Curator leg: CuratorVault.curatorFeeWad as a fraction of the same gain. */
  curatorShare?: number
}

export type RowKey =
  | 'gross'
  | 'venueFee'
  | 'venueNet'
  | 'membraneProtocol'
  | 'membraneCurator'
  | 'netIncentiveFree'
  | 'incentives'
  | 'netWithIncentives'
  | 'borrowRate'
  | 'borrowIncentives'
  | 'netBorrowCost'

export interface BreakdownRow {
  key: RowKey
  label: string
  op: '' | '−' | '+' | '='
  /** Fraction per year. null = not priced: the value is curator-set and none was given. */
  apr: number | null
  /** When `apr` is a ceiling rather than the value (net with an unpriced share). */
  bound: 'exact' | 'upper'
  labelClass: LabelClass
  note?: string
}

export interface WorstCase {
  kinkUtilization: number
  borrowAprAtKink: number
  supplyAprAtKink: number
  borrowAprAtFull: number
  /** Morpho only: the adaptive curve keeps climbing at 100% utilization. */
  borrowAprAtFullAfter7d: number | null
  borrowAprAtFullAfter30d: number | null
  labelClass: 'projected'
}

export interface SizeChecks {
  sizeRaw: bigint
  /** Remaining supply cap in USD; null = the venue has no supply cap (or none we read). */
  supplyCapHeadroomUsd: number | null
  /** Remaining borrow cap in USD; null = no cap read. */
  borrowCapHeadroomUsd: number | null
  /** Cash in the venue after the action — what can leave right now. */
  cashAfterUsd: number
  /** The action would revert on-chain (over a cap, or more than the venue's cash). */
  reverts: string | null
}

export interface NetBreakdown {
  venueKey: string
  label: string
  protocol: NetApyProtocol
  anchor: BlockAnchor
  side: 'supply' | 'borrow'
  sizeUsd: number
  now: RatePoint
  atSize: RatePoint | null
  rows: BreakdownRow[]
  /** The headline: net to user. APY converts the APR with per-second compounding. */
  net: { apr: number | null; apy: number | null; bound: 'exact' | 'upper'; withIncentives: boolean }
  netIncentiveFree: { apr: number | null; apy: number | null; bound: 'exact' | 'upper' }
  incentives: {
    eligible: (IncentiveCampaign & { aprAtSize: number })[]
    conditional: (IncentiveCampaign & { aprAtSize: number })[]
    calendar: { aprNow: number; steps: CalendarStep[] }
    coverage: IncentiveCoverage[]
  }
  worstCase: WorstCase
  checks: SizeChecks
  assumptions: string[]
}

export const NET_APY_ASSUMPTIONS = [
  'Projection from on-chain IRM parameters at the anchor block. Rates move every block; this is not a forecast and not a promise of positive carry.',
  'Sizes convert to tokens at $1.00 per stablecoin.',
  'Incentive APRs are reported by Merkl and not verified on-chain. A fixed-budget campaign is diluted pro rata by the size; other campaign types are shown as reported.',
  'Membrane charges through the venue: a curator-set share of realized gain (CuratorVault.settleProtocolPayment). It is not fixed pre-launch.',
]

const toUsd = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals

function validShare(name: string, v: number | undefined): number | undefined {
  if (v === undefined) return undefined
  // A zero share would print as a 0% Membrane charge. Omit it to show "curator-set".
  if (!Number.isFinite(v) || v <= 0 || v > 1) throw new RangeError(`${name} must be in (0, 1]; omit it to show "curator-set"`)
  return v
}

/** The CuratorVault split on a gain (APR). Mirrors settleProtocolPayment, incl. the cap. */
export function membraneSplit(gainApr: number, s: MembraneShareInput): { protocol: number | null; curator: number | null; user: number; bound: 'exact' | 'upper' } {
  const g = Math.max(0, gainApr)
  const p = s.protocolShare === undefined ? null : g * s.protocolShare
  const cRaw = s.curatorShare === undefined ? null : g * s.curatorShare
  const c = cRaw === null ? null : Math.min(cRaw, g - (p ?? 0))
  const user = g - (p ?? 0) - (c ?? 0)
  return { protocol: p, curator: c, user, bound: p === null || c === null ? 'upper' : 'exact' }
}

function sizeChecks(s: VenueSnapshot, side: 'supply' | 'borrow', sizeRaw: bigint): SizeChecks {
  const dec = s.asset.decimals
  const unit = 10n ** BigInt(dec)
  const st = s.state
  let supplyHead: bigint | null = null
  let borrowHead: bigint | null = null
  let cash: bigint
  if (st.kind === 'aave-virtual' || st.kind === 'spark') {
    const debt = st.kind === 'aave-virtual' ? st.totalDebt : st.totalVariableDebt
    // Aave's own check also counts accruedToTreasury (a sliver of supply), so this
    // headroom is a slight overstatement right at the cap.
    if (st.supplyCapWhole > 0n) supplyHead = st.supplyCapWhole * unit - st.totalSupplied
    if (st.borrowCapWhole > 0n) borrowHead = st.borrowCapWhole * unit - debt
    cash = st.kind === 'aave-virtual' ? st.virtualUnderlyingBalance : st.availableLiquidity
  } else if (st.kind === 'morpho-market') {
    cash = st.totalSupplyAssets - st.totalBorrowAssets
  } else {
    cash = st.cash
  }
  const cashAfter = side === 'supply' ? cash + sizeRaw : cash - sizeRaw
  let reverts: string | null = null
  if (side === 'supply' && supplyHead !== null && sizeRaw > supplyHead) reverts = 'over the supply cap'
  if (side === 'borrow' && borrowHead !== null && sizeRaw > borrowHead) reverts = 'over the borrow cap'
  if (side === 'borrow' && cashAfter < 0n) reverts = 'more than the venue’s cash'
  const head = (h: bigint | null) => (h === null ? null : toUsd(h < 0n ? 0n : h, dec))
  return {
    sizeRaw,
    supplyCapHeadroomUsd: head(supplyHead),
    borrowCapHeadroomUsd: head(borrowHead),
    cashAfterUsd: toUsd(cashAfter < 0n ? 0n : cashAfter, dec),
    reverts,
  }
}

function worstCase(s: VenueSnapshot): WorstCase {
  const k = kinkUtilization(s)
  const atKink = ratesAtUtilization(s, k)
  const atFull = ratesAtUtilization(s, WAD)
  const adaptive = s.irm.model === 'morpho-adaptive-curve'
  const path = adaptive ? ratePath(s, { utilization: 1, horizonSeconds: 30 * DAY_S, steps: 30 }) : null
  return {
    kinkUtilization: atKink.utilization,
    borrowAprAtKink: atKink.borrowApr,
    supplyAprAtKink: atKink.supplyApr,
    borrowAprAtFull: atFull.borrowApr,
    borrowAprAtFullAfter7d: path ? path[7].borrowApr : null,
    borrowAprAtFullAfter30d: path ? path[30].borrowApr : null,
    labelClass: 'projected',
  }
}

const apy = (apr: number | null): number | null => (apr === null ? null : aprToApy(apr))

export function netBreakdown(
  s: VenueSnapshot,
  opts: { side?: 'supply' | 'borrow'; sizeUsd: number; campaigns?: readonly IncentiveCampaign[]; share?: MembraneShareInput; nowTs?: number },
): NetBreakdown {
  const side = opts.side ?? 'supply'
  const share: MembraneShareInput = {
    protocolShare: validShare('protocolShare', opts.share?.protocolShare),
    curatorShare: validShare('curatorShare', opts.share?.curatorShare),
  }
  const sizeRaw = usdToRaw(opts.sizeUsd, s.asset)
  const nowTs = opts.nowTs ?? Number(s.anchor.blockTimestamp)
  const checks = sizeChecks(s, side, sizeRaw)
  const now = ratesNow(s)
  let atSize: RatePoint | null = null
  try {
    atSize = ratesAtSize(s, side === 'supply' ? { supply: sizeRaw, borrow: 0n } : { supply: 0n, borrow: sizeRaw })
  } catch (e) {
    if (!(e instanceof SizeError)) throw e
  }
  const sized: LabelClass = sizeRaw > 0n ? 'projected' : 'derived'

  const mine = (opts.campaigns ?? []).filter((c) => c.venueKey === s.venueKey && c.side === side)
  const withApr = mine.map((c) => ({ ...c, aprAtSize: aprAtSize(c, opts.sizeUsd) }))
  const eligible = withApr.filter((c) => c.plainDepositEligible)
  const conditional = withApr.filter((c) => !c.plainDepositEligible)
  const calendar = decayCalendar(eligible, opts.sizeUsd, nowTs)
  const incentiveApr = calendar.aprNow
  const soonest = eligible.length ? Math.min(...eligible.map((c) => c.endTs)) : null
  const endNote = soonest === null ? undefined : `first campaign ends ${new Date(soonest * 1000).toISOString().slice(0, 10)}`

  const rows: BreakdownRow[] = []
  let net: NetBreakdown['net']
  let netIncentiveFree: NetBreakdown['netIncentiveFree']

  if (side === 'supply') {
    const r = atSize ?? now
    rows.push(
      { key: 'gross', label: 'Gross venue yield', op: '', apr: r.grossSupplyApr, bound: 'exact', labelClass: sized, note: 'borrowers’ interest per unit supplied' },
      { key: 'venueFee', label: venueFeeLabel(s), op: '−', apr: r.venueFeeApr, bound: 'exact', labelClass: 'derived' },
      { key: 'venueNet', label: 'Venue supply APR', op: '=', apr: r.supplyApr, bound: 'exact', labelClass: sized },
    )
    const free = membraneSplit(r.supplyApr, share)
    rows.push(
      {
        key: 'membraneProtocol',
        label: 'Membrane protocol share',
        op: '−',
        apr: free.protocol,
        bound: 'exact',
        labelClass: 'curator-set',
        note: free.protocol === null ? 'curator-set share of yield — not fixed pre-launch' : 'curator-set share of realized gain',
      },
      {
        key: 'membraneCurator',
        label: 'Curator share',
        op: '−',
        apr: free.curator,
        bound: 'exact',
        labelClass: 'curator-set',
        note: free.curator === null ? 'curator-set — capped at the gain left after the protocol share' : 'capped at the gain left after the protocol share',
      },
      { key: 'netIncentiveFree', label: 'Net to you, no incentives', op: '=', apr: free.user, bound: free.bound, labelClass: 'projected' },
    )
    netIncentiveFree = { apr: free.user, apy: apy(free.user), bound: free.bound }
    if (eligible.length) {
      const all = membraneSplit(r.supplyApr + incentiveApr, share)
      rows.push(
        { key: 'incentives', label: 'Incentives at your size', op: '+', apr: incentiveApr, bound: 'exact', labelClass: 'reported', note: endNote },
        {
          key: 'netWithIncentives',
          label: 'Net to you, with incentives',
          op: '=',
          apr: all.user,
          bound: all.bound,
          labelClass: 'projected',
          note: 'the Membrane split applies to all realized gain, rewards included once the vault realizes them',
        },
      )
      net = { apr: all.user, apy: apy(all.user), bound: all.bound, withIncentives: true }
    } else {
      net = { ...netIncentiveFree, withIncentives: false }
    }
  } else {
    const r = atSize
    const borrowApr = r ? r.borrowApr : null
    rows.push({ key: 'borrowRate', label: 'Borrow APR at your size', op: '', apr: borrowApr, bound: 'exact', labelClass: sized, note: r ? undefined : checks.reverts ?? undefined })
    const cost = borrowApr === null ? null : borrowApr - incentiveApr
    if (eligible.length) {
      rows.push({ key: 'borrowIncentives', label: 'Borrow incentives at your size', op: '−', apr: incentiveApr, bound: 'exact', labelClass: 'reported', note: endNote })
    }
    rows.push({ key: 'netBorrowCost', label: 'Net borrow cost', op: '=', apr: cost, bound: 'exact', labelClass: 'projected' })
    netIncentiveFree = { apr: borrowApr, apy: apy(borrowApr), bound: 'exact' }
    net = { apr: cost, apy: apy(cost), bound: 'exact', withIncentives: eligible.length > 0 }
  }

  return {
    venueKey: s.venueKey,
    label: s.label,
    protocol: s.protocol,
    anchor: s.anchor,
    side,
    sizeUsd: opts.sizeUsd,
    now,
    atSize,
    rows,
    net,
    netIncentiveFree,
    incentives: { eligible, conditional, calendar, coverage: INCENTIVE_COVERAGE },
    worstCase: worstCase(s),
    checks,
    assumptions: NET_APY_ASSUMPTIONS,
  }
}

function venueFeeLabel(s: VenueSnapshot): string {
  if (s.protocol === 'aave-v3' || s.protocol === 'spark') return 'Reserve factor'
  if (s.protocol === 'morpho-blue') return 'Market fee'
  return 'Vault interest fee'
}
