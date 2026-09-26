# Practice Mode — design memo (layer 6, "belts and deliberate practice")

Status: design, 2026-09-25. Owner default: memo first, then a v1 that replays the
Oct-10 crossing. Execution stays backlogged, so practice never signs anything.

## The point

A borrower who has already lived through a crossing inside Membrane thinks in its
terms: the line, the 4% band, the 8-hour window, the repay that restores the borrow
line. Practice makes that happen before real money is at stake. Switching away later
means relearning how liquidation feels.

Everything shown is measured. The price path is the recorded Oct-10 1-minute series.
The rules are the same engine that produces the landing's numbers. The comparison is
what the real liquidators took. Nothing in practice is invented.

## What already exists (reuse, don't rebuild)

| Piece | Where | Role in practice |
|---|---|---|
| 1-minute Oct-10 prices (ETH, BTC, wstETH, USDe…) | `public/data/oct10-2025/` via `loadOct10()` / `buildPricePath()` (`lib/position-sim/scenario.ts`) | the tape the reader trades against |
| Delay state machine | `DelayTimer` (`lib/position-sim/curePath.ts:147`): none / arm / hold / save / sell(band\|expiry) | classifies every minute exactly as the contract would |
| Walk with repay-to-borrow-line | `cureWalk()` (`curePath.ts:278`) | the "do nothing" baseline and the "Membrane alone" outcome |
| Constants | `CURE_WINDOW_SECONDS`, `BORROW_LTV_GAP`, band (`lib/position-sim/membrane.ts`) | same numbers as the landing guarantee |
| Real liquidation outcome | `replayEpisode()` (`lib/position-sim/history.ts:211`), Oct-10 evidence | the "what Aave did" line |

## v1 — one scenario, three decisions

1. **Setup (10 s).** Pick collateral (ETH, BTC, wstETH) and an opening LTV, from
   presets that cross on Oct-10 (e.g. 2 pp under the line). The screen shows the
   line, the band and the borrow line on one gauge.
2. **The tape runs.** The Oct-10 path plays at about 1 simulated hour per 5 s. It
   pauses automatically at three moments the timer classifies:
   - **arm**: you just crossed the line. The 8h clock starts.
   - **mid-window**: halfway through, still over the line.
   - **band approach**: within 1 pp of line × (1 + band).
3. **At each pause, choose one:** add collateral (+10% / +25%), repay debt
   (to the borrow line / half-way), or hold. Choices apply to the walked position,
   and the engine re-classifies from that minute.
4. **Result card.** Three columns, same position and same tape:
   - **you**: collateral kept after your choices
   - **Membrane, no action**: `cureWalk()` with no intervention
   - **the real liquidators**: what Aave-style liquidation took (from the Oct-10 evidence for that asset/LTV)
   Plus the minute-by-minute strip showing where each of your choices landed.

**Scoring is collateral kept, in USD and %,** against the no-action Membrane line.
There is no points system. A choice that did nothing is shown as doing nothing.

## Belts (v2, after v1 ships)

A belt is earned by a measured result on a harder tape, never by time spent.

| Belt | Tape | Earned when |
|---|---|---|
| White | Oct-10 ETH, gentle preset | finish with no sale |
| Yellow | Oct-10 wstETH (wrap-rate path) | finish with ≤ one band sale |
| Green | a corpus episode that broke through the band | beat "Membrane, no action" |
| Black | a random corpus episode, blind (asset and date hidden until the end) | beat no-action on 3 in a row |

Green and black draw from `public/data/liquidation-corpus.json` episodes that have
price rounds, so every tape is a real episode. Belts store per wallet or browser;
nothing is on-chain.

## Build plan (v1)

- `lib/practice/engine.ts` (pure): `step(state, minute) → {state, pause?}` built on
  `DelayTimer`; `apply(state, choice)`; `score(state)`. Unit-tested against
  `cureWalk()`: with no choices, practice must equal `cureWalk()` exactly.
- `components/Practice/*`: gauge, tape, pause sheet, result card. Brand: Living
  Typeface; numbers in mono; no confetti.
- Route `/[chain]/practice`, linked from the simulator's result ("practice this
  crossing"). Indexable.
- Copy: every number from the engine; the result card names the tape and its source.

## Open questions (owner, not blocking v1)

- Should belts show publicly (a shareable card per belt), which would tie into layer 1?
- Should practice pull the reader's own asset/LTV from a scanned wallet, so the
  tape is "your position on Oct-10"? That's the strongest version, but it reads
  wallet data into a game.

## Noticed while designing (not practice scope)

`lib/position-sim/guarantee.ts` `GUARANTEE.noDials` says LTV moves "on a 14 day
notice, at a max of N% per window". The comment directly above it, and the
2026-09-21 parity audit, say there is no per-change cap and no 14-day delay on LTV
today. One of them is wrong. Nothing renders `noDials` today, so it is not live;
it must be corrected before anything does.
