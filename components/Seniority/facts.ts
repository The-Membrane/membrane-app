/**
 * THE SENIORITY LANDING — every claim on the page, with its proof.
 *
 * This file is the single source for the copy in components/Seniority/*. Nothing in
 * those components may contain a factual claim that is not here, and nothing here may
 * lack a citation. Citations are membrane-solidity paths as of 14 Sep 2026.
 *
 * WHY THIS IS STRICT. The brief for this page asserted three mechanisms that the
 * contracts do not implement: curator bonds as step 2 of the loss waterfall, redemption
 * "touching debt only", and a repricing freeze while exit is blocked. Each was checked
 * against the code and each fails (verdicts inline below). The page states the verified
 * version of every claim instead. docs/BADASS_RULESET.md §11: no confidence figure not
 * backed by realized outcomes; docs/MYCELIUM_NARRATIVE.md honesty boundaries.
 */

import { MODELLED_FOOTNOTE } from '@/lib/position-sim/guarantee'
import census from '@/public/data/oct10-2025/evidence-census-headline.json'

// ---------------------------------------------------------------------------
// THE CENSUS FIGURES. Owner decision 2026-10-16: the landing reads the FULL on-chain census
// of 10-11 Oct 2025 (every Aave V3 pool and Morpho Blue market on Ethereum, Arbitrum,
// Optimism and Base; each protocol's own oracle, read on chain). Every number below is read
// from public/data/oct10-2025/evidence-census-headline.json, which
// scripts/build-evidence-census.ts writes from the same computation as the Evidence page's
// evidence-census.json; tests/unit/oct10Totals.test.ts checks the two agree. Nothing here
// is typed by hand, so a rebuild cannot leave a stale figure on the page.
// ---------------------------------------------------------------------------
const n = (x: number) => x.toLocaleString('en-US')
const usdM = (x: number) => `$${(x / 1e6).toFixed(1)}M`
const usdAny = (x: number) =>
  Math.abs(x) >= 1e6 ? usdM(x) : `$${Math.round(x).toLocaleString('en-US')}`
const pct1 = (frac: number) => `${(frac * 100).toFixed(1)}%`
const gap = (gapPct: number) => `${Math.abs(gapPct).toFixed(1)}% ${gapPct >= 0 ? 'less' : 'more'}`
const CHAIN: Record<string, string> = {
  mainnet: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
}
const PROTOCOL: Record<string, string> = { 'aave-v3': 'Aave', 'morpho-blue': 'Morpho' }
const OUTCOME_PHRASE: Record<string, string> = {
  'sold-at-t0': 'already past the band at its first liquidation, so sold at once',
  'sold-at-band': 'sold when it broke the band',
  'sold-at-expiry': 'sold at the end of its window',
  'sold-no-delay': 'stablecoin collateral, sold at the line',
  'sold-at-grid-end': 'still in its window when the data ends',
  'cured-then-held': 'back under its line and never sold',
  held: 'never over its line',
}

/** The census in one sentence, both protocols on it. Shared by every hero variant. */
const CENSUS_LINE =
  `Replayed on every liquidation of ${census.window} — ${n(census.positions)} positions on Aave and Morpho across four chains, ` +
  `each walked on its protocol’s own oracle read on chain — the protocols force-closed ${usdM(census.all.realRepaidUsd)} of debt ` +
  `and Membrane’s rules would have closed ${usdM(census.all.memRepaidUsd)}†, ${gap(census.all.gapPct)}, net ` +
  `(Aave ${gap(census.aave.gapPct)}, Morpho ${gap(census.morpho.gapPct)}): less on ${n(census.less)} positions, more on ${n(census.more)}.`

const CENSUS_CITE =
  `public/data/oct10-2025/evidence-census.json debt.all and debt.byProtocol (${n(census.positions)} positions: ` +
  `protocols $${(census.all.realRepaidUsd / 1e6).toFixed(2)}M, Membrane $${(census.all.memRepaidUsd / 1e6).toFixed(2)}M; ` +
  `Aave ${n(census.aave.positions)}, Morpho ${n(census.morpho.positions)}) · scripts/build-evidence-census.ts · ` +
  'lib/wavefront/kernel.ts (the walk)'

