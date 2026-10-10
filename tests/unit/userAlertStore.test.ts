import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mock = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mock.execute } }))

import { createConsentChallenge } from '@/lib/alerts/challenge'
import { consentStatement, normalizeChoices } from '@/lib/alerts/consent'
import { readPreference, savePreference } from '@/lib/alerts/store'

const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7'
const SECRET = 'alert-consent-secret-for-tests-only-000001'
const dialect = new PgDialect()

function choice(action: 'subscribe' | 'pause', issuedAt = new Date()) {
  return normalizeChoices({
    address: ADDRESS,
    action,
    events: action === 'subscribe' ? ['delay_started'] : [],
    channels: action === 'subscribe' ? ['telegram'] : [],
    ...createConsentChallenge(ADDRESS, SECRET, issuedAt),
  })!
}

beforeEach(() => {
  mock.execute.mockReset()
  mock.execute.mockResolvedValueOnce({
    rows: [
      {
        address: ADDRESS,
        eventKinds: ['delay_started'],
        requestedChannels: ['telegram'],
        consentAt: new Date('2026-09-27T10:00:00Z'),
        pausedAt: new Date(),
        telegramConfirmedAt: new Date('2026-09-27T09:00:00Z'),
        emailConfirmedAt: null,
      },
    ],
  })
})

