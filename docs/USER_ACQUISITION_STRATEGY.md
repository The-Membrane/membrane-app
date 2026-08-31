# Membrane Protocol: User Acquisition Strategy for Osmosis Launch

## Context

Membrane is a CDP-based stablecoin protocol launching on Osmosis with four products: **CDPs** (mint CDT against multi-collateral bundles), **Disco** (9-slot insurance/revenue sharing), **Transmuter** (CDT-USDC swaps), and **Acquisition** (automated 3-tier control system that attracts Transmuter liquidity when utilization breaches thresholds — stabilizing borrowing rates by attracting deposits first, rather than spiking rates like 2-slope models). Manic (leverage looping) exists in codebase but will NOT launch — insufficient collateral.

This document identifies users whose pain points are directly abated by Membrane's structural advantages, prioritizes collateral types and early adopters for Osmosis, and lays out a Scientific Advertising campaign to attract them by positioning structural differences as lifestyle transformations.

---

## 1. Structural Benefits → Pain Points They Abate

| Structural Benefit | How It Works | Pain It Kills |
|---|---|---|
| **Multi-collateral bundles** | Single CDP holds ATOM + stATOM + OSMO + USDC in one `collateral_assets[]` | Forced to open separate vaults per collateral on Mars/Kujira — fragmenting risk, multiplying management overhead |
| **Fixed-rate segments** | Lock borrowing cost for 1/3/6 months via `FixedRateCaps` | Variable rates spike unpredictably across every Cosmos lending protocol; impossible to plan |
| **Modular CDP architecture** | Collateral, Debt, and Liquidation Engine as independent contracts. Each upgradable without redeploying the others. 7-step liquidation chain with partial-failure resilience. | Monolithic CDPs: a bug in rate logic takes down the whole system. A liquidation failure reverts the entire operation. |
| **3-stage liquidation** | Capital Recall → Liquidation Queue → Market Sale (DEX routing). Partial failures don't revert the whole chain. | Single-layer liquidation causes cascading losses in crashes |
| **Disco 9-slot system** | Explicit risk tiers: Slot 1 = 25% of revenue (absorbs bad debt first), Slot 9 = 3% (absorbs last). O(1) distribution. | Insurance/staking pools have opaque, one-size-fits-all risk — when bad debt hits, everyone loses equally |
| **Stabilized borrowing rates** | Acquisition is the first response to high utilization: attract deposits via MBRN incentives *before* rates need to spike. Only if deposits don't respond does the bump rate raise CDP interest. Reduction decays 2x faster than increases. | 2-slope rate models (Mars, Aave, Compound) spike borrowing costs directly when utilization is high — punishing borrowers instead of attracting lenders. Rates spike, borrowers panic-repay, liquidity whipsaws. |
| **Acquisition control system** | 3-tier feedback loop: (1) MBRN pool accrues when util ≥ target (attract deposits first), (2) bump rate raises CDP interest only when pool maxes (last resort), (3) efficiency mutation self-tunes emission rate | Stablecoin liquidity dries up in stress because no protocol has an automated mechanism to attract it back — they only know how to punish borrowers |
| **Acquisition intent routing** | Auto-route claimed MBRN to Disco/staking without manual intervention | Governance tokens airdropped → held → dumped. No productive use path built into the distribution |

---

## 2. User Segments

### Segment A: The Holder Who Needs Dollars Without Selling

**Behavior:** Holds BTC, ATOM, and/or stATOM on Osmosis ($500-$50k+). Long-term believer in these assets. Occasionally needs USDC for opportunities, expenses, or other DeFi positions. Currently either sells (tax event + lost upside) or does nothing and misses the opportunity.

**Current pain:** Borrowing against crypto on Osmosis means Mars Protocol — separate vaults per collateral. If they hold BTC + ATOM + stATOM, that's three separate positions to manage, three separate LTV thresholds to monitor, three separate liquidation risks. And all rates are variable — a 3% borrow rate can spike to 12% if utilization shifts. This is how 2-slope models work: when utilization is high, rates spike to punish borrowers instead of attracting lenders. There's no way to lock in a rate. They can't plan.

