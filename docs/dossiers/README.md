# Venue Dossiers

**This is an information inventory, not an assessment. The UNKNOWNS in each dossier
are part of the risk picture.**

## What a dossier is (and is not)

Owner ruling: *"our job isn't to co-sign venues, it's to provide info."* A dossier
**inventories evidence about a venue; it never reaches a conclusion.** You will find
no scores, no rankings, and no "safe / risky / recommended" vocabulary anywhere in
these files — by design. If those words appear, the file is broken.

Every line in a dossier is one of two things:

1. **Evidence**, with a source you can re-check:
   - a chain fact (contract address + method read), or
   - a number from our own corpus (which table, what query, actual values), or
   - an official-docs fact (a URL we fetched and quote from).
2. An explicit **UNKNOWN** — a question we cannot answer from evidence we hold.

The UNKNOWNS list is **first-class**: it sits at the same prominence as the facts,
because the historical record (see `docs/research/worst-carry-venues.md`) is blunt
that the losses came from the things nobody was measuring — self-referential
backing, gates that moved mid-crisis, oracle depth nobody had charted. A dossier
that hides its blind spots would misrepresent the risk.

## The five questions (from `worst-carry-venues.md` §5)

Each venue file answers these, with evidence or UNKNOWN, in this order:

1. **What prices this asset where exits happen, and how deep is that market vs the
   carried book?** (pattern P1/P4 — the single largest predictor of carry loss)
2. **Who can move the exit gate, how fast, with what notice?** (P2 — "the gate
   moves, or was never there")
3. **Does the backing reference itself or an unattested off-chain book? Who has
   attested it, when?** (P3 — self-referential / opaque composition)
4. **Is the yield's source identified, and does the rate move with markets?** (P7 —
   "yield that doesn't move is a subsidy or a fiction")
5. **What did the worst recorded exit day/week look like, and did the gate hold?**
   (our corpus)

Plus a **header block**: chain addresses (from `tools/venue-recorder.config.json`),
our corpus coverage (row counts, span, freshness), and the standing line above.

## Sources of evidence

| Source | Where it comes from | What it can and cannot say |
|---|---|---|
| **Chain facts** | addresses + reads in `tools/venue-recorder.config.json`, ABIs in `scripts/lib/venue-reads.mjs` | what a contract *is* and what a method *returned* at a block |
| **Our corpus** | Neon tables `venue_snapshots`, `venue_flows`, `venue_events`, `venue_news` (DDL: `scripts/apply-venue-recorder-ddl.mjs`) | capacity we observed and flows that actually moved — **not** APY, **not** the instant-vs-queued split, **not** depth-vs-book |
| **Official docs** | only the protocol's own documentation, fetched and quoted with a URL | stated design and governance — **not** proof it is enforced on-chain |

**What the corpus does NOT record today** (recorder roadmap, `worst-carry-venues.md`
§3, ranked by historical incident count): oracle-market **depth vs book size**
(rank 1), lending **utilization** (rank 2), a redemption-**terms-page hash watcher**
(rank 3), and **APY**. Wherever a question needs one of these, the answer is UNKNOWN
and the dossier names which roadmap item would fill it.

### A note on flow semantics (read before trusting question 5)

`venue_flows` decodes the ERC-4626 `Withdraw` event (direction `out`) and `Deposit`
(`in`) for the savings vaults, and Aave V3 `Pool.Withdraw` / `Supply` (filtered to
the reserve) for the aToken venue — see `scripts/record-venue-flows.mjs`. For a
vault with **no cooldown** (sUSDS, scrvUSD) the `Withdraw` event *is* a served exit.
For a **cooldown vault** (sUSDe) the `Withdraw` event marks funds *entering* cooldown
(moved to the silo), not final settlement — so our "out" flow is withdrawals
**initiated**, and the instant-vs-cooling-vs-served split is UNKNOWN. All four
underlyings are treated as 18-decimal $1 stables (`priceAssumptionUsd = 1`, recorded,
not silent); dollar figures inherit that assumption.

## Update cadence

The corpus is **live** — the recorder ticks hourly (`record-venue-liquidity.mjs`,
`record-venue-flows.mjs`) and backfills history (`backfill-venue-history.mjs`). Every
number in a dossier is therefore **date-stamped to when it was queried**, and worst-day
figures can only grow as history accumulates. Re-run the corpus queries before relying
on any figure; treat an undated number as stale.

## Template for a new venue

Create `docs/dossiers/<venue>.md` with this skeleton. Fill each section with evidence
(cite the source inline) or write `UNKNOWN` and say what would resolve it.

```markdown
# <Venue> — Venue Dossier

*This is an information inventory, not an assessment. The UNKNOWNS below are part of
the risk picture.*

## Header
- **Chain addresses** (from tools/venue-recorder.config.json): <vault>, <underlying>, <aux>
- **Corpus coverage**: snapshots N (span, freshness), flows N (span), events N, news N
- **Kind**: <erc4626-cooldown | atoken-liquidity>

## Q1 — What prices the exit, and how deep vs the book?
## Q2 — Who can move the exit gate, how fast, what notice?
## Q3 — Backing self-reference / attestation status?
## Q4 — Yield source, and does the rate move?
## Q5 — Worst recorded exit day/week — did the gate hold?

## UNKNOWNS (first-class — the blind spots are part of the picture)
- [ ] ... (name the roadmap item or lookup that would resolve each)
```

Rules that do not bend:
- No scores, no rankings, no "safe/risky/recommended/healthy/concerning" vocabulary.
- Every fact carries its source (address+method, table+numbers, or URL).
- If it isn't verified from one careful official-docs lookup or from our own data,
  it is UNKNOWN — do not fill the gap with training knowledge.
- Date-stamp corpus numbers. The corpus is live.

## Files

| File | Venue | Kind |
|---|---|---|
| `susde.md` | Ethena sUSDe (Staked USDe) | erc4626-cooldown |
| `susds.md` | Sky sUSDS (Sky Savings USDS) | erc4626 (no cooldown) |
| `scrvusd.md` | Curve scrvUSD (Savings crvUSD) | erc4626 (no cooldown) |
| `aave-v3-usde.md` | Aave V3 USDe reserve (aEthUSDe) | atoken-liquidity |
