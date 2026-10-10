import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'

import { db } from '@/db'

import type { ConsentChoices } from './consent'

type PreferenceState = {
  address: string
  eventKinds: string[]
  requestedChannels: string[]
  consentAt: Date
  pausedAt: Date | null
  telegramConfirmedAt: Date | null
  emailConfirmedAt: Date | null
}

function shape(row: PreferenceState | undefined) {
  if (!row) return { exists: false as const }
  const confirmedForCurrentConsent = (channel: string, confirmedAt: Date | null) =>
    row.pausedAt === null &&
    row.requestedChannels.includes(channel) &&
    confirmedAt !== null &&
    Number.isFinite(new Date(row.consentAt).getTime()) &&
    new Date(confirmedAt).getTime() >= new Date(row.consentAt).getTime()
  return {
    exists: true as const,
    address: row.address,
    events: row.eventKinds,
    requestedChannels: row.requestedChannels,
    paused: row.pausedAt !== null,
    telegramConfirmed: confirmedForCurrentConsent('telegram', row.telegramConfirmedAt),
    emailConfirmed: confirmedForCurrentConsent('email', row.emailConfirmedAt),
    deliveryEnabled: false as const,
  }
}

export async function readPreference(address: string) {
  const result = await db.execute(sql`
    SELECT address, event_kinds AS "eventKinds", requested_channels AS "requestedChannels",
      consent_at AS "consentAt", paused_at AS "pausedAt",
      telegram_confirmed_at AS "telegramConfirmedAt",
      email_confirmed_at AS "emailConfirmedAt"
    FROM user_alert_preferences WHERE address = ${address} LIMIT 1`)
  return shape(result.rows[0] as PreferenceState | undefined)
}

export async function savePreference(choice: ConsentChoices, statement: string, signature: string) {
  const paused = choice.action === 'pause'
  // One PostgreSQL statement is atomic on Neon HTTP. The preference write only
  // receives a row when this signed nonce was claimed and its issued time is
  // newer than the current signed intent. A stale nonce remains claimed while
  // its preference update is skipped; an UPSERT error rolls the claim back.
  const saved = await db.execute(sql`
    WITH claimed AS (
      INSERT INTO user_alert_nonces (nonce, address) VALUES (${choice.nonce}, ${choice.address})
      ON CONFLICT DO NOTHING RETURNING nonce
    )
    INSERT INTO user_alert_preferences (
      address, event_kinds, requested_channels, consent_nonce, consent_statement,
      consent_signature, consent_at, signed_issued_at, paused_at, telegram_chat_id,
      telegram_confirmed_at, email_address, email_confirmed_at, updated_at
    ) SELECT
      ${choice.address}, ${JSON.stringify(choice.events)}::jsonb,
      ${JSON.stringify(choice.channels)}::jsonb, claimed.nonce, ${statement},
      ${signature}, now(), ${choice.issuedAt}::timestamptz,
      CASE WHEN ${paused} THEN now() ELSE NULL END,
      NULL, NULL, ${choice.emailAddress ?? null}, NULL, now()
    FROM claimed
    WHERE true
    ON CONFLICT (address) DO UPDATE SET
      event_kinds = CASE WHEN ${paused} THEN user_alert_preferences.event_kinds ELSE EXCLUDED.event_kinds END,
      requested_channels = CASE WHEN ${paused} THEN user_alert_preferences.requested_channels ELSE EXCLUDED.requested_channels END,
      consent_nonce = EXCLUDED.consent_nonce,
      consent_statement = EXCLUDED.consent_statement,
      consent_signature = EXCLUDED.consent_signature,
      signed_issued_at = EXCLUDED.signed_issued_at,
      consent_at = now(), paused_at = EXCLUDED.paused_at,
      telegram_chat_id = CASE
        WHEN ${paused} THEN user_alert_preferences.telegram_chat_id ELSE NULL END,
      telegram_confirmed_at = CASE
        WHEN ${paused} THEN user_alert_preferences.telegram_confirmed_at ELSE NULL END,
      email_address = CASE
        WHEN ${paused} THEN user_alert_preferences.email_address ELSE EXCLUDED.email_address END,
      email_confirmed_at = CASE
        WHEN ${paused} THEN user_alert_preferences.email_confirmed_at ELSE NULL END,
      updated_at = now()
    WHERE EXCLUDED.signed_issued_at > user_alert_preferences.signed_issued_at
    RETURNING address, event_kinds AS "eventKinds",
      requested_channels AS "requestedChannels", consent_at AS "consentAt",
      paused_at AS "pausedAt", telegram_confirmed_at AS "telegramConfirmedAt",
      email_confirmed_at AS "emailConfirmedAt"`)
  if (saved.rows.length === 0) return { replay: true as const }

  return { replay: false as const, preference: shape(saved.rows[0] as PreferenceState) }
}

export async function createTelegramLink(choice: ConsentChoices, botUsername: string) {
  if (choice.action !== 'subscribe' || !choice.channels.includes('telegram')) return null
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) return null
  const token = `a_${randomBytes(32).toString('base64url')}`
  const tokenHash = createHash('sha256').update(token).digest('hex')
  await db.execute(sql`
    INSERT INTO user_alert_channel_links (token_hash, address, consent_nonce, expires_at)
    VALUES (${tokenHash}, ${choice.address}, ${choice.nonce}, now() + interval '10 minutes')`)
  return `https://t.me/${botUsername}?start=${token}`
}