**Membrane structural benefit:** One CDP. One position. BTC + ATOM + stATOM all in a single `collateral_assets[]` array. Mint CDT, swap to USDC via Transmuter. Fixed-rate segments lock the borrowing cost for 1, 3, or 6 months. Static per-asset LTVs mean your liquidation threshold is known and predictable from the moment you open the position. And rates stay stable because the Acquisition control system is the first response to high utilization — it attracts deposits via MBRN incentives *before* rates need to spike. Only if that fails does the bump rate touch borrowing costs. The modular architecture (separate Collateral, Debt, and Liquidation Engine contracts) means a bug in rate logic can be fixed without touching collateral management. Three-stage liquidation (Capital Recall → Liquidation Queue → Market Sale) with partial-failure resilience means even if one stage fails, the others still execute.

**Why competitors don't solve this:**
- Mars: Separate vaults per collateral. Variable rates only (2-slope model — rates spike at high utilization). Monolithic contract architecture.
- Kujira: USK minting with single-collateral vaults. Variable rates. No bundling.
- Maker: Ethereum only. Multi-collateral DAI exists but no Cosmos assets, no fixed rates.

**This is the largest addressable segment on Osmosis.** Every BTC holder, ATOM staker, and liquid staker is a potential CDP user. BTC alone has $1.51M daily volume on Osmosis.

---

### Segment B: The Stablecoin Holder Seeking Productive Yield Without Directional Risk

**Behavior:** 5k-500k USDC on Osmosis (Noble IBC). Has tried Mars lending (2-5% variable), maybe Osmosis LPs (impermanent loss). Wants yield on dollars without taking price exposure to volatile assets.

**Current pain:** USDC yield options on Osmosis are limited to Mars lending (variable, compresses to 2-3%) or LPing against volatile assets (impermanent loss). There's no way to earn from protocol revenue without holding a volatile governance token. And if they do hold governance tokens, they earn flat staking rewards with zero control over their risk exposure.

**Membrane structural benefit:** Three paths, all dollar-denominated:

*Path 1 — Transmuter deposit (retention emissions):* Deposit USDC directly into the Transmuter. Earn constant MBRN retention emissions for as long as you stay. This is passive — no windows, no lock periods. The longer you stay, the more weight you accrue (time-cliff discount curve: 60% in month 1, 40% over 3 months). Retention emissions incentivize staying, not entering.

*Path 2 — Acquisition window (new deposit incentives):* Deposit USDC via an Acquisition window when one is active. This is separate from existing Transmuter deposits. MBRN accrues in the Acquisition pool when Transmuter utilization ≥ target. Your share of that pool is proportional to your deposit × lock duration. Set auto-intent to route MBRN to Disco. Note: Acquisition incentives go to Acquisition window depositors only, NOT to existing Transmuter depositors.

*Path 3 — Disco slots:* Deposit directly into Disco slots. Pick risk tier explicitly. Earn protocol revenue (from CDP interest + Transmuter fees) in CDT. Slot 1 = 25% of revenue (most risk), Slot 9 = 3% (least risk). 2-day unstaking cooldown — not permanent lock.

**Why competitors don't solve this:**
- Mars: Variable lending rate only. No tiered insurance. No protocol revenue sharing for depositors.
- Kujira: ORCA liquidation bidding requires active management. Not passive.
- No Cosmos protocol offers user-selected risk tiers with published, transparent weights.

---

### Segment C: The Risk-Aware Yield Optimizer

**Behavior:** Experienced DeFi user who understands risk tiers conceptually. Has governance tokens earning flat staking rewards. Comfortable with complexity but frustrated that every insurance/staking product treats all depositors the same.

**Current pain:** Staking OSMO/MARS/KUJI earns the same rate regardless of how much risk you're willing to take. When bad debt occurs, all stakers absorb it equally. There's no instrument that lets them say "I want more risk for more revenue" or "I want to be last in line for bad debt, even if I earn less." Risk preferences cannot be expressed.

