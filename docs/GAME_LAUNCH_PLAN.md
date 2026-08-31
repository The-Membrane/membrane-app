# Gauntlet-First Launch Plan

**Owner decision (Aug 2026): the simulation strategy game launches publicly BEFORE any
executable Membrane page goes public.** The executable suite stays in demo-until-connect
(V20) with the connect seam pointed at a waitlist until contracts launch.

## Why game-first

- **Zero regulatory/fund-loss surface.** No wallet, no funds, no execution — shareable and
  marketable immediately, anywhere.
- **It trains the users the protocol needs.** The game's graduates arrive at launch already
  knowing partial liquidation, cure windows, recall risk, and sizing discipline — the
  competence pipeline IS the marketing funnel.
- **Its artifacts seed the product.** Winning game boards become the Carry boards
  leaderboard ("Load this board"); winning curator policies seed Defend's competition;
  calibration scores seed the "Is it luck?" identity.
- **The claim is honest and unique:** *play against six years of real 8-hour windows* —
  measured drawdown tails (collateral_rank.json), backtest v5 calibration, the real
  liquidation math (`_getRepayQuantities`, √M wipeout, 8h timer). Not a toy market.

## The five feedback loops (from the design convo) → what exists / what's missing

| Loop | Status | Asset |
|---|---|---|
| Cheap, loud failure | ✅ built | 15 gauntlet floors, retry-per-floor, blood-red settlement, partial-liq to the cap |
| Immediate counterfactuals | ❌ **the gap** | build: after every floor, render the roads not taken |
| Perceptual exposure | ✅ partial | boards leaderboard, routes table; needs the browsable run archive |
| Score decision, not outcome | ✅ built | floors-then-net ranking, Brier calibration as separate "+X% vs coin flip", §11 (no P&L progression) |
| Legible causal chain | ✅ built | three-term settlement sum, per-floor "what killed you" readouts, waterfall |

## Phases

### P0 — finish the game loop in the prototypes (days)

1. **Counterfactual renderer** (the one missing feedback loop). After each floor resolves,
   show a compact ghost table: *your board* vs (a) 2× the leverage, (b) the template you
   didn't pick, (c) the venue you swapped out — same floor, same math, side by side.
   **Every ghost row NAMES THE REASON it worked or failed** — derived from the constraint
   that actually bound in the engine ("survived — the 6.3% fall used 61% of its room" /
   "died — the freeze locked its exit while the timer ran"), never generic text. An
   unexplained counterfactual outcome is a slot-machine reel; the named reason is the lesson.
   Engine already computes outcomes; this is a render + attribution pass, not new simulation.
   Unprompted and retrospective — the novice doesn't know to ask.
