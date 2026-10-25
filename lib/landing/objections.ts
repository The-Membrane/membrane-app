/**
 * THE "YES, BUT" CARDS (framework "Y"). Each objection is answered by a rendered fact or
 * simulation and links to its data. Every figure is computed from a committed file or a
 * constant; where no source exists the card says "source pending" and prints no number.
 *
 * CONTRACT CITATIONS are pinned to membrane-solidity `origin/master` at SOLIDITY_PIN and
 * each carries the identifier its line must contain. tests/unit/landingCitations.test.ts
 * reads every cited line at that commit and fails if the identifier is gone, so a
 * citation cannot rot silently (refuting review D6).
 *
 * Framework answers corrected against the contracts:
 *   - Redemptions: the framework says "touch debt only". Redemption is served by curator
 *     vaults and never opens a borrower's position (RedemptionEngine.redeem; Cdp.sol has
 *     no redeem).
 *   - Negative spread: a negative carry spread is a cost, not bad debt. The loss
 *     waterfall covers bad debt only; bonds are slashed for unserved redemptions and for
 *     a vault's realized allocation losses, never for spread. No on-chain spread cap.
 */

import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

/** membrane-solidity origin/master, verified 2026-10-25. Shown once per card. */
export const SOLIDITY_PIN = '70f965e'

export interface Cite {
  /** Path inside membrane-solidity. */
  path: string
  /** First and last cited line (inclusive). */
  from: number
  to: number
  /** A string the FIRST cited line must contain. */
  expect: string
}

export const CITES = {
  absorbBadDebt: { path: 'contracts/Cdp.sol', from: 3041, to: 3152, expect: 'function _absorbBadDebt' },
  slashDivisor: { path: 'contracts/CuratorRegistry.sol', from: 161, to: 161, expect: 'SLASH_DIVISOR = 10' },
  slash: { path: 'contracts/CuratorRegistry.sol', from: 835, to: 848, expect: 'function slash(' },
  slashOnLoss: { path: 'contracts/CuratorRegistry.sol', from: 887, to: 887, expect: 'function slashOnLoss(' },
  bondOf: { path: 'contracts/CuratorRegistry.sol', from: 247, to: 247, expect: 'bondOf' },
  slashCalls: { path: 'contracts/RedemptionEngine.sol', from: 322, to: 328, expect: 'registry.slash(' },
  redeem: { path: 'contracts/RedemptionEngine.sol', from: 160, to: 181, expect: 'function redeem(' },
  delayConfig: { path: 'contracts/LiquidationEngine.sol', from: 976, to: 991, expect: 'le.liquidation_delay' },
  timelock: { path: 'contracts/lib/AccessControl.sol', from: 233, to: 234, expect: 'DEFAULT_TIMELOCK_REQUEST_S' },
  timelockConstants: { path: 'contracts/lib/Constants.sol', from: 153, to: 157, expect: 'DEFAULT_TIMELOCK_REQUEST_S = 14 days' },
  updateAsset: { path: 'contracts/Collateral.sol', from: 370, to: 387, expect: 'function updateAsset(' },
  onboardDefaultBand: { path: 'contracts/Collateral.sol', from: 348, to: 348, expect: 'max_threshold_to_delay = 95e16' },
  launchBand: { path: 'script/DeployFullSystem.s.sol', from: 254, to: 254, expect: 'LAUNCH_THRESHOLD_TO_DELAY = 4e16' },
  restoreToB: { path: 'contracts/LiquidationEngine.sol', from: 2690, to: 2696, expect: 'Restore-to-B partial' },
  permissionlessLiquidate: { path: 'contracts/Cdp.sol', from: 2256, to: 2256, expect: 'function liquidate(uint256 positionId, address positionOwner)' },
  timerStart: { path: 'contracts/LiquidationEngine.sol', from: 1702, to: 1702, expect: 'outcome = LiquidationOutcome.TimerStarted' },
} satisfies Record<string, Cite>

export const citeText = (c: Cite): string => `${c.path.replace(/^contracts\//, '')}:${c.from}${c.to !== c.from ? `-${c.to}` : ''}`

/** The slice of public/data/oct10-2025/evidence.json the delay card needs (server-built). */
export interface CensusSummary {
  window: string
  /**
   * Accounts walked minute by minute through the window: included rows whose collateral
   * has a price series. Every count below except `unpricedAtT0` is out of these.
   */
  walked: number
  /** Price came back under the line inside the window; would never have sold. */
  recovered: number
  /** Still over the line at expiry; would have sold then. */
  expired: number
  /** Broke the band while the timer ran; would have sold that minute. */
  brokeBand: number
  /** Priced, but already past the band at t0; no window existed. */
  atT0: number
  /** Price data ended mid-window; a sale is booked. */
  gridEnd: number
  /** Included accounts on collateral with NO price series: one repay at t0, never walked. */
  unpricedAtT0: number
  recoveredExample: CensusCase | null
  failedExample: CensusCase | null
  /** Accounts liquidated in the window (meta.accounts), before exclusions. Null if absent. */
  accounts: number | null
  /** Sums over the walked (priced) rows: debt the venue closed vs Membrane would have. */
  venueClosedUsd: number
  membraneClosedUsd: number
  /** Same sums, per chain, largest venue total first. */
  byChain: { chain: string; rows: number; venueClosedUsd: number; membraneClosedUsd: number }[]
}

