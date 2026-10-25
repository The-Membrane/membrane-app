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
 * THE GATE: Membrane's borrow LTV is max LTV − 3pp, but the Cdp's borrow path gates only on max
 * LTV (CdpInternal.insolvent reads max_LTV; review H-1). MembraneBundlerAdapter therefore checks
 * the LTV itself, after the borrow, at Membrane's own prices, against the lower of the owner's cap
 * and the asset's live max LTV − 3pp. The app passes cap = live max LTV − 3pp − LTV_MARGIN, read
 * on-chain (Collateral.currentMaxLTV), so a small price move between the read and the block does
 * not revert. Above the cap the plan computes the trim instead of letting the wallet sign a revert
 * (contracts/migrator/test: the 76.4–82% band and an oracle drop between read and execution).
 */

import {
  BORROW_LTV_GAP,
  MEMBRANE_LTV_PROVENANCE,
  membraneBorrowLtv,
  membraneMaxLtv,
} from '@/lib/position-sim/membrane'

import { stamp } from '@/lib/position-sim/types'

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
 * The proceeds P are the debt read plus this buffer, so interest that accrues between the read and
 * the block that executes is still covered. P is the flash amount, the exact Membrane borrow and
 * the exact proceeds permit (consumed to zero). The part the venue did not need comes back to the
 * owner as USDC in the same transaction. 2 bps ≈ 7 days of interest at 10% APR.
 */
export const ACCRUAL_BUFFER_BPS = 2

/**
 * The app opens at most at borrow LTV − 0.5pp. The adapter enforces the borrow LTV on-chain; this
 * margin keeps a ~0.6% collateral price drop between the read and the block from reverting the
 * whole bundle. Shown on the LTV row.
 */
export const LTV_MARGIN = 0.005

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
 * The wallet prompts each venue needs on a plain EOA, in the order the runner asks for them: the
 * typed-data signatures first, then — only after the exact signed bundle has simulated OK with the
 * grant as a prior call — the operator grant, then the bundle (lib/migrate/exec.ts runMigration). A wallet that reports EIP-5792
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
    short: 'Operator grant',
    label: 'Make the Membrane migration adapter an operator on your Membrane account',
    why: 'Cdp.setPositionOperator. It stays until you revoke it. It lets the adapter, only inside a Bundler3 transaction you send, open a NEW Membrane position from collateral already in the adapter and borrow on it up to the borrow LTV, paying the borrow to you. It cannot touch existing positions, withdraw, or send funds elsewhere.',
    skippedWhen: 'already granted',
  }
  const proceeds: SignatureStep = {
    id: 'proceeds-permit',
    kind: 'typed-data',
    short: `${PEG_PAIRED_SYMBOL} permit`,
    label: `Permit: the adapter may pull exactly the borrowed ${PEG_PAIRED_SYMBOL}, once`,
    why: 'Membrane pays the borrow to you; the same amount goes to GeneralAdapter1 to repay the flash loan. The permit is for that exact amount and is used up.',
    skippedWhen: null,
  }
  const send: SignatureStep = {
    id: 'bundle',
    kind: 'tx',
    short: 'Migrate',
    label: 'Migrate — one transaction',
    why: 'Bundler3.multicall: flash loan, repay, move collateral, open on Membrane, repay the flash loan.',
    skippedWhen: null,
  }
  if (venue === 'morpho-blue') {
    return [
      {
        id: 'morpho-auth',
        kind: 'typed-data',
        short: 'Morpho auth',
        label: 'Authorize Bundler3 GeneralAdapter1 on your Morpho account',
        why: 'Morpho setAuthorizationWithSig. It stays until you revoke it, and covers every Morpho market: GeneralAdapter1 can then act on your Morpho positions (repay, withdraw collateral, borrow) inside any Bundler3 transaction you send.',
        skippedWhen: 'already authorized',
      },
      proceeds,
      operator,
      send,
    ]
  }
  return [
    {
      id: 'atoken-permit',
      kind: 'typed-data',
      short: 'aToken permit',
      label: 'Permit: move exactly your aTokens, once',
      why: 'The aTokens are your collateral on the venue; exactly the amount read moves to the Aave migration adapter, which withdraws it. The permit is used up. Interest the aTokens earn after the read stays on the venue as dust you can withdraw.',
      skippedWhen: null,
    },
    proceeds,
    operator,
    send,
  ]
}

