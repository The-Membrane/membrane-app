/**
 * Governance-change events, as the governance-change rule consumes them.
 *
 * A venue can move a borrower's health factor with no price move: it cuts or ramps the
 * liquidation threshold, disables a collateral, or pauses repay. In E2 (Nov 2025) Euler cut
 * liquidation LTVs by 1–2 points on Nov 3 and, on Nov 4, liquidated a deUSD position at HF
 * 1.06 by setting its LTV to 0 inside the liquidation transaction (memo §1b).
 *
 * Severity of a threshold change is projected per position: the health factor the position
 * would have once the change fully applies, read against the warn line. A raise is not a
 * message. The adapters below take DECODED event arguments, so this module stays pure. The
 * event signatures are exported for the readers (scripts/research/build-governance-changes.mjs).
 *
 * Markets whose rules cannot change (Morpho Blue market params, Silo v2 configs) are covered
 * with no events. A source that is not wired reports `covered: false`, and the rule then
 * lists itself as uncovered — a quiet rule must never read as "no changes".
 */

import type {
  GovernanceChangeEvent,
  GovernanceChangeKind,
  PositionSnapshot,
  Severity,
} from './types'

export interface GovernanceChangeSource {
  covered: boolean
  /** Events of `market` with from <= ts <= to that touch the market or any of `assets`. */
  eventsBetween(from: number, to: number, market: string, assets: string[]): GovernanceChangeEvent[]
}

export const UNWIRED_GOVERNANCE_SOURCE: GovernanceChangeSource = {
  covered: false,
  eventsBetween: () => [],
}

/** A market whose rules cannot change: covered, never an event. */
export const IMMUTABLE_MARKET_SOURCE: GovernanceChangeSource = {
  covered: true,
  eventsBetween: () => [],
}

/** A fixed event list — for tests and replays. */
export function staticGovernanceSource(events: GovernanceChangeEvent[]): GovernanceChangeSource {
  return {
    covered: true,
    eventsBetween: (from, to, market, assets) => {
      const held = new Set(assets)
      return events.filter(
        (e) =>
          e.ts >= from &&
          e.ts <= to &&
          e.market === market &&
          (e.asset === undefined || held.has(e.asset)),
      )
    },
  }
}

/** Default severity per kind, when the adapter did not fix one and no projection applies. */
export const GOVERNANCE_CHANGE_SEVERITY: Record<GovernanceChangeKind, Severity> = {
  liquidation_threshold_changed: 'watch',
  collateral_disabled: 'critical',
  paused: 'critical',
  frozen: 'watch',
  liquidation_bonus_changed: 'watch',
  rate_model_changed: 'watch',
  governor_changed: 'watch',
  expiry_set: 'warn',
}

/** Health factor once a threshold change on `asset` fully applies, at today's prices. */
export function projectedHealthFactor(
  snapshot: PositionSnapshot,
  asset: string,
  threshold: number,
): number | null {
  if (!snapshot.collateral.some((c) => c.symbol === asset)) return null
  let weighted = 0
  for (const c of snapshot.collateral)
    weighted +=
      c.amount * c.oraclePriceUsd * (c.symbol === asset ? threshold : c.liquidationThreshold)
  const debt = snapshot.debt.reduce((a, d) => a + d.amount * d.priceUsd, 0)
  return debt > 0 ? weighted / debt : Infinity
}

/**
 * Severity of one change for one position, or null when it is not worth a message.
 * A threshold cut: critical when the projected HF is below 1, warn below `warnHf`, else watch.
 * A threshold raise: null. A threshold change on a collateral the position does not hold: null.
 */
export function governanceSeverity(
  e: GovernanceChangeEvent,
  snapshot: PositionSnapshot,
  warnHf: number,
): { severity: Severity; projectedHf: number | null } | null {
  if (e.severity) return { severity: e.severity, projectedHf: null }
  if (e.kind !== 'liquidation_threshold_changed' || !e.threshold)
    return { severity: GOVERNANCE_CHANGE_SEVERITY[e.kind], projectedHf: null }
  const to = e.threshold.to
  if (e.asset === undefined) return { severity: to === 0 ? 'critical' : 'watch', projectedHf: null }
  const leg = snapshot.collateral.find((c) => c.symbol === e.asset)
  if (!leg) return null
  // A cut: lower than where it started, or lower than the venue's threshold now (mid-ramp).
  const from = e.threshold.from ?? leg.liquidationThreshold
  if (!(to < Math.max(from, leg.liquidationThreshold) - 1e-9)) return null
  if (to === 0) return { severity: 'critical', projectedHf: 0 }
  const hf = projectedHealthFactor(snapshot, e.asset, to)
  if (hf === null) return null
  return { severity: hf < 1 ? 'critical' : hf < warnHf ? 'warn' : 'watch', projectedHf: hf }
}