// NOTE: lib/position-sim/guarantee.ts CARRY_CLAIMS are NOT imported wholesale. Two of
// the four fail against the contracts as worded (fee is taken from collateral,
// LiquidationEngine.sol:1553-1563; the "when exit is blocked" condition names no
// mechanism, Cdp.sol:802-804). The 14-day yield cover is the owner's forward claim,
// ruled in 2026-09-14 (the mechanism is being built); it is carried verbatim below.

// ---------------------------------------------------------------------------
// HERO
// ---------------------------------------------------------------------------
export interface HeroCopy {
  readonly eyebrow: string
  readonly headline: string
  readonly sub: string
  readonly cta: string
  readonly readNote: string
  readonly bridge: {
    readonly eyebrow: string
    readonly line: string
    /** The one footer line for the † in `line` (DESIGN_RULES.md §3). Rendered. */
    readonly footnote: string
    readonly cite: string
    readonly note: string
  }
  readonly demoNote: string
  /** Why this variant exists. Never rendered; it is the ruling the test is run under. */
  readonly note: string
}

/**
 * Everything the three variants share. The test moves the H1 and the line under it,
 * and nothing else, so the eyebrow, the CTA target, the read disclosure, the bridge
 * and the demo note are one object spread into all three.
 */
const SHARED = {
  eyebrow: 'Borrowers',
  readNote:
    'Reads your open position on leading Ethereum money markets. Replays it through the measured 10 Oct 2025 prices.',
  /**
   * THE BRIDGE. The h1 and sub are about the loss waterfall (who absorbs bad debt); the
   * sim under it is about liquidation behaviour (repay to cap, cure, recall). Owner,
   * 14 Sep: the two topics need a connector, and the saving must not imply Membrane is
   * the only venue that repays part of a position (Aave V3 had a 50% close factor; V4
   * refines it). So the bridge names the mechanism and gives partial repayment away.
   */
  bridge: {
    eyebrow: 'Tested on a real day',
    line:
      'With borrower-first liquidation a breach inside the 4% band gets eight hours; a return under the line clears it; past the band, or still over the line at expiry, the position is repaid to its cap. Stablecoin collateral gets no window†. ' +
      CENSUS_LINE +
      ' Aave’s own close factor repays partially too; the eight hours and the recall are Membrane’s.',
    /** † on "Stablecoin collateral gets no window": modelled (collateralClass.ts). */
    footnote: MODELLED_FOOTNOTE,
    cite:
      CENSUS_CITE +
      ' · contracts/LiquidationEngine.sol:2099-2103 (band), :1362-1382 (re-arm), :1388-1392 (expiry, band break), :2241-2269 ($2,000 floor)',
    note: 'Owner decision 2026-10-16: the landing and the Evidence page read the full on-chain census (every Aave V3 pool and Morpho Blue market on four chains, each protocol’s own oracle). The old census’s 747-row priced subset and its headline are superseded; the Evidence page’s method section explains, from the 747-row cross-check, why it moved.',
  },

  /** Shown while the demo position is loaded, before any address or wallet. */
  demoNote: 'a real wallet Aave V3 liquidated on 10 Oct 2025. Connect yours to replace it.',
} as const

/**
 * THE B/C SUB-LINE, shared by both assigned variants so the H1 is the only difference
 * between them. The loss order here is the one the contracts implement: the reserve,
 * MBRN staked under the asset, then the junior and senior lender tranches
 * (Cdp._absorbBadDebt, contracts/Cdp.sol:2758-2869). Curator bonds are deliberately
 * absent: CuratorRegistry.slash is onlyRedemptionEngine, so a bond is slashed for a
 * failed redemption and never in the bad-debt cascade.
 */
const BC_SUB =
  'Cross your line inside 4% and nothing sells for eight hours. The reserve, MBRN stakers and both lender tranches take a loss before you do.'

