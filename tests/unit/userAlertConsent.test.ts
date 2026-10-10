import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'

import { createConsentChallenge, validConsentChallenge } from '@/lib/alerts/challenge'
import { consentStatement, normalizeChoices, normalizeEmailAddress } from '@/lib/alerts/consent'
import { handleUpdate } from '@/scripts/lib/telegramBot.mjs'
import * as telegramLogic from '@/components/Radar/telegramLogic'

const SECRET = 'alert-consent-secret-for-tests-only-000001'
const ACCOUNT = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)

function makeChoice(action: 'subscribe' | 'pause' | 'inspect' = 'subscribe') {
  const challenge = createConsentChallenge(
    ACCOUNT.address,
    SECRET,
    new Date('2026-09-27T18:00:00Z'),
  )
  return normalizeChoices({
    address: ACCOUNT.address,
    action,
    events: action === 'subscribe' ? ['position_kept', 'delay_started'] : [],
    channels: action === 'subscribe' ? ['telegram'] : [],
    ...challenge,
  })!
}

describe('signed alert consent', () => {
  it('uses a bounded HMAC challenge and a deterministic statement binding the exact choices', async () => {
    const choice = makeChoice()
    expect(validConsentChallenge(choice, SECRET, Date.parse('2026-09-27T18:09:59Z'))).toBe(true)
    expect(validConsentChallenge(choice, SECRET, Date.parse('2026-09-27T18:10:01Z'))).toBe(false)
    const signature = await ACCOUNT.signMessage({ message: consentStatement(choice) })
    const { verifyMessage } = await import('viem')
    expect(
      await verifyMessage({
        address: choice.address,
        message: consentStatement(choice),
        signature,
      }),
    ).toBe(true)
    expect(consentStatement(choice)).toContain('Events: delay_started,position_kept')
    expect(
      validConsentChallenge(
        { ...choice, address: '0x52908400098527886E0F7030069857D2E4169EE7' },
        SECRET,
        Date.parse('2026-09-27T18:01:00Z'),
      ),
    ).toBe(false)
    expect(
      await verifyMessage({
        address: choice.address,
        message: consentStatement({ ...choice, events: ['position_kept'] }),
        signature,
      }),
    ).toBe(false)
  })

  it('rejects duplicate, unknown, missing, and contradictory choices', () => {
    const base = makeChoice()
    expect(normalizeChoices({ ...base, events: ['position_kept', 'position_kept'] })).toBeNull()
    expect(normalizeChoices({ ...base, events: ['fake'] })).toBeNull()
    expect(normalizeChoices({ ...base, channels: [] })).toBeNull()
    expect(normalizeChoices({ ...base, action: 'pause' })).toBeNull()
    expect(normalizeChoices({ ...base, action: 'pause', events: [], channels: [] })).not.toBeNull()
  })

  it('preserves the exact Version 1 Telegram statement and binds normalized email in Version 2', async () => {
    const telegram = makeChoice()
    expect(consentStatement(telegram)).toBe(
      [
        'Membrane alert preference consent',
        'Version: 1',
        'Chain: Ethereum',
        `Address: ${telegram.address}`,
        'Action: subscribe',
        'Events: delay_started,position_kept',
        'Requested channels: telegram',
        'Delivery requires separate channel confirmation and supported event sources.',
        `Issued at: ${telegram.issuedAt}`,
        `Nonce: ${telegram.nonce}`,
      ].join('\n'),
    )
    const email = normalizeChoices({
      ...telegram,
      channels: ['email'],
      emailAddress: '  Alice+Alerts@EXAMPLE.COM  ',
    })!
    expect(email.emailAddress).toBe('Alice+Alerts@example.com')
    expect(consentStatement(email)).toContain('Version: 2\n')
    expect(consentStatement(email)).toContain('Email address: Alice+Alerts@example.com\n')
    const signature = await ACCOUNT.signMessage({ message: consentStatement(email) })
    const { verifyMessage } = await import('viem')
    const swapped = normalizeChoices({ ...email, emailAddress: 'bob@example.com' })!
    expect(
      await verifyMessage({
        address: email.address,
        message: consentStatement(swapped),
        signature,
      }),
    ).toBe(false)
  })

  it('rejects malformed email and any email address on non-email choices', () => {
    const base = makeChoice()
    expect(normalizeChoices({ ...base, channels: ['email'] })).toBeNull()
    expect(normalizeChoices({ ...base, emailAddress: 'alice@example.com' })).toBeNull()
    expect(
      normalizeChoices({ ...makeChoice('inspect'), emailAddress: 'alice@example.com' }),
    ).toBeNull()
    expect(
      normalizeChoices({ ...makeChoice('pause'), emailAddress: 'alice@example.com' }),
    ).toBeNull()
    for (const bad of [
      'alice\nBcc:evil@example.com',
      'alice bob@example.com',
      'alice@example.com\r',
      'alice@-example.com',
      'alice..bob@example.com',
      'álîce@example.com',
      `${'a'.repeat(65)}@example.com`,
    ]) {
      expect(normalizeEmailAddress(bad)).toBeNull()
    }
  })
})

