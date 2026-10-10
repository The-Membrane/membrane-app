# scrvUSD v2 NOW slot runner

`scripts/research/scrvusd-now-slot-runner.mjs` is an opt-in research command. It is not wired into launchd or the existing v1 recorder tick. It requires a previously published and confirmed future manifest and an audited dedicated PostgreSQL publisher connection with both the schedule and attempt migrations installed.

```text
SCRVUSD_SCHEDULE_PUBLISHER_DATABASE_URL=... \
  node scripts/research/scrvusd-now-slot-runner.mjs <manifest-sha256> <slot-id>
```

The supplied slot must be open when called. For each of the fixed 1h, 2h, 24h, and 7d arms, the runner persists exact newline-terminated local start bytes under the 1 GiB disk reserve and commits the corresponding server-timed DB start. It then requires the adapter's distinct-transaction four-start confirmation and committed capture-floor readback **before** invoking quote, target-code attestation, fixed-holder observation, and holder-duration issuance. Optional historical flow context follows; absence is left absent. A missed slot, partial start, missing floor, or closed slot never becomes a synthetic successful run.

The default source stages require a newly `recorded` quote, an `attested` target, a completed fixed-holder probe, and an `issued` duration receipt. The holder ledger keeps `success`, `revert`, and `provider_error` as distinct observations. The v2 NOW-origin issue enrolls only a current sampled-success risk set: revert and provider-error probes cause duration issuance to return `unavailable`, so the arm is recorded as an abstention rather than silently disappearing or becoming a future failure. For each arm, the runner reloads verified as-of source rows, rejects quote/holder/attestation capture starts and duration/flow issue times before the DB floor, builds the fixed holder/1,000 crvUSD direct-withdrawal v2 receipt, persists exact bytes, and records an issued DB result. Source and verification failures record `abstained` or `failed` results if the slot remains open. A result write failure or elapsed slot leaves the run unconfirmed; only four committed results can receive the separate run confirmation.

The DB timestamps establish ordered database events. Quote, holder, and attestation `captureStartUtc` fields are **local self-reported times**, so comparing them with the DB floor does not independently prove the RPC reads began after that floor. The durable v2 verifier must check exact retained bytes and fresh DB linkage. Even a fully confirmed operational run is research evidence, not an executable withdrawal guarantee, calibrated probability, alert, or likely duration. No live PostgreSQL execution or future-slot run has been performed.
