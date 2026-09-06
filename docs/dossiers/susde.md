# Ethena sUSDe (Staked USDe) — Venue Dossier

*This is an information inventory, not an assessment. The UNKNOWNS below are part of
the risk picture.*

## Header

- **Chain addresses** (from `tools/venue-recorder.config.json`):
  - sUSDe vault: `0x9D39A5DE30e57443BfF2A8307A4256c8797A3497`
  - underlying USDe: `0x4c9EDD5852cd905f086C759E8383e09bff1E68B3`
  - cooldown silo (read on-chain via `silo()`): `0x7FC7c91D556B400AFa565013E3F32055a0713425`
- **Kind**: `erc4626-cooldown`
- **Corpus coverage** (queried 2026-09-06):
  - `venue_snapshots`: **198 rows** (134 backfilled + 64 observed), span **2025-07-26 → 2026-09-06**, blocks 23,000,000–25,915,809. Freshness: latest snapshot 2026-09-06.
  - `venue_flows`: **51,938 rows** (34,258 `in` / 17,680 `out`), span 2025-07-26 → 2026-09-06.
  - `venue_events`: **0 rows** (see Q2 — the cooldown change is captured in snapshots, not as an event row).
  - `venue_news`: **25 rows**, span 2023-12-17 → 2026-09-02 (external headlines, verbatim, no sentiment — not treated as fact here).

---

## Q1 — What prices the exit, and how deep vs the carried book?

**UNKNOWN — this is the biggest blind spot for this venue.** Our corpus records the
vault's aggregate state, not the market that prices an exit.

- What we *do* hold: `totalAssets` and `totalSupply` from `venue_snapshots`. Latest
  (block 25,915,809, 2026-09-06): totalAssets **1,403,898,694 USDe (~$1.40B)**,
  totalSupply **1,126,070,916 sUSDe** → NAV ≈ **1.247 USDe/sUSDe**. The redemption
  path is USDe (1:1 by protocol design — see Q4/Q2), so the "exit price" for a
  patient holder is the vault's NAV in USDe, not a secondary-market quote.
- What we do **not** hold: the depth of the USDe↔USD (USDT/USDC) market where a
  holder who will not wait out the cooldown must sell, relative to the size of the
  carried book. The historical pattern that most predicts carry loss
  (`worst-carry-venues.md` P1/P4) is exactly this depth-vs-book ratio, and the
  recorder does not record it yet. **Roadmap item that fills this: the depth-vs-book
  snapshot ("what prices this collateral and how deep is it"), rank-1 ADD in
  `worst-carry-venues.md` §3.**
- The Oct-2025 record (`worst-carry-venues.md`, Ethena/Binance row) is that USDe
  traded $0.60–0.68 **on Binance only** while on-chain deviation stayed <30bps —
  i.e. the venue where the exit is priced matters enormously. We do not measure it.

---

## Q2 — Who can move the exit gate, how fast, with what notice?

**Chain fact (contract read):** `cooldownDuration()` is a settable `uint24`. Our
snapshots show it took two distinct values over our coverage:

| cooldownDuration | first seen in our snapshots |
|---|---|
| 604800 s (**7 days**) | 2025-07-26 (start of coverage) |
| 86400 s (**1 day**) | **2026-03-18 13:54:47 UTC** |

This is **our recorded observation** that the gate moved 7d → 1d, dated 2026-03-18,
derived from consecutive `venue_snapshots.params.cooldownDuration`. (It is not in
`venue_events`, which has 0 rows for this venue; the transition is visible only in
the snapshot series.)

**Official-docs fact (fetched 2026-09-06):** the role `DEFAULT_ADMIN_ROLE` "can set
`setCooldownDuration`, up to a maximum value of 90 days," and "the cooldown is
dynamic (currently between 1 and 7 days) depending on reserve conditions; the current
parameters are set by governance."
Sources: `https://docs.ethena.fi/technical-design/staking-usde/staking-key-functions`,
`https://docs.ethena.fi/video-guides/how-to-stake-usde`.

- So the ceiling on the gate is **90 days**, code-enforced per the docs.
- **UNKNOWN — governance timelock / advance notice:** the fetched docs state *who*
  can change it (admin role, "set by governance") but **do not state any timelock or
  advance-notice period** before a `setCooldownDuration` change takes effect. We have
  not verified an on-chain timelock on the admin role. Do not assume there is one.
- **UNKNOWN — terms-page change history:** we run no terms-page hash watcher
  (rank-3 roadmap ADD), so we cannot say whether redemption terms were edited
  around any date. In the historical record this is precisely how USD0++ surprised
  holders (`worst-carry-venues.md`).

---

## Q3 — Backing self-reference / attestation status?

