/**
 * THE MIGRATION PLAN. Pure: a position (the simulator adapter shape) in, the exact rows of the
 * order slip out. No reads, no float defaults, no invented numbers — every figure is the
 * position's own, a Membrane constant (lib/position-sim/membrane.ts), or a constant of the
 * flow defined below with its source.
 *
 * THE FLOW (Morpho Bundler3; the only new contract is the periphery MembraneBundlerAdapter):
 *   GeneralAdapter1.morphoFlashLoan(debt token, flash)                fee-free (Morpho.sol flashLoan)
 *     venue leg   Aave/Spark: AaveV3MigrationAdapter repay → aTokens in → withdraw to the adapter
 *                 Morpho:     GeneralAdapter1 morphoRepay(all shares) → morphoWithdrawCollateral
 *     Membrane    MembraneBundlerAdapter.depositAndBorrowFor: deposit the collateral into a new
 *                 Membrane position, peg-borrow exactly the shortfall, pull it back to repay
 *   Morpho pulls the flash amount back.
 *
 * THE GATE: Membrane opens a position at most at its BORROW LTV (max LTV − 3pp). Above it the
 * Cdp reverts InsolventAfterAction (contracts/migrator/test: 82% and 80.1% revert, 77% opens),
 * so the plan computes the trim first instead of letting the wallet sign a revert.
 */

import {
  BORROW_LTV_GAP,
  MEMBRANE_LTV_PROVENANCE,
  membraneBorrowLtv,
  membraneMaxLtv,
} from '@/lib/position-sim/membrane'

import type {
  MigrateSource,
  MigrateVenue,
  MigrationPlan,
  MovedAsset,
  PlanRow,
  PlanTrim,
  RepaidDebt,
  SignatureStep,
} from './types'

/** Morpho Blue charges no flash-loan fee (Morpho.sol `flashLoan` transfers `assets` out and
 *  pulls exactly `assets` back). */
export const FLASH_FEE_BPS = 0
export const FLASH_SOURCE = 'Morpho Blue flash loan via Bundler3 GeneralAdapter1'

/**
 * The flash amount is the debt read plus this buffer, so interest that accrues between the read
 * and the block that executes is still covered. The buffer is NOT borrowed: the adapter borrows
 * only the shortfall (contracts/migrator test_AaveMigration_EndToEnd: Membrane debt == exactly
 * what Aave was owed). 10 bps ≈ 9 days of interest at 4% APR.
 */
export const FLASH_BUFFER_BPS = 10

/** The only debt the peg borrow can repay is the Transmuter's paired asset. */
export const PEG_PAIRED_SYMBOL = 'USDC'

const VENUE_OF: Partial<Record<MigrateSource['protocol'], MigrateVenue>> = {
  'aave-v3': 'aave-v3',
  spark: 'spark',
  'morpho-blue': 'morpho-blue',
  liquity: 'liquity',
}

const VENUE_LABEL: Record<MigrateVenue, string> = {
  'aave-v3': 'Aave V3',
  spark: 'Spark',
  'morpho-blue': 'Morpho Blue',
  liquity: 'Liquity',
}

// ------------------------------------------------------------------ formatting (mono rows)

