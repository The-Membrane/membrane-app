# Aave USDe v2 recorder ledger

The additive migration in `scripts/apply-aave-usde-first-breach-recorder-ddl.mjs`
is **dormant**. It does not modify the v1 issue, score, publisher or running
recorder. Apply only with a distinct owner credential through
`AAVE_USDE_V2_RECORDER_MIGRATION_DATABASE_URL=… node scripts/apply-aave-usde-first-breach-recorder-ddl.mjs --apply`.
No live database execution has been performed. The SQL-shape tests do not prove
PostgreSQL compatibility or a successful cutover.
The migration is intentionally one shot: an existing table causes it to fail
instead of silently accepting a drifted schema.

## Transaction order

```text
publish exact v2 issue schedule bytes → COMMIT
confirm issue schedule              → COMMIT
publish exact coverage bytes/slots  → COMMIT
confirm coverage                    → COMMIT
start recorder slot                 → COMMIT before RPC
RPC/read result                     → finish failure/skip OR atomic success
atomic success = atomic snapshot insert + returned ID + terminal row, one DB transaction
```

The publisher reconstructs the canonical JS schedule and coverage byte strings
and every hourly slot in SQL, then hashes the exact UTF-8 bytes. It validates
the fixed nine issue arms, v2 study, cadence and aligned bounded windows. A
published issue schedule is limited to 23 days 16 hours so its last 7-day arm
and 8-hour outcome witness fit inside a maximum 31-day coverage manifest. The
coverage publisher requires that full future window before accepting a plan.
The pure issue builder uses the same shorter bound. A separate confirmation
transaction makes the stored schedule or coverage manifest visible before its
first slot. The issue calendar has an overlap exclusion. Coverage manifests
may overlap because an ending issue calendar retains its longest outcome window
while the next calendar begins. Each coverage manifest has a membership row for
each hourly slot; the physical recorder start and terminal are keyed by the
global venue/hour slot ID. One successful snapshot can therefore be joined to
both overlapping manifests through their membership rows, with one RPC and one
atomic insert. Recorder starts require a confirmed manifest containing that
database generated slot. The
recorder must commit that start before contacting RPC; a same-transaction
terminal is rejected by transaction ID. A terminal must name the same manifest
used for its start; other overlapping manifests consume the shared physical
slot receipt through membership rather than relabeling its provenance.

The success function calls `ingest_venue_snapshot_atomic_v1` itself, requires
`status='inserted'`, validates its returned snapshot ID and observed Aave USDe
identity, and inserts the terminal row in the same transaction. Any conflict,
skip, stale source or error aborts that transaction. A separate non-success
terminal function records skip, read failure, insert failure or missed status;
it cannot claim success. Late non-success terminals remain visible for audit.
An additive `BEFORE INSERT` trigger sets `created_at=observed_at` for new
marked Aave USDe rows. The existing atomic function captures observation with
`clock_timestamp()`, whereas the table's default `created_at=now()` is the
earlier transaction start. Without this correction, the hourly auditor would
reject genuine success rows. The trigger runs before the existing USDe
first-seen time check; updating the row after insert would violate the
append-only snapshot guard.
Tables are append only through triggers, keys and unique constraints. The
database allows only one physical start and terminal per venue/hour slot. The
runtime role must have function `EXECUTE` only and **no direct DML** on these
tables or `venue_snapshots`; grant it explicit calls after an ownership/ACL
audit. The success wrapper's owner needs rights to call the existing
security-invoker atomic ingest and insert its snapshot/events. Because that
existing function uses unqualified venue tables, the wrapper searches
`pg_catalog,public,pg_temp` with temporary relations last; verify untrusted
roles cannot `CREATE` in `public` before granting the wrapper. Do not grant
`PUBLIC` execution. The migration revokes default `PUBLIC` privileges but
does not create or grant a runtime role. The runner obtains the latest marked
predecessor through the narrow `aave_usde_v2_atomic_predecessor()` function;
it does not need direct `SELECT` on `venue_snapshots`.

## Limits and next integration

This is an unexecuted migration, not a recorder cutover. Before use, run it in
a disposable PostgreSQL instance with the existing venue schema and atomic
function, exercise transaction boundaries and rollbacks, audit ownership and
grants, then connect the hourly recorder to these functions and separately
persist the v2 issue and score ledger. A schedule may be confirmed only before
its first slot; a missed start remains missing. Snapshot insertion may still
be rejected by the atomic recorder's existing recent-row and predecessor
rules. This ledger can show an attempted slot and a snapshot-bound success; it
does not establish complete RPC reads, canonical chain provenance, calibrated
future breach probability, likely exit duration or a user-facing alert.