/** The B/C call to action. Names the day the read replays, in the reader’s own terms. */
const BC_CTA = 'See what you’d have kept on 10 Oct 2025'

const BC_BRIDGE = {
  ...SHARED.bridge,
  line:
    CENSUS_LINE +
    ' Stablecoin collateral gets no window†. Aave’s own close factor repays partially too; the eight hours and the recall are Membrane’s.',
}


/**
 * THE THREE HEROES.
 *
 * Owner ruling 2026-09-15: run the test on the H1 alone. B and C carry the same
 * sub-line and the same CTA, so whichever wins, the win is the headline.
 */
export const HERO_VARIANTS: Record<'a' | 'b' | 'c', HeroCopy> = {
  a: {
    ...SHARED,
    headline: 'Borrowers are senior here.',
    sub: 'Four layers take a loss before it reaches you. The order is drawn below, open to anyone.',
    /**
     * The CTA names exactly what the read does (owner, 14 Sep: "stand in line where? mock or
     * real? does it need a connection?"). It reads the address's OPEN position today on
     * Ethereum mainnet across Aave V3, Spark, Compound V3, Morpho Blue and Fluid over a
     * public read-only RPC (lib/position-sim/rpc.ts, adapters/), then replays it through the
     * measured 10 Oct 2025 price path (lib/position-sim/scenario.ts). A pasted address does
     * the same; the wallet only fills the box.
     */
    cta: 'Replay my position through 10 Oct 2025',
    note: 'Owner ruling 2026-09-15. A is the seniority-led original, the hero that shipped on 14 Sep. It is saved in code and reachable at ?v=a, and the assignment in lib/landingVariant.ts never hands it out, so the test reads as a clean two-way between B and C.',
  },
  b: {
    ...SHARED,
    headline: 'Stop getting liquidated on wicks.',
    sub: BC_SUB,
    cta: BC_CTA,
    bridge: BC_BRIDGE,
    note: 'Owner ruling 2026-09-15. B is the imperative form the copy rule bans, entered on purpose: it names the reader’s problem in the reader’s own words, and the test measures what that form is worth against the same claim stated positively. It ships only if it wins, and the rule stands everywhere else on the app.',
  },
  c: {
    ...SHARED,
    headline: 'Liquidated on a wick? Here a drop has to hold for eight hours first.',
    sub: BC_SUB,
    cta: BC_CTA,
    bridge: BC_BRIDGE,
    note: 'Owner ruling 2026-09-15. C is the positive form: it states what the protocol does rather than what the reader should stop doing, which is the house rule. It is also the variant every known crawler is pinned to, so the indexed H1 is one stable headline.',
  },
}

/**
 * BACK-COMPAT. Anything that reads HERO without knowing about the test keeps the
 * original seniority-led copy. The landing itself goes through HERO_VARIANTS.
 */
export const HERO: HeroCopy = HERO_VARIANTS.a

// ---------------------------------------------------------------------------
// THE WATERFALL — Cdp._absorbBadDebt, contracts/Cdp.sol:2758-2869
// ---------------------------------------------------------------------------
export interface WaterfallStep {
  label: string
  who: string
  /** One clause of mechanism. No paragraphs (BADASS §3.1). */
  how: string
  cite: string
}

/**
 * VERIFIED order. Steps are the real cascade. Two honesty notes carried into the UI:
 *  - the reserve is deployed at reserve_ratio = 0 (script/DeployFullSystem.s.sol:301),
 *    so at launch step 1 absorbs nothing. The UI marks it "empty at launch".
 *  - the MBRN here is LtvDisco stake under a collateral asset, sold at auction
 *    (contracts/LtvDisco.sol:1549-1610). It is NOT Staking.sol, which has no slash path.
 *
 * WRONG in the brief, omitted here: "curator bonds" as step 2. CuratorRegistry.slash is
 * onlyRedemptionEngine (contracts/CuratorRegistry.sol:670-672) and is called only from
 * the redemption walk (contracts/RedemptionEngine.sol:280,285). Bonds never enter the
 * bad-debt cascade. They are a separate lane, described in BOND_COVERAGE below.
 */
