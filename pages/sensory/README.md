# Sensory dashboard (dev-only)

A read-only developer view of the Membrane **sensory system** outputs, surfaced
inside membrane-app. Reachable at **`/sensory`** in `npm run dev` (port 3005).
It is intentionally **not linked from app navigation**.

## What it shows

- **Status bar** — the code graph's `git_head` / `generated_at`, a Fresh/Stale
  badge (graph HEAD vs. the solidity repo's current HEAD), and symbol / edge /
  hypothesis-suite counts.
- **Hypotheses** — the latest run per suite from `hypothesis/runs/*.jsonl`,
  pass/fail/pending tallies, with failing and pending hypotheses listed first
  and their failing predicate (`delta`) / pending reason prominent — that is the
  actionable output of the adversarial + behavioral harness.
- **Hotspots** — top 25 code-graph hotspots from `graph.db` salience (churn ×
  complexity), with incoming blast radius — the "where risk concentrates" view.

## Where the data comes from

The outputs live in the **sibling solidity repo**, not in membrane-app:

```
$MEMBRANE_SOLIDITY_ROOT/tools/sensory/graph.db                 (sqlite, code graph)
$MEMBRANE_SOLIDITY_ROOT/tools/sensory/hypothesis/runs/*.jsonl  (hypothesis ledgers)
```

`MEMBRANE_SOLIDITY_ROOT` defaults to `/Users/EBmic/membrane-solidity` (a
sibling checkout). Point it at a different checkout before starting the dev
server:

```bash
MEMBRANE_SOLIDITY_ROOT=/path/to/membrane-solidity npm run dev
```

The API route reads `graph.db` with Node's built-in `node:sqlite`
(`DatabaseSync`, opened **READONLY**); if that import fails at runtime it falls
back to the `sqlite3` binary (`-readonly`), and if neither works it returns a
clean `{ error }` JSON telling you to `npm run regen` in `tools/sensory`.

## Guarantees

- **Read-only.** Neither the page nor its API (`pages/api/sensory/[resource].ts`)
  ever writes to, or triggers a run in, the solidity repo. Refresh only re-reads
  on-disk artifacts.
- **Dev-only.** The API returns `404` when `NODE_ENV === 'production'`, so the
  route ships dead in a production build.
- **No new deps** and **no existing file modified** — fully self-contained in
  `pages/sensory/` + `pages/api/sensory/`.

## Regenerating the data

If the dashboard shows "Artifact unavailable" or a stale badge, regenerate the
graph in the solidity repo:

```bash
cd $MEMBRANE_SOLIDITY_ROOT/tools/sensory && npm run regen
```

Hypothesis runs are produced by running a suite through the hypothesis harness
(`tools/sensory/hypothesis/`); the dashboard reads whatever ledgers exist.
