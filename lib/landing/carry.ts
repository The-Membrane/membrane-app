/**
 * THE CARRY LANDING AT /carry (owner, 2026-10-25): carry traders and points farmers who
 * borrow against yield-bearing collateral. Same STORY as `/`, own copy.
 *
 * Every protocol claim here was checked against membrane-solidity master 70f965e (see
 * CARRY_OBJECTIONS cites; tests/unit/landingCitations.test.ts reads each line). The
 * owner's brief listed four points; their status:
 *   1. "Curators pay 14 days of spread": NOT FOUND in the contracts. No mechanism pays a
 *      borrower's negative spread (bonds are slashed for unserved redemptions and for a
 *      vault's realized allocation loss only). DROPPED from the page. What IS on-chain:
 *      debt whose principal is deployed in a canonical factory venue accrues no interest
 *      (Cdp.sol:5975-5996, eligibility :5932-5951), so that slice's cost is the venue's
 *      own yield, not a borrow rate.
 *   2. "Curators manage your deployment": REWORDED. In a CuratorVault an allocator moves
 *      funds between venues (reallocate, onlyAllocator) within caps the curator sets; cap
 *      raises wait the vault's timelock of 1 day to 2 weeks. A factory DeploymentVault is
 *      a single-venue wrapper with no curator.
 *   3. "Curators can be recalled to protect your collateral": REWORDED. The liquidation
 *      engine recalls the borrower's deployed CDT from each venue and burns it against
 *      the debt BEFORE collateral is assessed (Step 1.5). Curators are not recalled; the
 *      deployment is.
 *   4. The 4% band and 8h window: VERIFIED (same cites as `/`).
 */

import { CURE_WINDOW_HOURS, MAX_THRESHOLD_TO_DELAY } from '@/lib/position-sim/membrane'

import type { HeadlineCopy, HeadlineKey } from './headline'
import { CITES, type ObjectionCard } from './objections'

const BAND = `${Math.round(MAX_THRESHOLD_TO_DELAY * 100)}%`
const HOURS = `${CURE_WINDOW_HOURS} hours`

const C1 = `Earn the carry without managing it. Within ${BAND} of your line, you get ${HOURS} — and your deployment is recalled first.`
const C2 = `Run the carry, not the dashboard. Within ${BAND} of your line, Membrane waits ${HOURS} and recalls your deployment first.`
const C3 = `Earn the spread with less to watch. Within ${BAND} of your line: ${HOURS}, and a recall before any sale.`

export const CARRY_HEADLINES: Record<HeadlineKey, HeadlineCopy> = {
  default: { headline: C1, draft: null },
  a: { headline: C1, draft: null },
  b: { headline: C2, draft: null },
  c: { headline: C3, draft: null },
}

export const CARRY_SUBHEAD_DESKTOP = 'Open your carry, then close your laptop.'
export const CARRY_SUBHEAD_PHONE = 'Open your carry, then throw your phone.'

/** Contract lines for the carry claims, pinned with the rest in CITES' test. */
export const CARRY_CITES = {
  coverageDiscount: { path: 'contracts/Cdp.sol', from: 5975, to: 5996, expect: 'carry-spine coverage discount' },
  coverageEligibility: { path: 'contracts/Cdp.sol', from: 5932, to: 5951, expect: 'function _positionCoverage' },
  curatorTimelock: { path: 'contracts/vaults/CuratorVault.sol', from: 154, to: 155, expect: 'MIN_TIMELOCK = 1 days' },
  reallocate: { path: 'contracts/vaults/CuratorVault.sol', from: 820, to: 820, expect: 'function reallocate(' },
  submitCap: { path: 'contracts/vaults/CuratorVault.sol', from: 1196, to: 1208, expect: 'function submitCap(' },
  vaultRecall: { path: 'contracts/vaults/CuratorVault.sol', from: 1568, to: 1571, expect: 'function repayUserDebt(' },
  recallStep: { path: 'contracts/LiquidationEngine.sol', from: 1107, to: 1107, expect: '_step1_5_venueRecall(p)' },
  recallCall: { path: 'contracts/LiquidationEngine.sol', from: 1476, to: 1476, expect: 'repayUserDebt' },
  recallApply: { path: 'contracts/LiquidationEngine.sol', from: 1510, to: 1510, expect: 'applyVenueRecall' },
} as const

