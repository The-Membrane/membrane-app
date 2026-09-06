# Sky sUSDS (Sky Savings USDS) — Venue Dossier

*This is an information inventory, not an assessment. The UNKNOWNS below are part of
the risk picture.*

## Header

- **Chain addresses** (from `tools/venue-recorder.config.json`):
  - sUSDS vault: `0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD`
  - underlying USDS: `0xdC035D45d973E3EC169d2276DDab16f1e407384F`
- **Kind**: `erc4626-cooldown` in config, but on-chain **`cooldownDuration()` does not
  exist** — that read fails gracefully every snapshot (`reads.cooldownDuration:false`).
  In practice this is a plain ERC-4626 savings vault with **no on-chain cooldown gate**.
- **Corpus coverage** (queried 2026-09-06):
  - `venue_snapshots`: **93 rows** (31 backfilled + 62 observed), span **2026-06-04 →
    2026-09-06**, blocks 25,246,000–25,915,809. Freshness: latest 2026-09-06. (1 snapshot
    had a failed `totalAssets` read; all others carry it.)
  - `venue_flows`: **71,027 rows** (37,663 `in` / 33,364 `out`), span 2026-06-04 →
    2026-09-06 — by far the highest throughput of the four venues.
  - `venue_events`: **0 rows**.
  - `venue_news`: **16 rows**, span 2024-09-20 → 2026-08-29 (verbatim headlines, not
    treated as fact).

---

## Q1 — What prices the exit, and how deep vs the carried book?

**UNKNOWN as a depth measurement.** The redemption path is USDS at NAV (see Q2/Q4),
so a patient exit is priced at the vault's USDS NAV, not a market quote.

- What we hold (`venue_snapshots`): last successful read (block 25,915,809,
  2026-09-06) `totalAssets` **4,657,255,899 USDS (~$4.66B)**, `totalSupply`
  **4,200,972,129 sUSDS** → NAV ≈ **1.109 USDS/sUSDS**.
- What we do **not** hold: the depth of the USDS↔USD (USDC etc.) market — including
  Sky's PSM / USDC swap capacity — that a holder unwilling to hold USDS itself would
  hit, relative to the carried book. **Fills with the rank-1 depth-vs-book roadmap
  ADD.** For a savings vault whose *own* exit is instant (Q2), the binding constraint
  is the liquidity of the underlying USDS, which we do not record.

---

## Q2 — Who can move the exit gate, how fast, with what notice?

**Chain fact:** no `cooldownDuration()` method — the read fails on every snapshot, so
there is **no on-chain cooldown gate on the vault itself**.

**Official-docs fact (fetched 2026-09-06):** sUSDS "balance grows automatically, is
fully liquid, and has no lockups or fees," and "can be moved back to USDS without fees
or lock-ups." Governance: "The rate is set by SKY governance token holders."
Source: `https://sky.money/susds`.

- The exit-relevant parameter Sky governance controls is the **Sky Savings Rate**
  (Q4), not a withdrawal gate. The vault redemption is not explicitly termed "instant"
  on the page but no waiting period is described.
- **UNKNOWN — executive-vote / timelock mechanics:** the fetched page does not
  describe the executive-vote or timelock process by which Sky governance changes
  parameters. `docs.sky.money/what-is-savings-rate` returned "Page Not Found" on the
  fetch, so we did not verify governance timing from the docs subdomain. Do not assume
  a specific timelock.
- **UNKNOWN — terms-page change history:** no terms-hash watcher (rank-3 roadmap ADD).
- Note: the *underlying* USDS↔USDC PSM and any Sky-governance-controlled parameters
  on that path are a separate gate we do not read here.

---

## Q3 — Backing self-reference / attestation status?

**Composition facts (our snapshots):** the vault holds USDS; NAV ≈ 1.109 (Q1). Over
our coverage `totalAssets` moved from **6,332,880,696 USDS (~$6.33B, 2026-06-04)** to
**~$4.66B (2026-09-06)** — a decline in staked USDS over the ~3-month span. Observed
fact; no conclusion drawn.