export interface CensusCase {
  user: string
  collSymbol: string
  debtUsd: number
  outcome: string
  aaveClosedUsd: number
  membraneClosedUsd: number
  /** Minutes from the breach to the first return under the line (row.minutesToFirstCure). */
  minutesToFirstCure: number | null
}

interface EvidenceRow {
  user: string
  excluded?: boolean
  priced?: boolean
  outcome: string
  collSymbol: string
  debtUsd: number
  aaveClosedUsd: number
  membraneClosedUsd: number
  chain?: string
  minutesToFirstCure?: number | null
}

export interface EvidenceDocLike {
  meta: { window: string; accounts?: number; cureModel?: { outcomes?: Record<string, number> } }
  cohort: EvidenceRow[]
}

const toCase = (r: EvidenceRow): CensusCase => ({
  user: r.user,
  collSymbol: r.collSymbol,
  debtUsd: r.debtUsd,
  outcome: r.outcome,
  aaveClosedUsd: r.aaveClosedUsd,
  membraneClosedUsd: r.membraneClosedUsd,
  minutesToFirstCure: r.minutesToFirstCure ?? null,
})

/**
 * Builds the delay card's figures from the cohort rows, ONE path (review D5). The
 * builder's meta.cureModel.outcomes tally mixes the priced and unpriced t0 rows; here
 * they are split, and the test checks the two agree in total. The examples are the
 * largest-debt mainnet row of each kind, so the cases are real and checkable.
 */
export function summariseCensus(doc: EvidenceDocLike): CensusSummary {
  const included = doc.cohort.filter((r) => !r.excluded)
  const priced = included.filter((r) => r.priced !== false)
  const count = (rows: EvidenceRow[], k: string) => rows.filter((r) => r.outcome === k).length
  const biggest = (k: string) =>
    priced.filter((r) => r.outcome === k && (r.chain ?? 'mainnet') === 'mainnet').sort((a, b) => b.debtUsd - a.debtUsd)[0] ?? null
  const rec = biggest('cured-then-held')
  const fail = biggest('sold-at-expiry')
  return {
    window: doc.meta.window,
    walked: priced.length,
    recovered: count(priced, 'cured-then-held'),
    expired: count(priced, 'sold-at-expiry'),
    brokeBand: count(priced, 'sold-at-band'),
    atT0: count(priced, 'sold-at-t0'),
    gridEnd: count(priced, 'sold-at-grid-end'),
    unpricedAtT0: count(included.filter((r) => r.priced === false), 'sold-at-t0'),
    recoveredExample: rec ? toCase(rec) : null,
    failedExample: fail ? toCase(fail) : null,
    accounts: typeof doc.meta.accounts === 'number' ? doc.meta.accounts : null,
    venueClosedUsd: sum(priced, 'aaveClosedUsd'),
    membraneClosedUsd: sum(priced, 'membraneClosedUsd'),
    byChain: [...new Set(priced.map((r) => r.chain ?? 'mainnet'))]
      .map((chain) => {
        const rows = priced.filter((r) => (r.chain ?? 'mainnet') === chain)
        return { chain, rows: rows.length, venueClosedUsd: sum(rows, 'aaveClosedUsd'), membraneClosedUsd: sum(rows, 'membraneClosedUsd') }
      })
      .sort((a, b) => b.venueClosedUsd - a.venueClosedUsd),
  }
}

const sum = (rows: EvidenceRow[], k: 'aaveClosedUsd' | 'membraneClosedUsd') => rows.reduce((t, r) => t + (r[k] || 0), 0)

export interface ObjectionFact {
  text: string
  /** Contract citations, pinned to SOLIDITY_PIN. */
  cites?: Cite[]
  /** A repo file or data source, when the fact is not a contract line. */
  source?: string
}

export interface ObjectionCard {
  id: 'backtest' | 'redemptions' | 'spread' | 'trust' | 'delay' | 'manage' | 'recall'
  question: string
  /** The visible answer, facts and numbers only (copy budget: card ≤ 25 words). */
  answer: string
  /** Visible "source pending" stubs, ≤ 4 words each. Full text is in `pending`. */
  pendingShort?: string[]
  /** Lines of fact. Copy only; figures are rendered by the component from data. */
  facts: ObjectionFact[]
  /** "source pending" items: named, never numbered. */
  pending?: string[]
  href: string
  hrefLabel: string
}

