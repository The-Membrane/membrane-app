# Corroborated scrvUSD historical flow summary

Run `node scripts/research/scrvusd-corroborated-flow-summary.mjs` to inspect a
read-only summary of the full validated historical primary flow directory. The summary
exposes historical gross withdrawal and signed net depletion maxima for
complete 24-hour and 7-day windows only when every primary receipt has a valid
second-RPC sidecar. Missing, injected-transport, or malformed sidecars do not
produce maxima. The result retains the second-RPC audit and labels operator
independence `unverified`: distinct HTTPS hostnames are not proof of independent
infrastructure. The successful branch is labeled `research_only`,
`publishable: false`, and `forecastEligible: false`. Local SHA seals protect
against accidental file changes, but a file writer could replace both a sidecar
and its seal. The positive test deliberately demonstrates that trust boundary.

The `historical` field describes past scrvUSD vault Deposit/Withdraw events.
The `current` field remains unavailable. In particular, the archived window is
not joined to the live ledger and event flow cannot prove a holder could exit.
No number here is vault withdrawal capacity, a future exit duration, or a
public maximum flow claim. Those need a contiguous archive-to-live bridge,
provider ownership verification, current holder-executable route evidence, and
prospective outcome calibration.