/**
 * OPTIONAL, after a settled migration (not counted in the prompts): revoke the standing grants.
 * Each is one transaction. Morpho's applies only to the Morpho flow.
 */
export function revokeSteps(venue: MigrateVenue): SignatureStep[] {
  const steps: SignatureStep[] = [
    {
      id: 'revoke-operator',
      kind: 'tx',
      short: 'Revoke adapter',
      label: 'Revoke the Membrane migration adapter',
      why: 'Cdp.setPositionOperator(adapter, false). Your next migration asks for it again.',
      skippedWhen: 'not granted',
    },
  ]
  if (venue === 'morpho-blue') {
    steps.push({
      id: 'revoke-morpho',
      kind: 'tx',
      short: 'Revoke Morpho',
      label: 'Revoke GeneralAdapter1 on Morpho',
      why: 'Morpho setAuthorization(GeneralAdapter1, false).',
      skippedWhen: 'not authorized',
    })
  }
  return steps
}

// ------------------------------------------------------------------ blockers

type Blocker = { long: string; short: string }

function blockerFor(source: MigrateSource, venue: MigrateVenue | null): Blocker | null {
  if (!venue) {
    return {
      long: `${source.label} is read by the simulator but is not a migration source yet. Migrate supports Aave V3, Spark, Morpho Blue and Liquity.`,
      short: `${source.label} can't be migrated yet.`,
    }
  }
  if (venue === 'liquity') {
    return {
      long: 'Liquity troves can only be closed or adjusted by their owner (BorrowerOperations acts on msg.sender), and LUSD debt is not the asset Membrane’s peg borrow pays out, so no bundle can move this trove. Close it on Liquity, then deploy fresh.',
      short: 'Liquity troves can’t move in one transaction. Deploy fresh instead.',
    }
  }
  if (venue === 'spark') {
    return {
      long: 'No Bundler3 migration adapter is deployed for the Spark pool. A stock AaveV3MigrationAdapter pointed at Spark would serve; until one exists Spark cannot be migrated in one transaction.',
      short: 'No Spark migration adapter yet.',
    }
  }
  if (source.collateral.length !== 1 || source.debt.length !== 1) {
    return {
      long: `This position has ${source.collateral.length} collateral and ${source.debt.length} debt assets. Migrate moves one collateral and one debt asset per transaction today.`,
      short: 'One collateral and one debt asset only, for now.',
    }
  }
  const debt = source.debt[0]
  if (debt.symbol !== PEG_PAIRED_SYMBOL) {
    return {
      long: `The debt is ${debt.symbol}. Membrane’s borrow pays out ${PEG_PAIRED_SYMBOL} (the Transmuter’s paired asset), so only ${PEG_PAIRED_SYMBOL} debt can be repaid inside the flash loan.`,
      short: `${debt.symbol} debt can't be repaid; ${PEG_PAIRED_SYMBOL} only.`,
    }
  }
  if (membraneMaxLtv(source.collateral[0].symbol) === null) {
    return {
      long: `Membrane has no listing assumption for ${source.collateral[0].symbol}, so it cannot open this collateral.`,
      short: `${source.collateral[0].symbol} isn't listed on Membrane.`,
    }
  }
  return null
}

// ------------------------------------------------------------------ trim

/** The debt that must come off (or the collateral that must come in) to land at the borrow LTV. */
/** The highest LTV the app opens at: borrow LTV − LTV_MARGIN. */
export const openCap = (borrowLtv: number): number => Math.max(0, borrowLtv - LTV_MARGIN)

/** The debt that must come off (or the collateral that must come in) to land at the open cap.
 *  `debtUsd` is what will be borrowed (the debt plus the accrual buffer). */