export const MEMBRANE_WATERFALL: WaterfallStep[] = [
  {
    label: 'Reserve',
    who: 'protocol',
    how: 'drained first. Empty at launch: reserve_ratio is deployed at 0.',
    cite: 'contracts/Cdp.sol:2766-2774 · script/DeployFullSystem.s.sol:301',
  },
  {
    label: 'MBRN under the asset',
    who: 'LTV voters',
    how: 'revenue stops, then their stake is sold at auction, up to the stake under that asset.',
    cite: 'contracts/Cdp.sol:2799-2814 · contracts/LtvDisco.sol:1549-1610,1572-1573',
  },
  {
    label: 'Junior lenders',
    who: 'junior tranche',
    how: 'yield burned, then capital.',
    cite: 'contracts/Cdp.sol:2817-2824',
  },
  {
    label: 'Senior lenders',
    who: 'senior tranche',
    how: 'yield burned, then capital, then a haircut that later revenue refills when there is any.',
    cite: 'contracts/Cdp.sol:2834-2867 · contracts/Transmuter.sol:848,877 · contracts/RevenueDistributor.sol:562-585',
  },
]

/** The line under the cascade. VERIFIED: no position write anywhere in _absorbBadDebt. */
export const WATERFALL_FLOOR = {
  line: 'No other borrower’s debt or collateral is touched. The cascade never writes to a position.',
  cite: 'contracts/Cdp.sol:2758-2869 · contracts/Cdp.sol:3214-3260 (shortfall re-entry, also no position write)',
} as const

/**
 * The comparison column. Kept to what is uncontroversial about pooled lending: the
 * pool socialises shortfall to suppliers and liquidates borrowers at threshold in the
 * same block. No protocol-specific numbers here; those live in MIMICRY with a source.
 */
export const SUPPLY_SIDE_WATERFALL: WaterfallStep[] = [
  { label: 'Borrower', who: 'you', how: 'liquidated at the threshold, same block, no window.', cite: 'pooled-lending design' },
  { label: 'Safety module', who: 'stakers', how: 'if one exists, and only after a vote.', cite: 'pooled-lending design' },
  { label: 'Suppliers', who: 'lenders', how: 'shortfall socialised across the pool.', cite: 'pooled-lending design' },
]

// ---------------------------------------------------------------------------
// BOND COVERAGE — the receipt
// ---------------------------------------------------------------------------
/**
 * What is real on-chain (VERIFIED):
 *   CuratorRegistry.bondOf(vault)   contracts/CuratorRegistry.sol:194  (public mapping)
 *   CuratorRegistry.totalBonded     contracts/CuratorRegistry.sol:196
 *   CuratorRegistry.allVaultsLength contracts/CuratorRegistry.sol:714
 *   slash = min(failed, bond / 10)  contracts/CuratorRegistry.sol:676-678, divisor :129
 *   slashed ONLY for failing to serve a redemption: contracts/RedemptionEngine.sol:273-287
 *
 * What is NOT real yet:
 *   - membrane-app has no CuratorRegistry address or ABI (config/evm has no entry). The
 *     figure below therefore cannot be read live today and is stamped accordingly.
 *   - the denominator. reportedAum is written by the vault itself
 *     (contracts/CuratorRegistry.sol:534-541, msg.sender == vault). Any ratio built on it
 *     is bonds ÷ a curator's own attestation, and the UI says so.
 *   - no on-chain "max negative spread" parameter exists (NOT FOUND). The spread basis
 *     in the brief cannot be computed from chain state.
 *
 * So: the page shows the formula, names the basis, names the read path, and renders the
 * number as mock until the registry is wired. It does not print a ratio as if verified.
 */
