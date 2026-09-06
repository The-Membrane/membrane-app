# Aave V3 USDe reserve (aEthUSDe) — Venue Dossier

*This is an information inventory, not an assessment. The UNKNOWNS below are part of
the risk picture.*

## Header

- **Chain addresses** (from `tools/venue-recorder.config.json` and
  `scripts/record-venue-flows.mjs`):
  - aToken aEthUSDe: `0x4F5923Fc5FD4a93352581b38B7cD26943012DECF`
  - underlying USDe: `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3`
  - Aave V3 Pool (flow source, reserve-filtered): `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`
  - (Reserve verified on-chain 2026-09-02: `Pool.getReserveData(USDe)` → this aToken,
    which answers `symbol()='aEthUSDe'` and `UNDERLYING_ASSET_ADDRESS()=USDe`.)
- **Kind**: `atoken-liquidity` — instant liquidity = `USDe.balanceOf(aToken)`, valued
  at $1/stable (assumption **recorded**, not silent).
- **Corpus coverage** (queried 2026-09-06):
  - `venue_snapshots`: **93 rows** (31 backfilled + 62 observed), span **2026-06-04 →
    2026-09-06**, blocks 25,246,000–25,915,505. Freshness: latest 2026-09-06.
  - `venue_flows`: **2,924 rows** (1,310 `in` = `Supply` / 1,614 `out` = `Withdraw`),
    span 2026-06-04 → 2026-09-06.
  - `venue_events`: **0 rows**.
  - `venue_news`: **25 rows**, span 2023-04-24 → 2026-08-28 (verbatim headlines, not
    treated as fact).

---

## Q1 — What prices the exit, and how deep vs the carried book?

**Partly measured, partly UNKNOWN.** This is the one venue where we record an instant
exit-liquidity number.

- **Measured (our snapshots):** `instant_usd = USDe.balanceOf(aToken)` = the
  unborrowed underlying available to withdraw right now. Latest (block 25,915,505,
  2026-09-06): **$360.35M**. Earliest in coverage (2026-06-04): **$144.68M**. So
  recorded instant liquidity has grown over the span.
- **Pricing (official docs, fetched 2026-09-06):** "Each reserve within the Aave
  Protocol is associated with an oracle contract... responsible for reporting the
  market price of assets," oracle sources "selected through Aave Governance," with two
  named production types — "Chainlink Price Feeds" and the "Correlated Assets Price
  Oracle (CAPO)."
  Source: `https://aave.com/docs/ecosystem/oracle`.
- **UNKNOWN — the specific USDe oracle feed** for this reserve. The docs describe the
  Aave Oracle mechanism generally but do not state which feed prices USDe; we did not
  read the reserve's oracle source on-chain. This matters because the historical record
  (`worst-carry-venues.md` P1) turns on *what* prices the asset — Aave's USDe=USDT
  hardcode is credited with preventing the Oct-2025 Binance cascade from reaching
  on-chain borrowers, but **we have not verified the current feed**, so do not assume it.
- **UNKNOWN — utilization vs book size.** We record instant liquidity but **not
  utilization** (rank-2 roadmap ADD). Withdrawal is capped by unborrowed liquidity
  (Q2); how close utilization ran to 100% during stress is not in our corpus.

---

## Q2 — Who can move the exit gate, how fast, with what notice?

**Official-docs facts (fetched 2026-09-06):**

- **The exit is liquidity-gated, not time-gated:** "Withdrawing redeems aTokens for the
  underlying asset... subject to available unborrowed liquidity and the
  collateralization of any active borrow positions."
  Source: `https://aave.com/docs/aave-v3/overview`.
- **Admin controls that can gate a reserve** (ACLManager): the `EMERGENCY_ADMIN` role
  "can pause and unpause the pool or an individual reserve"; `RISK_ADMIN` can
  "freeze/unfreeze" a reserve; role admins are "specified by Aave Governance," and "all
  instances of the POOL_ADMIN role... are now governed by the Guardians multisig or by
  the Governance Bridge executors."
  Source: `https://aave.com/docs/aave-v3/smart-contracts/acl-manager`.

So there are **two distinct gates**: (1) an automatic, market-driven one — you cannot
withdraw more than the unborrowed liquidity (this is the utilization constraint in Q1);
and (2) an administrative pause/freeze that a Guardian multisig / governance-controlled
role can invoke.

- **UNKNOWN — the speed and notice of an admin pause/freeze** for *this* reserve: the
  Guardian multisig can act quickly by design, but we have not verified the specific
  multisig, its threshold, or any timelock/notice on a USDe-reserve freeze. Do not
  assume a notice period.
