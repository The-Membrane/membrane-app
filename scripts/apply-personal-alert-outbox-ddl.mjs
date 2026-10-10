// INERT additive migration. Activation gates, in order:
// 1. Verify the signed-intent/link SQL and this SQL on disposable PostgreSQL,
//    including concurrent lease, pause, /stop, expiry and crash transitions.
// 2. Attest deployed chain-1 emitter address, ABI/log subject ownership and
//    finalized block hash with a reorg-aware indexer; no simulator events.
// 3. Give that indexer a least-privilege DB role and backfill no earlier event.
// 4. Build a separate sender that rechecks consent immediately before I/O,
//    quarantines uncertain HTTP outcomes and exposes operator reconciliation.
// 5. Verify inbound Telegram operation and confirmed email ownership before
//    enabling their respective channels; test end-to-end on a disposable rig.
// This script creates no sender, subscription, schedule, or historical backfill.
import { neon } from '@neondatabase/serverless'
const usage = 'Usage: node scripts/apply-personal-alert-outbox-ddl.mjs [--help|--dry-run|--run]'
const mode = process.argv.slice(2)
if (mode.length > 1 || (mode.length === 1 && !['--help', '--dry-run', '--run'].includes(mode[0]))) {
  console.error(usage)
  process.exit(2)
}
if (mode.length === 0 || mode[0] === '--help' || mode[0] === '--dry-run') {
  console.log(
    `${usage}\nNo database connection or SQL executed. --run requires USER_ALERT_MIGRATION_DATABASE_URL.`,
  )
  process.exit(0)
}

// Deliberately do not read .env.local or fall back to the app's general DB URL.
// An operator must provide a dedicated migration credential for this one run.
const url = process.env.USER_ALERT_MIGRATION_DATABASE_URL?.trim()
if (!url) {
  console.error('USER_ALERT_MIGRATION_DATABASE_URL is required for --run; no SQL executed.')
  process.exit(2)
}