export const BOND_COVERAGE = {
  title: 'Bond coverage',
  definition: 'curator bonds posted ÷ the redemption volume they could fail to serve',
  /** What the bond actually backs. Anything else is a promise the contract does not make. */
  backs: 'Bonds are slashed for failing to serve a redemption: min(shortfall, bond ÷ 10) per incident. The slash is booked as protocol revenue; the unserved redeemer holds an open claim.',
  backsCite: 'contracts/RedemptionEngine.sol:156-160,273-287 · contracts/CuratorRegistry.sol:130,676-686',
  bases: [
    {
      id: 'redemption',
      label: 'Redemption basis',
      formula: 'totalBonded ÷ Σ reportedAum',
      answers: 'how much redemption demand curators can fail to serve before the bond runs out',
      caveat: 'reportedAum is set by each vault (self-attested).',
      cite: 'contracts/CuratorRegistry.sol:194,196,534-541',
    },
    {
      id: 'depth',
      label: 'Depth basis',
      formula: 'totalBonded ÷ (Σ reportedAum − Σ instantLiquidity)',
      answers: 'how big a venue freeze curators can cover from bond',
      caveat: 'instantLiquidity is a real view; reportedAum is still self-attested.',
      cite: 'contracts/vaults/CuratorVault.sol:581-582',
    },
  ],
  readPath: 'CuratorRegistry.totalBonded · bondOf(vault) · allVaultsLength()',
  /** Stamp until config/evm carries the registry address. */
  status: 'registry address absent from config/evm · reads land once it is wired',
} as const

// ---------------------------------------------------------------------------
// THREE CONSEQUENCES — the brief's claims, restated as VERIFIED effects
// ---------------------------------------------------------------------------
export interface Consequence {
  effect: string
  proof: string
  proofHref: string
  cite: string
  /** The claim in the brief, and why it was changed. Kept for the refuter, not rendered. */
  note?: string
}

export const CONSEQUENCES: Consequence[] = [
  {
    effect: 'Redemption never touches a borrower. Curator vaults deliver the served asset; no position is read or written.',
    proof: 'RedemptionEngine.redeem',
    proofHref: '/simulator',
    cite: 'contracts/RedemptionEngine.sol:142-164 · Cdp.sol has 0 occurrences of redeem',
    note: 'Brief said "redemption touches debt only". WRONG: it touches no borrower at all. This is the stronger claim.',
  },
  {
    effect: 'Nobody else’s loss lands on you. Reserve, MBRN and both lender tranches absorb it; the cascade never writes to a position.',
    proof: 'Cdp._absorbBadDebt',
    proofHref: '/simulator',
    cite: 'contracts/Cdp.sol:2758-2869 · contracts/Cdp.sol:3214-3260',
    note: 'Brief listed "can’t be repriced when exit is blocked" here. Owner, 14 Sep: that may be an old claim; the section must state seniority, so this is the loss-order effect. For the record the rate fact is real and unconditional (segments snapshot their rate at draw, Cdp.sol:1516-1521, 4396) but it is a rate property, not a seniority one, and is kept off this row.',
  },
  {
    effect: 'A breach gets 8 hours to cure while it stays inside the asset’s band. Launch collateral is set to 4%. Past the band, the sale is immediate.',
    proof: 'run your position through 10 Oct 2025',
    proofHref: '/simulator',
    cite: 'script/DeployFullSystem.s.sol:164,178,219 · contracts/LiquidationEngine.sol:803-819,1501-1503,2099-2103 · contracts/Collateral.sol:223,232',
    note: 'The 8h delay is behind a 14d+2d timelock (LiquidationEngine.sol:803-819, lib/Constants.sol:144,148). The 4% band is NOT: Collateral.updateAsset is plain onlyOwner (Collateral.sol:223,232) and Collateral has no timelocked fields (:449-452). maybeOnboard stamps 95e16 on permissionlessly onboarded assets (:208, reachable via submitDeposit :163-166). The copy therefore says "launch collateral" and "the asset’s band", and names the immediate sale past it.',
  },
]

// ---------------------------------------------------------------------------
// MIMICRY — Helmer's counter-positioning test: the incumbent will not copy this
// because copying damages its existing business. Owner framing, 14 Sep 2026.
// ---------------------------------------------------------------------------
export interface MimicryCard {
  name: string
  /** What Membrane does, in one verified clause. */
  membrane: string
  /** Why the incumbent will not mimic it. The business reason, not the parameter. */
  wontCopy: string
  cite: string
}

