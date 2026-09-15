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

// NOTE: lib/position-sim/guarantee.ts CARRY_CLAIMS are NOT imported wholesale. Two of
// the four fail against the contracts as worded (fee is taken from collateral,
// LiquidationEngine.sol:1553-1563; the "when exit is blocked" condition names no
// mechanism, Cdp.sol:802-804). The 14-day yield cover is the owner's forward claim,
// ruled in 2026-09-14 (the mechanism is being built); it is carried verbatim below.

// ---------------------------------------------------------------------------
// HERO
// ---------------------------------------------------------------------------
export const HERO = {
  eyebrow: 'Borrowers',
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
  readNote: 'Reads your open position on leading Ethereum money markets. Replays it through the measured 10 Oct 2025 prices.',
  /**
   * THE BRIDGE. The h1 and sub are about the loss waterfall (who absorbs bad debt); the
   * sim under it is about liquidation behaviour (repay to cap, cure, recall). Owner,
   * 14 Sep: the two topics need a connector, and the saving must not imply Membrane is
   * the only venue that repays part of a position (Aave V3 had a 50% close factor; V4
   * refines it). So the bridge names the mechanism and gives partial repayment away.
   */
  bridge: {
    eyebrow: 'Tested on a real day',
    line: 'With borrower-first liquidation a breach inside the 4% band gets eight hours; a return under the line clears it; past the band, or still over the line at expiry, the position is repaid to its cap. Replayed on 10 Oct 2025 against the same oracle rounds Aave liquidated on, that closes 36% less debt than Aave did across the 748 accounts whose collateral the day’s feeds can price. Aave’s own close factor repays partially too; the eight hours and the recall are Membrane’s.',
    cite: 'public/data/oct10-2025/evidence.json debt.priced (748 accounts: Aave $34.69M, Membrane $22.19M) · lib/position-sim/curePath.ts (the walk) · contracts/LiquidationEngine.sol:2099-2103 (band), :1362-1382 (re-arm), :1388-1392 (expiry, band break), :2241-2269 ($2,000 floor)',
    note: 'Six census passes on 14 Sep, each refuted by a separate agent. What survived: the priced-set sign (Membrane closes less) under every control except pricing wstETH on the market stETH feed Aave does not use. What did not: the shipped $39.2M / 27.2% (one repay, no delay, 599 accounts credited with a breach nobody can locate); a $35.0M cure figure (price-recovery cure the engine did not implement); "Membrane closes more" ($31.9M of it was the wrong wstETH feed, the rest one unpriced AAVE-collateral whale).',
  },

  /** Shown while the demo position is loaded, before any address or wallet. */
  demoNote: 'a real wallet Aave V3 liquidated on 10 Oct 2025. Connect yours to replace it.',
} as const

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
export const CLOSE = {
  eyebrow: 'Counterfactual · 10 Oct 2025',
  headline: 'What this order did to 2,350 real liquidations.',
  cta: 'Run yours through the same day',
  href: '/simulator',
  evidenceHref: '/evidence',
  /**
   * WHAT THE NUMBER CONTAINS. Every figure is read from public/data/oct10-2025/evidence.json
   * (the cohort rows) with the builder's own rule for "closes more" (strict >,
   * scripts/build-evidence.ts). Owner, 14 Sep: predict the questions and answer them
   * with numbers. Regenerate these lines when the census is rebuilt.
   */
  contains: {
    title: 'What the number contains',
    lines: [
      'Two sets, never folded. 748 accounts whose collateral the day’s feeds price minute by minute: Aave closed $34.7M, Membrane $22.2M, 36.0% less. 1,003 accounts on collateral they cannot price (AAVE, LINK, OP, ARB, UNI, CRV): the engine can only repay to cap once, and with them added in Membrane closes 14.1% more. The lens above shows both.',
      'What Membrane’s figure is: a breach inside the 4% band waits eight hours; a return under the line clears the timer and a later breach starts a fresh one; a move past line × 1.04, or still over the line at expiry, repays to the borrow cap at that minute’s price; the position then re-arms. Aave’s figure is every hit on the account across 10 and 11 Oct, measured.',
      'Five wallets are 75% of the $12.5M difference. Without the largest it is 30% less; without the five, 14.6% less. The sign holds; the size is a handful of whales.',
      '133 wallets held the whole day, $110.7M of debt. One is 58.6% of that: a $64.9M wstETH loan Aave closed 4.4% of.',
      'Under $2,000 of debt both venues close the loan whole: 932 accounts, Aave a median 99.9%, Membrane 100%; Aave’s own leftover rule and Membrane’s $2,000 minimum agree, and both exist for the same reason: below it an Ethereum liquidation costs more in gas than it recovers, so the contract indexes the floor to the gas price rather than to a choice of ours. Between $2,000 and $4,000 the minimum still closes the loan where Aave took half: 161 accounts, 150 closed whole. From $4,000 up the median account loses 49.8% of the loan to Aave and 32.4% to Membrane, across 658 accounts.',
      '290 of the 748 lose more on Membrane and 111 come out equal. 184 of the 290 are under the $2,000 minimum and total $18,050. The other 106 are past the band or sold at expiry, where repay to cap restores the line in one pass while Aave’s liquidators took a median 46% bite: $6.6M.',
      '599 accounts, $96.8M of what Aave closed, are left out of both sides: 350 on L2s whose oracle this dataset lacks, 168 healthy by Aave’s own read the block before, 80 on unpriced collateral. No breach can be located, so no window can start.',
      'Stress it, priced set: cap each repay at the largest single Aave repay on that asset that day, $20.8M; price the day from Aave’s own snapshot instead of the round log, $17.5M; put wstETH on the market stETH feed Aave does not use, $54.3M. Every one keeps Membrane under Aave’s $34.7M except the last, and that feed is the wrong one.',
      'The Chainlink aggregator in this dataset is not the one Aave read that day: none of Aave’s own prices match a round in it (median gap 0.6%, worst 5.7%). Aave’s side is priced by Aave; Membrane’s walk uses the log as a ratio path. The Aave-anchored line above is the same model on Aave’s prices.',
    ],
    cite: 'public/data/oct10-2025/evidence.json (debt.priced, debt.allIncluded, meta.cureModel, meta.sensitivity, meta.anchor, meta.excluded.byReason, cohort rows) · scripts/build-evidence.ts · contracts/LiquidationEngine.sol:2246-2248 (floor = max(liqDebtMinimum, gas stipend × CHUNK_GAS_MULT))',
  },

} as const
