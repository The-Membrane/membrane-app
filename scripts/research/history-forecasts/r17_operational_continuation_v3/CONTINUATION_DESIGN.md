# R17 operational continuation v3 — SOURCE REVIEW PENDING

No READY request or model job has been created. This is a prospective instrumentation amendment, not an automatic research retry.
Every v1/v2 source, failed receipt and partial result remains in its original directory. This directory contains separate copies.
A future published O80 commit, independent review/tests and explicit request preparation remain prerequisites.

## Known failure and narrow change

The v2 monitor rejected legitimate '?' state on owned PID51431 with reported RSS0. This was not a forecasting-model failure.
Apple source and the finite metadata-only comparison are preserved under r17-monitor-unknown-state-v1.
The historical executable identity and EPERM cause remain uncertain. No claim is made that zero reported RSS was actual zero memory.
The finite inherited-versus-isolated inner-ps comparison did not reproduce '?' or establish isolation as a repair.
V3 retains the inherited process structure and changes only observer qualification and operational continuation provenance.

## Explicit observation protocol

A syntactically valid '?' or '?'+flags is a live member with rss_bytes=null and rss_qualified=false.
Its numeric reported_rss_bytes remains diagnostic, never a trusted zero. Cleanup counts unknown members as live.
Malformed field counts, numeric values, state-token syntax, ps exit failures and probe exceptions remain immediate failures.
Only an unknown member INSIDE the owned PGID permits another fresh census. An outside-group unknown adds a diagnostic count.
MAX3 counts the initial probe. All probes, parsing and pauses share the original absolute min(3seconds, remaining wall time) deadline.
No deadline reset, stale member merge or model retry occurs. Each next census includes the whole owned group.
Accept only a fresh complete qualified RSS census, including a fresh census in which the formerly unknown PID is absent.
If owned RSS is still unqualified after the fixed budget, stop fail-closed and retain bounded diagnostics.

An incomplete census has total_rss_bytes=null. Its known-member subtotal is only a lower bound.
Apply the unchanged1,000,000,000-byte cap immediately to EVERY known subtotal, before another probe or recovery.
A later low sample or concurrent leader exit cannot erase an observed breach.
Report separate known-subtotal lower-bound peak, complete-census count and nullable complete-census peak.
If no complete census exists, its count is0 and peak isnull. The legacy global peak0 then means no qualified complete measurement, not zero memory.
Bound event records to32 and unknown member details to16 per event, retaining truncation counts. Never collect command lines.
Cleanup uses a fresh identity/state census without requiring RSS qualification, sends TERM then KILL regardless of leader status,
and verifies no remaining live members. Zombies remain distinct. Existing cleanup errors remain visible and can prevent completion.
Final hashing is charged before the single checked elapsed sample used in the receipt.

## Exact same scientific run

All original mathematical functions are AST-identical, including training masks, feature transforms, cap selection, optimization,
XGBoost settings/seeds, offset handling, barrier PAV, scoring and missing-label bounds.
The adapter reuses the admitted H6/H12 prefix without refitting or rescoring it. Only H24/H72/H168 are recomputed.
Partial unfinished H24 work may be repeated operationally. It is not a fresh independent experiment or an extra model candidate.
Prefix copies retain exact bytes and score/fit records. Original evidence is never deleted, overwritten or treated as a completed full run.
The same complete-label support and all missingness, sample-selection, calibration and market-proxy limitations remain.
All blind/reserve and production holds remain unchanged.

## Two-attempt identity and time accounting

First receipt:121.7220577seconds, conservatively charged122. Second:2.712388625seconds, charged3.
125seconds are consumed, leaving at most1075 of the original1200. No budget reset is permitted.
The monitor and child adapter both enforce1075seconds. Validation, copying and result hashing consume that time.
An additional failed attempt would require a new remaining-budget calculation, not reuse of1075seconds.

Pin BOTH prior launch/model/source/receipt chains and the same five original staged inputs.
Require each receipt to bind its actual launch, unchanged admission pins and confirmed no remaining live group members.
Bind launch argv to the exact trainer, model request, input directory and output directory.
The accepted parent prefix audit must bind the exact first failed receipt and exact original prefix progress.
V2 must report exactly H6/H12 completed, identical horizon records and byte-identical copied progress and predictions.
Reject any v2 final result or new H24/H72/H168 prediction file. No v2 horizon is silently added to the accepted prefix.
Validate every non-operational original request setting unchanged and both rounded elapsed charges before copying anything.
Structural/byte checks are not a replacement for the separately pinned independent numerical prefix audit.

## Future request preparation

prepare_launch.py requires --o80-board-commit with a full commit matching current local HEAD, remote main and O80 subject.
It refuses placeholders and rechecks source, both original closures, prefix and qualified runtime/native identities.
Only explicit parent invocation may create model-request.v3.json and train-launch.v3.json.
Expected output is fresh model-results-v3/, with train-v3.monitor.json and sibling start/stdout/stderr paths.
Preparation never executes a trainer or monitor. No READY file exists at this source-review checkpoint.

## Validation and limits

Synthetic tests cover the exact state, MAX3/shared deadline, fresh recovery, PID disappearance, outside unknown diagnostics,
non-retried malformed probes, lower-bound cap before recovery, terminal-leader cap persistence and nullable measurement status.
A cheap actual owned child group is observed with deliberately injected first-snapshot unknown metadata, then fresh recovery and cleanup.
Synthetic two-attempt chains test wrong audits/receipts, changed inputs/scientific settings/budget, altered prefix and prohibited new horizons.
These fixtures do not prove the kernel will always supply qualified RSS. A future unqualified observation still stops the run.
Sampled peaks are observations, not continuous hard maxima or syscall containment. The observer change needs fresh review and publication.