// ------------------------------------------------------------------ event signatures

/** Euler v2 EVK Governance module (on the borrow vault). */
export const EULER_GOVERNANCE_EVENTS = [
  'event GovSetLTV(address indexed collateral, uint16 borrowLTV, uint16 liquidationLTV, uint16 initialLiquidationLTV, uint48 targetTimestamp, uint32 rampDuration)',
  'event GovSetHookConfig(address indexed newHookTarget, uint32 newHookedOps)',
  'event GovSetMaxLiquidationDiscount(uint16 newDiscount)',
  'event GovSetInterestRateModel(address newInterestRateModel)',
  'event GovSetGovernorAdmin(address indexed newGovernorAdmin)',
] as const

/** Gearbox v3 CreditConfigurator (one per credit manager). */
export const GEARBOX_CONFIGURATOR_EVENTS = [
  'event SetTokenLiquidationThreshold(address indexed token, uint16 liquidationThreshold)',
  'event ScheduleTokenLiquidationThresholdRamp(address indexed token, uint16 liquidationThresholdInitial, uint16 liquidationThresholdFinal, uint40 timestampRampStart, uint40 timestampRampEnd)',
  'event ForbidToken(address indexed token)',
  'event SetExpirationDate(uint40 expirationDate)',
  'event SetMaxDebtPerBlockMultiplier(uint8 maxDebtPerBlockMultiplier)',
] as const

/**
 * Aave v3 PoolConfigurator. v3.0 emits ReserveFrozen(asset) / ReserveUnfrozen(asset) and the
 * same for paused; v3.1 on emits one event with a bool. v3.2 on can drop an asset from an
 * e-mode category's collateral.
 */
export const AAVE_CONFIGURATOR_EVENTS = [
  'event CollateralConfigurationChanged(address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus)',
  'event ReserveFrozen(address indexed asset, bool frozen)',
  'event ReservePaused(address indexed asset, bool paused)',
  'event ReserveFrozen(address indexed asset)',
  'event ReserveUnfrozen(address indexed asset)',
  'event ReservePaused(address indexed asset)',
  'event ReserveUnpaused(address indexed asset)',
  'event EModeCategoryAdded(uint8 indexed categoryId, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, address oracle, string label)',
  'event AssetCollateralInEModeChanged(address indexed asset, uint8 categoryId, bool collateral)',
] as const

/**
 * Compound v3. A Configurator change takes effect when the comet proxy is upgraded
 * (`Upgraded`), usually in the same governance transaction. PauseAction is on the comet.
 */
export const COMPOUND_GOVERNANCE_EVENTS = [
  'event UpdateAssetLiquidateCollateralFactor(address indexed cometProxy, address indexed asset, uint64 oldLiquidateCF, uint64 newLiquidateCF)',
  'event UpdateAssetPriceFeed(address indexed cometProxy, address indexed asset, address oldPriceFeed, address newPriceFeed)',
  'event PauseAction(bool supplyPaused, bool transferPaused, bool withdrawPaused, bool absorbPaused, bool buyPaused)',
  'event Upgraded(address indexed implementation)',
] as const

/** Venus isolated-pools Comptroller (Enclabs). Arguments are not indexed, except MarketUnlisted. */
export const VENUS_COMPTROLLER_EVENTS = [
  'event NewLiquidationThreshold(address vToken, uint256 oldLiquidationThresholdMantissa, uint256 newLiquidationThresholdMantissa)',
  'event ActionPausedMarket(address vToken, uint8 action, bool pauseState)',
  'event MarketUnlisted(address indexed vToken)',
  'event NewPriceOracle(address oldPriceOracle, address newPriceOracle)',
  'event NewLiquidationIncentive(uint256 oldLiquidationIncentiveMantissa, uint256 newLiquidationIncentiveMantissa)',
] as const

// ------------------------------------------------------------------ adapters