**Membrane structural benefit:** Disco. 9 explicit slots with published revenue weights. Slot 1 absorbs bad debt first and earns 25% of protocol revenue. Slot 9 absorbs last and earns 3%. The weights are on-chain, transparent, and visible in the UI. O(1) event-based distribution means it scales to 20,000+ depositors with no performance degradation. Compound mode auto-reinvests revenue. Users actively manage risk by moving between slots as market conditions change — more risk in calm markets, less risk in volatile ones.

**Why competitors don't solve this:**
- Mars: No tiered insurance. Single stability pool treats all depositors equally.
- Kujira ORCA: Premium slots exist for liquidation bidding, but it's active management (place bids, monitor). Not passive yield with risk selection.
- Maker: MKR holders backstop the system but have no slot selection. Risk is binary: you hold MKR or you don't.

---

### Segment D: The Governance Token Cynic

**Behavior:** Burned by OSMO, MARS, or other Cosmos governance tokens that lost 80%+. Still active on Osmosis. Reflexively avoids new tokens. Sees MBRN and assumes it will dump like every other governance token.

**Current pain:** Every new Cosmos protocol launches a governance token. Airdropped tokens sit in wallet, lose value, eventually get sold at a loss. There's no reason to hold them — staking rewards don't justify the drawdown. The problem isn't the token; it's that there's no productive path from "receiving the token" to "earning real yield" that doesn't require actively managing a volatile position.

**Membrane structural benefit:** Acquisition intent routing. Users deposit USDC, earn MBRN proportional to points (`deposit × (1 + lockDays/365)`), and set intents that auto-route claimed MBRN directly to Disco — the token never sits in their wallet. The MBRN flows into a revenue-generating insurance slot where it earns real protocol revenue (CDT from CDP interest + Transmuter fees). The user never needs to believe in MBRN price appreciation. They just need the USDC deposit → MBRN → Disco → CDT revenue pipeline to produce positive yield. And because the Acquisition emission rate is self-tuning (3-tier control system), MBRN isn't over-emitted — efficiency mutation automatically reduces emission when deposits are responding well.

**Why competitors don't solve this:**
- Mars: MARS staking earns protocol revenue but with no slot selection, no intent routing, no self-tuning emission.
- Kujira: KUJI staking earns revenue but no acquisition flywheel or auto-routing.
- No Cosmos protocol has a built-in pipeline from "earn token → deposit into revenue-generating position" that runs without manual intervention.

---

### Segment E: The DAO/Treasury Operator

**Behavior:** DAO treasury managers or sophisticated individuals with 50k-5M in Cosmos assets who need predictable cost of capital for operations. They've used DeFi borrowing but been burned by variable rate spikes that made loans unprofitable.

**Current pain:** Every Cosmos CDP/lending protocol charges variable rates. A treasury that borrows at 3% to deploy capital at 8% can see its borrowing cost spike to 15% in a utilization surge, turning a profitable position into a losing one overnight. There is no fixed-rate borrowing in Cosmos DeFi. Period.

**Membrane structural benefit:** Rate Segments. Fixed 1-month, 3-month, 6-month borrowing rates with explicit `FixedRateCap` structures. The rate is locked for the duration. Static per-asset LTVs are set at collateral onboarding and don't shift mid-term. Multi-collateral bundles mean the treasury can use its full portfolio (ATOM + stATOM + USDC buffer) as collateral in one position, maximizing capital efficiency. The modular architecture means rate logic lives in the Debt contract — it can be upgraded independently without touching collateral management.

**Why competitors don't solve this:**
- Mars: Variable only.
- Kujira: Variable only.
- Maker: Stability fees change via governance votes. Not truly fixed.
- **No fixed-rate borrowing exists anywhere in Cosmos DeFi.** This is a category of one.

---

## 3. Priority Collateral Types for Osmosis Launch

Based on Osmosis volume data: USDC ($2.42M) > BTC ($1.51M) > ATOM ($813K) > stATOM ($366K) > OSMO ($343K).