export function trimFor(collateralUsd: number, debtUsd: number, borrowLtv: number): PlanTrim | null {
  if (collateralUsd <= 0) return null
  const cap = openCap(borrowLtv)
  const ltv = debtUsd / collateralUsd
  if (ltv <= cap) return null
  const debtUsdOff = debtUsd - cap * collateralUsd
  const collateralUsdIn = debtUsd / cap - collateralUsd
  return {
    debtUsd: debtUsdOff,
    targetLtv: cap,
    short: `Repay ${usd(debtUsdOff)} or add ${usd(collateralUsdIn)} collateral first.`,
    reason: `At ${pct(ltv)} this position is over the ${pct(cap)} Membrane opens at (borrow LTV ${pct(borrowLtv)} − ${pct(LTV_MARGIN)} margin), and the reopen would revert. Repay ${usd(debtUsdOff)} on the venue first, or add ${usd(collateralUsdIn)} of collateral there, then migrate.`,
  }
}

// ------------------------------------------------------------------ plan

export interface GasStep {
  id: string
  label: string
  gas: bigint
}

export interface PlanOptions {
  /** Per-step gas from a simulation (each +5%), when one has run. */
  gasSteps?: GasStep[] | null
  /** The collateral's live max LTV read on-chain (Collateral.currentMaxLTV). Overrides the
   *  modelled table when present. */
  onchainMaxLtv?: number | null
  /** The wallet batches atomically (EIP-5792): the migration is ONE prompt. */
  atomic?: boolean
  /** Deploy fresh: which path runs (lib/migrate/exec.ts deployPathFor). */
  deployPath?: 'batch-router' | 'router' | 'direct'
}

/** The one prompt of the atomic path. Its calls are listed in Details. */
export function batchStep(venue: MigrateVenue | null): SignatureStep {
  const morpho = venue === 'morpho-blue'
  return {
    id: 'batch',
    kind: 'tx',
    short: 'Migrate batch',
    label: 'One atomic batch (EIP-5792 wallet_sendCalls)',
    why: morpho
      ? 'setAuthorization(GeneralAdapter1, true) · approve USDC to the adapter (exact) · grant the adapter · Bundler3.multicall · revoke the adapter · setAuthorization(GeneralAdapter1, false). All or nothing; no grant or allowance stays afterwards.'
      : 'approve aTokens to GeneralAdapter1 (exact) · approve USDC to the adapter (exact) · grant the adapter · Bundler3.multicall · revoke the adapter. All or nothing; no grant or allowance stays afterwards.',
    skippedWhen: null,
  }
}

/** Deploy-fresh prompts for the chosen path. */
export function deploySteps(path: 'batch-router' | 'router' | 'direct'): SignatureStep[] {
  if (path === 'batch-router') {
    return [
      {
        id: 'batch',
        kind: 'tx',
        short: 'Deploy batch',
        label: 'One atomic batch (EIP-5792 wallet_sendCalls)',
        why: 'approve the collateral to CdpRouter (exact) · grant CdpRouter · CdpRouter.depositAndBorrow · revoke CdpRouter. All or nothing; nothing stays granted.',
        skippedWhen: null,
      },
    ]
  }
  if (path === 'router') {
    return [
      { id: 'approve', kind: 'tx', short: 'Approve', label: 'Approve the collateral to CdpRouter', why: 'CdpRouter pulls exactly the deposit.', skippedWhen: 'the allowance already covers it' },
      { id: 'router', kind: 'tx', short: 'Open position', label: 'CdpRouter.depositAndBorrow', why: 'One transaction: opens a new position owned by you and borrows; CDT lands on you. Uses your standing CdpRouter grant.', skippedWhen: null },
    ]
  }
  return [
    { id: 'approve', kind: 'tx', short: 'Approve', label: 'Approve the collateral to Membrane', why: 'Cdp.deposit pulls the collateral from you.', skippedWhen: 'the allowance already covers it' },
    { id: 'deposit', kind: 'tx', short: 'Deposit', label: 'Deposit', why: 'Cdp.deposit opens a new position owned by you.', skippedWhen: null },
    { id: 'borrow', kind: 'tx', short: 'Borrow', label: 'Borrow', why: 'Cdp.increaseDebt mints CDT to you.', skippedWhen: null },
  ]
}