2. **Daily seed — and the seed is a visible, first-class object.** One seeded scenario-set
   per UTC day (mulberry32 already in the engine) so every player faces the same floors —
   Wordle's fairness model, and the Defend brief's rotating-seed anti-gaming answer.
   The UI says so plainly: a challenge chip ("Challenge · Aug 24 · seed #A7F3 · same floors
   for everyone today · new at 00:00 UTC") — the user must KNOW tomorrow is a different
   challenge and that they can load a different one. Seed picker + `?seed=` URLs make any
   challenge shareable/replayable; non-daily seeds are marked **practice — unranked**.
3. **Share card.** Canvas-rendered PNG in Living Typeface: floors grid (■■■■□),
   net banked, "+X% vs coin flip" calibration, the lifestyle equivalence line, date + seed.
   The Hevy pattern; the recap card already proves the format.
4. **Entry framing.** Landing's primary CTA becomes *Play today's gauntlet* (no wallet);
   the terminal (demo suite) is the secondary door.

### P1 — extract the engine (≈1 week)

- Port floor mechanics from builder.html into `lib/gauntlet-engine/` (TypeScript, pure,
  deterministic): `run(seed, board, choices) → outcome log`. The floor levers are already
  parameterized (coll/hair/bleed/freeze/fail/rate/ltvCut/timer/divest/stale/closed).
- Unit tests pin the port to current builder.html behavior (fixture floors, known boards,
  exact settlement sums). Engine version stamped into every run record.
- Client and server run the SAME module — this is what makes anti-cheat trivial (below).

### P2 — persistence + leaderboard backend (≈1 week)

- **Identity, wallet-free:** anonymous handle + client token; optional wallet signature
  later to claim/port the handle. No accounts wall before first play.
- **API routes (Next):** `POST /api/game/run` — client submits (seed, board, choice log);
  server REPLAYS it with the same engine and stores the verified outcome (submitted scores
  are never trusted). `GET /api/game/leaderboard` — daily + all-time, ranked floors-then-net
  (process before profit, §11). `GET /api/game/archive?day=` — every verified run on a past
  seed, board + outcome, browsable: the chess-games archive.
- **DB:** extend `db/schema.sql` with `game_run(seed, handle, board jsonb, choices jsonb,
  floors_cleared, net, engine_version, verified_at)`; `calibration_call` table already
  drafted there — wire it for server-side Brier scoring.
- Points linkage is a decision, not a default (see Open Decisions).

### P3 — public launch (checklist)

- Game page is public and **server-renders real content** (SEO R1 curl check applies);
  unique title/description via the Seo component; dynamic OG image per shared run.
- The demo suite ships alongside as "the terminal — preview": demo layer's connect action
  flips from mock-connect to **waitlist capture** (one-line change at the
  `membrane.wallet` seam) until contracts go live.
- Liquidate page stays a stub; nothing executable is public.
- **Oracle-card gate (owner ruling, Aug 26 2026).** The per-asset Oracle Info cards
  (`prototypes/_oracle-cards.html`) are written in DEPLOYED VOICE on purpose — so no copy
  edit is needed or forgotten at launch. The cost of that choice is this gate: **an asset
  may not ship a visible oracle card until its feed is actually wired on-chain.** Before
  any executable page goes public, verify per asset: 4626 assets have
  `Oracle.setAdapterSource` called (sUSDS / syrupUSDC / scrvUSD — plus syrupUSDC's
  6-decimal supply-cap fix), TWAP assets have a route/pool configured (WBTC, wstETH), and
  the PT template is registered (`PtLinearDiscount` currently reverts by design). Any asset
  still unwired at launch: pull its card or mark it, do not let it assert a feed that does
  not exist.
- Launch content: the measured-data provenance page (what the floors are made of, with the
  same stamps the app uses) — the honesty IS the differentiator, say it loudly.
- **AEO structure on all launch content** (SEO_RULESET R13–R18, from the blogEO build-log):
  TL;DR blocks, questions-as-headers, FAQ on the game/provenance pages; every claim
  provenance-traced; post-launch, run the GSC near-miss loop (impressions at position 5–20
  with no dedicated page → cheapest new content) and track AI-engine citations (crawled →
  cited → clicked) separately from search clicks. Launch-week blog posts ship on the
  in-repo `/blog` (canonical) with Substack excerpts for the email list.
- Defend's curator competition opens later as **season 2** (blocked on Trey's OPEN #4
  runtime decision; do not block season 1 on it).

## Guardrails that survive gamification (binding)

- Rank = floors survived, then net. Never net alone. No progression on returns (§11).
- Calibration stays optional and separately scored ("Is it luck?" framing).
- Softened failure still reads as failure: liquidation screens stay blood-red and terminal
  for the run; retry is a new attempt, not an undo.
- Every scenario names its data source; sim edge ≠ live edge disclosure stays on-screen.
- If the system saves you (partial liq stopping at the cap), the readout says so — silent
  rescue teaches nothing.

## Open decisions (owner's — surfaced, not resolved)

1. **Name/brand:** "the Gauntlet" (current) vs Foundry umbrella naming.
2. **Identity:** handle-only vs optional wallet-signature at launch.
3. **Points linkage:** whether game seasons earn a slice of the 100k MBRN/mo emissions
   (touches tokenomics; RiskManager class is the natural home if yes).
4. **Domain:** where the game lives (play. subdomain vs main site front door).
5. **Season 2 timing:** Defend competition needs the runtime decision (Trey OPEN #4).

## Sequence

```
P0 prototypes (days)          P1 engine (~1wk)         P2 backend (~1wk)        P3 LAUNCH
counterfactuals · daily seed  lib/gauntlet-engine      replay-verified runs     game public (SEO'd)
share card · Play-first entry deterministic + tested   leaderboard + archive    terminal = waitlist demo
                              same module client+server anonymous handles       executable stays private
```