| Priority | Asset | Launch Timing | Rationale |
|----------|-------|---------------|-----------|
| **1** | **BTC** | Day 0 | Highest volume asset on Osmosis after USDC ($1.51M). BTC holders are the largest addressable segment who want to borrow stablecoins without selling. Generates the most CDT demand. Strong narrative: "borrow against your BTC at a fixed rate." |
| **1** | **ATOM + stATOM** | Day 0 | Most-held IBC assets on Osmosis ($813K + $366K volume). Multi-collateral bundle (BTC + ATOM + stATOM in one CDP) is the primary differentiator vs. Mars. Natural CDT demand: holders want liquidity without selling. |
| **2** | **USDC** | Day 0 | As CDP collateral, USDC is primarily useful for market makers arbing CDT peg deviations — not for powering the Transmuter. (Transmuter gets USDC from Acquisition deposits, not CDP collateral.) Low-risk collateral that complements volatile assets in bundles. |
| **3** | **OSMO** | Week 2-3 | Most active Osmosis-native users hold OSMO ($343K volume). Higher volatility = tighter static LTV, but good secondary collateral in bundles with ATOM/BTC to diversify. |
| **4** | **LP Shares** | Month 2+ | Most complex (requires LP token oracle pricing). Unlocks an entirely new collateral class unavailable on competitors. Delay until core flywheel proven. |

**Strategic note:** BTC + ATOM/stATOM CDPs create CDT demand that flows through the Transmuter, driving utilization up. Acquisition responds to high utilization by attracting USDC deposits (via MBRN incentives) into the Transmuter — this is how the Transmuter gets its USDC liquidity, not from USDC CDP collateral. Both sides (CDT demand from CDPs + USDC supply from Acquisition) need to launch together for the flywheel to spin.

---

## 4. Early Adopter Priority

### Primary: BTC + ATOM/stATOM Holders Already Borrowing on Mars

- **Already on Osmosis** — zero friction. BTC is the highest-volume non-stablecoin asset ($1.51M/day).
- **Highest pain-to-solution fit** — they already know the pain of separate vaults, variable rates, and 2-slope rate spikes. Multi-collateral bundles + fixed rates + stabilized variable rates are an instant upgrade.
- **Most likely to spread word** — DeFi borrowers are vocal on Cosmos Twitter when they find a better tool. "My rate didn't spike when everyone else's did" is a story that spreads.
- **Generate CDT demand** — every CDP minting CDT creates Transmuter flow, which drives the flywheel
- **Smallest acquisition cost** — already understand CDPs, stablecoins, LTV. Only need to learn "one position, fixed rate, bundled collateral, rates that don't spike first"

### Secondary: USDC Holders Seeking Productive Yield

These users seed the Transmuter. Without them, CDT → USDC swaps don't work and CDPs are less useful. Acquisition MBRN rewards + Disco revenue sharing are the draw.

### Tertiary: Existing MBRN Holders (from any prior distribution)

Already have the token. The only question is which Disco slot to deposit into. Lowest acquisition cost of any segment.

---

## 5. Scientific Advertising Campaigns

*Hopkins' principles applied: specific claims with numbers, reason-why mechanics, risk reduction through trials, lifestyle before/after transformation.*

### Campaign 1: BTC/ATOM/stATOM Holders → CDPs (Segment A)

**Headline:** "BTC + ATOM + stATOM. One Position. Fixed Rate. Your Rate Doesn't Spike When Everyone Else Is Borrowing."

**Reason Why:** "On Mars, each collateral type needs its own vault — three positions to monitor, three liquidation thresholds to track, three variable rates that spike when utilization gets high. That's how 2-slope models work: high demand = punish borrowers. Membrane does the opposite. Your BTC, ATOM, and stATOM go in a single collateral bundle with one weighted liquidation threshold. You mint CDT at a rate locked for 3 months via Rate Segments. And when utilization gets high, Membrane's Acquisition control system attracts new deposits via MBRN incentives *before* touching your borrowing rate. Only if that fails does the bump rate activate — and it decays 2x faster than it increases. Three-stage liquidation (Capital Recall → Liquidation Queue → Market Sale) processes in stages — partial failures don't revert the whole chain."