describe('alert preference persistence', () => {
  it('pauses without erasing prior choices or chat binding, but no longer labels that chat confirmed', async () => {
    const signed = choice('pause')
    const result = await savePreference(signed, consentStatement(signed), '0xsigned')
    expect(result.replay).toBe(false)
    expect(result.preference).toMatchObject({
      paused: true,
      events: ['delay_started'],
      requestedChannels: ['telegram'],
      telegramConfirmed: false,
    })
    expect(mock.execute).toHaveBeenCalledTimes(1)
    const query = dialect.sqlToQuery(mock.execute.mock.calls[0][0])
    expect(query.sql).toContain('WITH claimed AS')
    expect(query.sql).toContain('FROM claimed')
    expect(query.sql).toContain('WHERE true')
    expect(query.sql).toContain('RETURNING address, event_kinds AS "eventKinds"')
    expect(query.sql).toContain('event_kinds = CASE WHEN')
    expect(query.sql).toContain('THEN user_alert_preferences.event_kinds ELSE EXCLUDED.event_kinds')
    expect(query.sql).toContain('THEN user_alert_preferences.telegram_chat_id ELSE NULL END')
    expect(query.sql).toContain('consent_nonce = EXCLUDED.consent_nonce')
    expect(query.params).toContain(true)
  })

  it('new subscribe clears prior Telegram and email bindings even when requested again', async () => {
    const signed = choice('subscribe')
    await savePreference(signed, consentStatement(signed), '0xsigned')
    const query = dialect.sqlToQuery(mock.execute.mock.calls[0][0])
    expect(query.sql).not.toContain('user_alert_preferences.requested_channels ?')
    expect(query.sql).toContain('THEN user_alert_preferences.telegram_chat_id ELSE NULL END')
    expect(query.sql).toContain('THEN user_alert_preferences.telegram_confirmed_at ELSE NULL END')
    expect(query.sql).toContain(
      'THEN user_alert_preferences.email_address ELSE EXCLUDED.email_address END',
    )
    expect(query.params).toContain(null)
    expect(query.sql).toContain('THEN user_alert_preferences.email_confirmed_at ELSE NULL END')
    expect(query.sql).toContain('paused_at = EXCLUDED.paused_at')
    expect(query.params).toContain(false)
  })

  it('stores signed normalized email as pending and clears confirmation on replacement', async () => {
    const signed = normalizeChoices({
      ...choice('subscribe'),
      channels: ['email'],
      emailAddress: '  ALICE+ALERTS@Example.COM  ',
    })!
    expect(signed.emailAddress).toBe('ALICE+ALERTS@example.com')
    await savePreference(signed, consentStatement(signed), '0xsigned')
    const query = dialect.sqlToQuery(mock.execute.mock.calls[0][0])
    expect(query.params).toContain('ALICE+ALERTS@example.com')
    expect(
      query.params.some(
        (param) =>
          typeof param === 'string' && param.includes('Email address: ALICE+ALERTS@example.com'),
      ),
    ).toBe(true)
    expect(query.sql).toContain('email_address = CASE')
    expect(query.sql).toContain('ELSE EXCLUDED.email_address END')
    expect(query.sql).toContain('THEN user_alert_preferences.email_confirmed_at ELSE NULL END')
    expect(query.sql).not.toContain('email_address AS')
  })

  it('claims a late older nonce without allowing it to replace newer signed intent', async () => {
    const older = choice('subscribe', new Date('2026-09-27T10:00:00.000Z'))
    const newer = choice('subscribe', new Date('2026-09-27T10:00:01.000Z'))
    mock.execute
      .mockReset()
      .mockResolvedValueOnce({
        rows: [
          {
            address: ADDRESS,
            eventKinds: ['delay_started'],
            requestedChannels: ['telegram'],
            consentAt: new Date('2026-09-27T10:02:00Z'),
            pausedAt: null,
            telegramConfirmedAt: null,
            emailConfirmedAt: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
    expect((await savePreference(newer, consentStatement(newer), '0xnewer')).replay).toBe(false)
    expect(await savePreference(older, consentStatement(older), '0xolder')).toEqual({
      replay: true,
    })
    const newerQuery = dialect.sqlToQuery(mock.execute.mock.calls[0][0])
    const olderQuery = dialect.sqlToQuery(mock.execute.mock.calls[1][0])
    for (const query of [newerQuery, olderQuery]) {
      expect(query.sql).toContain('WITH claimed AS')
      expect(query.sql).toContain('signed_issued_at = EXCLUDED.signed_issued_at')
      expect(query.sql).toContain(
        'WHERE EXCLUDED.signed_issued_at > user_alert_preferences.signed_issued_at',
      )
      expect(query.sql).toContain('consent_at = now()')
    }
    expect(newerQuery.params).toContain(newer.issuedAt)
    expect(olderQuery.params).toContain(older.issuedAt)
    expect(Date.parse(newer.issuedAt)).toBeGreaterThan(Date.parse(older.issuedAt))
  })

  it('adds a conservative signed-time floor for pre-migration preferences', () => {
    const ddl = readFileSync(resolve(process.cwd(), 'scripts/apply-user-alerts-ddl.mjs'), 'utf8')
    expect(ddl).toContain('signed_issued_at timestamptz NOT NULL')
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS signed_issued_at timestamptz')
    expect(ddl).toContain('SET signed_issued_at = consent_at WHERE signed_issued_at IS NULL')
    expect(ddl).toContain('ALTER COLUMN signed_issued_at SET NOT NULL')
  })

  it('does not advertise consent readiness before the signed-time migration', () => {
    const status = readFileSync(resolve(process.cwd(), 'pages/api/alerts/status.ts'), 'utf8')
    expect(status).toContain("column_name = 'signed_issued_at'")
    expect(status).toContain('schemaReady = result.rows[0]?.ready === true')
  })

  it('reports a nonce replay without reading or changing a preference', async () => {
    mock.execute.mockReset().mockResolvedValueOnce({ rows: [] })
    const signed = choice('subscribe')
    expect(await savePreference(signed, consentStatement(signed), '0xsigned')).toEqual({
      replay: true,
    })
    expect(mock.execute).toHaveBeenCalledTimes(1)
    const query = dialect.sqlToQuery(mock.execute.mock.calls[0][0])
    expect(query.sql).toContain('ON CONFLICT DO NOTHING RETURNING nonce')
    expect(query.sql).toContain('INSERT INTO user_alert_preferences')
  })

  it('propagates an atomic write failure and does not report the nonce claimed', async () => {
    mock.execute.mockReset().mockRejectedValueOnce(new Error('preference constraint failure'))
    const signed = choice('subscribe')
    await expect(savePreference(signed, consentStatement(signed), '0xsigned')).rejects.toThrow(
      'preference constraint failure',
    )
    expect(mock.execute).toHaveBeenCalledTimes(1)
  })

  it('only reports a currently requested, unpaused channel confirmed after consent', async () => {
    mock.execute.mockReset().mockResolvedValue({
      rows: [
        {
          address: ADDRESS,
          eventKinds: ['delay_started'],
          requestedChannels: ['telegram'],
          consentAt: new Date('2026-09-27T10:00:00Z'),
          pausedAt: null,
          telegramConfirmedAt: new Date('2026-09-27T10:01:00Z'),
          emailConfirmedAt: new Date('2026-09-27T10:01:00Z'),
          emailAddress: 'private@example.com',
        },
      ],
    })
    const preference = await readPreference(ADDRESS)
    expect(preference).toMatchObject({
      telegramConfirmed: true,
      emailConfirmed: false,
    })
    expect(preference).not.toHaveProperty('emailAddress')
  })

  it('does not count a pre-consent confirmation as current', async () => {
    mock.execute.mockReset().mockResolvedValue({
      rows: [
        {
          address: ADDRESS,
          eventKinds: ['delay_started'],
          requestedChannels: ['telegram'],
          consentAt: new Date('2026-09-27T10:00:00Z'),
          pausedAt: null,
          telegramConfirmedAt: new Date('2026-09-27T09:59:59Z'),
          emailConfirmedAt: null,
        },
      ],
    })
    expect(await readPreference(ADDRESS)).toMatchObject({ telegramConfirmed: false })
  })
})
