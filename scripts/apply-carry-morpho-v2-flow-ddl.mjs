// Prospective Morpho VaultV2 event capture. This migration does not enroll or scan.
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'
import { readEnv } from './lib/venue-reads.mjs'

export async function apply(sql) {
  await sql`CREATE TABLE IF NOT EXISTS carry_morpho_v2_flow_subjects (
    vault text PRIMARY KEY CHECK (vault ~ '^0x[0-9a-f]{40}$'),
    asset text NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
    route_keys jsonb NOT NULL CHECK (jsonb_typeof(route_keys) = 'array'),
    manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
    seed_sha256 text NOT NULL CHECK (seed_sha256 ~ '^[0-9a-f]{64}$'),
    board_sha256 text NOT NULL CHECK (board_sha256 ~ '^[0-9a-f]{64}$'),
    displayed_routes_sha256 text NOT NULL CHECK (displayed_routes_sha256 ~ '^[0-9a-f]{64}$'),
    cohort_id text NOT NULL,
    enrolled_block bigint NOT NULL CHECK (enrolled_block > 0),
    enrolled_hash text NOT NULL CHECK (enrolled_hash ~ '^0x[0-9a-f]{64}$'),
    enrolled_observed_at timestamptz NOT NULL,
    enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp()
  )`
  await sql`CREATE TABLE IF NOT EXISTS carry_morpho_v2_flow_cursors (
    vault text PRIMARY KEY REFERENCES carry_morpho_v2_flow_subjects(vault),
    last_block bigint NOT NULL CHECK (last_block > 0),
    last_hash text NOT NULL CHECK (last_hash ~ '^0x[0-9a-f]{64}$')
  )`
  await sql`CREATE TABLE IF NOT EXISTS carry_morpho_v2_flow_intervals (
    vault text NOT NULL REFERENCES carry_morpho_v2_flow_subjects(vault),
    from_block bigint NOT NULL,
    to_block bigint NOT NULL,
    prior_hash text NOT NULL CHECK (prior_hash ~ '^0x[0-9a-f]{64}$'),
    to_hash text NOT NULL CHECK (to_hash ~ '^0x[0-9a-f]{64}$'),
    finalized_head_block bigint NOT NULL CHECK (finalized_head_block > 0),
    finalized_head_hash text NOT NULL CHECK (finalized_head_hash ~ '^0x[0-9a-f]{64}$'),
    to_observed_at timestamptz NOT NULL,
    combined_set_sha256 text NOT NULL CHECK (combined_set_sha256 ~ '^[0-9a-f]{64}$'),
    coverage_grade text NOT NULL DEFAULT 'provider_attested' CHECK (coverage_grade = 'provider_attested'),
    payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    event_count integer NOT NULL CHECK (event_count >= 0),
    first_local_receipt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (vault, from_block),
    CHECK (to_block >= from_block AND to_block - from_block < 512),
    CHECK (to_block <= finalized_head_block),
    CHECK (to_block <> finalized_head_block OR to_hash = finalized_head_hash)
  )`
  await sql`CREATE TABLE IF NOT EXISTS carry_morpho_v2_flow_events (
    vault text NOT NULL,
    interval_from_block bigint NOT NULL,
    block bigint NOT NULL,
    block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
    transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
    transaction_index integer NOT NULL CHECK (transaction_index >= 0),
    log_index integer NOT NULL CHECK (log_index >= 0),
    event_kind text NOT NULL CHECK (event_kind IN ('deposit', 'withdraw')),
    sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
    owner text NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
    receiver text CHECK (receiver ~ '^0x[0-9a-f]{40}$'),
    assets_raw numeric(78,0) NOT NULL CHECK (assets_raw >= 0),
    shares_raw numeric(78,0) NOT NULL CHECK (shares_raw >= 0),
    flow_class text NOT NULL CHECK (flow_class IN
      ('deposit_observed', 'external_receiver_unreconciled',
       'internal_vault_receiver', 'internal_force_deallocate')),
    force_event_in_transaction boolean NOT NULL,
    PRIMARY KEY (vault, transaction_hash, log_index),
    FOREIGN KEY (vault, interval_from_block)
      REFERENCES carry_morpho_v2_flow_intervals(vault, from_block),
    CHECK ((event_kind = 'deposit' AND receiver IS NULL AND flow_class = 'deposit_observed')
      OR (event_kind = 'withdraw' AND receiver IS NOT NULL AND flow_class <> 'deposit_observed'))
  )`
  await sql`CREATE INDEX IF NOT EXISTS carry_morpho_v2_flow_intervals_to_idx
    ON carry_morpho_v2_flow_intervals (vault, to_block)`
  await sql`CREATE INDEX IF NOT EXISTS carry_morpho_v2_flow_events_block_idx
    ON carry_morpho_v2_flow_events (vault, block, log_index)`

  // Both operations lock the one cursor row. An interval and its events either
  // commit together, or the cursor remains at the prior finalized block.
  await sql`CREATE OR REPLACE FUNCTION carry_morpho_v2_enroll(p jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE s carry_morpho_v2_flow_subjects%ROWTYPE;
    BEGIN
      IF (p->>'vault') !~ '^0x[0-9a-f]{40}$'
        OR (p->>'asset') !~ '^0x[0-9a-f]{40}$'
        OR (p->>'blockHash') !~ '^0x[0-9a-f]{64}$'
        OR (p->>'manifestSha256') !~ '^[0-9a-f]{64}$'
        OR (p->>'seedSha256') !~ '^[0-9a-f]{64}$'
        OR (p->>'boardSha256') !~ '^[0-9a-f]{64}$'
        OR (p->>'displayedRoutesSha256') !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(p->'routeKeys') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p->'routeKeys') = 0
      THEN RAISE EXCEPTION 'invalid Morpho enrollment'; END IF;
      INSERT INTO carry_morpho_v2_flow_subjects
        (vault, asset, route_keys, manifest_sha256, seed_sha256,
         board_sha256, displayed_routes_sha256, cohort_id,
         enrolled_block, enrolled_hash, enrolled_observed_at)
      VALUES (p->>'vault', p->>'asset', p->'routeKeys', p->>'manifestSha256',
        p->>'seedSha256', p->>'boardSha256', p->>'displayedRoutesSha256',
        p->>'cohortId', (p->>'block')::bigint, p->>'blockHash',
        (p->>'observedAt')::timestamptz)
      ON CONFLICT (vault) DO NOTHING;
      SELECT * INTO s FROM carry_morpho_v2_flow_subjects
        WHERE vault = p->>'vault' FOR SHARE;
      IF s.asset IS DISTINCT FROM p->>'asset'
        OR s.route_keys IS DISTINCT FROM p->'routeKeys'
        OR s.manifest_sha256 IS DISTINCT FROM p->>'manifestSha256'
        OR s.seed_sha256 IS DISTINCT FROM p->>'seedSha256'
        OR s.board_sha256 IS DISTINCT FROM p->>'boardSha256'
        OR s.displayed_routes_sha256 IS DISTINCT FROM p->>'displayedRoutesSha256'
        OR s.cohort_id IS DISTINCT FROM p->>'cohortId'
      THEN RAISE EXCEPTION 'Morpho enrollment identity disagreement'; END IF;
      INSERT INTO carry_morpho_v2_flow_cursors(vault, last_block, last_hash)
        VALUES (s.vault, s.enrolled_block, s.enrolled_hash)
        ON CONFLICT (vault) DO NOTHING;
      IF s.enrolled_block <> (p->>'block')::bigint
        OR s.enrolled_hash <> p->>'blockHash'
        OR s.enrolled_observed_at <> (p->>'observedAt')::timestamptz
      THEN RAISE EXCEPTION 'Morpho enrollment replay block disagreement'; END IF;
      RETURN true;
    END $$`

  await sql`CREATE OR REPLACE FUNCTION carry_morpho_v2_record_interval(p jsonb)
    RETURNS boolean LANGUAGE plpgsql AS $$
    DECLARE c carry_morpho_v2_flow_cursors%ROWTYPE;
      s carry_morpho_v2_flow_subjects%ROWTYPE;
      old carry_morpho_v2_flow_intervals%ROWTYPE;
      n integer;
    BEGIN
      SELECT * INTO c FROM carry_morpho_v2_flow_cursors
        WHERE vault = p->>'vault' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Morpho flow subject unenrolled'; END IF;
      SELECT * INTO s FROM carry_morpho_v2_flow_subjects WHERE vault = c.vault;
      IF s.manifest_sha256 IS DISTINCT FROM p->>'manifestSha256'
        OR s.asset IS DISTINCT FROM p->>'asset'
        OR s.seed_sha256 IS DISTINCT FROM p->>'seedSha256'
        OR s.board_sha256 IS DISTINCT FROM p->>'boardSha256'
        OR s.displayed_routes_sha256 IS DISTINCT FROM p->>'displayedRoutesSha256'
        OR s.cohort_id IS DISTINCT FROM p->>'cohortId'
        OR (p->>'priorHash') !~ '^0x[0-9a-f]{64}$'
        OR (p->>'toHash') !~ '^0x[0-9a-f]{64}$'
        OR (p->>'finalizedHeadHash') !~ '^0x[0-9a-f]{64}$'
        OR (p->>'combinedSetSha256') !~ '^[0-9a-f]{64}$'
        OR (p->>'payloadSha256') !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(p->'events') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p->'events') > 10000
        OR (p->>'toBlock')::bigint < (p->>'fromBlock')::bigint
        OR (p->>'toBlock')::bigint - (p->>'fromBlock')::bigint >= 512
        OR (p->>'toBlock')::bigint > (p->>'finalizedHeadBlock')::bigint
        OR ((p->>'toBlock')::bigint = (p->>'finalizedHeadBlock')::bigint
            AND p->>'toHash' <> p->>'finalizedHeadHash')
      THEN RAISE EXCEPTION 'invalid Morpho flow interval'; END IF;
      SELECT * INTO old FROM carry_morpho_v2_flow_intervals
        WHERE vault = c.vault AND from_block = (p->>'fromBlock')::bigint;
      IF FOUND THEN
        IF old.to_block IS DISTINCT FROM (p->>'toBlock')::bigint
          OR old.prior_hash IS DISTINCT FROM p->>'priorHash'
          OR old.to_hash IS DISTINCT FROM p->>'toHash'
          OR old.finalized_head_block IS DISTINCT FROM (p->>'finalizedHeadBlock')::bigint
          OR old.finalized_head_hash IS DISTINCT FROM p->>'finalizedHeadHash'
          OR old.to_observed_at IS DISTINCT FROM (p->>'toObservedAt')::timestamptz
          OR old.combined_set_sha256 IS DISTINCT FROM p->>'combinedSetSha256'
          OR old.payload_sha256 IS DISTINCT FROM p->>'payloadSha256'
          OR old.event_count IS DISTINCT FROM jsonb_array_length(p->'events')
          OR (SELECT count(*) FROM carry_morpho_v2_flow_events e
              WHERE e.vault = c.vault AND e.interval_from_block = old.from_block)
              <> old.event_count
          OR c.last_block < old.to_block
        THEN RAISE EXCEPTION 'Morpho flow replay disagreement'; END IF;
        RETURN false;
      END IF;
      IF c.last_block + 1 <> (p->>'fromBlock')::bigint
        OR c.last_hash <> p->>'priorHash'
      THEN RAISE EXCEPTION 'Morpho flow cursor or prior hash disagreement'; END IF;
      INSERT INTO carry_morpho_v2_flow_intervals
        (vault, from_block, to_block, prior_hash, to_hash, finalized_head_block,
         finalized_head_hash, to_observed_at, combined_set_sha256,
         payload_sha256, event_count)
      VALUES (c.vault, (p->>'fromBlock')::bigint, (p->>'toBlock')::bigint,
        p->>'priorHash', p->>'toHash', (p->>'finalizedHeadBlock')::bigint,
        p->>'finalizedHeadHash', (p->>'toObservedAt')::timestamptz,
        p->>'combinedSetSha256', p->>'payloadSha256',
        jsonb_array_length(p->'events'));
      INSERT INTO carry_morpho_v2_flow_events
        (vault, interval_from_block, block, block_hash, transaction_hash,
         transaction_index, log_index, event_kind, sender, owner, receiver,
         assets_raw, shares_raw, flow_class, force_event_in_transaction)
      SELECT c.vault, (p->>'fromBlock')::bigint, e.block::bigint, e.block_hash,
        e.transaction_hash, e.transaction_index, e.log_index, e.event_kind,
        e.sender, e.owner, e.receiver, e.assets_raw::numeric,
        e.shares_raw::numeric, e.flow_class, e.force_event_in_transaction
      FROM jsonb_to_recordset(p->'events') AS e(
        block text, block_hash text, transaction_hash text,
        transaction_index integer, log_index integer, event_kind text,
        sender text, owner text, receiver text, assets_raw text,
        shares_raw text, flow_class text, force_event_in_transaction boolean);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> jsonb_array_length(p->'events')
        OR EXISTS (SELECT 1 FROM carry_morpho_v2_flow_events e
          WHERE e.vault = c.vault AND e.interval_from_block = (p->>'fromBlock')::bigint
            AND (e.block < (p->>'fromBlock')::bigint OR e.block > (p->>'toBlock')::bigint))
      THEN RAISE EXCEPTION 'Morpho flow event range/count disagreement'; END IF;
      UPDATE carry_morpho_v2_flow_cursors
        SET last_block = (p->>'toBlock')::bigint, last_hash = p->>'toHash'
        WHERE vault = c.vault;
      RETURN true;
    END $$`

  await sql`CREATE OR REPLACE FUNCTION reject_carry_morpho_v2_flow_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Morpho flow evidence is append only'; END $$`
  for (const table of [
    'carry_morpho_v2_flow_subjects',
    'carry_morpho_v2_flow_intervals',
    'carry_morpho_v2_flow_events',
  ]) {
    // Identifiers are hardcoded above. Triggers guard evidence; cursors advance
    // only through the DB function and therefore remain mutable.
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${table}_immutable') THEN CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_carry_morpho_v2_flow_mutation(); END IF; END $$`,
    )
    await sql.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${table}_truncate') THEN CREATE TRIGGER ${table}_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION reject_carry_morpho_v2_flow_mutation(); END IF; END $$`,
    )
  }
}

async function main() {
  const { get } = readEnv()
  const url =
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    get('DATABASE_URL_UNPOOLED') ||
    get('DATABASE_URL')
  if (!url) throw new Error('database_url_required')
  await apply(neon(url))
  process.stdout.write('carry_morpho_v2_flow ready\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('carry_morpho_v2_flow_ddl_failed\n')
    process.exitCode = 1
  })
}