**Composition facts we can verify (our snapshots):** the vault holds USDe; NAV in
USDe is ~1.247 (Q1). Over our coverage, snapshot `totalAssets` moved from
**4,151,194,692 USDe (~$4.15B, 2025-07-26)** to **~$1.40B (2026-09-06)** — a ~66%
decline in staked USDe over ~13.5 months. That is a size/redemption fact we observed;
we draw no conclusion from it.

**Backing of the underlying USDe:** the sUSDe vault is a wrapper; USDe's backing is a
delta-hedged basis position (see Q4), i.e. it references off-chain derivatives
positions held at custodians — **not** self-referential to Ethena's own token, and
**not** fully on-chain-verifiable from these reads.

**Attestation (official docs, fetched 2026-09-06):** "Monthly attestations are
completed with the custodians to validate the existence, control, and value of the
backing assets of USDe." Cadence = **monthly**.
Source: `https://docs.ethena.fi/resources/custodian-attestations`.

- **UNKNOWN — attestor identity:** the fetched page does not name the attesting firm
  (it points to a Transparency dashboard for detail, which we did not fetch). We do
  not assert who performs the attestation or verify any individual attestation.

---

## Q4 — Yield source, and does the rate move?

**We do not record APY. UNKNOWN as a measured number** — the recorder captures
capacity and flows, not rate. (Not on the ranked ADD list; derivable in principle
from NAV drift between snapshots, which we have not computed here.)

**Yield mechanism (official docs, fetched 2026-09-06):** revenue comes from "(1)
Staked ETH assets receiving consensus and execution layer rewards, (2) rewards earned
from liquid stable backing assets, (3) the funding and basis spread from the delta
hedging derivatives positions." The docs state it is variable: "Revenue from staked
assets is floating by nature," and the funding/basis spread "will vary considerably
(even day to day)."
Sources: `https://docs.ethena.fi/solution-overview/usde-overview`,
`https://docs.ethena.fi/protocol-overview/rewards-mechanism`.

So per the official source the rate **does move** with markets (funding rates,
staking yield) — the opposite of the flat-subsidy shape flagged in
`worst-carry-venues.md` P7. We report this as the documented mechanism, not as a
measurement.

---

## Q5 — Worst recorded exit day/week — did the gate hold?

From `venue_flows` (ERC-4626 `Withdraw`-event assets, $1/USDe; queried 2026-09-06).
**Read the flow-semantics caveat below before interpreting these.**

- **Worst single-day gross withdraw-initiations:** **2025-08-05 — $716.9M** across
  only 12 events (a handful of very large redemptions). Next: 2026-04-20 $376.9M
  (384 events), 2026-04-21 $303.7M (333 events).
- **Worst single-day net outflow** (out − in): 2025-08-05 **$450.5M**; then
  2026-04-20 $376.9M, 2026-04-22 $288.3M.
- **Worst rolling 7-day gross withdraw-initiations:** window ending **2026-04-25 —
  $1.478B** (adjacent windows ending 04-24 $1.472B, 04-23 $1.356B).
- **Worst rolling 7-day net outflow:** ending **2026-04-25 — $1.359B**.

**Did the gate hold?** What we can say from evidence:
- The cooldown parameter did **not** change during the worst window: by April 2026
  `cooldownDuration` was already **1 day** (it changed on 2026-03-18, Q2) and our
  snapshots show it stable at 86400 across that period. The 2025-08-05 spike occurred
  while the cooldown was **7 days**. We recorded no gate change *during* either event.
- **UNKNOWN — whether the gate "held" in the sense of serving withdrawers:** our
  "out" flow for a cooldown vault records withdrawals **entering cooldown** (funds
  moved to the silo `0x7FC7…3425`), **not** final settlement. We do not observe the
  instant-vs-cooling-vs-served split (the recorder explicitly refuses to fabricate it
  — `scripts/lib/venue-reads.mjs`, `instant_note`). So we cannot state that every
  initiated withdrawal was ultimately paid, only that the parameter was not moved
  against holders mid-flight in our record.

---

## UNKNOWNS (first-class — the blind spots are part of the picture)

- [ ] **Depth of the USDe exit market vs the carried book** (Q1). Fills with the
      rank-1 roadmap ADD (depth-vs-book snapshot).
- [ ] **Governance timelock / advance notice on `setCooldownDuration`** (Q2). Docs
      state who can change it and the 90-day ceiling, but no notice period; not
      verified on-chain. Would fill via a careful on-chain read of the admin role /
      any timelock contract, or an official governance-process page.
- [ ] **Redemption-terms-page change history** (Q2). No terms-hash watcher (rank-3
      roadmap ADD).
- [ ] **Attesting firm identity and per-attestation content** (Q3). Docs state
      monthly custodian attestations but do not name the firm on the page fetched.
- [ ] **APY as a measured series** (Q4). Not recorded; derivable from NAV drift, not
      computed here.
- [ ] **Instant-vs-cooling-vs-served split of recorded outflows** (Q5). Not derivable
      from aggregate reads by design.