**Attestation — UNKNOWN.** The fetched official page states only that "every dollar of
its backing is verifiable in real-time via skyeco.com" — a real-time-verifiability
**claim**, not a stated attestation / proof-of-reserves program with a named auditor
and cadence. We did not fetch or verify skyeco.com. Source of the claim:
`https://sky.money/susds`. Whether a formal attestation program exists is UNKNOWN from
the official page checked.

- **UNKNOWN — USDS backing composition** (RWA / crypto / allocation): not stated on
  the page fetched; not read on-chain here.

---

## Q4 — Yield source, and does the rate move?

**We do not record APY. UNKNOWN as a measured number** (recorder captures capacity and
flows, not rate).

**Yield mechanism (official docs, fetched 2026-09-06):** "sUSDS yield is generated
through the Sky Savings Rate, which is backed by the Sky Agent Network and governed via
Sky Protocol." On variability: "The rate is variable and set by SKY governance token
holders, **not by market utilization or algorithmic adjustment**."
Source: `https://sky.money/susds`.

- So per the official source the rate is **variable but governance-set**, not
  market-driven. This is a distinct shape from a market-breathing rate (Ethena/Aave)
  and from a flat subsidy — a discretionary rate. We report the documented mechanism,
  not a measurement, and draw no conclusion about it.

---

## Q5 — Worst recorded exit day/week — did the gate hold?

From `venue_flows` (ERC-4626 `Withdraw`-event assets, $1/USDS; queried 2026-09-06).
Because sUSDS has **no cooldown**, the `Withdraw` event *is* a served exit — so unlike
sUSDe these figures are realized settlements, not initiations.

- **Worst single-day gross withdraw:** **2026-07-13 — $832.7M** (351 events). Next:
  2026-07-07 $664.0M (852 events), 2026-07-14 $662.7M (317 events).
- **Worst single-day net outflow:** 2026-07-13 **$477.4M**; then 2026-06-04 $305.1M,
  2026-06-16 $274.3M.
- **Worst rolling 7-day gross withdraw:** window ending **2026-07-16 — $3.754B**
  (adjacent: 07-19 $3.728B, 07-18 $3.711B).
- **Worst rolling 7-day net outflow:** ending **2026-07-13 — $801.2M**.

**Did the gate hold?** Evidence:
- There is **no gate parameter to move** on this vault (no cooldown), and we recorded
  **no `venue_events`** and no parameter change. The ~$3.75B one-week gross exit and
  ~$801M one-week net exit cleared as ordinary `Withdraw` events — i.e. the ERC-4626
  redemption path emitted served withdrawals throughout, against a book of ~$4.7–6.3B.
- **UNKNOWN — whether the underlying USDS liquidity (PSM / USDC) was ever strained**
  during these windows. The vault redemption to USDS is instant, but a holder who then
  needs actual USDC hits a path we do not record (Q1). We observe the vault emptied
  without a vault-level gate; we do not observe the depth behind USDS itself.

---

## UNKNOWNS (first-class — the blind spots are part of the picture)

- [ ] **Depth of the USDS exit market / PSM capacity vs the carried book** (Q1/Q5).
      Fills with the rank-1 depth-vs-book roadmap ADD.
- [ ] **Sky-governance timelock / executive-vote mechanics** for changing the Savings
      Rate or any exit-relevant parameter (Q2). `docs.sky.money` page 404'd on fetch.
- [ ] **Redemption-terms-page change history** (Q2). No terms-hash watcher.
- [ ] **Formal attestation / proof-of-reserves program and USDS backing composition**
      (Q3). Official page makes a real-time-verifiability claim only; no named auditor
      or cadence.
- [ ] **APY as a measured series** (Q4). Not recorded.
- [ ] **One snapshot with a failed `totalAssets` read** (header) — a transient RPC
      gap, not a state fact; noted for provenance.