export const usd = (v: number): string =>
  `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
export const pct = (v: number, dp = 1): string => `${(v * 100).toFixed(dp)}%`
export const amt = (v: number, symbol: string): string =>
  `${v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 })} ${symbol}`

// ------------------------------------------------------------------ signatures

/**
 * The wallet prompts each venue needs on a plain EOA, in order. A wallet that reports EIP-5792
 * atomic batching 'supported' signs the transactions as one batch; the typed-data permits are
 * still signed first.
 *
 * Why it is not two on a plain EOA: Cdp pays borrow proceeds to the position OWNER, never the
 * operator (Cdp.sol STEP 9), and the flash loan must be repaid in the same transaction, so the
 * owner must authorise one pull of the proceeds. Removing that needs a core change, which the
 * owner ruled out (2026-10-25).
 */
export function signatureSteps(venue: MigrateVenue): SignatureStep[] {
  const operator: SignatureStep = {
    id: 'operator',
    kind: 'tx',
    label: 'Allow the Membrane migration adapter on your Membrane positions',
    why: 'Cdp.setPositionOperator — the adapter opens the position and borrows for you, and acts only for the wallet that sends the bundle.',
    skippedWhen: 'already granted',
  }
  const proceeds: SignatureStep = {
    id: 'proceeds-permit',
    kind: 'typed-data',
    label: `Permit: the adapter may pull the borrowed ${PEG_PAIRED_SYMBOL} once`,
    why: 'Membrane pays the borrow to you; the same amount goes back to repay the flash loan in the same transaction.',
    skippedWhen: null,
  }
  const send: SignatureStep = {
    id: 'bundle',
    kind: 'tx',
    label: 'Migrate — one transaction',
    why: 'Bundler3.multicall: flash loan, repay, move collateral, open on Membrane, repay the flash loan.',
    skippedWhen: null,
  }
  if (venue === 'morpho-blue') {
    return [
      operator,
      {
        id: 'morpho-auth',
        kind: 'typed-data',
        label: 'Authorize Bundler3 GeneralAdapter1 on Morpho',
        why: 'Morpho setAuthorizationWithSig — lets the adapter repay and withdraw your collateral inside the bundle.',
        skippedWhen: 'already authorized',
      },
      proceeds,
      send,
    ]
  }
  return [
    operator,
    {
      id: 'atoken-permit',
      kind: 'typed-data',
      label: 'Permit: move your aTokens once',
      why: 'The aTokens are your collateral on the venue; they move to the migration adapter, which withdraws them.',
      skippedWhen: null,
    },
    proceeds,
    send,
  ]
}

// ------------------------------------------------------------------ blockers

function blockerFor(source: MigrateSource, venue: MigrateVenue | null): string | null {
  if (!venue) {
    return `${source.label} is read by the simulator but is not a migration source yet. Migrate supports Aave V3, Spark, Morpho Blue and Liquity.`
  }
  if (venue === 'liquity') {
    return 'Liquity troves can only be closed or adjusted by their owner (BorrowerOperations acts on msg.sender), and LUSD debt is not the asset Membrane’s peg borrow pays out, so no bundle can move this trove. Close it on Liquity, then deploy fresh.'
  }
  if (venue === 'spark') {
    return 'No Bundler3 migration adapter is deployed for the Spark pool. A stock AaveV3MigrationAdapter pointed at Spark would serve; until one exists Spark cannot be migrated in one transaction.'
  }
  if (source.collateral.length !== 1 || source.debt.length !== 1) {
    return `This position has ${source.collateral.length} collateral and ${source.debt.length} debt assets. Migrate moves one collateral and one debt asset per transaction today.`
  }
  const debt = source.debt[0]
  if (debt.symbol !== PEG_PAIRED_SYMBOL) {
    return `The debt is ${debt.symbol}. Membrane’s borrow pays out ${PEG_PAIRED_SYMBOL} (the Transmuter’s paired asset), so only ${PEG_PAIRED_SYMBOL} debt can be repaid inside the flash loan.`
  }
  if (membraneMaxLtv(source.collateral[0].symbol) === null) {
    return `Membrane has no listing assumption for ${source.collateral[0].symbol}, so it cannot open this collateral.`
  }
  return null
}

// ------------------------------------------------------------------ trim

/** The debt that must come off (or the collateral that must come in) to land at the borrow LTV. */
export function trimFor(collateralUsd: number, debtUsd: number, borrowLtv: number): PlanTrim | null {
  if (collateralUsd <= 0) return null
  const ltv = debtUsd / collateralUsd
  if (ltv <= borrowLtv) return null
  const debtUsdOff = debtUsd - borrowLtv * collateralUsd
  const collateralUsdIn = debtUsd / borrowLtv - collateralUsd
  return {
    debtUsd: debtUsdOff,
    targetLtv: borrowLtv,
    reason: `At ${pct(ltv)} this position is over Membrane’s ${pct(borrowLtv)} borrow LTV, and the reopen would revert. Repay ${usd(debtUsdOff)} on the venue first, or add ${usd(collateralUsdIn)} of collateral there, then migrate.`,
  }
}

// ------------------------------------------------------------------ plan

export interface PlanOptions {
  /** Gas units from a simulation, when one has run. */
  gasUnits?: bigint | null
}

function membraneSide(source: MigrateSource) {
  const legs = source.collateral
  const coll = legs.reduce((a, l) => a + l.valueUsd, 0)
  let wMax = 0
  let known = 0
  for (const l of legs) {
    const m = membraneMaxLtv(l.symbol)
    if (m === null) continue
    wMax += m * l.valueUsd
    known += l.valueUsd
  }
  const maxLtv = known > 0 ? wMax / known : 0
  return { coll, maxLtv, borrowLtv: membraneBorrowLtv(maxLtv) }
}

export function buildMigrationPlan(source: MigrateSource, opts: PlanOptions = {}): MigrationPlan {
  const venue = VENUE_OF[source.protocol] ?? null
  const { coll, maxLtv, borrowLtv } = membraneSide(source)
  const debtUsd = source.totalDebtUsd
  const ltv = coll > 0 ? debtUsd / coll : 0
  const blocked = blockerFor(source, venue)
  const trim = blocked ? null : trimFor(coll, debtUsd, borrowLtv)

  const repay: RepaidDebt[] = source.debt.map((d) => ({ symbol: d.symbol, amount: d.amount, valueUsd: d.valueUsd }))
  const move: MovedAsset[] = source.collateral.map((c) => ({
    symbol: c.symbol,
    amount: c.amount,
    valueUsd: c.valueUsd,
    membraneMaxLtv: membraneMaxLtv(c.symbol),
  }))
  const flashFeeUsd = (debtUsd * FLASH_FEE_BPS) / 10_000
  const gasUnits = opts.gasUnits ?? null

  const rows: PlanRow[] = [
    ...repay.map((d) => ({
      key: `repay-${d.symbol}`,
      label: `Repay on ${venue ? VENUE_LABEL[venue] : source.label}`,
      value: amt(d.amount, d.symbol),
      detail: `${usd(d.valueUsd)} · flash-loaned, plus ${FLASH_BUFFER_BPS} bps for interest until the block (not borrowed)`,
    })),
    ...move.map((c) => ({
      key: `move-${c.symbol}`,
      label: 'Move to Membrane',
      value: amt(c.amount, c.symbol),
      detail: usd(c.valueUsd),
    })),
    {
      key: 'ltv',
      label: 'New Membrane LTV',
      value: pct(ltv),
      detail: `borrow cap ${pct(borrowLtv)} · liquidation line ${pct(maxLtv)} (modelled, max LTV − ${pct(BORROW_LTV_GAP, 0)})`,
      tone: trim ? 'danger' : ltv > borrowLtv - 0.05 ? 'warn' : 'default',
    },
    {
      key: 'borrow',
      label: 'Membrane borrow',
      value: usd(debtUsd),
      detail: `peg borrow: CDT minted and swapped 1:1 to ${PEG_PAIRED_SYMBOL}, exactly what the venue was owed`,
    },
    {
      key: 'flash-fee',
      label: 'Flash-loan fee',
      value: usd(flashFeeUsd),
      detail: FLASH_SOURCE,
    },
    {
      key: 'gas',
      label: 'Gas',
      value: gasUnits === null ? 'after simulation' : `${gasUnits.toLocaleString('en-US')} units`,
      detail: gasUnits === null ? 'the bundle is simulated before you sign' : 'simulated · +5% buffer',
      tone: gasUnits === null ? 'muted' : 'default',
    },
  ]

  return {
    kind: 'migrate',
    venue,
    sourceLabel: source.label,
    repay,
    move,
    membrane: {
      collateralUsd: coll,
      debtUsd,
      ltv,
      borrowLtv,
      maxLtv,
      provenance: MEMBRANE_LTV_PROVENANCE,
    },
    fees: { flashFeeUsd, flashSource: FLASH_SOURCE, gasUnits },
    trim,
    blocked,
    signatures: venue && !blocked ? signatureSteps(venue) : [],
    rows,
  }
}

// ------------------------------------------------------------------ deploy fresh

/**
 * DEPLOY FRESH: the same collateral from the wallet into a new Membrane position, borrowing
 * the replayed debt capped at the borrow LTV. No flash loan, no old venue. Cdp direct: the
 * owner is msg.sender, so no operator grant. Prompts: approve (skipped when the allowance
 * covers it), deposit, borrow.
 */
export function buildDeployPlan(source: MigrateSource, opts: PlanOptions = {}): MigrationPlan {
  const { coll, maxLtv, borrowLtv } = membraneSide(source)
  const cap = borrowLtv * coll
  const borrowUsd = Math.min(source.totalDebtUsd, cap)
  const ltv = coll > 0 ? borrowUsd / coll : 0
  const capped = source.totalDebtUsd > cap
  const unknown = source.collateral.find((c) => membraneMaxLtv(c.symbol) === null)
  const blocked =
    source.collateral.length === 0
      ? 'There is no collateral to prefill from.'
      : unknown
        ? `Membrane has no listing assumption for ${unknown.symbol}, so it cannot open this collateral.`
        : null
  const gasUnits = opts.gasUnits ?? null
  const move: MovedAsset[] = source.collateral.map((c) => ({
    symbol: c.symbol,
    amount: c.amount,
    valueUsd: c.valueUsd,
    membraneMaxLtv: membraneMaxLtv(c.symbol),
  }))
  const rows: PlanRow[] = [
    ...move.map((c) => ({
      key: `deposit-${c.symbol}`,
      label: 'Deposit from your wallet',
      value: amt(c.amount, c.symbol),
      detail: `${usd(c.valueUsd)} · prefilled from the replayed position`,
    })),
    {
      key: 'borrow',
      label: 'Borrow',
      value: `${Math.floor(borrowUsd).toLocaleString('en-US')} CDT`,
      detail: capped
        ? `the replay borrowed ${usd(source.totalDebtUsd)}; capped at Membrane’s ${pct(borrowLtv)} borrow LTV`
        : `the replay’s debt, ${usd(source.totalDebtUsd)}`,
      tone: capped ? 'warn' : 'default',
    },
    {
      key: 'ltv',
      label: 'Membrane LTV',
      value: pct(ltv),
      detail: `borrow cap ${pct(borrowLtv)} · liquidation line ${pct(maxLtv)} (modelled)`,
    },
    {
      key: 'gas',
      label: 'Gas',
      value: gasUnits === null ? 'after simulation' : `${gasUnits.toLocaleString('en-US')} units`,
      tone: gasUnits === null ? 'muted' : 'default',
    },
  ]
  return {
    kind: 'deploy',
    venue: null,
    sourceLabel: source.label,
    repay: [],
    move,
    membrane: { collateralUsd: coll, debtUsd: borrowUsd, ltv, borrowLtv, maxLtv, provenance: MEMBRANE_LTV_PROVENANCE },
    fees: { flashFeeUsd: 0, flashSource: 'none', gasUnits },
    trim: null,
    blocked,
    signatures: blocked
      ? []
      : [
          { id: 'approve', kind: 'tx', label: 'Approve the collateral to Membrane', why: 'Cdp.deposit pulls the collateral from you.', skippedWhen: 'the allowance already covers it' },
          { id: 'deposit', kind: 'tx', label: 'Deposit', why: 'Cdp.deposit opens a new position owned by you.', skippedWhen: null },
          { id: 'borrow', kind: 'tx', label: 'Borrow', why: 'Cdp.increaseDebt mints CDT to you.', skippedWhen: null },
        ],
    rows,
  }
}
