# Blog — initial post prompts

Six launch-slate posts for the in-repo `/blog` (canonical; Substack gets a same-day excerpt
+ link). Each prompt below is self-contained: paste it into a fresh session with repo
access and it can draft the post.

**Shared rules (prepend to every prompt):**

> You are drafting a post for Membrane's blog. Binding rules:
> - Structure (SEO_RULESET R13): open with a labeled **TL;DR** (3–5 bullets), use
>   questions-as-headers where natural, end with a 4–6 item **FAQ**. One H1, keyword-honest
>   (plain English first, protocol vocabulary second — R9).
> - Provenance (R14): every number traces to a named source with a date — a dataset, a
>   contract read, a measurement stamp. If you cannot verify a figure against the cited
>   source, mark it `[VERIFY]` or cut it. NEVER invent a number, a percentage, or a quote.
> - Voice: Membrane's house style — measured, unflattering results included, no hype
>   adjectives. Losers stay in the data. "Measured, not promised."
> - §11: no returns-based promises, no unbacked confidence figures. Simulated ≠ live edge,
>   say so where relevant.
> - Deliver: the post in MDX/markdown; a meta title (≤60 chars) + description (140–160
>   chars); a 150–250 word Substack excerpt ending with a link back to the canonical post;
>   3 internal links (game, borrow, earn pages as relevant).
> - Length: 1,200–2,000 words unless the prompt says otherwise.

---

## 1. The carry-route report (flagship — revert-style research)

Title direction: "We measured 1,245 real stablecoin carry positions. Here's who made money."
Target queries: *stablecoin carry trade*, *defi carry trade returns*, *is the carry trade profitable*.