type Args = Record<string, unknown>
const n = (v: unknown): number => Number(v as bigint | number | string)
const bps = (v: unknown): number => n(v) / 1e4
const ZERO = '0x0000000000000000000000000000000000000000'

export interface AdapterCtx {
  market: string
  ts: number
  source: string
  /** Symbol of a collateral token (or Euler collateral vault) by lower-cased address. */
  symbolOf?: (address: string) => string | undefined
}

const sym = (ctx: AdapterCtx, a: unknown) =>
  typeof a === 'string' ? (ctx.symbolOf?.(a.toLowerCase()) ?? a.toLowerCase()) : undefined

/** Euler EVK hooked-operation bits (EVK Constants.sol). */
export const EULER_OP = {
  deposit: 1 << 0,
  withdraw: 1 << 2,
  borrow: 1 << 6,
  repay: 1 << 7,
  repayWithShares: 1 << 8,
  liquidate: 1 << 11,
} as const

/** One Euler borrow-vault governance event as a change, or null when it does not matter. */
export function fromEulerGovernance(
  name: string,
  args: Args,
  ctx: AdapterCtx,
): GovernanceChangeEvent | null {
  const base = { market: ctx.market, ts: ctx.ts, source: ctx.source }
  switch (name) {
    case 'GovSetLTV': {
      const asset = sym(ctx, args.collateral)
      const to = bps(args.liquidationLTV)
      const from = bps(args.initialLiquidationLTV)
      const ramp = n(args.rampDuration)
      const fullAtTs = n(args.targetTimestamp)
      const what = `liquidation LTV ${(from * 100).toFixed(1)}% → ${(to * 100).toFixed(1)}%${ramp > 0 ? ` over ${(ramp / 3600).toFixed(1)}h` : ''}`
      if (to === 0)
        return {
          ...base,
          asset,
          kind: 'collateral_disabled',
          detail: `${asset}: ${what}`,
          threshold: { from, to: 0, fullAtTs },
        }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail: `${asset}: ${what}`,
        threshold: { from, to, fullAtTs: ramp > 0 ? fullAtTs : ctx.ts },
      }
    }
    case 'GovSetHookConfig': {
      const ops = n(args.newHookedOps)
      const target = String(args.newHookTarget ?? ZERO).toLowerCase()
      if (!ops) return null
      // With no hook target, a hooked operation reverts: it is disabled.
      if (target !== ZERO)
        return {
          ...base,
          kind: 'paused',
          severity: 'watch',
          detail: `a hook contract now gates operations ${ops}`,
        }
      if (ops & (EULER_OP.repay | EULER_OP.repayWithShares))
        return { ...base, kind: 'paused', detail: 'repay disabled' }
      if (ops & EULER_OP.liquidate)
        return { ...base, kind: 'paused', severity: 'warn', detail: 'liquidation disabled' }
      return { ...base, kind: 'frozen', detail: 'deposit, borrow or withdraw disabled' }
    }
    case 'GovSetMaxLiquidationDiscount':
      return {
        ...base,
        kind: 'liquidation_bonus_changed',
        detail: `max liquidation discount ${(bps(args.newDiscount) * 100).toFixed(2)}%`,
      }
    case 'GovSetInterestRateModel':
      return {
        ...base,
        kind: 'rate_model_changed',
        detail: `interest rate model → ${String(args.newInterestRateModel)}`,
      }
    case 'GovSetGovernorAdmin':
      // Governance renounced makes the market immutable: not a risk to the borrower.
      if (String(args.newGovernorAdmin).toLowerCase() === ZERO) return null
      return {
        ...base,
        kind: 'governor_changed',
        detail: `governor → ${String(args.newGovernorAdmin)}`,
      }
    default:
      return null
  }
}