- **UNKNOWN — terms/parameter change history** for the reserve (caps, reserve factor,
  freeze status over time): no terms-hash watcher (rank-3 roadmap ADD); we hold no
  `venue_events` for this venue.

---

## Q3 — Backing self-reference / attestation status?

**Not directly applicable in the vault sense** — aEthUSDe is a 1:1 claim on supplied
USDe in the Aave pool, not a wrapper with its own NAV. The relevant "backing" questions
are (a) the USDe underlying's backing — see the sUSDe/Ethena dossier (`susde.md` Q3:
delta-hedged basis at custodians, monthly custodian attestations, attestor UNKNOWN) —
and (b) the pool's solvency, which depends on the oracle (Q1) and liquidations.

- **Composition fact (our snapshots):** the aToken's unborrowed USDe balance is what we
  record (Q1); we do **not** record total supplied, total borrowed, or utilization for
  the reserve. So we cannot state the reserve's full balance sheet from our corpus.
- **Attestation — UNKNOWN** at the Aave-reserve level; the underlying-asset attestation
  question is answered (and bounded) in `susde.md`.

---

## Q4 — Yield source, and does the rate move?

**We do not record APY. UNKNOWN as a measured number.**

**Rate mechanism (official docs, fetched 2026-09-06):** "Interest rates adjust with
utilization. v3 uses an interest rate model based on two slopes with an optimal
utilization point... Supplier yields are funded by borrower interest net of the reserve
factor."
Sources: `https://aave.com/docs/aave-v3/overview`,
`https://aave.com/docs/aave-v3/concepts/reserve`.

- So the supply rate is **utilization-driven and variable** — it moves with markets by
  construction (the clearest market-breathing shape of the four venues). Reported as
  documented mechanism, not a measurement.
- **UNKNOWN — the reserve's specific interest-rate-model parameters** (slopes, optimal
  utilization, reserve factor) and their change history; not read here.

---

## Q5 — Worst recorded exit day/week — did the gate hold?

From `venue_flows` (Aave V3 `Pool.Withdraw` on the USDe reserve, $1/USDe; queried
2026-09-06). `Withdraw` here is a served supplier exit.

- **Worst single-day gross withdraw:** **2026-07-10 — $53.19M** (24 events). Next:
  2026-08-28 $43.18M (30 events), 2026-08-25 $34.67M (27 events).
- **Worst single-day net outflow** (withdraw − supply): 2026-08-28 **$41.93M**; then
  2026-08-25 $26.33M, 2026-08-18 $20.15M.
- **Worst rolling 7-day gross withdraw:** window ending **2026-08-29 — $111.41M**
  (adjacent: 08-30 $111.36M, 07-13 $108.81M).
- **Worst rolling 7-day net outflow:** ending **2026-08-29 — $82.38M**.

**Did the gate hold?** Evidence:
- The worst single-day net outflow (~$41.9M, 2026-08-28) and worst 7-day net outflow
  (~$82.4M, ending 2026-08-29) are **below the instant liquidity we recorded**
  (~$360M latest; ~$145M even at the start of coverage). At the snapshot cadence we
  observe, realized outflow did not approach recorded unborrowed liquidity, and we
  recorded **no admin pause/freeze event** (`venue_events` = 0).
- **UNKNOWN — intra-window utilization.** We snapshot instant liquidity roughly hourly;
  we do **not** record utilization continuously (rank-2 roadmap ADD). We cannot rule
  out that unborrowed liquidity was momentarily exhausted between snapshots and
  refilled — the liquidity gate (Q2) could bind transiently without appearing in our
  data. "The gate held" is supported only at snapshot granularity, not continuously.

---

## UNKNOWNS (first-class — the blind spots are part of the picture)

- [ ] **The specific USDe oracle feed** for this reserve (Q1). Would fill via an
      on-chain read of the reserve's oracle source, or an official parameter page.
- [ ] **Reserve utilization vs book size**, continuously (Q1/Q5). Fills with the
      rank-2 utilization roadmap ADD — the historically second-ranked warning signal.
- [ ] **Speed / notice / multisig identity of an admin pause or freeze** on the USDe
      reserve (Q2). Docs state the roles exist; the timing and controllers are not
      verified.
- [ ] **Reserve parameter change history** (caps, reserve factor, freeze) (Q2/Q4). No
      terms-hash watcher; no `venue_events` recorded.
- [ ] **Full reserve balance sheet** — total supplied / borrowed / utilization (Q3).
      We record only the aToken's unborrowed underlying balance.
- [ ] **APY and interest-rate-model parameters as measured series** (Q4). Not recorded.
- [ ] **USDe underlying backing/attestation** — bounded in `susde.md` Q3, not
      re-derived here (attestor firm remains UNKNOWN there).
