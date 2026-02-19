// ─── Simulation Configuration ─────────────────────────────────────────────

export interface SimConfig {
  /** Base emission rate in uMBRN/sec (default: 826.719) */
  baseAcquisitionRate: number
  /** Maximum pool cap in uMBRN (default: 1_000_000_000) */
  maxMbrnEmission: number
  /** Utilization threshold for accrual (default: 0.50) */
  targetUtilization: number
  /** Bump rate increment per tick (default: 0.001) */
  bumpIncrement: number
  /** Seconds between bump UP ticks (default: 17280 = 4.8hrs) */
  bumpIntervalSeconds: number
  /** Bump decay speed multiplier (default: 2) */
  reductionSpeedMultiplier: number
  /** Max efficiency ratio change per mutation (default: 0.20) */
  maxRateChangePerMutation: number
  /** Deposit period in days (default: 14) */
  depositPeriodDays: number
  /** Withdrawal period in days (default: 7) */
  withdrawalPeriodDays: number
  /** Cliff period in days (default: 90) */
  cliffPeriodDays: number
  /** Carry-over bump rate from previous window (default: 0) */
  initialBumpRate: number
  /** Example max LTV for CDP impact display (default: 0.80) */
  maxLTV: number
}

// ─── Simulation Inputs ────────────────────────────────────────────────────

export interface SimEvent {
  /** When the event occurs (fractional days from T=0) */
  dayOffset: number
  /** Deposit adds to total; withdrawal removes from net */
  type: 'deposit' | 'withdrawal'
  /** Amount in uCDT */
  amount: number
}

export interface UtilizationPoint {
  /** Day offset (fractional) */
  dayOffset: number
  /** Utilization ratio 0.0–1.0 */
  utilization: number
}

// ─── Simulation Output ────────────────────────────────────────────────────

export type SimPhase =
  | 'awaiting'
  | 'deposit'
  | 'withdrawal'
  | 'post-withdrawal'
  | 'cliff'

export interface SimTick {
  /** Fractional day from T=0 */
  day: number
  /** Absolute seconds from T=0 */
  seconds: number
  /** Current window phase */
  phase: SimPhase

  // ── Pool state ──
  /** Accrued MBRN in pool */
  accruedPool: number
  /** Whether pool has hit max cap */
  poolMaxed: boolean
  /** Current emission rate (uMBRN/sec) */
  currentRate: number

  // ── Utilization ──
  /** Current utilization (interpolated) */
  utilization: number
  /** Whether pool is currently accruing (util >= target) */
  isAccruing: boolean

  // ── Bump ──
  /** Current bump rate */
  bumpRate: number
  /** CDP rate impact: bump × maxLTV */
  cdpRateImpact: number

  // ── Efficiency ──
  /** Gross deposits (only incremented, never decremented) */
  totalGrossDeposits: number
  /** Net deposits (reduced on withdrawal) */
  totalNetDeposits: number
  /** Efficiency ratio: grossDeposits / pool (0 if pool=0) */
  efficiency: number
  /** Last stored mutation efficiency (null before first measurement) */
  lastMutationEfficiency: number | null

  // ── Efficiency clamp ──
  efficiencyClamped: boolean
  /** Final acquisition budget after clamp (null before post-withdrawal) */
  acquisitionBudget: number | null

  // ── Events ──
  /** Label describing any event at this tick */
  eventLabel?: string
}

// ─── Default Config ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: SimConfig = {
  baseAcquisitionRate: 826.719,
  maxMbrnEmission: 1_000_000_000,
  targetUtilization: 0.50,
  bumpIncrement: 0.001,
  bumpIntervalSeconds: 17280,
  reductionSpeedMultiplier: 2,
  maxRateChangePerMutation: 0.20,
  depositPeriodDays: 14,
  withdrawalPeriodDays: 7,
  cliffPeriodDays: 90,
  initialBumpRate: 0,
  maxLTV: 0.80,
}