/** One Gearbox v3 CreditConfigurator event as a change, or null. */
export function fromGearboxConfigurator(
  name: string,
  args: Args,
  ctx: AdapterCtx,
): GovernanceChangeEvent | null {
  const base = { market: ctx.market, ts: ctx.ts, source: ctx.source }
  switch (name) {
    case 'SetTokenLiquidationThreshold': {
      const asset = sym(ctx, args.token)
      const to = bps(args.liquidationThreshold)
      if (to === 0)
        return {
          ...base,
          asset,
          kind: 'collateral_disabled',
          detail: `${asset}: liquidation threshold → 0`,
        }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail: `${asset}: liquidation threshold → ${(to * 100).toFixed(1)}%`,
        threshold: { to, fullAtTs: ctx.ts },
      }
    }
    case 'ScheduleTokenLiquidationThresholdRamp': {
      const asset = sym(ctx, args.token)
      const from = bps(args.liquidationThresholdInitial)
      const to = bps(args.liquidationThresholdFinal)
      const fullAtTs = n(args.timestampRampEnd)
      const detail = `${asset}: liquidation threshold ramps ${(from * 100).toFixed(1)}% → ${(to * 100).toFixed(1)}% by ${new Date(fullAtTs * 1000).toISOString().slice(0, 16)}Z`
      if (to === 0)
        return {
          ...base,
          asset,
          kind: 'collateral_disabled',
          severity: 'warn',
          detail,
          threshold: { from, to, fullAtTs },
        }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail,
        threshold: { from, to, fullAtTs },
      }
    }
    case 'ForbidToken': {
      const asset = sym(ctx, args.token)
      // A forbidden token cannot be added to; the account cannot raise debt while it holds it.
      return {
        ...base,
        asset,
        kind: 'frozen',
        severity: 'warn',
        detail: `${asset}: forbidden as collateral`,
      }
    }
    case 'SetExpirationDate':
      return {
        ...base,
        kind: 'expiry_set',
        detail: `credit manager expires ${new Date(n(args.expirationDate) * 1000).toISOString().slice(0, 10)}`,
      }
    case 'SetMaxDebtPerBlockMultiplier':
      return n(args.maxDebtPerBlockMultiplier) === 0
        ? { ...base, kind: 'frozen', detail: 'new borrowing stopped' }
        : null
    default:
      return null
  }
}

/**
 * One Compound v3 event as a change, or null. `effectiveTs` is the comet upgrade that put a
 * Configurator change in force. UpdateAssetPriceFeed is an oracle change: oracleRegistry's
 * kind 'feed_replaced', not a governance change, so it returns null here.
 */
export function fromCompoundGovernance(
  name: string,
  args: Args,
  ctx: AdapterCtx & { effectiveTs?: number },
): GovernanceChangeEvent | null {
  const base = { market: ctx.market, ts: ctx.ts, source: ctx.source }
  const e18 = (v: unknown) => n(v) / 1e18
  switch (name) {
    case 'UpdateAssetLiquidateCollateralFactor': {
      const asset = sym(ctx, args.asset)
      const from = e18(args.oldLiquidateCF)
      const to = e18(args.newLiquidateCF)
      const fullAtTs = ctx.effectiveTs ?? ctx.ts
      const detail = `${asset}: liquidate collateral factor ${(from * 100).toFixed(1)}% → ${(to * 100).toFixed(1)}%`
      if (to === 0)
        return {
          ...base,
          asset,
          kind: 'collateral_disabled',
          detail,
          threshold: { from, to, fullAtTs },
        }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail,
        threshold: { from, to, fullAtTs },
      }
    }
    case 'PauseAction':
      // Repaying is a supply of the base asset: a supply pause stops repay.
      if (args.supplyPaused)
        return { ...base, kind: 'paused', detail: 'supply (and so repay) paused' }
      if (args.absorbPaused)
        return { ...base, kind: 'paused', severity: 'warn', detail: 'liquidation (absorb) paused' }
      if (args.withdrawPaused || args.transferPaused)
        return { ...base, kind: 'frozen', detail: 'withdraw or transfer paused' }
      return null
    default:
      return null
  }
}

/** Venus isolated-pools action ids (ComptrollerStorage.Action). */
export const VENUS_ACTION = {
  mint: 0,
  redeem: 1,
  borrow: 2,
  repay: 3,
  seize: 4,
  liquidate: 5,
  transfer: 6,
  enterMarket: 7,
  exitMarket: 8,
} as const

