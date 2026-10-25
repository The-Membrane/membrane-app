/**
 * THE "YES, BUT" CARDS (framework "Y"). Each objection is answered by a rendered fact or
 * simulation and links to its data. Every figure is computed from a committed file or a
 * constant; where no source exists the card says "source pending" and prints no number.
 *
 * Two framework answers were checked against the contracts and changed
 * (components/Seniority/facts.ts holds the verdicts):
 *   - Redemptions: the framework says "touch debt only, never collateral". The contracts
 *     do better: redemption is served by curator vaults and never opens a borrower's
 *     position at all (RedemptionEngine.sol:142-164; Cdp.sol has no redeem).
 *   - Negative spread: the framework says "curator bonds eat it first". Bonds are
 *     slashed for failing to serve a REDEMPTION, never for spread
 *     (CuratorRegistry.sol:670-678, RedemptionEngine.sol:273-287), and no on-chain
 *     max-negative-spread parameter exists. The registry is not wired in config/evm, so
 *     no bond-coverage number can be read: source pending.
 */

import { BOND_COVERAGE, CONSEQUENCES, MEMBRANE_WATERFALL, MIMICRY } from '@/components/Seniority/facts'
import { MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

/** The slice of public/data/oct10-2025/evidence.json the delay card needs (server-built). */
export interface CensusSummary {
  window: string
  /** Accounts the window could be walked for (every outcome but "no series"). */
  walked: number
  /** Price came back under the line inside the window; never sold. */
  recovered: number
  /** Still over the line at expiry; sold then. */
  expired: number
  /** Broke the band while the timer ran; sold that minute. */
  brokeBand: number
  /** Already past the band at t0; no window existed. */
  atT0: number
  /** Price data ended mid-window; a sale is booked. */
  gridEnd: number
  medianMinutesToCure: number | null
  recoveredExample: CensusCase | null
  failedExample: CensusCase | null
}

export interface CensusCase {
  user: string
  collSymbol: string
  debtUsd: number
  outcome: string
  aaveClosedUsd: number
  membraneClosedUsd: number
  minutesToCure: number | null
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
  cure?: { minutesToCure?: number | null }
}

export interface EvidenceDocLike {
  meta: { window: string; cureModel?: { outcomes?: Record<string, number> } }
  time?: { medianMinutesToCure?: number }
  cohort: EvidenceRow[]
}

const toCase = (r: EvidenceRow): CensusCase => ({
  user: r.user,
  collSymbol: r.collSymbol,
  debtUsd: r.debtUsd,
  outcome: r.outcome,
  aaveClosedUsd: r.aaveClosedUsd,
  membraneClosedUsd: r.membraneClosedUsd,
  minutesToCure: r.cure?.minutesToCure ?? null,
})

/**
 * Builds the delay card's figures from the census. Counts come from meta.cureModel when
 * present (the builder's own tally), else from the included cohort rows. The examples
 * are the largest-debt mainnet row of each kind, so the cases are real and checkable.
 */
export function summariseCensus(doc: EvidenceDocLike): CensusSummary {
  const included = doc.cohort.filter((r) => !r.excluded && r.priced !== false)
  const count = (k: string) => doc.meta.cureModel?.outcomes?.[k] ?? included.filter((r) => r.outcome === k).length
  const recovered = count('cured-then-held')
  const expired = count('sold-at-expiry')
  const brokeBand = count('sold-at-band')
  const atT0 = count('sold-at-t0')
  const gridEnd = count('sold-at-grid-end')
  const biggest = (k: string) =>
    included
      .filter((r) => r.outcome === k && (r.chain ?? 'mainnet') === 'mainnet')
      .sort((a, b) => b.debtUsd - a.debtUsd)[0] ?? null
  const rec = biggest('cured-then-held')
  const fail = biggest('sold-at-expiry')
  return {
    window: doc.meta.window,
    walked: recovered + expired + brokeBand + atT0 + gridEnd,
    recovered,
    expired,
    brokeBand,
    atT0,
    gridEnd,
    medianMinutesToCure: doc.time?.medianMinutesToCure ?? null,
    recoveredExample: rec ? toCase(rec) : null,
    failedExample: fail ? toCase(fail) : null,
  }
}

export interface ObjectionFact {
  text: string
  cite: string
}

export interface ObjectionCard {
  id: 'backtest' | 'redemptions' | 'spread' | 'trust' | 'delay'
  question: string
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
    facts: [
      {
        text: 'Inputs: Chainlink oracle rounds at one-minute resolution, the venue’s own liquidation line and bonus read on-chain, and its repay size measured from that day’s liquidations.',
        cite: 'public/data/oct10-2025/manifest.json · protocols.json',
      },
      {
        text: 'Where it cannot be accurate: liquidators are assumed to fire in the first minute over the line; gas, MEV and slippage on seized collateral are not modelled; Membrane has no mainnet deployment, so its per-asset line is our assumption.',
        cite: 'lib/position-sim/compare.ts caveats · lib/position-sim/membrane.ts',
      },
    ],
    href: '/data/oct10-2025/manifest.json',
    hrefLabel: 'the scenario manifest',
  },
  {
    id: 'redemptions',
    question: '“Redemptions will eat me like Liquity.”',
    facts: [
      { text: CONSEQUENCES[0].effect, cite: CONSEQUENCES[0].cite },
    ],
    href: '/ethereum',
    hrefLabel: 'the loss order, with contract lines',
  },
  {
    id: 'spread',
    question: '“What if the spread goes negative?”',
    facts: [
      {
        text: `A shortfall goes ${MEMBRANE_WATERFALL.map((s) => s.label.toLowerCase()).join(' → ')} before it reaches a borrower. The cascade never writes to a position.`,
        cite: 'contracts/Cdp.sol:2758-2869',
      },
      { text: BOND_COVERAGE.backs, cite: BOND_COVERAGE.backsCite },
    ],
    pending: [`Bond coverage (${BOND_COVERAGE.definition}): source pending — ${BOND_COVERAGE.status}.`],
    href: '/ethereum',
    hrefLabel: 'the waterfall',
  },
  {
    id: 'trust',
    question: '“New protocol. Why trust it?”',
    facts: [
      { text: MIMICRY[0].membrane, cite: MIMICRY[0].cite },
      {
        text: `The ${BAND} band is set per asset at listing and is not timelocked.`,
        cite: 'contracts/Collateral.sol:223,232',
      },
      {
        text: 'Design of record: deployed once, then frozen when ownership is renounced; new features ship as outside extension contracts.',
        cite: 'membrane-solidity audit/FROZEN-CORE-PIVOT.md (2026-05-15)',
      },
      {
        text: 'Start small: “Deploy fresh” opens a new position at any size, so a fraction can go first.',
        cite: 'this page · the two doors below the chart',
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
    facts: [],
    href: '/ethereum/evidence',
    hrefLabel: 'the full census, row by row',
  },
]