try {
  const sql = neon(url)

  // A calculated venue-capacity shift has no tx/log identity and MUST NOT be
  // manufactured as a chain log here. It needs its own atomic source/event key.
  await sql`CREATE TABLE IF NOT EXISTS user_alert_chain_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id = 1),
  emitter_address text NOT NULL CHECK (emitter_address ~ '^0x[0-9a-f]{40}$'),
  transaction_hash text NOT NULL CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number bigint NOT NULL CHECK (block_number > 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  first_observed_at timestamptz NOT NULL CHECK (first_observed_at >= occurred_at),
  kind text NOT NULL CHECK (kind IN ('delay_started', 'position_kept', 'curator_vault_action')),
  subject_address text NOT NULL CHECK (subject_address ~ '^0x[0-9a-f]{40}$'),
  source_attestation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (chain_id, emitter_address, transaction_hash, log_index)
)`

  await sql`CREATE TABLE IF NOT EXISTS user_alert_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES user_alert_chain_events(id),
  recipient_address text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('telegram', 'email')),
  consent_nonce text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'leased', 'sending', 'sent', 'suppressed', 'dead', 'uncertain')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, recipient_address, channel),
  CHECK ((state IN ('leased', 'sending')) = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
)`
  await sql`CREATE INDEX IF NOT EXISTS user_alert_outbox_due_idx
  ON user_alert_outbox (next_attempt_at, id) WHERE state = 'queued'`
  await sql`CREATE INDEX IF NOT EXISTS user_alert_outbox_lease_idx
  ON user_alert_outbox (lease_until) WHERE state IN ('leased', 'sending')`

  // One row per source event + wallet + channel. A signed current preference,
  // wallet ownership mapping and confirmed destination must already exist when
  // the event OCCURRED; the event cannot be replayed into newly joined users.
  // The caller must separately attest that the subject was decoded from the
  // deployed emitter, not inferred from a simulator or arbitrary address input.
  await sql`CREATE OR REPLACE FUNCTION enqueue_user_alert_chain_event(
  p_event_id bigint, p_recipient_address text, p_channel text
) RETURNS bigint LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE v_id bigint;
BEGIN
  IF p_channel IS NULL OR p_channel NOT IN ('telegram', 'email') THEN RETURN NULL; END IF;
  INSERT INTO public.user_alert_outbox (event_id, recipient_address, channel, consent_nonce)
  SELECT e.id, pg_catalog.lower(p.address), p_channel, p.consent_nonce
  FROM public.user_alert_chain_events e
  JOIN public.user_alert_preferences p ON pg_catalog.lower(p.address) = pg_catalog.lower(p_recipient_address)
  WHERE e.id = p_event_id AND e.subject_address = pg_catalog.lower(p.address)
    AND p.paused_at IS NULL AND p.event_kinds ? e.kind
    AND p.requested_channels ? p_channel
    AND p.consent_at <= e.occurred_at
    AND p.consent_at <= e.first_observed_at
    AND CASE p_channel
      WHEN 'telegram' THEN p.telegram_chat_id IS NOT NULL
        AND p.telegram_confirmed_at >= p.consent_at
        AND p.telegram_confirmed_at <= e.occurred_at
        AND p.telegram_confirmed_at <= e.first_observed_at
      ELSE p.email_address IS NOT NULL
        AND p.email_confirmed_at >= p.consent_at
        AND p.email_confirmed_at <= e.occurred_at
        AND p.email_confirmed_at <= e.first_observed_at
    END
  ON CONFLICT (event_id, recipient_address, channel) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$`

  // Expired pre-send leases are safe to requeue. An expired "sending" lease is
  // NOT safe to retry: Telegram may have accepted the request before a crash.
  await sql`CREATE OR REPLACE FUNCTION expire_user_alert_leases()
RETURNS TABLE(requeued integer, uncertain integer)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  WITH expired AS (
    UPDATE user_alert_outbox o
    SET state = CASE WHEN o.state = 'leased' THEN 'queued' ELSE 'uncertain' END,
        last_error_code = CASE WHEN o.state = 'leased' THEN 'lease_expired_before_send'
          ELSE 'delivery_outcome_unknown' END,
        lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
    WHERE o.state IN ('leased', 'sending') AND o.lease_until < clock_timestamp()
    RETURNING state
  ) SELECT count(*) FILTER (WHERE state = 'queued')::integer,
           count(*) FILTER (WHERE state = 'uncertain')::integer
    INTO requeued, uncertain FROM expired;
  RETURN NEXT;
END;
$$`

  // Run after expiry and before leasing. Paused, revoked, stale-consent or
  // replaced-destination rows never linger as apparently deliverable work;
  // exhausted pre-send retries become a distinct terminal dead letter.
  await sql`CREATE OR REPLACE FUNCTION retire_user_alert_outbox()
RETURNS TABLE(suppressed integer, dead integer)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  WITH retired AS (
    UPDATE user_alert_outbox o
    SET state = CASE WHEN o.attempts >= 5 THEN 'dead' ELSE 'suppressed' END,
        last_error_code = CASE WHEN o.attempts >= 5 THEN 'retry_budget_exhausted'
          ELSE 'consent_or_destination_revoked' END,
        updated_at = clock_timestamp()
    WHERE o.state = 'queued' AND (o.attempts >= 5 OR NOT EXISTS (
      SELECT 1 FROM user_alert_chain_events e
      JOIN user_alert_preferences p ON lower(p.address) = o.recipient_address
      WHERE e.id = o.event_id AND e.subject_address = o.recipient_address
        AND p.consent_nonce = o.consent_nonce AND p.paused_at IS NULL
        AND p.event_kinds ? e.kind AND p.requested_channels ? o.channel
        AND p.consent_at <= e.occurred_at AND p.consent_at <= e.first_observed_at
        AND CASE o.channel WHEN 'telegram' THEN p.telegram_chat_id IS NOT NULL
          AND p.telegram_confirmed_at >= p.consent_at
          AND p.telegram_confirmed_at <= e.occurred_at
          AND p.telegram_confirmed_at <= e.first_observed_at
          ELSE p.email_address IS NOT NULL AND p.email_confirmed_at >= p.consent_at
          AND p.email_confirmed_at <= e.occurred_at
          AND p.email_confirmed_at <= e.first_observed_at END
    ))
    RETURNING state
  ) SELECT count(*) FILTER (WHERE state = 'suppressed')::integer,
           count(*) FILTER (WHERE state = 'dead')::integer
    INTO suppressed, dead FROM retired;
  RETURN NEXT;
END;
$$`

  // SKIP LOCKED + conditional update give each due row one finite lease. A
  // changed consent nonce/paused channel never leases an older queue row.
  await sql`CREATE OR REPLACE FUNCTION lease_user_alert_outbox(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id bigint, event_id bigint, recipient_address text, channel text, lease_token uuid)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  IF p_limit IS NULL OR p_lease_seconds IS NULL OR p_limit < 1 OR p_limit > 100
    OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid outbox lease bounds';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM user_alert_outbox o
    JOIN user_alert_chain_events e ON e.id = o.event_id
    JOIN user_alert_preferences p ON lower(p.address) = o.recipient_address
    WHERE o.state = 'queued' AND o.channel = 'telegram'
      AND e.kind IN ('delay_started', 'position_kept')
      AND o.next_attempt_at <= clock_timestamp() AND o.attempts < 5
      AND e.subject_address = o.recipient_address
      AND p.consent_nonce = o.consent_nonce AND p.paused_at IS NULL
      AND p.event_kinds ? e.kind AND p.requested_channels ? o.channel
      AND p.consent_at <= e.occurred_at AND p.consent_at <= e.first_observed_at
      AND CASE o.channel WHEN 'telegram' THEN p.telegram_chat_id IS NOT NULL
        AND p.telegram_confirmed_at >= p.consent_at
        AND p.telegram_confirmed_at <= e.occurred_at
        AND p.telegram_confirmed_at <= e.first_observed_at
        ELSE p.email_address IS NOT NULL AND p.email_confirmed_at >= p.consent_at
        AND p.email_confirmed_at <= e.occurred_at
        AND p.email_confirmed_at <= e.first_observed_at END
    ORDER BY o.next_attempt_at, o.id LIMIT p_limit FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE user_alert_outbox o
    SET state = 'leased', attempts = o.attempts + 1,
        lease_token = gen_random_uuid(),
        lease_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        updated_at = clock_timestamp()
  FROM due WHERE o.id = due.id
  RETURNING o.id, o.event_id, o.recipient_address, o.channel, o.lease_token;
END;
$$`

  // Final consent/destination read occurs before external I/O, in the same
  // statement that marks "sending". A pause or /stop racing AFTER this commit
  // can still precede the HTTP request; strict post-revocation non-delivery is
  // impossible without holding a lock across the external call. Disclose this.
  await sql`CREATE OR REPLACE FUNCTION begin_user_alert_delivery(p_id bigint, p_token uuid)
RETURNS TABLE(destination text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  WITH eligible AS (
    SELECT o.id, CASE o.channel WHEN 'telegram' THEN p.telegram_chat_id
      ELSE p.email_address END AS address
    FROM user_alert_outbox o
    JOIN user_alert_chain_events e ON e.id = o.event_id
    JOIN user_alert_preferences p ON lower(p.address) = o.recipient_address
    WHERE o.id = p_id AND o.lease_token = p_token AND o.state = 'leased'
      AND o.lease_until > clock_timestamp()
      AND o.channel = 'telegram' AND e.kind IN ('delay_started', 'position_kept')
      AND p.consent_nonce = o.consent_nonce AND p.paused_at IS NULL
      AND e.subject_address = o.recipient_address
      AND p.event_kinds ? e.kind AND p.requested_channels ? o.channel
      AND p.consent_at <= e.occurred_at AND p.consent_at <= e.first_observed_at
      AND CASE o.channel WHEN 'telegram' THEN p.telegram_chat_id IS NOT NULL
        AND p.telegram_confirmed_at >= p.consent_at
        AND p.telegram_confirmed_at <= e.occurred_at
        AND p.telegram_confirmed_at <= e.first_observed_at
        ELSE p.email_address IS NOT NULL AND p.email_confirmed_at >= p.consent_at
        AND p.email_confirmed_at <= e.occurred_at
        AND p.email_confirmed_at <= e.first_observed_at END
    FOR UPDATE OF o, p
  ), marked AS (
    UPDATE user_alert_outbox o SET state = 'sending', updated_at = clock_timestamp()
    FROM eligible x WHERE o.id = x.id RETURNING x.address
  ) SELECT marked.address INTO destination FROM marked;
  IF FOUND THEN RETURN NEXT; END IF;
END;
$$`

  await sql`CREATE OR REPLACE FUNCTION complete_user_alert_delivery(p_id bigint, p_token uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  UPDATE user_alert_outbox
    SET state = 'sent', sent_at = clock_timestamp(), lease_token = NULL,
        lease_until = NULL, updated_at = clock_timestamp()
    WHERE id = p_id AND lease_token = p_token AND state = 'sending'
      AND lease_until > clock_timestamp();
  RETURN FOUND;
END;
$$`

  await sql`CREATE OR REPLACE FUNCTION retry_user_alert_before_send(
  p_id bigint, p_token uuid, p_delay_seconds integer, p_error_code text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  IF p_delay_seconds IS NULL OR p_delay_seconds < 30 OR p_delay_seconds > 86400 THEN
    RAISE EXCEPTION 'invalid retry delay';
  END IF;
  UPDATE user_alert_outbox
    SET state = 'queued', next_attempt_at = clock_timestamp() + make_interval(secs => p_delay_seconds),
        lease_token = NULL, lease_until = NULL, last_error_code = left(p_error_code, 80),
        updated_at = clock_timestamp()
    WHERE id = p_id AND lease_token = p_token AND state = 'leased'
      AND lease_until > clock_timestamp();
  RETURN FOUND;
END;
$$`

  // A malformed or mismatched source discovered after leasing must terminate
  // before any send. Otherwise expiry would requeue the same poison row forever.
  await sql`CREATE OR REPLACE FUNCTION suppress_user_alert_before_send(
  p_id bigint, p_token uuid, p_reason text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
BEGIN
  UPDATE user_alert_outbox
    SET state = 'suppressed', lease_token = NULL, lease_until = NULL,
        last_error_code = left(coalesce(p_reason, 'invalid_source'), 80),
        updated_at = clock_timestamp()
    WHERE id = p_id AND lease_token = p_token AND state = 'leased'
      AND lease_until > clock_timestamp();
  RETURN FOUND;
END;
$$`

  console.log('personal alert outbox schema ready; no sender enabled')
} catch {
  // Database driver errors can include connection details. Never print them.
  console.error(
    'Personal alert outbox migration failed. Earlier statements may have applied; inspect the target database.',
  )
  process.exitCode = 1
}
