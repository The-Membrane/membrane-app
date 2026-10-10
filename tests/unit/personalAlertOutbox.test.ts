import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  chainLogIdentity,
  consentAllowsDelivery,
  normalizeFinalizedChainLog,
  retiredQueuedState,
  stateAfterLeaseExpiry,
  type DeliveryConsent,
  type FinalizedChainLog,
} from '@/lib/alerts/outbox'

const ADDRESS = '0x1111111111111111111111111111111111111111'
const EMITTER = '0x2222222222222222222222222222222222222222'
const EVENT: FinalizedChainLog = {
  chainId: 1,
  emitter: EMITTER,
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 7,
  blockNumber: 26_000_000,
  blockHash: `0x${'cd'.repeat(32)}`,
  occurredAt: '2026-09-27T18:00:00Z',
  firstObservedAt: '2026-09-27T18:01:00Z',
  kind: 'delay_started',
  subjectAddress: ADDRESS,
}
const CONSENT: DeliveryConsent = {
  address: ADDRESS,
  eventKinds: ['delay_started', 'position_kept'],
  requestedChannels: ['telegram'],
  consentAt: '2026-09-27T17:50:00Z',
  pausedAt: null,
  telegramConfirmedAt: '2026-09-27T17:55:00Z',
  emailConfirmedAt: null,
}