const token = `a_${'A'.repeat(43)}`
const hash = createHash('sha256').update(token).digest('hex')

describe('private Telegram chat confirmation', () => {
  it('keeps confirm and stop behind matching transactional chat locks in the unapplied migration', () => {
    const ddl = readFileSync(resolve(process.cwd(), 'scripts/apply-user-alerts-ddl.mjs'), 'utf8')
    expect(ddl).toContain('confirm_user_alert_telegram_link')
    expect(ddl).toContain('disconnect_user_alert_telegram_chat')
    expect(
      ddl.match(
        /pg_advisory_xact_lock\(hashtextextended\('membrane-alert-chat:' \|\| p_chat_id, 0\)\)/g,
      ),
    ).toHaveLength(2)
    expect(ddl).toContain('l.expires_at > clock_timestamp()')
    expect(ddl.match(/LANGUAGE plpgsql VOLATILE SECURITY INVOKER/g)).toHaveLength(2)
  })

  it('consumes only the matching wallet-consented link and binds the private chat', async () => {
    const calls: string[] = []
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim()
      calls.push(query)
      if (query.startsWith('SELECT address FROM confirm_user_alert_telegram_link')) {
        expect(values).toEqual([hash, '7'])
        return [{ address: ACCOUNT.address }]
      }
      throw new Error(`Unexpected query: ${query}`)
    }) as any
    const result = await handleUpdate(
      { message: { chat: { id: 7, type: 'private' }, text: `/start ${token}` } },
      { sql, logic: telegramLogic, footerFor: async () => '' },
    )
    expect(result?.text).toContain('Personal event alerts are not active')
    expect(calls).toHaveLength(1)
  })

  it('refuses a group chat, used token, and changed preference without sending', async () => {
    const sql = vi.fn(async () => []) as any
    const group = await handleUpdate(
      { message: { chat: { id: -7, type: 'group' }, text: `/start ${token}` } },
      { sql, logic: telegramLogic, footerFor: async () => '' },
    )
    expect(group?.text).toContain('private chat')
    expect(sql).not.toHaveBeenCalled()
    const used = await handleUpdate(
      { message: { chat: { id: 7, type: 'private' }, text: `/start ${token}` } },
      { sql, logic: telegramLogic, footerFor: async () => '' },
    )
    expect(used?.text).toContain('expired, was used')
  })

  it('/stop disconnects personal and public-address watches for this chat', async () => {
    const queries: string[] = []
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim()
      queries.push(query)
      if (query.startsWith('SELECT disconnect_user_alert_telegram_chat')) return [{ count: 1 }]
      if (query.startsWith('UPDATE alert_subscriptions')) return [{ id: 's1' }]
      return []
    }) as any
    const result = await handleUpdate(
      { message: { chat: { id: 7, type: 'private' }, text: '/stop' } },
      { sql, logic: telegramLogic, footerFor: async () => '' },
    )
    expect(result?.text).toContain('Personal alert chat disconnected')
    expect(queries).toHaveLength(2)
  })

  it('/stop still revokes venue watches but warns when the personal migration is absent', async () => {
    const queries: string[] = []
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim()
      queries.push(query)
      if (query.startsWith('SELECT disconnect_user_alert_telegram_chat'))
        throw Object.assign(new Error('function absent'), { code: '42883' })
      if (query.startsWith('UPDATE alert_subscriptions')) return [{ id: 's1' }]
      return []
    }) as any
    const result = await handleUpdate(
      { message: { chat: { id: 7, type: 'private' }, text: '/stop' } },
      { sql, logic: telegramLogic, footerFor: async () => '' },
    )
    expect(result?.text).toContain('disconnect could not be confirmed')
    expect(queries).toHaveLength(2)
  })
})