function gasRow(steps: GasStep[] | null | undefined): PlanRow {
  if (!steps || steps.length === 0) {
    return { key: 'gas', label: 'Gas', value: '—', detail: 'Gas: the exact transaction is simulated (eth_simulateV1) before any prompt; nothing is signed or sent first.', tone: 'muted' }
  }
  const total = steps.reduce((a, s) => a + s.gas, 0n)
  return {
    key: 'gas',
    label: 'Gas',
    value: total.toLocaleString('en-US'),
    detail: `Gas per step: ${steps.map((s) => `${s.label} ${s.gas.toLocaleString('en-US')}`).join(' · ')} (simulated, +5% each).`,
  }
}

function membraneSide(source: MigrateSource, onchainMaxLtv?: number | null) {
  const legs = source.collateral
  if (onchainMaxLtv !== undefined && onchainMaxLtv !== null) {
    const coll = legs.reduce((a, l) => a + l.valueUsd, 0)
    return { coll, maxLtv: onchainMaxLtv, borrowLtv: membraneBorrowLtv(onchainMaxLtv), onchain: true }
  }
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
  return { coll, maxLtv, borrowLtv: membraneBorrowLtv(maxLtv), onchain: false }
}

export function buildMigrationPlan(source: MigrateSource, opts: PlanOptions = {}): MigrationPlan {
  const venue = VENUE_OF[source.protocol] ?? null
  const { coll, maxLtv, borrowLtv, onchain } = membraneSide(source, opts.onchainMaxLtv)
  const debtUsd = source.totalDebtUsd
  // what is borrowed: the debt plus the accrual buffer (the unused part comes back as USDC)
  const borrowUsd = (debtUsd * (10_000 + ACCRUAL_BUFFER_BPS)) / 10_000
  const ltv = coll > 0 ? borrowUsd / coll : 0
  const blocker = blockerFor(source, venue)
  const blocked = blocker?.long ?? null
  const trim = blocked ? null : trimFor(coll, borrowUsd, borrowLtv)
  const cap = openCap(borrowLtv)

  const repay: RepaidDebt[] = source.debt.map((d) => ({ symbol: d.symbol, amount: d.amount, valueUsd: d.valueUsd }))
  const move: MovedAsset[] = source.collateral.map((c) => ({
    symbol: c.symbol,
    amount: c.amount,
    valueUsd: c.valueUsd,
    membraneMaxLtv: membraneMaxLtv(c.symbol),
  }))
  const flashFeeUsd = (debtUsd * FLASH_FEE_BPS) / 10_000
  const gasSteps = opts.gasSteps ?? null
  const gasUnits = gasSteps ? gasSteps.reduce((a, s) => a + s.gas, 0n) : null

  const rows: PlanRow[] = [
    ...repay.map((d) => ({
      key: `repay-${d.symbol}`,
      label: `${venue ? VENUE_LABEL[venue] : source.label} debt`,
      value: amt(d.amount, d.symbol),
      detail: `Repay: ${usd(d.valueUsd)} on ${venue ? VENUE_LABEL[venue] : source.label}, flash-loaned from Morpho (fee-free) with ${ACCRUAL_BUFFER_BPS} bps for interest until the block. Repaid in full, or the whole transaction reverts.`,
    })),
    ...move.map((c) => ({
      key: `move-${c.symbol}`,
      label: 'Collateral',
      value: `${amt(c.amount, c.symbol)} (${usd(c.valueUsd)})`,
      detail: `Collateral: ${amt(c.amount, c.symbol)} moves from the venue into a new Membrane position.`,
    })),
    {
      key: 'ltv',
      label: 'New LTV',
      value: `${pct(ltv)} (max ${pct(cap)})`,
      detail: `LTV: opens at most ${pct(cap)} (borrow LTV ${pct(borrowLtv)} − ${pct(LTV_MARGIN)} margin, checked on-chain) · liquidation line ${pct(maxLtv)} (${onchain ? 'read on-chain' : 'modelled'}, borrow LTV = max − ${pct(BORROW_LTV_GAP, 0)})`,
      tone: trim ? 'danger' : ltv > cap - 0.05 ? 'warn' : 'default',
    },
    {
      key: 'borrow',
      label: 'Membrane borrow',
      value: usd(borrowUsd),
      detail: `Borrow: a peg borrow, CDT minted and swapped 1:1 to ${PEG_PAIRED_SYMBOL}. The debt plus ${ACCRUAL_BUFFER_BPS} bps; what the venue did not need comes back to you as ${PEG_PAIRED_SYMBOL}`,
    },
    {
      key: 'flash-fee',
      label: 'Flash fee',
      value: usd(flashFeeUsd),
      detail: `Flash loan: ${FLASH_SOURCE}. Morpho charges no flash-loan fee.`,
    },
    gasRow(gasSteps),
  ]

  return {
    kind: 'migrate',
    venue,
    sourceLabel: source.label,
    repay,
    move,
    membrane: {
      collateralUsd: coll,
      debtUsd: borrowUsd,
      ltv,
      borrowLtv,
      maxLtv,
      provenance: onchain ? stamp('onchain', 'Collateral.currentMaxLTV', 'read on the connected chain') : MEMBRANE_LTV_PROVENANCE,
    },
    fees: { flashFeeUsd, flashSource: FLASH_SOURCE, gasUnits },
    trim,
    blocked,
    blockedShort: blocker?.short ?? null,
    signatures: venue && !blocked ? (opts.atomic ? [batchStep(venue)] : signatureSteps(venue)) : [],
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
  const { coll, maxLtv, borrowLtv, onchain } = membraneSide(source, opts.onchainMaxLtv)
  // Cdp.increaseDebt gates only on max LTV (review H-1); the app caps a fresh borrow at the open cap
  const cap = openCap(borrowLtv) * coll
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
  const gasSteps = opts.gasSteps ?? null
  const gasUnits = gasSteps ? gasSteps.reduce((a, g) => a + g.gas, 0n) : null
  const move: MovedAsset[] = source.collateral.map((c) => ({
    symbol: c.symbol,
    amount: c.amount,
    valueUsd: c.valueUsd,
    membraneMaxLtv: membraneMaxLtv(c.symbol),
  }))
  const rows: PlanRow[] = [
    ...move.map((c) => ({
      key: `deposit-${c.symbol}`,
      label: 'Deposit',
      value: `${amt(c.amount, c.symbol)} (${usd(c.valueUsd)})`,
      detail: `Deposit: ${amt(c.amount, c.symbol)} from your wallet, prefilled from the replayed position.`,
    })),
    {
      key: 'borrow',
      label: 'Borrow',
      value: `${Math.floor(borrowUsd).toLocaleString('en-US')} CDT`,
      detail: capped
        ? `Borrow: the replay borrowed ${usd(source.totalDebtUsd)}; capped at ${pct(openCap(borrowLtv))} (borrow LTV ${pct(borrowLtv)} − ${pct(LTV_MARGIN)} margin)`
        : `Borrow: ${usd(borrowUsd)}, the replay’s ${pct(source.totalCollateralUsd > 0 ? source.totalDebtUsd / source.totalCollateralUsd : 0)} LTV`,
      tone: capped ? 'warn' : 'default',
    },
    {
      key: 'ltv',
      label: 'LTV',
      value: `${pct(ltv)} (max ${pct(openCap(borrowLtv))})`,
      detail: `LTV: borrow LTV ${pct(borrowLtv)} · liquidation line ${pct(maxLtv)} (${onchain ? 'read on-chain' : 'modelled'})`,
    },
    gasRow(gasSteps),
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
    blockedShort: blocked
      ? source.collateral.length === 0
        ? 'Nothing to prefill from.'
        : `${unknown?.symbol} isn't listed on Membrane.`
      : null,
    signatures: blocked ? [] : deploySteps(opts.deployPath ?? 'direct'),
    rows,
  }
}