describe('inert personal-alert outbox model', () => {
  it('binds finalized chain-1 emitter/tx/log identity, not a simulator or synthetic venue event', () => {
    expect(chainLogIdentity(EVENT)).toBe(`1:${EMITTER}:${EVENT.transactionHash}:7`)
    expect(chainLogIdentity({ ...EVENT, logIndex: 8 })).not.toBe(chainLogIdentity(EVENT))
    expect(normalizeFinalizedChainLog({ ...EVENT, chainId: 31337 as 1 })).toBeNull()
    expect(normalizeFinalizedChainLog({ ...EVENT, blockHash: '0x0' })).toBeNull()
    expect(normalizeFinalizedChainLog({ ...EVENT, logIndex: -1 })).toBeNull()
    expect(normalizeFinalizedChainLog({ ...EVENT, kind: 'venue_capacity_change' })).toBeNull()
    expect(normalizeFinalizedChainLog(null as unknown as FinalizedChainLog)).toBeNull()
    expect(
      normalizeFinalizedChainLog({ ...EVENT, firstObservedAt: '2026-09-27T17:59:00Z' }),
    ).toBeNull()
  })

  it('requires owner, chosen event/channel, prior signed consent and confirmed destination', () => {
    expect(consentAllowsDelivery(EVENT, CONSENT, 'telegram')).toBe(true)
    expect(consentAllowsDelivery(EVENT, CONSENT, 'email')).toBe(false)
    expect(consentAllowsDelivery(EVENT, { ...CONSENT, address: EMITTER }, 'telegram')).toBe(false)
    expect(
      consentAllowsDelivery(EVENT, { ...CONSENT, eventKinds: ['position_kept'] }, 'telegram'),
    ).toBe(false)
    expect(
      consentAllowsDelivery(EVENT, { ...CONSENT, pausedAt: '2026-09-27T18:02:00Z' }, 'telegram'),
    ).toBe(false)
    expect(
      consentAllowsDelivery(EVENT, { ...CONSENT, consentAt: '2026-09-27T18:00:01Z' }, 'telegram'),
    ).toBe(false)
    expect(
      consentAllowsDelivery(
        EVENT,
        { ...CONSENT, telegramConfirmedAt: '2026-09-27T18:00:01Z' },
        'telegram',
      ),
    ).toBe(false)
    // A new signed preference may preserve the old chat/email binding. Its
    // confirmation predates the new consent and cannot receive that consent's events.
    expect(
      consentAllowsDelivery(EVENT, { ...CONSENT, consentAt: '2026-09-27T17:58:00Z' }, 'telegram'),
    ).toBe(false)
    expect(
      consentAllowsDelivery(
        EVENT,
        {
          ...CONSENT,
          consentAt: '2026-09-27T17:58:00Z',
          requestedChannels: ['email'],
          emailConfirmedAt: '2026-09-27T17:55:00Z',
        },
        'email',
      ),
    ).toBe(false)
  })

  it('requeues only an expired pre-send lease and quarantines an uncertain HTTP send', () => {
    expect(stateAfterLeaseExpiry('leased')).toBe('queued')
    expect(stateAfterLeaseExpiry('sending')).toBe('uncertain')
    expect(stateAfterLeaseExpiry('sent')).toBe('sent')
    expect(retiredQueuedState(4, false)).toBe('suppressed')
    expect(retiredQueuedState(5, true)).toBe('dead')
    expect(retiredQueuedState(4, true)).toBe('queued')
  })

  it('defines additive identity/dedupe, consent CAS, finite leases and no sender in the unapplied DDL', () => {
    const ddl = readFileSync(
      resolve(process.cwd(), 'scripts/apply-personal-alert-outbox-ddl.mjs'),
      'utf8',
    )
    expect(ddl).toContain('UNIQUE (chain_id, emitter_address, transaction_hash, log_index)')
    expect(ddl).toContain('UNIQUE (event_id, recipient_address, channel)')
    expect(ddl).toContain('e.subject_address = pg_catalog.lower(p.address)')
    expect(ddl).toContain('p.consent_at <= e.occurred_at')
    expect(ddl).toContain('p.consent_nonce = o.consent_nonce')
    expect(ddl.match(/p\.telegram_confirmed_at >= p\.consent_at/g)).toHaveLength(4)
    expect(ddl.match(/p\.email_confirmed_at >= p\.consent_at/g)).toHaveLength(4)
    expect(ddl).toContain('SKIP LOCKED')
    expect(ddl.match(/o\.channel = 'telegram'/g)).toHaveLength(2)
    expect(ddl.match(/e\.kind IN \('delay_started', 'position_kept'\)/g)).toHaveLength(2)
    expect(ddl).toContain("WHEN o.state = 'leased' THEN 'queued' ELSE 'uncertain'")
    expect(ddl).toContain("state = 'sending'")
    expect(ddl).toContain("state = 'sent'")
    expect(ddl).toContain("state = 'leased'")
    expect(ddl).toContain('retire_user_alert_outbox')
    expect(ddl).toContain('suppress_user_alert_before_send')
    expect(ddl).toContain("WHEN o.attempts >= 5 THEN 'dead' ELSE 'suppressed'")
    expect(ddl).toContain('no sender enabled')
  })

  it('keeps the enqueue helper safe under the liquidation definer search path', () => {
    const liquidationDdl = readFileSync(
      resolve(process.cwd(), 'scripts/apply-liquidation-ingest-ddl.mjs'),
      'utf8',
    )
    const ddl = readFileSync(
      resolve(process.cwd(), 'scripts/apply-personal-alert-outbox-ddl.mjs'),
      'utf8',
    )
    const enqueue = ddl.match(
      /CREATE OR REPLACE FUNCTION enqueue_user_alert_chain_event\([\s\S]*?\$\$`/,
    )?.[0]
    expect(liquidationDdl).toContain('SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp')
    expect(liquidationDdl).toContain('public.enqueue_user_alert_chain_event(')
    expect(enqueue).toBeDefined()
    expect(enqueue).toContain('SECURITY INVOKER')
    expect(enqueue).toContain('INSERT INTO public.user_alert_outbox')
    expect(enqueue).toContain('FROM public.user_alert_chain_events e')
    expect(enqueue).toContain('JOIN public.user_alert_preferences p')
    expect(enqueue).toContain('pg_catalog.lower(p.address)')
    expect(enqueue).toContain('pg_catalog.lower(p_recipient_address)')
  })
})