const BAND = `${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}%`

export const OBJECTIONS: ObjectionCard[] = [
  {
    id: 'backtest',
    question: '“It’s a backtest, not reality.”',
    answer: 'Measured oracle prices, venue parameters read on-chain, measured repay sizes. Not modelled: gas, MEV, slippage.',
    facts: [
      {
        text: 'Inputs: Chainlink oracle rounds at one-minute resolution, the venue’s own liquidation line and bonus read on-chain, and its repay size measured from that day’s liquidations. On a wallet in the census, Aave’s side is what Aave actually closed.',
        source: 'public/data/oct10-2025/manifest.json · protocols.json · evidence.json',
      },
      {
        text: 'Where it cannot be accurate: a modelled liquidator fires the first minute over the line; gas, MEV and slippage on seized collateral are not modelled; Membrane has no mainnet deployment, so its per-asset line is our assumption.',
        source: 'lib/position-sim/compare.ts caveats · lib/position-sim/membrane.ts',
      },
    ],
    href: '/data/oct10-2025/manifest.json',
    hrefLabel: 'the scenario manifest',
  },
  {
    id: 'redemptions',
    question: '“Redemptions will eat me like Liquity.”',
    answer: 'Curator vaults serve redemptions. A redemption never opens a borrower’s position.',
    facts: [
      {
        text: 'Redemption is served by curator vaults. It never opens a borrower’s position: Cdp.sol has no redeem.',
        cites: [CITES.redeem],
      },
    ],
    href: '/ethereum',
    hrefLabel: 'the loss order, with contract lines',
  },
  {
    id: 'spread',
    question: '“What if the spread goes negative?”',
    answer: 'It is a carry cost, uncapped on-chain. The bad-debt waterfall does not cover it.',
    pendingShort: ['Bond coverage: source pending.'],
    facts: [
      {
        text: 'Then the carry costs you: the debt’s rate is above what the deployed debt earns, and the difference is yours. No contract parameter caps a negative spread.',
      },
      {
        text: 'The loss waterfall is for bad debt, not for spread: reserve → MBRN under the asset → junior lenders → senior lenders. It never writes to a position.',
        cites: [CITES.absorbBadDebt],
      },
      {
        text: 'Curator bonds are slashed min(shortfall, bond ÷ 10) when a vault fails to serve a redemption, and pro-rata on a vault’s realized allocation loss (slashOnLoss). Neither is spread cover.',
        cites: [CITES.slashDivisor, CITES.slash, CITES.slashOnLoss, CITES.slashCalls],
      },
    ],
    pending: ['Bond coverage (bonds ÷ the redemption volume they back): source pending — the CuratorRegistry address is not in config/evm, so bondOf cannot be read.'],
    href: '/ethereum',
    hrefLabel: 'the waterfall',
  },
  {
    id: 'trust',
    question: '“New protocol. Why trust it?”',
    answer: `${CURE_WINDOW_HOURS}h window inside a ${BAND} band; its length is timelocked. Frozen core (design). Not on mainnet yet.`,
    pendingShort: ['External audit: source pending.'],
    facts: [
      {
        text: `A breach inside the asset’s band gets an ${CURE_WINDOW_HOURS}h cure window. No-delay assets, and breaches past the band, sell at once. The window’s length is a timelocked config field: 14 days to request, then 2 days to execute.`,
        cites: [CITES.delayConfig, CITES.timelock, CITES.timelockConstants],
      },
      {
        text: `Launch collateral’s band is ${BAND} (a deploy setting). An asset onboarded without a listing gets 95% by default. The owner can change a band without a timelock.`,
        cites: [CITES.launchBand, CITES.onboardDefaultBand, CITES.updateAsset],
      },
      {
        text: 'Design of record: deployed once, then frozen when ownership is renounced; new features ship as outside extension contracts.',
        source: 'membrane-solidity audit/FROZEN-CORE-PIVOT.md (2026-05-15)',
      },
      {
        text: 'Start small: “Deploy fresh” opens a new position at any size, so a fraction can go first.',
        source: 'this page · the two doors below the chart',
      },
    ],
    pending: [
      'External audit: source pending. Only internal audit passes exist (membrane-solidity audit/).',
      'Mainnet deployment: none yet. Membrane is pre-launch.',
    ],
    href: '/ethereum',
    hrefLabel: 'every claim with its contract line',
  },
  {
    id: 'delay',
    question: '“The delay just postpones the loss.”',
    answer: '',
    facts: [],
    href: '/ethereum/evidence',
    hrefLabel: 'the full census, row by row',
  },
]
