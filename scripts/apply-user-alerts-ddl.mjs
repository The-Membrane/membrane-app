// Additive schema for wallet-signed alert INTENT and one-time Telegram linking.
// This does not create a sender or enable personal alerts. Run manually only
// after reviewing the target database; never use drizzle-kit push for this.

import { neon } from '@neondatabase/serverless'
const usage = 'Usage: node scripts/apply-user-alerts-ddl.mjs [--help|--dry-run|--run]'
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

  await sql`CREATE TABLE IF NOT EXISTS user_alert_nonces (
  nonce text PRIMARY KEY,
  address text NOT NULL,
  used_at timestamptz NOT NULL DEFAULT now()
)`
  await sql`CREATE INDEX IF NOT EXISTS user_alert_nonces_used_idx ON user_alert_nonces (used_at)`

  await sql`CREATE TABLE IF NOT EXISTS user_alert_preferences (
  address text PRIMARY KEY,
  event_kinds jsonb NOT NULL,
  requested_channels jsonb NOT NULL,
  consent_nonce text NOT NULL REFERENCES user_alert_nonces(nonce),
  consent_statement text NOT NULL,
  consent_signature text NOT NULL,
  consent_at timestamptz NOT NULL DEFAULT now(),
  signed_issued_at timestamptz NOT NULL,
  paused_at timestamptz,
  telegram_chat_id text,
  telegram_confirmed_at timestamptz,
  email_address text,
  email_confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
)`
  // Existing rows predate this ordering key. Their DB consent time is a
  // conservative floor: an older in-flight challenge cannot replace them.
  await sql`ALTER TABLE user_alert_preferences ADD COLUMN IF NOT EXISTS signed_issued_at timestamptz`
  await sql`UPDATE user_alert_preferences SET signed_issued_at = consent_at WHERE signed_issued_at IS NULL`
  await sql`ALTER TABLE user_alert_preferences ALTER COLUMN signed_issued_at SET NOT NULL`

  await sql`CREATE TABLE IF NOT EXISTS user_alert_channel_links (
  token_hash text PRIMARY KEY,
  address text NOT NULL REFERENCES user_alert_preferences(address) ON DELETE CASCADE,
  consent_nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  telegram_chat_id text
)`
  await sql`CREATE INDEX IF NOT EXISTS user_alert_channel_links_address_idx ON user_alert_channel_links (address, expires_at DESC)`

  // Bot inbound can arrive concurrently (webhook and poller). Both functions
  // serialize on the same chat key, then take a fresh READ COMMITTED snapshot
  // after acquiring the lock. A one-statement CTE alone cannot make /stop see
  // a binding that was uncommitted when its statement snapshot began.
  await sql`CREATE OR REPLACE FUNCTION confirm_user_alert_telegram_link(
  p_token_hash text, p_chat_id text
) RETURNS TABLE(address text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
  v_link record;
  v_address text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('membrane-alert-chat:' || p_chat_id, 0));
  UPDATE user_alert_channel_links l
    SET consumed_at = clock_timestamp(), telegram_chat_id = p_chat_id
    WHERE l.token_hash = p_token_hash AND l.consumed_at IS NULL AND l.expires_at > clock_timestamp()
      AND EXISTS (
        SELECT 1 FROM user_alert_preferences p
        WHERE p.address = l.address AND p.consent_nonce = l.consent_nonce
          AND p.paused_at IS NULL AND p.requested_channels ? 'telegram'
      )
    RETURNING l.address, l.consent_nonce INTO v_link;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE user_alert_preferences p
    SET telegram_chat_id = p_chat_id, telegram_confirmed_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE p.address = v_link.address AND p.consent_nonce = v_link.consent_nonce
      AND p.paused_at IS NULL AND p.requested_channels ? 'telegram'
    RETURNING p.address INTO v_address;
  IF FOUND THEN
    address := v_address;
    RETURN NEXT;
  END IF;
END;
$$`

  await sql`CREATE OR REPLACE FUNCTION disconnect_user_alert_telegram_chat(
  p_chat_id text
) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('membrane-alert-chat:' || p_chat_id, 0));
  WITH cleared AS (
    UPDATE user_alert_preferences p
      SET telegram_chat_id = NULL, telegram_confirmed_at = NULL, updated_at = clock_timestamp()
      WHERE p.telegram_chat_id = p_chat_id
      RETURNING p.address
  ), invalidated AS (
    UPDATE user_alert_channel_links l
      SET consumed_at = clock_timestamp()
      WHERE l.consumed_at IS NULL AND l.address IN (SELECT c.address FROM cleared c)
      RETURNING l.token_hash
  ) SELECT count(*)::integer INTO v_count FROM cleared;
  RETURN v_count;
END;
$$`

  console.log('user alert intent schema ready; no sender enabled')
} catch {
  // Database driver errors can include connection details. Never print them.
  console.error(
    'Alert intent migration failed. Earlier statements may have applied; inspect the target database.',
  )
  process.exitCode = 1
}