**Trial / Risk Reduction:**
- Start with a small BTC + USDC bundle (USDC buffer lowers overall LTV)
- Use the Liquidation Simulator to see exact liquidation price before committing
- Fixed-rate segment means no rate surprises during your trial period
- Static LTVs per asset — your liquidation threshold is known from day one

**Lifestyle Transformation:**
- *Before:* Hold 0.5 BTC + 1,000 ATOM. Need $5,000 USDC for an opportunity. Options: sell BTC (taxes, lose upside), open two Mars vaults (manage separately, watch variable rates that spike when everyone else is borrowing too). Choose to do nothing. Miss the opportunity.
- *After:* Open one Membrane CDP. Deposit BTC + ATOM together. Mint CDT at 3.8% fixed for 3 months. Swap CDT → USDC via Transmuter. Deploy the capital. Repay when convenient. Keep all your BTC and ATOM. Your rate is locked — it doesn't spike when the market gets busy.

**Measurement:**
- Multi-collateral positions created (positions with 2+ assets in `collateral_assets`)
- Fixed-rate vs. variable-rate segment uptake
- CDT minted per collateral deposited (indicates leverage comfort)
- 30-day CDP retention vs. Mars vault retention

---

### Campaign 2: USDC Holders → Transmuter + Acquisition (Segment B)

**Headline:** "Your USDC Earns 2.8% on Mars. Deposit It in Membrane's Transmuter and Earn MBRN Every Day You Stay."

**Reason Why:** "Two ways to earn MBRN on your USDC — one passive, one opportunistic.

**Transmuter retention:** Deposit USDC directly into the Transmuter. Earn constant MBRN retention emissions for as long as your deposit stays. The longer you stay, the more weight you accrue — 60% of your retention weight builds in month 1, the remaining 40% over the next 3 months. This isn't utilization-dependent. You earn simply for being there.

**Acquisition windows:** When Transmuter utilization breaches the target threshold, the Acquisition control system opens a window to attract new USDC. Deposit during this window and earn MBRN from the Acquisition pool — separate from retention. Points = deposit × (1 + lockDays/365). The Acquisition system self-tunes: if deposits respond well, emission decreases (efficient). If not, emission increases. This is the opposite of 2-slope models that just spike your borrowing rate — Membrane attracts lenders first."

**Trial / Risk Reduction:**
- Minimum deposit: 1 USDC
- Deposit is USDC → USDC the whole time (no price risk on your principal)
- MBRN is the upside layer, not required for the position to be worthwhile
- Retention emissions are constant — you earn from day one
- 2-day unstaking from Disco if you route MBRN there

**Lifestyle Transformation:**
- *Before:* USDC sits in Mars earning 2.8% variable. Check it weekly. Rate goes down. Consider moving to Ethereum. Don't. USDC sits there.
- *After:* Deposit USDC into Membrane's Transmuter. Earn retention MBRN every day you stay — weight builds over time. When an Acquisition window opens (high utilization), deposit more for bonus MBRN. Route all MBRN to Disco Slot 5 via intent. Your USDC earns retention, your MBRN earns protocol revenue. Check quarterly.

**Measurement:**
- USDC deposited via Acquisition windows
- Intent configuration rate (% of users who set auto-route vs. manual claim)
- Transmuter utilization before/after Acquisition window opens (proves the control system works)
- Cost per $1,000 of new Transmuter TVL

---

### Campaign 3: Risk Managers → Disco (Segment C)

**Headline:** "Disco Slot 1: 25% of Revenue, First to Absorb Bad Debt. Slot 9: 3% of Revenue, Last to Absorb. Pick Your Number."

**Reason Why:** "Every other insurance/staking pool treats all depositors identically. When bad debt hits Mars's stability pool, everyone takes the same haircut. Membrane's Disco has 9 numbered slots with published, on-chain revenue weights: Slot 1 = 25%, Slot 2 = 20%, Slot 3 = 15%, down to Slot 9 = 3%. Slot 1 absorbs bad debt first — highest risk, highest reward. Slot 9 absorbs last — lowest risk, lowest reward. You see the `bad_debt` field per slot. You choose your number. Revenue distribution is O(1) event-based — it works identically whether there are 50 depositors or 20,000. 2-day unstaking cooldown, not permanent lock."