export const CARRY_OBJECTIONS: ObjectionCard[] = [
  {
    id: 'spread',
    question: '“What if the spread goes negative?”',
    answer: 'Deployed debt in a listed venue accrues no interest; its cost is the venue’s yield. No curator cover exists on-chain yet.',
    facts: [
      {
        text: 'Debt whose principal sits in a canonical factory venue is charged no interest for the covered slice; the rest of the debt pays the rate. Coverage is the smaller of deployed principal now and at the last accrual.',
        cites: [CARRY_CITES.coverageDiscount, CARRY_CITES.coverageEligibility],
      },
      {
        text: 'A 14-day curator cover of negative spread is not in the contracts at this commit. Curator bonds are slashed for unserved redemptions and realized allocation losses only.',
        cites: [CITES.slash, CITES.slashOnLoss],
      },
    ],
    href: '/ethereum/carry',
    hrefLabel: 'the carry board',
  },
  {
    id: 'manage',
    question: '“Who manages my deployment?”',
    answer: 'In a curator vault an allocator moves funds between venues within caps; cap raises wait 1 day to 2 weeks.',
    facts: [
      {
        text: 'Only the vault’s allocator can reallocate. The curator sets each venue’s cap; a lower cap applies at once, a higher one waits the vault’s timelock, bounded between 1 day and 2 weeks, and a guardian can revoke it. A factory deployment vault is a single venue with no curator.',
        cites: [CARRY_CITES.reallocate, CARRY_CITES.submitCap, CARRY_CITES.curatorTimelock],
      },
    ],
    href: '/ethereum/carry',
    hrefLabel: 'curators and venues',
  },
  {
    id: 'recall',
    question: '“Can I get out?”',
    answer: 'Before any collateral is sold, the engine recalls your deployed debt from each venue and burns it against the loan.',
    facts: [
      {
        text: 'Liquidation step 1.5 calls each venue’s repayUserDebt for the position, measures what arrived by balance delta, and applies it to the debt before collateral is assessed. A venue that cannot pay is skipped, not trusted.',
        cites: [CARRY_CITES.recallStep, CARRY_CITES.recallCall, CARRY_CITES.recallApply, CARRY_CITES.vaultRecall],
      },
    ],
    href: '/ethereum/carry',
    hrefLabel: 'venue recall',
  },
  {
    id: 'backtest',
    question: '“It’s a backtest, not reality.”',
    answer: 'Measured oracle prices, venue parameters read on-chain, measured repay sizes. Not modelled: gas, MEV, slippage.',
    facts: [
      {
        text: 'Venue recall rates in the replay are modelled per venue (lib/position-sim/venues.ts), not measured on Oct 10.',
        source: 'lib/position-sim/venues.ts · public/data/oct10-2025/manifest.json',
      },
    ],
    href: '/data/oct10-2025/manifest.json',
    hrefLabel: 'the scenario manifest',
  },
  {
    id: 'trust',
    question: '“New protocol. Why trust it?”',
    answer: `${CURE_WINDOW_HOURS}h window inside a ${BAND} band; its length is timelocked. Frozen core (design). Not on mainnet yet.`,
    pendingShort: ['External audit: source pending.'],
    facts: [
      { text: 'Window length is a timelocked config field: 14 days to request, then 2 days to execute.', cites: [CITES.delayConfig, CITES.timelock, CITES.timelockConstants] },
      { text: 'Design of record: deployed once, then frozen when ownership is renounced.', source: 'membrane-solidity audit/FROZEN-CORE-PIVOT.md (2026-05-15)' },
    ],
    pending: ['External audit: source pending. Only internal audit passes exist (membrane-solidity audit/).'],
    href: '/ethereum',
    hrefLabel: 'every claim with its contract line',
  },
]