/** One Venus isolated-pools Comptroller event (Enclabs) as a change, or null. */
export function fromVenusComptroller(
  name: string,
  args: Args,
  ctx: AdapterCtx,
): GovernanceChangeEvent | null {
  const base = { market: ctx.market, ts: ctx.ts, source: ctx.source }
  switch (name) {
    case 'NewLiquidationThreshold': {
      const asset = sym(ctx, args.vToken)
      const from = n(args.oldLiquidationThresholdMantissa) / 1e18
      const to = n(args.newLiquidationThresholdMantissa) / 1e18
      const detail = `${asset}: liquidation threshold ${(from * 100).toFixed(1)}% → ${(to * 100).toFixed(1)}%`
      if (to === 0)
        return {
          ...base,
          asset,
          kind: 'collateral_disabled',
          detail,
          threshold: { from, to: 0, fullAtTs: ctx.ts },
        }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail,
        threshold: { from, to, fullAtTs: ctx.ts },
      }
    }
    case 'ActionPausedMarket': {
      if (args.pauseState === false) return null
      const asset = sym(ctx, args.vToken)
      const action = n(args.action)
      // Repay or liquidation stopped on any market of the pool touches every borrower in it.
      if (action === VENUS_ACTION.repay)
        return { ...base, kind: 'paused', detail: `${asset}: repay paused` }
      if (action === VENUS_ACTION.liquidate || action === VENUS_ACTION.seize)
        return { ...base, kind: 'paused', severity: 'warn', detail: `${asset}: liquidation paused` }
      return { ...base, asset, kind: 'frozen', detail: `${asset}: action ${action} paused` }
    }
    case 'MarketUnlisted': {
      const asset = sym(ctx, args.vToken)
      return { ...base, asset, kind: 'collateral_disabled', detail: `${asset}: market unlisted` }
    }
    case 'NewLiquidationIncentive':
      return n(args.newLiquidationIncentiveMantissa) > n(args.oldLiquidationIncentiveMantissa)
        ? {
            ...base,
            kind: 'liquidation_bonus_changed',
            detail: `liquidation incentive → ${(n(args.newLiquidationIncentiveMantissa) / 1e18).toFixed(3)}`,
          }
        : null
    default:
      return null
  }
}

/** One Aave v3 PoolConfigurator event as a change, or null. */
export function fromAaveConfigurator(
  name: string,
  args: Args,
  ctx: AdapterCtx & { previousThreshold?: number },
): GovernanceChangeEvent | null {
  const base = { market: ctx.market, ts: ctx.ts, source: ctx.source }
  switch (name) {
    case 'CollateralConfigurationChanged': {
      const asset = sym(ctx, args.asset)
      const to = bps(args.liquidationThreshold)
      const from = ctx.previousThreshold
      if (from !== undefined && Math.abs(from - to) < 1e-9) return null
      const what = `liquidation threshold ${from === undefined ? '' : `${(from * 100).toFixed(1)}% → `}${(to * 100).toFixed(1)}%`
      if (to === 0)
        return { ...base, asset, kind: 'collateral_disabled', detail: `${asset}: ${what}` }
      return {
        ...base,
        asset,
        kind: 'liquidation_threshold_changed',
        detail: `${asset}: ${what}`,
        threshold: { from, to, fullAtTs: ctx.ts },
      }
    }
    case 'ReserveFrozen':
      return args.frozen === false
        ? null
        : {
            ...base,
            asset: sym(ctx, args.asset),
            kind: 'frozen',
            detail: `${sym(ctx, args.asset)}: reserve frozen`,
          }
    case 'ReservePaused':
      return args.paused === false
        ? null
        : {
            ...base,
            asset: sym(ctx, args.asset),
            kind: 'paused',
            detail: `${sym(ctx, args.asset)}: reserve paused`,
          }
    case 'AssetCollateralInEModeChanged':
      // Dropped from an e-mode category: its positions fall back to the asset's base threshold.
      return args.collateral === true
        ? null
        : {
            ...base,
            market: `${ctx.market}:emode-${n(args.categoryId)}`,
            asset: sym(ctx, args.asset),
            kind: 'liquidation_threshold_changed',
            severity: 'warn',
            detail: `${sym(ctx, args.asset)}: no longer collateral in e-mode ${n(args.categoryId)}`,
          }
    case 'EModeCategoryAdded': {
      // Applies to the positions in that e-mode category; the category is the market.
      const to = bps(args.liquidationThreshold)
      return {
        ...base,
        market: `${ctx.market}:emode-${n(args.categoryId)}`,
        kind: to === 0 ? 'collateral_disabled' : 'liquidation_threshold_changed',
        detail: `e-mode ${n(args.categoryId)} (${String(args.label ?? '')}): liquidation threshold → ${(to * 100).toFixed(1)}%`,
        threshold: { from: ctx.previousThreshold, to, fullAtTs: ctx.ts },
      }
    }
    default:
      return null
  }
}