**Trial / Risk Reduction:**
- Start in Slot 8 or 9 (lowest risk — 4% and 3% of revenue, last to absorb bad debt)
- Enable compound mode to auto-reinvest
- 2-day unstaking cooldown — not locked for months
- Move to higher slots when comfortable with the system

**Lifestyle Transformation:**
- *Before:* Stake governance tokens in a flat pool. Earn 5% APR. Market crashes. Bad debt occurs. You lose 8% of your deposit. You had no say in how much risk you took. Everyone lost the same amount.
- *After:* Choose Disco Slot 6. Earn 7% of protocol revenue. Market crashes. Bad debt occurs. Slots 1-5 absorb it before you're touched. You see exactly how much each slot absorbed on-chain. Move to Slot 8 during volatile months. Move to Slot 3 during calm months. You manage your own risk curve.

**Measurement:**
- Deposit distribution across all 9 slots (tells us if users understand the gradient)
- Slot migration frequency (users moving between slots = engaged risk management)
- Revenue claimed vs. compounded ratio (sophistication indicator)
- Slot 1-3 vs. Slot 7-9 deposit ratio (market sentiment indicator)

---

### Campaign 4: Governance Skeptics → Acquisition Intent Routing (Segment D)

**Headline:** "Deposit 10,000 USDC for 90 Days. Earn 12,466 Points. Auto-Route MBRN to Disco. The Token Never Touches Your Wallet."

**Reason Why:** "Points = deposit × (1 + lockDays/365). 10,000 USDC for 90 days = 10,000 × 1.247 = 12,466 points. Your share of the MBRN pool is your points divided by total points. But here's the structural difference: intent routing. Set your claim intent to auto-deposit 100% of MBRN into Disco Slot 5. The token flows from Acquisition → Disco in one transaction. It never sits in your wallet. You never have to decide when to sell, when to stake, or whether to hold. Your MBRN immediately starts earning protocol revenue (CDT from CDP interest + Transmuter fees). The Acquisition emission rate is self-tuning — 3-tier control system adjusts based on real deposit efficiency, so MBRN isn't over-emitted."

**Trial / Risk Reduction:**
- Minimum lock: 3 days. Minimum deposit: 1 USDC.
- Set intent at any time — can update before claiming
- USDC principal flows into the Transmuter during the lock — separate from retention (Acquisition is its own deposit mechanism)
- Intent boosts (5%+) incentivize auto-routing — you earn more by not holding the token

**Lifestyle Transformation:**
- *Before:* Get airdropped 5,000 governance tokens. Watch them drop 60% over 3 months. Finally sell. Net loss. Resolve to never hold governance tokens again.
- *After:* Deposit USDC in Acquisition. Set intent: 100% MBRN → Disco Slot 5. Lock for 90 days. After cliff, MBRN auto-deposits into Disco. Disco earns protocol revenue in CDT. You check once a quarter: "Am I earning revenue? Yes. Is my USDC still in the Transmuter? Yes." That's it. No token price watching. No sell decisions.

**Measurement:**
- Intent configuration rate (% setting auto-route vs. claim-to-wallet)
- Lock duration distribution (conviction level)
- Post-acquisition behavior: do users who enter via Acquisition become CDP users? (flywheel conversion)
- MBRN sell pressure: what % of claimed MBRN gets sold vs. staked vs. Disco'd

---

### Campaign 5: Fixed-Rate Borrowers / DAOs (Segment E)

**Headline:** "Lock Your Borrowing Rate at 3.8% for 6 Months. The Only Fixed-Rate CDP in Cosmos."

**Reason Why:** "Every CDP and lending protocol in Cosmos charges variable rates. Mars, Kujira, Osmosis — all variable. When utilization spikes, 2-slope models spike your rate from 3% to 12% overnight. Membrane is different in two ways. First: Fixed-Rate Segments lock your cost for 1, 3, or 6 months. Second: even the variable rate is stabilized — when utilization is high, the Acquisition control system attracts new deposits via MBRN incentives *before* touching your rate. Only if deposits don't respond does the bump rate activate, and it decays 2x faster than it increases. Static per-asset LTVs mean your liquidation parameters are known from day one. You deposit collateral, mint CDT at a known cost, and plan around it. This is basic treasury management that didn't exist in Cosmos until now."

