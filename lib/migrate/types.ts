/**
 * THE MIGRATE / DEPLOY-FRESH SEAM (lane Q41). Stable export names: the landing page
 * (feat/forecast-landing) calls
 *
 *   onMigrate(position)      → <MigrateSheet position={position} onClose={…} />
 *   onDeployFresh(position)  → <DeploySheet  position={position} onClose={…} />
 *
 * `position` is the simulator adapter shape (lib/position-sim/types.ts ProtocolPosition),
 * widened so a Liquity trove (lib/migrate/liquity.ts) fits the same seam.
 *
 * Nothing in this file is a number. Plans are built by lib/migrate/plan.ts from the
 * position the caller passes plus the Membrane constants in lib/position-sim/membrane.ts.
 */

import type { ProtocolPosition, Provenance } from '@/lib/position-sim/types'

export type Address = `0x${string}`

/** The four venues the framework names. Compound and Fluid are read by the simulator but
 *  are not migration sources yet (the plan says so instead of hiding the button). */
export type MigrateVenue = 'aave-v3' | 'spark' | 'morpho-blue' | 'liquity'

/** What the landing passes in. Same shape as the simulator adapters return. */
export type MigrateSource = Omit<ProtocolPosition, 'protocol'> & {
  protocol: ProtocolPosition['protocol'] | 'liquity'
  /** The wallet the position belongs to, when the caller knows it (the read address). */
  owner?: Address
}

export type RowTone = 'default' | 'warn' | 'danger' | 'muted'

/** One exact row of the order slip. `value` is already formatted (mono); `detail` is
 *  the plain-language line under it. Every number comes from the position or a constant. */
export interface PlanRow {
  key: string
  /** ≤ 3 words. */
  label: string
  /** Short, mono, right-aligned. */
  value: string
  /** Shown only in Details. */
  detail?: string
  tone?: RowTone
}

/** A wallet prompt the flow needs. `when` says when it is skipped (e.g. a standing grant). */
export interface SignatureStep {
  id: string
  /** 'tx' costs gas; 'typed-data' is an off-chain signature (permit / authorization). */
  kind: 'tx' | 'typed-data'
  /** ≤ 2 words, the visible step line (`01 Sign aToken permit`). */
  short: string
  /** The full line, shown in Details. */
  label: string
  /** Plain reason this step is needed. */
  why: string
  /** null = always needed; else the condition under which it is skipped. */
  skippedWhen: string | null
}

export interface MovedAsset {
  symbol: string
  /** Human units. */
  amount: number
  valueUsd: number
  /** Membrane's modelled max LTV for this asset, null when Membrane has no assumption. */
  membraneMaxLtv: number | null
}

export interface RepaidDebt {
  symbol: string
  amount: number
  valueUsd: number
}

export interface PlanTrim {
  /** Debt value that must come off before the position fits under Membrane's borrow LTV. */
  debtUsd: number
  /** The Membrane borrow LTV the trim targets. */
  targetLtv: number
  /** ≤ 12 words, visible. */
  short: string
  /** The full explanation, shown in Details. */
  reason: string
}

export interface PlanFees {
  /** Flash-loan fee in USD (Morpho Blue flash loans are fee-free; 0 is a read constant). */
  flashFeeUsd: number
  flashSource: string
  /** Gas units from the simulation, null until simulated. */
  gasUnits: bigint | null
}

export interface MigrationPlan {
  kind: 'migrate' | 'deploy'
  /** null for a deploy-fresh plan, or a migrate source that is not supported. */
  venue: MigrateVenue | null
  sourceLabel: string
  repay: RepaidDebt[]
  move: MovedAsset[]
  /** The new Membrane position. */
  membrane: {
    collateralUsd: number
    debtUsd: number
    ltv: number
    /** Collateral-weighted Membrane borrow cap (max LTV − 3pp). */
    borrowLtv: number
    /** Collateral-weighted Membrane liquidation line. */
    maxLtv: number
    provenance: Provenance
  }
  fees: PlanFees
  /** Set when the old LTV is above Membrane's borrow LTV and a trim makes it fit. */
  trim: PlanTrim | null
  /** Set when the plan cannot run at all. Full reason (Details). */
  blocked: string | null
  /** ≤ 12 words, visible, when blocked. */
  blockedShort: string | null
  signatures: SignatureStep[]
  rows: PlanRow[]
}

/** The sheet's own props. Stable — the landing page depends on these names. */
export interface MigrateSheetProps {
  position: MigrateSource
  onClose: () => void
}

export type DeploySheetProps = MigrateSheetProps