/**
 * Two of the owner's four counters were adjusted to the verified mechanic:
 *  - Aave: params are owner-mutable (contracts/Collateral.sol:232, onlyOwner), not
 *    immutable. The liquidation delay IS timelocked (LiquidationEngine.sol:445,779-784).
 *    The counter is stated on "timelocked, not a DAO option", which is what holds.
 *  - Morpho: bonds are slashed for failing to serve a redemption, never for negative
 *    spread (RedemptionEngine.sol:273-287; no spread param exists). The counter is stated
 *    on "curators are bonded and junior to redemption failure", which holds.
 *  Liquity's counter got stronger: redemption touches no borrower at all.
 */
export const MIMICRY: MimicryCard[] = [
  {
    name: 'Aave',
    membrane: 'Every breach gets a cure window, and the window’s length sits behind a 14-day timelock.',
    wontCopy: 'Aave has no cure window to offer. Adding one makes the borrower’s time a fixed term instead of a parameter the DAO prices.',
    cite: 'contracts/LiquidationEngine.sol:803-819 · contracts/lib/Constants.sol:144,148',
  },
  {
    name: 'Morpho',
    membrane: 'Curators post a bond and are slashed when they fail to serve a redemption.',
    wontCopy: 'Morpho’s distribution runs through supply-side partners. Telling curators they are bonded and junior is a business-model concession.',
    cite: 'contracts/CuratorRegistry.sol:194,676-678 · contracts/RedemptionEngine.sol:273-287',
  },
  {
    name: 'Liquity',
    membrane: 'Redemption is served by curator vaults. It never opens a borrower’s position.',
    wontCopy: 'Redeeming against borrower collateral IS Liquity’s peg defence. Removing it removes the peg.',
    cite: 'contracts/RedemptionEngine.sol:142-164 · Cdp.sol: 0 occurrences of redeem',
  },
  {
    name: 'Recall',
    membrane: 'The engine pulls deployed CDT back from venues and burns it against debt inside the unwind.',
    wontCopy: 'To copy it Aave would have to become a yield router and own venue liability, abandoning neutral base-layer positioning.',
    cite: 'contracts/LiquidationEngine.sol:1105-1280 · contracts/Cdp.sol:3023,3127-3151',
  },
]
/** Rendered under the cards. No article exists yet; the link goes to the proof surface. */
export const MIMICRY_FOOT = {
  line: 'Counter-positioning: each is a thing the incumbent could build and will not, because it costs them their model.',
  proofHref: '/simulator',
} as const

// ---------------------------------------------------------------------------
// CARRY — the flagship, below the fold
// ---------------------------------------------------------------------------
/**
 * VERIFIED mechanics behind the headline:
 *   recall = LiquidationEngine Step 1.5 walks position.deployedTo[], pulls CDT back and
 *   burns it against debt (contracts/LiquidationEngine.sol:1105-1280, Cdp.sol:3127-3151).
 *   It runs INSIDE liquidate(); it is the unwind, not a user action (Cdp.sol:3023 onlyEngine).
 *   keeper fee = per intent fulfilment, off yield only, capped 5%
 *   (contracts/vaults/DeploymentVaultBase.sol:65,853-855).
 * The four lines are CARRY_CLAIMS verbatim: owner's wording, 2026-09-12. Do not restate.
 */
export const CARRY = {
  eyebrow: 'Carry',
  headline: 'The debt earns the yield. That is what makes a recall possible.',
  sub: 'When a position must unwind, the engine pulls the deployed CDT back and burns it against the debt. The recall itself charges nothing.',
  claims: [
    // Owner's wording, 2026-09-12; ruled in 2026-09-14. Same string as CARRY_CLAIMS[0]
    // and VerdictHero's carry line; the three must never drift.
    'Borrow cost comes out of the carry yield. If the spread inverts, curators cover 14 days of yield to give you time to act.',
    'The debt is deployed to venues and the yield accrues against it.',
    'Unwinds run in the engine. No outside keeper has to fire for a recall to happen.',
    'A recall pulls CDT back from the venue and burns it against the debt, measured by balance delta.',
    'No protocol fee on liquidation. The liquidator’s fee is sized on what is repaid and capped by collateral value.',
  ] as const,
  href: '/carry',
  cite: 'contracts/LiquidationEngine.sol:1105-1280,1235-1250,1504-1563 · contracts/Cdp.sol:3023,3127-3151',
} as const

