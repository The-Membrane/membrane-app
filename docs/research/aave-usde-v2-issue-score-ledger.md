# Aave USDe v2 issue and score ledger

The additive migration in `scripts/apply-aave-usde-v2-issue-score-ddl.mjs` is
**dormant** and depends on the separately unapplied v2 recorder migration.
It does not change the locked v1 issue or score tables. It is a one-shot
migration: an existing object fails the transaction instead of silently
accepting schema drift. It requires an explicit owner credential:

```sh
AAVE_USDE_V2_ISSUE_SCORE_MIGRATION_DATABASE_URL=… node scripts/apply-aave-usde-v2-issue-score-ddl.mjs --apply
```

No PostgreSQL migration, runtime grant, issue or score has been executed.
Static SQL-shape tests are not PostgreSQL integration tests.

## Transaction sequence

```text
confirmed predeclared issue schedule
  → start_aave_usde_v2_issue_slot(schedule SHA, current slot ID) → COMMIT
      └─ all nine fixed q/H cells receive starts in one statement
  → source read and pure v2 issuer
  → finish_aave_usde_v2_issue_cell(...) → COMMIT for each cell
      ├─ issued: exact UTF-8 payload, physical SHA, logical issue SHA
      └─ failed / abstained: nonempty reason, no issued payload
  → repeated execution after an issued cell → separate append-only collision row
  → target + 8h + 120s
  → insert_aave_usde_v2_score(issue SHA, exact payload) → COMMIT once
```

The start function derives the nine cells from the stored, previously
confirmed canonical schedule and requires the current hourly slot. Its single
insert is atomic; a duplicate start fails. Each terminal requires that cell's
start from a different committed transaction. An issued terminal must be
recorded inside its slot and its `issuedAt`, amount, horizon, target and basic
source fields must match the planned cell. The database hashes the **physical
UTF-8 bytes** and verifies the issuer's logical SHA against the exact JSON
body before the trailing `sha256` field. An issued
receipt also stores a foreign key to an actual marked Aave USDe snapshot and
checks its block/hash, raw cash, $1/18-decimal cash threshold, millisecond
observation clock, derived anchor age and creation clock against the claimed
anchor. It rejects an anchor when a newer observed USDe row was locally
available at issue time. This does not prove that the source path was complete
or that the RPC supplied every relevant observation. A
nonissued terminal retains its reason. Once a slot closes, a cell without an
on-time terminal is **missing** from the on-time denominator, never silently
converted to abstention. A collision is a
separate append-only attempt referencing the already issued receipt in the
same cell; it cannot replace that cell's terminal. Counts should report
starts, terminals by status, collisions and missing cells separately.
Late failed or abstained terminals remain stored with `timely=false`, but do
not satisfy the scheduled cell's on-time denominator. Issued terminals require
`timely=true`.
The pure schedule classifier's `duplicate` terminal is a caller-input state;
the database's canonical cell remains `issued` and records any repeat as a
separate collision attempt. A collision after the slot closes has
`timely=false` and cannot count as an on-time repeat.

The final score function requires a committed issued receipt and waits until
the fixed `targetAt + 8h + 120s` source cutoff. It accepts only `observed` or
`censored` scores, checks the cutoff and corresponding issue identity, and
inserts one row keyed by issue SHA. `pending` is a transient scorer response,
not a final row. No upsert or rescore path exists. All four new tables have
append-only UPDATE/DELETE triggers; the runtime role must have function
`EXECUTE` only and no direct table DML. The migration revokes default `PUBLIC`
privileges but makes **no runtime grants**. Audit function ownership, public
schema `CREATE` privileges and exact grants before any use.

The database checks receipt envelope fields, physical SHA and the trailing
logical seal of both issue and score bytes. It **cannot attest** that the pure
JavaScript issuer/scorer was actually called or recompute source-path
eligibility, completeness, canonical chain data,
hourly recorder coverage, or that source work really happened after the
committed start. Those remain separate reader/replay/coverage checks. A
caller-provided clock within a slot is also not independent observation
provenance. Function-entry timestamps also do not prove the transaction
committed before slot close; activation needs commit-lag checks and an
independent database read. Before cutover, exercise this DDL and each function in disposable
PostgreSQL with duplicate, missing, same-transaction, early-score and rollback
cases, then wire a dedicated publisher to the pure issuer/scorer and audit the
complete DB denominators. Nothing here licenses a user-facing prediction.
