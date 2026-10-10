# Aave USDe v2 first-breach issue schedule

`scripts/research/aave-usde-first-breach-schedule.mjs` defines a distinct, pure
calendar for the **first locally sampled reserve-cash breach by H** study. It
does not reuse the v1 endpoint schedule, publisher, database rows, or receipts.

## Fixed enrollment contract

An operator chooses explicit `plannedAt`, `startAt`, and `endExclusiveAt` UTC
timestamps. `plannedAt` precedes the first slot. The interval contains aligned
hourly slots and is at most 568 hours (23 days, 16 hours), leaving seven days
plus eight hours for the longest fixed horizon inside the separate 31-day
hourly coverage manifest. Each slot has the same nine fixed cells:
three predeclared USD amounts × three horizons (8h, 24h, 7d). A deterministic
slot ID hashes the v2 study ID, full schedule plan and interval, and that
slot's bounds, so overlapping calendars do not share slot IDs. The builder returns
canonical UTF-8 JSON bytes. The physical SHA-256 is over those exact bytes,
including field order. `verifyFirstBreachSchedule` requires an **externally
expected** physical SHA and regenerates the entire schedule byte for byte;
changed whitespace, study, slot IDs, cadence, grid, or arms fail.

`bindFirstBreachIssue` additionally verifies the sealed v2 issue, its fixed
cell, and `issuedAt ∈ [scheduledAt, closesAt)`. It returns
`membership: caller_consistent_only` and `prospectiveEligible: false` because
the caller's schedule bytes and SHA cannot prove physical publication before
the slot, independent witnessing, insert-once persistence, or an exhaustive
issue read.

`classifyFirstBreachSchedule` retains all nine cells per slot. A supplied
terminal attempt can classify a cell `issued` or `duplicate` (both require a
sealed v2 issue in the same scheduled slot and arm), or `failed` or `abstained`
(both require a reason and no issue). An open cell without a terminal attempt
is `scheduled`; after the slot closes it becomes `missing`. These are
**caller-input states**, not database facts. A `duplicate` classification
does not prove a database uniqueness conflict or earlier persistence. The
classifier rejects unscheduled arms, duplicate terminal attempts, out-of-slot
or future receipt times, string-coerced arm values, and an issue recorded before its own issue time. It
also requires each attempt to carry the same physical schedule SHA. It cannot
establish that the caller supplied every attempt.

## Additive production lane still required

1. Persist the exact v2 bytes and physical SHA in an insert-once v2 schedule
   table before the first slot. Confirm publication in a separate transaction.
2. On each planned cell, persist a scheduled start and a terminal result,
   including failures and abstentions, tied to schedule SHA, slot ID and arm.
   Persist the v2 issue in a distinct insert-once issue ledger.
3. Audit the complete schedule, attempt, issue, hourly recorder and score sets
   from one consistent database snapshot with independent source provenance.
   The separate hourly coverage manifest references this schedule's physical
   SHA through `issueSchedulePhysicalSha256`.
4. Keep outcome and alert gates closed until prospective, independently
   assessed performance and executable holder-route evidence support the
   specific amount, horizon and exit claim.

No function in this module writes to a database, collects chain observations,
projects duration, estimates probability, or authorizes an alert.
