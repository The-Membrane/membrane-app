-- Wavefront live engine — Postgres tables.
--
-- STATUS: PENDING OWNER APPROVAL. NOT APPLIED to any database. This file lives in
-- db/migrations-pending/ precisely so no migration runner picks it up. Applying it to the
-- production Neon database is an owner decision (docs/WAVEFRONT_LIVE_ENGINE.md, "Decisions").
--
-- Writer: lib/wavefront/live/sinks.ts PostgresSink (one transaction per minute: a guard on the
-- state row's seq, the minute's records, the new state). Readers: the app (later), the daily
-- export to membrane-datasets (later, also pending approval).

-- One row per stream record, in stream order. `seq` is the stream's own seq (the writer inserts it
-- explicitly; the sequence default is only a fallback). `body` is the whole record as JSON, flags
-- (backfilled, late, eventTs, priceBasis, protocolFeeUsd, gaps) included.
CREATE TABLE IF NOT EXISTS wavefront_events (
  seq   bigserial   PRIMARY KEY,
  ts    timestamptz NOT NULL,
  kind  text        NOT NULL CHECK (kind IN ('open', 'real', 'mem', 'tick')),
  pid   text,                      -- NULL for ticks
  body  jsonb       NOT NULL
);
CREATE INDEX IF NOT EXISTS wavefront_events_ts  ON wavefront_events (ts);
CREATE INDEX IF NOT EXISTS wavefront_events_pid ON wavefront_events (pid) WHERE pid IS NOT NULL;

-- Append-only: the stream is never rewritten.
CREATE OR REPLACE FUNCTION wavefront_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wavefront_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wavefront_events_no_update ON wavefront_events;
CREATE TRIGGER wavefront_events_no_update BEFORE UPDATE OR DELETE ON wavefront_events
  FOR EACH ROW EXECUTE FUNCTION wavefront_events_append_only();

-- The engine's durable state (resume point): one row per stream. `state` is opaque JSON text
-- (lib/wavefront/live/state.ts EngineState; non-finite numbers encoded as {"$num": "..."}).
CREATE TABLE IF NOT EXISTS wavefront_engine_state (
  stream     text        PRIMARY KEY,
  header     jsonb       NOT NULL,
  seq        bigint      NOT NULL,
  state      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