**Trial / Risk Reduction:**
- Start with a 1-month fixed rate (shortest commitment)
- Multi-collateral bundle with USDC buffer lowers overall risk
- Liquidation Simulator shows exact liquidation price
- Can always add more collateral to lower LTV during the term

**Lifestyle Transformation:**
- *Before:* DAO treasury borrows $100k at 3% on Mars to fund operations for 6 months. Month 3: utilization spikes, rate hits 11%. The loan now costs $11k/year instead of $3k. Budget blown. Operations scaled back.
- *After:* DAO treasury borrows $100k at 3.8% fixed for 6 months on Membrane. Month 3: market goes crazy. Rate is still 3.8%. Cost is exactly $1,900 for the 6-month term. Budget intact. Operations continue. Renew at end of term.

**Measurement:**
- Fixed-rate segment uptake by duration (1m vs. 3m vs. 6m)
- Average position size for fixed-rate borrowers (likely larger = institutional)
- Renewal rate at end of fixed-rate term
- CDT minted under fixed vs. variable rates

---

## 6. Channel Strategy

| Channel | Why | Tactic |
|---------|-----|--------|
| **Cosmos Twitter/X** | Every Osmosis DeFi user is here. Small enough that 50 vocal users create a narrative. | Weekly "Membrane Metrics" threads with specific numbers: "$2.4M in multi-collateral CDPs. Average fixed rate: 3.8%. Disco Slot 1 revenue: $18,400. Transmuter util: 68%." Side-by-side comparisons vs. Mars (separate vaults vs. bundled, variable vs. fixed). No slogans — just numbers. |
| **Osmosis Governance Forum** | Most engaged, highest-conviction users. They vote and read proposals. | Integration proposals: CDT/USDC pool incentive requests with cost-per-TVL analysis. Governance actions that put Membrane in front of every forum reader. Not ads — governance participation. |
| **Cosmos Discord** (Osmosis, Stride, Cosmos Hub) | Where confused users ask questions. stATOM holders hang out in Stride Discord. | Dedicated support presence. Pre-built FAQ responses matching campaign messaging: "What are Rate Segments?" → links to specific-number campaign content. Target Stride Discord for stATOM → CDP pipeline. |
| **Ditto In-App Notifications** | Cross-product retention nudges for existing users. | When CDP is stable for 7 days → suggest Disco. When Acquisition claims are ready → suggest intent routing. When Transmuter utilization crosses threshold → notify depositors. |
| **Affiliate System (1% revenue share)** | Ecosystem tools = distribution channels at no upfront cost. | Target Mintscan, Celatone, Keplr dashboard integrations. 1% passive revenue for referrals. These reach every Osmosis user without paid ads. |
| **On-Chain Targeted Outreach** | Can see exactly who holds idle USDC or borrows on Mars. | Query Osmosis for addresses with (a) >$5k USDC not in any protocol, or (b) active Mars vaults. Small CDT airdrop with message: "You have 3 Mars vaults. Membrane bundles them into 1. Try swapping this CDT to USDC to see how the Transmuter works." |
| **Stride Partnership** | stATOM is a Tier 2 collateral type. Stride has a motivated community. | Co-marketing: "Your stATOM is earning staking yield. Now borrow against it at a fixed rate without selling." Stride benefits from increased stATOM utility/demand. |

---

## 7. Flywheel Activation Sequence

The flywheel without Manic: **CDPs → Transmuter → Disco → Acquisition (control system) → back to Transmuter.**

### Week 0: Seed Transmuter via Acquisition

The Transmuter must have USDC liquidity before CDPs are useful. Without CDT → USDC swap capacity, minting CDT has no utility.

**Action:** Launch Acquisition window + Transmuter simultaneously. Acquisition USDC deposits flow into Transmuter as liquidity (`EnterVault()`).

