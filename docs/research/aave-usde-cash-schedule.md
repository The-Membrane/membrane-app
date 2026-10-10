# USDe sampled-cash prospective schedule

**Offline implementation, 2026-09-28. No manifest has been published and no live issue has been run.** The nine-cell cash study can only claim prospective operational coverage after a future schedule is persisted before its first slot. A random run ID proves that an invocation began; it cannot reveal an invocation that never happened.

## Operator flow

An upgrade from an earlier experimental publisher may encounter manifests without `publisher_xid`; the additive DDL deliberately fails its `NOT NULL` gate on those rows. Quarantine and review them before upgrading. Do not fill transaction IDs retrospectively or count those manifests as prospectively confirmed.

Choose the exact UTC `startAt` and `endAt` for an hourly schedule. The runner does not choose study dates. It accepts canonical timestamps with millisecond precision, such as `YYYY-MM-DDTHH:MM:SS.000Z`; the end is exclusive. The sealed manifest contains every expected hourly slot and all nine fixed `q/H` arms.

```text
node scripts/research/run-aave-usde-cash-ledger.mjs --publish-schedule START_UTC END_UTC
node scripts/research/run-aave-usde-cash-ledger.mjs --publish-schedule START_UTC END_UTC --apply
node scripts/research/run-aave-usde-cash-ledger.mjs --issue MANIFEST_SHA256
node scripts/research/run-aave-usde-cash-ledger.mjs --score
node scripts/research/run-aave-usde-cash-ledger.mjs --audit-schedule MANIFEST_SHA256
```

The first command is a **local-clock draft** and makes no database connection. Its slot count is illustrative; it is not a published manifest. `--apply` deliberately publishes through the dedicated database function using the database clock. The SQL function requires at least two hours of statement-time lead before the first slot and rejects overlapping windows. After that transaction commits, the runner calls `confirm_aave_usde_cash_manifest` in a **second transaction**, then performs an exact-payload readback. The confirmation function can see the manifest only after its first transaction commits; it records a distinct transaction ID and a database clock at least two hours before the first slot. `persisted_at` alone remains a statement clock, not COMMIT time. The immutable confirmation row provides database-level evidence of a pre-slot manifest COMMIT, subject to trust in the database owner and migration; it is not a cryptographic external timestamp. The database role must be a separately provisioned non-owner publisher, supplied only through `CASH_PUBLISHER_DATABASE_URL`. The runner rejects reuse of generic app database credentials and requires at least 1 GiB free on the repository volume for connected operations.

`--issue` requires the exact persisted manifest SHA. The runner loads and verifies the stored TEXT payload, table metadata, and post-COMMIT manifest confirmation before selecting the currently open slot by database time. The issue ledger verifies the full sealed manifest, publishes start/result attempt rows bound to its SHA and slot ID, and confirms the complete run in a separate transaction after result COMMIT. A bound issue reports `cohortEligible:true` only after that confirmation. If the confirmation fails, the attempt rows remain visible but the runner reports failure rather than claiming a prospective issue. A manual unbound issue remains research-only and cannot enter the scheduled cohort. Score runs process due issues; they do not create missed schedule slots.

The current enabled USDe config is checked for new publication and issuance. Scoring and auditing historical receipts continue from persisted evidence even if that config later changes or is disabled; otherwise a config change could silently erase due outcomes from the denominator.

`--audit-schedule` reads the exact persisted manifest, its confirmation, all related attempt rows, linked issue receipts, issue-run confirmations, and `asOf` from one repeatable-read, read-only database snapshot. Its first transaction statement captures `transaction_timestamp()` as `asOf` and establishes the read snapshot, so a slot cannot become due after the snapshot while a newly committed receipt remains invisible to it. The query is unpaginated and rejects a receipt timestamp later than `asOf`. It includes all rows bound to the manifest, rows using one of its slot IDs under another manifest, and unbound rows recorded inside its window. Conflicting or partial bindings fail the audit. Unbound runs and arm receipts are disclosed as `unboundResearchOnly` and excluded from scheduled coverage. The pure auditor reports missed invocations, unfinished arms, retries, abstentions, failures, duplicates, and issued arms; missing confirmations remain operational evidence but cannot qualify as prospective issuance. The JSON query label means the adapter requested a complete snapshot; it is not an independent database or chain attestation.

An issued result must also resolve to its immutable issue receipt with matching `q/H` and valid issue/persistence times. These are operational denominator checks. They do not show executable withdrawal capacity, exit duration, forecasting calibration, or large-dataset predictive accuracy. Those claims need later observed outcomes, complete flow histories, route evidence, and holdout analysis.
