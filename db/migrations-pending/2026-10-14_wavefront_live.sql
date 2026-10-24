-- Wavefront live engine — Postgres tables.
--
-- STATUS: PENDING OWNER APPROVAL. NOT APPLIED to any database. This file lives in
-- db/migrations-pending/ precisely so no migration runner picks it up. Applying it to the
-- production Neon database is an owner decision (docs/WAVEFRONT_LIVE_ENGINE.md, "Decisions").
--
-- DRIZZLE NOTE (part of the owner's migration step). These tables are deliberately NOT declared
-- in db/schema.ts. `pnpm db:push` compares the database with db/schema.ts (drizzle.config.ts),
-- so once this file is applied it will OFFER TO DROP wavefront_events and
-- wavefront_engine_state, data included. Answer no — or, together with applying this file,
-- declare both tables in db/schema.ts (or exclude them with drizzle's `tablesFilter`) before
-- anyone runs db:push again.
--
-- Writer: lib/wavefront/live/sinks.ts PostgresSink, one transaction per minute:
--   1. the guard: UPDATE wavefront_engine_state SET version = <next>, seq, state
--      WHERE stream = $1 AND version = <the version this writer last committed>, inside a CTE
--      whose row count divides 1 — 0 rows (another writer, a stale writer) raises
--      division_by_zero at run time and the whole transaction rolls back;
--   2. the minute's records, INSERT INTO wavefront_events (stream, seq, …), ≤ 1,000 per statement.
-- Readers: the app (later), the daily export to membrane-datasets (later, also pending approval).

-- One row per stream record, in stream order. `seq` is the stream's own seq (1, 2, 3, … per
-- stream, inserted explicitly). `body` is the whole record as JSON, flags (backfilled, late,
-- eventTs, priceBasis, protocolFeeUsd, gaps) included.
CREATE TABLE IF NOT EXISTS wavefront_events (
  stream text        NOT NULL,
  seq    bigint      NOT NULL,
  ts     timestamptz NOT NULL,
  kind   text        NOT NULL CHECK (kind IN ('open', 'real', 'mem', 'tick')),
  pid    text,                      -- NULL for ticks
  body   jsonb       NOT NULL,
  PRIMARY KEY (stream, seq)
);
CREATE INDEX IF NOT EXISTS wavefront_events_stream_ts  ON wavefront_events (stream, ts);
CREATE INDEX IF NOT EXISTS wavefront_events_stream_pid ON wavefront_events (stream, pid) WHERE pid IS NOT NULL;

-- Append-only: the stream is never rewritten.
CREATE OR REPLACE FUNCTION wavefront_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wavefront_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wavefront_events_no_update ON wavefront_events;
CREATE TRIGGER wavefront_events_no_update BEFORE UPDATE OR DELETE ON wavefront_events
  FOR EACH ROW EXECUTE FUNCTION wavefront_events_append_only();

-- The engine's durable state (resume point): one row per stream, created explicitly by the
-- writer when it creates the stream. `version` counts commits (the concurrency guard; seq alone
-- does not move on a minute without records); `seq` is the last record's seq; `state` is opaque
-- JSON text (lib/wavefront/live/state.ts EngineState; non-finite numbers encoded as
-- {"$num": "..."}). It holds open positions only — closed ones live in the stream — so its size
-- follows the number of positions walking, not the age of the stream.
CREATE TABLE IF NOT EXISTS wavefront_engine_state (
  stream     text        PRIMARY KEY,
  header     jsonb       NOT NULL,
  version    bigint      NOT NULL,
  seq        bigint      NOT NULL,
  state      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
