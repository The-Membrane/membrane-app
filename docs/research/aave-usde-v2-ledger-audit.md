# Aave USDe v2 ledger audit reader

`auditAaveUsdeV2Ledger({ pool, scheduleSha256, manifestSha256, issueSha256 })`
accepts an injected PostgreSQL pool with `connect()`, `client.query(sql, params)` and
`client.release()`. It has no CLI, connection URL, write path or runtime grants.

The reader opens one `REPEATABLE READ READ ONLY` transaction and obtains the
server as-of clock before unpaginated reads of the schedule and confirmation,
all starts, terminals, collisions and scores for that schedule, the coverage
manifest and confirmation, all member slots and their global recorder receipts,
success-linked snapshots, and every Aave USDe row from ten minutes before the
coverage window through its end, including unmarked and non-observed rows. The
pre-window read covers the earliest valid issue anchor; the in-window inventory
exposes observations with no assigned slot. Score replay cannot silently omit
legacy or other-source rows. Hourly coverage uses the observed subset, while
score replay sees every source row that the pure scorer could have consumed.
No `LIMIT` or pagination can silently turn a partial denominator into complete
coverage. Missing database query results fail; the session rolls back and releases.

Stored schedule/manifest payloads must match their physical SHA and canonical
byte builders. The reader checks published clocks, confirmation clocks and
separate XIDs, row membership, starts/terminals, timeliness, physical issue and
score hashes, collisions and snapshot links. It then calls the pure fixed-grid
schedule classifier only with on-time terminal rows, while retaining late and
missing rows in the inventory and anomaly list. It calls the pure hourly
coverage auditor for the selected issued forecast with deterministic snapshot
projection. Timestamp fields become UTC millisecond strings; `block` becomes a
decimal string; numeric amount columns become JS numbers; params retain parsed
JSONB values. A row SHA generated from that projection is an internal
consistency check, not an independently witnessed physical DB row hash.

The selected score is replayed with its stored score time from all source rows
between the issue anchor and target plus eight hours. A different logical
outcome is an anomaly, and equal observation timestamps return an ambiguous
replay because original caller ordering cannot be proven. Replay remains a
comparison against stored rows: the later database snapshot cannot establish
which rows were available to the original scorer or whether the upstream feed
omitted observations. Other issued scores receive seal/identity checks but are
not yet replayed.

The selected issue anchor is re-normalized from its referenced marked database
snapshot and compared field for field with the sealed issue anchor. A matching
**censored** score remains an incomplete outcome; only a matching observed
score can satisfy the requested-issue completeness verdict.

Pure classification is withheld if the schedule or coverage confirmation is
missing or contradictory; coverage classification is also withheld for a late,
unstarted, or database-unbound requested issue and for inconsistent stored
coverage slots. The output deliberately separates:

- `databaseQuery`: one consistent, unpaginated read of the available ledgers;
- `databaseConsistency` and `anomalies`: local ledger/caller consistency only;
- `requestedIssueCompleteness`: whether the schedule has all planned issue
  receipts and scores, the manifest has all recorder receipts, and the **one
  requested issue** has uncensored hourly coverage after its source cutoff and
  a matching stored-row score replay, with no collision or anomaly. This does
  not certify coverage or score truth for other issued
  cells in the schedule and remains limited to the database;
- `scheduleAudit` and `coverageAudit`: pure classifications with their own
  caller-evidence limits;
- `requestedScoreReplay`: match, mismatch or ambiguity against stored observed
  rows for the one selected issue;
- `sourceCompleteness: 'unverified'` and `prospectiveEligible: false`.

PostgreSQL receipt timestamps are function clocks, not proven commit clocks.
Database rows cannot attest that an RPC feed was complete or that no observations
were omitted before insert. This reader does not make a forecast, alert, or
historical outcome label reliable by itself. It remains untested against live
PostgreSQL while the v2 migrations are dormant.
