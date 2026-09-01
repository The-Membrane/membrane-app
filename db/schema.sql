-- Membrane data pipeline — Postgres schema.
-- Status: the database does not exist yet. This file is the one-step setup for when it
-- does: `psql $DATABASE_URL -f db/schema.sql`. Until then the scheduled jobs write JSON
-- into the repo (see docs/DATA_PIPELINE.md, "Interim mode").
--
-- One rule binds every table here: nothing is served to a user without its
-- measured_at. A figure with no measurement date is a rumour.

-- =============================================================================
-- 1. Breach-probability surface (Monte Carlo, daily + on governance change)
--    Writer: scripts/breach-surface.mjs   Reader: dashboard + intent cards
-- =============================================================================

CREATE TABLE IF NOT EXISTS breach_surface_run (
  id            BIGSERIAL PRIMARY KEY,
  measured_at   timestamptz NOT NULL,
  -- line, window, delay_h, horizon_days — a governance change makes a new run,
  -- it never mutates an old one
  params        jsonb       NOT NULL,
  -- kind, step_h, paths, antithetic
  model         jsonb       NOT NULL,
  realized_vol  numeric,              -- NULL = the vol feed failed; readers must show the full band
  vol_source    text        NOT NULL
);

CREATE TABLE IF NOT EXISTS breach_surface_cell (
  run_id  bigint  NOT NULL REFERENCES breach_surface_run(id) ON DELETE CASCADE,
  ltv     numeric NOT NULL,
  vol     numeric NOT NULL,
  p       numeric NOT NULL CHECK (p >= 0 AND p <= 1),
  PRIMARY KEY (run_id, ltv, vol)
);

CREATE OR REPLACE VIEW breach_surface_latest AS
  SELECT c.ltv, c.vol, c.p, r.measured_at, r.realized_vol, r.params
  FROM breach_surface_cell c
  JOIN breach_surface_run  r ON r.id = c.run_id
  WHERE r.id = (SELECT max(id) FROM breach_surface_run);

-- =============================================================================
-- 2. Route economics + venue measurements (the stale-board fix; periodic re-measure)
--    Writer: route sweep job (to build)   Readers: landing routes, builder venue
--    tray, Disco LTV benchmarks
-- =============================================================================

CREATE TABLE IF NOT EXISTS venue_snapshot (
  id           BIGSERIAL PRIMARY KEY,
  measured_at  timestamptz NOT NULL,
  venue        text        NOT NULL,   -- 'aave-v3', 'susde', ...
  chain        text        NOT NULL,
  apr          numeric,
  recall_pct   numeric,                -- share returned on a recall, cooldowns priced in
  spd          numeric,                -- share arriving inside the grace window
  tvl_usd      numeric,
  detail       jsonb,                  -- utilization, cooldown state, caps — venue-specific
  source       text        NOT NULL,   -- rpc endpoint / subgraph / block number
  UNIQUE (measured_at, venue, chain)
);
CREATE INDEX IF NOT EXISTS venue_snapshot_latest_idx ON venue_snapshot (venue, measured_at DESC);

CREATE TABLE IF NOT EXISTS route_snapshot (
  id                 BIGSERIAL PRIMARY KEY,
  measured_at        timestamptz NOT NULL,
  route              text        NOT NULL,  -- 'wbtc/cdt/susde', ...
  gross_apr          numeric,
  borrow_rate        numeric,
  net_spread         numeric,
  measured_positions integer,               -- how many live positions price this route
  detail             jsonb,
  UNIQUE (measured_at, route)
);

-- =============================================================================
-- 3. Retroactive attribution (price-history sweep names events, computes per-user
--    outcomes). Writer: attribution job (to build)   Reader: "What you have survived"
-- =============================================================================

CREATE TABLE IF NOT EXISTS market_event (
  id           BIGSERIAL PRIMARY KEY,
  name         text        NOT NULL,   -- 'Aug 12 wick'
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  asset        text        NOT NULL DEFAULT 'BTC',
  drawdown_pct numeric     NOT NULL,
  detail       jsonb,                  -- path summary, blocks, venue states during
  computed_at  timestamptz NOT NULL,   -- when the sweep found it (retroactive is fine)
  UNIQUE (name, started_at)
);

CREATE TABLE IF NOT EXISTS position_outcome (
  event_id           bigint      NOT NULL REFERENCES market_event(id) ON DELETE CASCADE,
  account            text        NOT NULL,   -- address; positions are on-chain public data
  position_id        text        NOT NULL,
  headroom_low_hours numeric,                -- the low-water mark
  ltv_peak           numeric,
  recall_invoked     boolean     NOT NULL,
  recall_covered_usd numeric,
  btc_sold           numeric     NOT NULL DEFAULT 0,
  -- the attribution-to-self rule: name the user's decision, never a silent rescue
  attribution        text        NOT NULL,   -- 'sized at 40%; 52% would have been recalled'
  computed_at        timestamptz NOT NULL,
  PRIMARY KEY (event_id, position_id)
);

-- =============================================================================
-- 4. Calibration calls (today in localStorage; must move server-side so the score
--    survives the browser). Writer: app API route   Reader: "Is it luck?" module
-- =============================================================================

CREATE TABLE IF NOT EXISTS calibration_call (
  id          BIGSERIAL PRIMARY KEY,
  account     text        NOT NULL,
  surface     text        NOT NULL,   -- 'gauntlet' | 'live'
  subject     text        NOT NULL,   -- 'floor-6' | 'P(breach 80% headroom, wk 32)'
  p           numeric     NOT NULL CHECK (p >= 0 AND p <= 1),
  called_at   timestamptz NOT NULL,
  -- outcome is NULL until it resolves; a call scored before resolution is the exact
  -- "confidence with nothing behind it" the ruleset prohibits
  outcome     boolean,
  resolved_at timestamptz,
  CHECK (outcome IS NULL OR resolved_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS calibration_call_account_idx ON calibration_call (account, resolved_at);