// ---------------------------------------------------------------------------
// CDT — one line
// ---------------------------------------------------------------------------
export const CDT_LINE = {
  line: 'CDT is the mechanism: the debt you mint is the capital that earns, and the thing a recall burns.',
  href: '/mint',
} as const

// ---------------------------------------------------------------------------
// CLOSE
// ---------------------------------------------------------------------------
/** The five largest differences, and the one that leads them, as the copy reads them. */
const top = census.concentration
const topLine =
  `The largest single difference ${top.top1GapUsd < 0 ? 'runs the other way' : 'is one position'}: one ${CHAIN[top.top1Chain] ?? top.top1Chain} ${PROTOCOL[top.top1Protocol] ?? top.top1Protocol} position, ${OUTCOME_PHRASE[top.top1Outcome] ?? top.top1Outcome}, where Membrane closes ${usdM(Math.abs(top.top1GapUsd))} ${top.top1GapUsd < 0 ? 'more' : 'less'}†. ` +
  `Without it Membrane closes ${gap(top.gapWithoutTop1Pct)}†. The five largest differences are ${(top.top5Share * 100).toFixed(0)}% of every dollar of difference in either direction; without them it is ${gap(top.gapWithoutTop5Pct)}†.`

const B = census.brackets
const more = census.membraneMore
const moreOut = more.atOrAboveFloor.outcomes as Record<string, number>
const moreBand = moreOut['sold-at-band'] ?? 0
const moreT0 = moreOut['sold-at-t0'] ?? 0
const moreRest = more.atOrAboveFloor.positions - moreBand - moreT0

/** The stress list: the same walk, one rule changed. Which corners cross the protocols' total is computed. */
const S = census.sensitivity
const bandAt = (b: number) => S.band.find((x) => x.band === b)?.memRepaidUsd ?? NaN
const STRESS: { label: string; usd: number }[] = [
  { label: 'a 2% band', usd: bandAt(0.02) },
  { label: 'an 8% band', usd: bandAt(0.08) },
  { label: 'nobody clears a timer early', usd: S.noEarlyClearUsd },
  { label: 'no $2,000 floor', usd: S.noDebtFloorUsd },
  { label: 'one sale per position', usd: S.singleSaleUsd },
  { label: 't0 read at the block before', usd: S.t0AtNm1Usd },
]
const crossing = STRESS.filter((x) => x.usd >= census.all.realRepaidUsd).map((x) => x.label)