**User action:** Deposit USDC via Acquisition. Set MBRN intents. USDC sits in Transmuter as swap liquidity.

**Target:** $1M+ USDC in Transmuter.

### Week 0-1: Launch CDPs (BTC + ATOM + stATOM + USDC collateral)

With Transmuter liquid, CDT has a use: swap to USDC. Now CDPs are valuable.

**Action:** Open CDP deposits for BTC, ATOM, stATOM, USDC. Enable multi-collateral bundles + fixed-rate segments. USDC collateral serves market makers arbing CDT peg deviations.

**User action:** Deposit BTC + ATOM + stATOM bundle → mint CDT at fixed rate → swap to USDC via Transmuter.

**Target:** 100+ CDPs opened, 50+ multi-collateral positions.

**Why simultaneous with Transmuter:** CDP borrowers create CDT demand → CDT flows into Transmuter → drives utilization up → activates Acquisition Tier 1 (MBRN pool accrual) → attracts more USDC deposits. Both sides of the flywheel need to start together.

### Week 2: Activate Disco

CDP interest payments + Transmuter usage fees (1% above 80% utilization) = protocol revenue. This revenue needs somewhere to go.

**Action:** Open Disco deposits. Early Acquisition participants who set intents to route MBRN to Disco auto-populate slots.

**User action:** Deposit into chosen Disco slot → earn revenue share.

**Target:** All 9 slots non-empty. At least $500k total Disco TVL.

### Week 3: Add OSMO Collateral

With flywheel proven for ATOM/stATOM, add OSMO as CDP collateral.

**Target:** OSMO CDPs opened by active Osmosis users who were watching the first 2 weeks.

### Month 2+: Self-Sustaining Control Loop

The Acquisition control system takes over:
1. Transmuter utilization rises (more CDT swaps than USDC available)
2. Acquisition Tier 1: MBRN pool accrues → attracts USDC deposits
3. If pool maxes → Tier 2: bump rate raises CDP interest → discourages excessive borrowing
4. Tier 3: Efficiency mutation self-tunes emission rate based on deposit response
5. New USDC deposits increase Transmuter liquidity → utilization falls → pool accrual stops → bump rate decays (2x faster than it increases)
6. Equilibrium: Transmuter maintains liquidity around target utilization without manual intervention

### Critical Metrics Per Phase

| Phase | Week | Metric | Target |
|-------|------|--------|--------|
| Transmuter Seed | 0 | USDC via Acquisition | $1M+ |
| CDP Launch | 0-1 | Multi-collateral CDPs | 50+ |
| Disco Activation | 2 | All slots populated | 9/9 non-empty |
| OSMO Addition | 3 | OSMO CDP positions | 20+ |
| Self-Sustaining | 8+ | Transmuter utilization holding near target | ±10% of target |
| Self-Sustaining | 8+ | Monthly protocol revenue / Disco TVL | >0.5% |

---

## 8. Verification

Before publishing any campaign claim, verify against actual contract state:

1. **Fixed-rate availability:** Confirm `FixedRateCaps` are non-zero for 1/3/6 month segments in the CDP contract
2. **Slot weights:** Confirm Disco slot weights (25%, 20%, 15%, 12%, 9%, 7%, 5%, 4%, 3%) match on-chain after deployment
3. **Acquisition control parameters:** Verify `target_utilization`, `base_acquisition_rate`, `bump_increment`, `bump_interval_seconds` match claimed values
4. **Stabilized rates:** Verify Acquisition bump_rate mechanism triggers after pool accrual (not immediately) and that reduction_speed_multiplier = 2x (decays faster than it increases)
5. **Points formula:** Verify `points = deposit × (1 + lockDays/365)` matches contract logic in `acquisition.rs`
6. **Multi-collateral:** Verify CDP contract accepts 2+ collateral types in a single position on Osmosis
7. **Liquidation stages:** Verify all 3 stages (Capital Recall, Liquidation Queue, Market Sale) are deployed and active in the modular Liquidation Engine
8. **Modular contracts:** Verify Collateral, Debt, and Liquidation Engine contracts are deployed separately on Osmosis
