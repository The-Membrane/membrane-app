/**
 * THE RPC CALL LEDGER in Postgres — one row per endpoint call the ring made while it
 * built a dataset (lib/position-sim/rpcRing.ts `RpcCall`, delivered through the ring's
 * `onCall`). Owner 2026-10-11: record "which RPC we are getting things from so that we
 * can evaluate them".
 *
 * HOSTS ONLY. A row holds the host, never the URL, and an error keeps only its numeric
 * code: viem's error text carries the request URL, and a keyed URL carries its key.
 *
 * Rows are per BLOCK RANGE, not per event: a dropped event has no row of its own, so the
 * range ledger is what shows which endpoint answered (and which one was contradicted)
 * for the blocks a missing event sits in. `run` + `piece` group the calls of one piece.
 *
 * Kept free of TypeScript imports at module level so the plain-node DDL script
 * (scripts/apply-venue-recorder-ddl.mjs) can import `ensureLedgerTable`.
 */

export const LEDGER_TABLE = 'rpc_log_calls'

/** Idempotent. Every writer calls it, so a scan can never run without its ledger. */
export async function ensureLedgerTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS rpc_log_calls (
    id bigserial PRIMARY KEY,
    run text NOT NULL,
    piece integer NOT NULL,
    at timestamptz NOT NULL,
    host text NOT NULL,
    query text NOT NULL,
    from_block bigint NOT NULL,
    to_block bigint NOT NULL,
    role text NOT NULL,
    outcome text NOT NULL,
    logs integer NOT NULL,
    ms integer NOT NULL,
    error_code integer,
    verdict text NOT NULL,
    contradicted boolean NOT NULL
  )`
  await sql`CREATE INDEX IF NOT EXISTS rpc_log_calls_query_block_idx ON rpc_log_calls (query, from_block)`
  await sql`CREATE INDEX IF NOT EXISTS rpc_log_calls_host_at_idx ON rpc_log_calls (host, at)`
}

/** Batch insert of RpcCall records for one run. */
export async function insertCalls(sql, run, calls) {
  if (calls.length === 0) return
  await sql`
    INSERT INTO rpc_log_calls
      (run, piece, at, host, query, from_block, to_block, role, outcome, logs, ms, error_code, verdict, contradicted)
    SELECT ${run}::text, * FROM UNNEST(
      ${calls.map((c) => c.piece)}::int[],
      ${calls.map((c) => c.at)}::timestamptz[],
      ${calls.map((c) => c.host)}::text[],
      ${calls.map((c) => c.query)}::text[],
      ${calls.map((c) => String(c.fromBlock))}::bigint[],
      ${calls.map((c) => String(c.toBlock))}::bigint[],
      ${calls.map((c) => c.role)}::text[],
      ${calls.map((c) => c.outcome)}::text[],
      ${calls.map((c) => c.logs)}::int[],
      ${calls.map((c) => c.ms)}::int[],
      ${calls.map((c) => c.errorCode)}::int[],
      ${calls.map((c) => c.verdict)}::text[],
      ${calls.map((c) => c.contradicted)}::boolean[]
    )`
}

/** Ledger rows as RpcCall-shaped records (plus `run`). `queryLike` is a SQL LIKE pattern. */
export async function readCalls(sql, { queryLike = '%', since = '1970-01-01T00:00:00Z' } = {}) {
  const rows = await sql`
    SELECT run, piece, at, host, query, from_block, to_block, role, outcome, logs, ms, error_code, verdict, contradicted
    FROM rpc_log_calls
    WHERE query LIKE ${queryLike} AND at >= ${since}::timestamptz
    ORDER BY id`
  return rows.map((r) => ({
    run: r.run,
    piece: Number(r.piece),
    at: new Date(r.at).toISOString(),
    host: r.host,
    query: r.query,
    fromBlock: BigInt(r.from_block),
    toBlock: BigInt(r.to_block),
    role: r.role,
    outcome: r.outcome,
    logs: Number(r.logs),
    ms: Number(r.ms),
    errorCode: r.error_code === null ? null : Number(r.error_code),
    verdict: r.verdict,
    contradicted: Boolean(r.contradicted),
  }))
}

/**
 * The `provenance` block a published dataset carries: which hosts answered its log
 * scan, how they checked out, and how much of the scanned range the ledger covers.
 * Ranges fetched before the ledger existed have no rows, so blocksWithLedger can be
 * below blocksTotal — that is reported, never filled in.
 */
export async function ledgerProvenance(sql, { queryLike, fromBlock, toBlock }) {
  const { scorecard, pieceVerdicts, coveredBlocks } = await import('../../lib/position-sim/rpcScorecard.ts')
  const rows = await readCalls(sql, { queryLike })
  const lo = BigInt(fromBlock)
  const hi = BigInt(toBlock)
  const accepted = rows
    .filter((r) => r.role === 'first' && r.outcome !== 'error' && ['agreed', 'recovered', 'single'].includes(r.verdict))
    .filter((r) => r.toBlock >= lo && r.fromBlock <= hi)
    .map((r) => ({ fromBlock: r.fromBlock < lo ? lo : r.fromBlock, toBlock: r.toBlock > hi ? hi : r.toBlock }))
  return {
    ledger: LEDGER_TABLE,
    query: queryLike,
    blocksTotal: Number(hi - lo + 1n),
    blocksWithLedger: Number(coveredBlocks(accepted)),
    pieces: pieceVerdicts(rows),
    byHost: scorecard(rows),
    note:
      'Which RPC endpoint answered each block range of the log scan, from the ring call ledger (hosts only). ' +
      'Ranges fetched before the ledger existed (2026-10-11) have no rows: they count in blocksTotal, not in blocksWithLedger. ' +
      'falseEmptyRate and shortRate are over answers a second endpoint checked; null means none were checked.',
  }
}