export const CLOSE = {
  eyebrow: `Counterfactual · ${census.window}`,
  headline: `What this order did to ${n(census.positions)} real liquidations.`,
  cta: 'Run yours through the same day',
  href: '/simulator',
  evidenceHref: '/evidence',
  /**
   * WHAT THE NUMBER CONTAINS. Every figure is read from
   * public/data/oct10-2025/evidence-census-headline.json (scripts/build-evidence-census.ts,
   * the same computation as the Evidence page). Owner, 14 Sep: predict the questions and
   * answer them with numbers. A rebuild moves these lines by itself.
   */
  contains: {
    title: 'What the number contains',
    lines: [
      `Every liquidation, both protocols, never folded. Aave V3: ${n(census.aave.positions)} positions, the protocol closed ${usdM(census.aave.realRepaidUsd)} and Membrane would close ${usdM(census.aave.memRepaidUsd)}†, ${gap(census.aave.gapPct)}. Morpho Blue: ${n(census.morpho.positions)} positions, ${usdM(census.morpho.realRepaidUsd)} against ${usdM(census.morpho.memRepaidUsd)}†, ${gap(census.morpho.gapPct)}. Together ${usdM(census.all.realRepaidUsd)} against ${usdM(census.all.memRepaidUsd)}†, ${gap(census.all.gapPct)}, net: Membrane closes less on ${n(census.less)} positions (${usdM(census.lessUsd)}†) and more on ${n(census.more)} (${usdM(census.moreUsd)}†). The lens above shows each chain.`,
      'What Membrane’s figure is: a breach inside the 4% band waits eight hours; a return under the line clears the timer and a later breach starts a fresh one; a move past line × 1.04, or still over the line at expiry, repays to the borrow cap at that minute’s price; the position then walks on. Stablecoin collateral has no window† and is repaid to cap the minute it crosses. Each position is its whole composition at its first liquidation, every leg on its protocol’s own oracle read on chain. The protocols’ figure is every liquidation the position took across 10 and 11 Oct, measured.',
      topLine,
      `${n(census.neverSold.positions)} positions were never sold at all†, ${usdM(census.neverSold.debtUsd)} of debt: back under their line inside the window, or never over it. The protocols closed ${usdM(census.neverSold.realRepaidUsd)} of it.`,
      `Under $2,000 of debt both sides close the loan whole: ${n(B.underFloor.positions)} positions, the protocols a median ${pct1(B.underFloor.realMedianFrac)}, Membrane ${pct1(B.underFloor.memMedianFrac)}†. Membrane’s $2,000 minimum exists because below it a liquidation costs more in gas than it recovers, so the contract indexes the floor to the gas price rather than to a choice of ours. Between $2,000 and $4,000 the minimum still closes ${n(B.floorToTwice.memClosesWhole)} of ${n(B.floorToTwice.positions)} loans whole† where the protocols took a median ${pct1(B.floorToTwice.realMedianFrac)}. From $4,000 up the median position loses ${pct1(B.twiceFloorUp.realMedianFrac)} of the loan to the protocols and ${pct1(B.twiceFloorUp.memMedianFrac)} to Membrane†, across ${n(B.twiceFloorUp.positions)} positions.`,
      `${n(more.positions)} positions lose more on Membrane† and ${n(census.equal)} come out equal to the cent. ${n(more.underFloor.positions)} of the ${n(more.positions)} are under the $2,000 minimum and total ${usdAny(more.underFloor.extraUsd)}. The other ${n(more.atOrAboveFloor.positions)} (${n(moreBand)} sold at the band, ${n(moreT0)} already past it at the first liquidation, ${n(moreRest)} otherwise) are where repay to cap restores the line in one pass while the protocols’ liquidators took a median ${pct1(more.atOrAboveFloor.realMedianFrac)} bite: ${usdM(more.atOrAboveFloor.extraUsd)}†.`,
      `${n(census.gridEnd.positions)} positions were still inside their 8-hour window when the data ends (23:59 UTC 11 Oct). A window still open is not a completed sale; the census books each at the last price, ${usdAny(census.gridEnd.memRepaidUsd)}† of Membrane’s total, the conservative choice.`,
      `${n(census.unpricedPositions)} Morpho positions borrow a token with no USD price that day: they are in every count above and in no dollar figure, on either side.`,
      `Stress it, same walk, one rule changed: ${STRESS.map((x) => `${x.label}, ${usdM(x.usd)}†`).join('; ')}. ${crossing.length ? `Every one keeps Membrane under the protocols’ ${usdM(census.all.realRepaidUsd)} except ${crossing.join(' and ')}.` : `Every one keeps Membrane under the protocols’ ${usdM(census.all.realRepaidUsd)}.`}`,
    ],
    /** The one footer line for every † above (DESIGN_RULES.md §3). Rendered. */
    footnote: MODELLED_FOOTNOTE,
    cite: `public/data/oct10-2025/evidence-census-headline.json (census sha256 ${census.censusSha256.slice(0, 12)}…) · scripts/build-evidence-census.ts · contracts/LiquidationEngine.sol:2246-2248 (floor = max(liqDebtMinimum, gas stipend × CHUNK_GAS_MULT))`,
  },
} as const