> Draft the flagship research post from the carry-route dataset (memory:
> carry-trade-route-economics; source session in /Users/EBmic/membrane-solidity; 12-route
> subset rendered in the app's carry page). Cover: the attribution method that survived
> scrutiny (atomicity + proximity matching, median 33-block borrow→deploy lag, evidence
> tiers A–D, publish A+B only = 1,245 positions / 975 borrowers); carry rate by venue
> (Morpho 23.7% of its borrows vs Aave 3.8% — and WHY: isolated markets vs governance
> listing); route economics (17 positive / 8 negative, median net +0.60%, position-weighted
> +1.31%); the losers by name (GHO→UmbrellaStakeToken at −3.75% into a confirmed 0% module);
> gas irrelevance ($0.09 median, $179 breakeven at median spread). End with the honest
> conclusion: the spread gates this trade, not gas, and ~50% of positions were already
> closed at measurement. Include the method's two published corrections (Compound Withdraw
> ≠ borrow; 4byte's wrong ERC-4626 Deposit topic) — showing corrections IS the credibility.
> Offer the data as a downloadable CSV if the file exists; otherwise link the carry page's
> route table and say the full set publishes with the pipeline.

## 2. How liquidation actually works here (the cure window)

Title direction: "You get 8 hours: how Membrane liquidation works" / plain-English mechanism.
Target queries: *defi liquidation explained*, *how to avoid liquidation crypto loan*, *what happens when you get liquidated*.

> Draft the mechanism explainer from the contracts (membrane-solidity LiquidationEngine;
> memory: gauntlet-floor-mechanics). The mechanism, in order: breach = crossing the
> liquidation line; the 4% window (M×1.04, ≈3.85% price hysteresis) and the two ways in —
> cross the line (8h timer starts) vs jump 4% past it (immediate, no window); cure = deposit,
> repay, or price recovery, ANY time inside the window; expiry → partial liquidation that
> repays to the borrow cap, NOT to zero (√M wipeout frontier: at LTV ≥ √M the partial takes
> everything — give the 86→92.74% example); dynamic caller fee, protocol fee = 0. Contrast
> honestly with instant-liquidation venues (Aave/Morpho have no window — but their design
> choice has reasons; don't strawman). Question-headers throughout ("What starts the
> timer?", "Can I save my position after breach?"). Cross-link the gauntlet ("practice this
> against six years of measured 8-hour windows — no wallet").

## 3. What is a CDP stablecoin? (cornerstone keyword page)

Title direction: "What is a CDP stablecoin? Borrowing against crypto without selling it."
Target queries: *cdp stablecoin*, *borrow against crypto*, *borrow against bitcoin without selling*.

> Draft the educational cornerstone. Plain English throughout: what a collateralized debt
> position is; why someone borrows against crypto instead of selling (keep exposure, no
> taxable disposal — flag jurisdiction-dependence, no tax advice); how the stablecoin (CDT)
> stays backed; what LTV, the borrow cap, and the liquidation line mean (use Membrane's
> real parameters, labeled as ours: B = M − g); what it costs (borrow rate, today's, moves);
> what can go wrong, honestly ranked (price fall → breach → cure window → partial
> liquidation; oracle risk; venue risk if deployed). This page will be many strangers'
> first touch: no protocol vocabulary before its plain-English introduction, every risk
> named before every benefit repeats. 1,000–1,400 words. FAQ targets: "is borrowing against
> crypto safe", "do I pay tax when I borrow against crypto" (answer: jurisdiction-dependent,
> not advice), "what happens if my collateral drops".

## 4. The gauntlet launch post

Title direction: "We turned six years of market data into a strategy game."
Target: AI citation + social more than search. 800–1,200 words.

> Draft the launch announcement from docs/GAME_LAUNCH_PLAN.md and the design frame in
> memory gauntlet-first-launch. The story: real finance has slow, noisy, expensive
> feedback — the opposite of a good game — so we engineered the four properties back in
> (fast, cheap, unambiguous, attributable). Walk the five loops with the game features
> that implement them: cheap-loud failure (15 floors from real contract failure modes),
> immediate counterfactuals WITH named reasons, the daily challenge seed (same floors for
> everyone, new at 00:00 UTC), process scoring (floors-then-net, never P&L — say why: a
> bull market promotes the reckless), calibration as the optional "Is it luck?" side-game.
> Provenance section: what the floors are made of (2,950+ measured 8-hour windows per
> asset 2019–2026, backtest v5's 3,111 Aave + 886 Morpho liquidation events). Close: no
> wallet, free, the terminal preview is next. TL;DR + FAQ ("Is this real money?" No.
> "Is the sim the same as live?" Sim edge ≠ live edge, and the game says so on-screen.)

## 5. How far can a "stable" coin fall in 8 hours?

Title direction: exactly that question (it IS the H1 — AEO question-shaped).
Target queries: *how safe are yield stablecoins*, *susds risk*, *stablecoin depeg history*.

> Draft the dataset post from the lending-scan drawdown tails (collateral_rank.json;
> memory: gauntlet-floor-mechanics + the carry pages' embedded figures): ~2,950 eight-hour
> windows per asset, 2019–2026. Per asset: the 1-in-1000 8h move and the worst-ever
> (sUSDS −0.41% p999 / −6.26% worst; syrupUSDC −0.18%/−0.20%; scrvUSD −0.92%). Explain why
> 8 hours is THE window for us (the cure timer — link post #2). Then the design consequence:
> how a 4% liquidation window absorbs (5.41% absorption at max draw) and what "62× covered"
> means on a real board. Honest section: what the tails DON'T tell you (venue recalls are
> not price events; the worst window ever was 15× the p999 — tails are fat). Every figure
> traces to the scan; if a number can't be re-verified from the dataset, cut it.

## 6. Can you actually withdraw? (the three-band honesty piece)

Title direction: "INSTANT, COOLING, STRANDED: an honest map of DeFi vault exit liquidity."
Target queries: *can I withdraw from defi vault*, *defi vault liquidity risk*, *curator vault withdrawal*.

> Draft the contrarian-honest piece from memory withdrawal-capacity-redemption-history and
> the Earn page's capacity gauge. The thesis: most vault UIs show a balance; almost none
> show whether you can LEAVE. The three bands (never folded): INSTANT (withdrawals here are
> instant-or-revert — no queue exists, a too-big withdrawal simply fails), COOLING
> (mid-unstake, known ETA — and the ETA reconstruction caveat), STRANDED (deployed capital
> that needs an operator crank — use the real sUSDe case: Ethena's global cooldown makes
> the venue read zero-liquid). Explain why we show the ugly band instead of folding it:
> instant+cooling alone overstates reachable liquidity, which is the exact lie the gauge
> exists to prevent. Mention the queued protocol fix (auto top-up) and that the band is
> designed to shrink to zero. This is the E-E-A-T piece: we published our own liveness gap.

---

**Publishing order suggestion:** #3 (cornerstone, needs indexing time) → #5 (question-AEO)
→ #2 (mechanism) → #1 (flagship, coordinate with the data CSV) → #4 (with the game launch)
→ #6. Check R16 (cannibalization) between #2 and #3 before publishing both — their FAQ
sections must target disjoint queries.

## 7. The Mycelium Thesis (editorial flagship — the narrative post)

Title direction: "The mycelium thesis: how a stablecoin grows" / signed, dated, opinionated.
Target: brand/AI-citation; the canonical statement of what Membrane IS. 900–1,400 words.

> Draft the thesis post from docs/MYCELIUM_NARRATIVE.md — the owner's verbatim thesis is
> the spine; expand it, don't dilute it. Structure: the network (carry traders as root
> system, extracting arbitrage from USD yield venues, channeling it into CDT's core); the
> dual-empowerment loop (the same flow rewards inefficiency-closers AND funds the
> borrower-centric lending side — describe the mechanism, venue yield flowing to lenders
> holding borrow costs down; the "no interest" claim is DELETED per the narrative doc's
> boundary #1, do not use it; neither side extracts from the other); the mastery arc (capital
> retention + carry optimization as learnable skills — link the gauntlet as the training
> ground); the reserve-denominator thesis WITH the historical analogy (denomination shifts
> reward prior fluency), clearly labeled as a thesis about the future, not a measured
> claim. This post is allowed conviction — it is signed editorial, not a data report — but
> every number it borrows (route economics, measured yields) still traces to source (R14),
> and it links post #1 for the evidence. TL;DR + FAQ ("Is CDT trying to replace the
> dollar?" — answer honestly: it's a thesis about denomination optionality, not a
> prediction; "What does borrowing cost?" — the mechanism + today's measured rate, dated).
