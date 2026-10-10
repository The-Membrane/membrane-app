import { describe, expect, it, vi } from 'vitest'

import {
  dispatchLeasedTelegramAlert,
  type LeasedTelegramAlert,
  type TelegramDeliveryPorts,
} from '@/lib/alerts/telegramDelivery'
import type { FinalizedChainLog } from '@/lib/alerts/outbox'

const OWNER = '0x1111111111111111111111111111111111111111'
const EMITTER = '0x2222222222222222222222222222222222222222'
const TOKEN = '11111111-2222-4333-8444-555555555555'

const EVENT: FinalizedChainLog = {
  chainId: 1,
  emitter: EMITTER,
  transactionHash: `0x${'ab'.repeat(32)}`,
  logIndex: 2,
  blockNumber: 26_000_000,
  blockHash: `0x${'cd'.repeat(32)}`,
  occurredAt: '2026-09-27T18:00:00Z',
  firstObservedAt: '2026-09-27T18:01:00Z',
  kind: 'delay_started',
  subjectAddress: OWNER,
}
const ATTESTED_EVENT = {
  ...EVENT,
  positionId: '41',
  startTime: Date.parse(EVENT.occurredAt) / 1000,
}

const lease: LeasedTelegramAlert = {
  id: '7',
  leaseToken: TOKEN,
  recipientAddress: OWNER,
  event: ATTESTED_EVENT,
}

function ports(trace: string[]): TelegramDeliveryPorts {
  return {
    suppress: async () => {
      trace.push('suppress')
      return true
    },
    begin: async () => {
      trace.push('begin')
      return '123456789'
    },
    send: async (_chat, message) => {
      trace.push('send')
      expect(message).toContain('protection delay started')
      expect(message).toContain('not a live countdown')
      expect(message).toContain('Delay started at 2026-09-27T18:00:00.000Z (UTC)')
      expect(message).toContain('Position 41')
      expect(message).not.toMatch(/8.hour|ends at|expires at/i)
      expect(message).toContain('Ethereum block 26000000')
      return true
    },
    complete: async () => {
      trace.push('complete')
      return true
    },
  }
}

describe('inert Telegram outbox dispatch boundary', () => {
  it('sends only after the consent-rechecking begin transition, then acknowledges success', async () => {
    const trace: string[] = []
    const result = await dispatchLeasedTelegramAlert(lease, EMITTER, ports(trace))
    expect(result).toBe('sent')
    expect(trace).toEqual(['begin', 'send', 'complete'])
  })

  it('rejects a wrong emitter, recipient, event kind, chain, or lease before touching ports', async () => {
    const trace: string[] = []
    const p = ports(trace)
    const cases: LeasedTelegramAlert[] = [
      { ...lease, recipientAddress: EMITTER },
      { ...lease, id: '0' },
      { ...lease, leaseToken: 'invalid' },
      { ...lease, event: { ...EVENT, chainId: 31337 as 1 } },
    ]
    for (const item of cases)
      expect(await dispatchLeasedTelegramAlert(item, EMITTER, p)).toBe('invalid_source')
    expect(await dispatchLeasedTelegramAlert(lease, OWNER, p)).toBe('emitter_mismatch')
    expect(await dispatchLeasedTelegramAlert(lease, 'not-an-address', p)).toBe(
      'source_config_error',
    )
    expect(trace).toEqual(['suppress', 'suppress'])
  })

  it('abstains without suppressing a future CuratorVault event', async () => {
    const trace: string[] = []
    expect(
      await dispatchLeasedTelegramAlert(
        { ...lease, event: { ...EVENT, kind: 'curator_vault_action' } },
        EMITTER,
        ports(trace),
      ),
    ).toBe('unsupported_kind')
    expect(trace).toEqual([])
  })

  it('suppresses a delay row with absent or inconsistent timing before begin or send', async () => {
    const trace: string[] = []
    for (const event of [
      EVENT,
      { ...ATTESTED_EVENT, startTime: ATTESTED_EVENT.startTime + 1 },
      { ...ATTESTED_EVENT, positionId: '0' },
    ]) {
      expect(await dispatchLeasedTelegramAlert({ ...lease, event }, EMITTER, ports(trace))).toBe(
        'invalid_source',
      )
    }
    expect(trace).toEqual(['suppress', 'suppress', 'suppress'])
  })

  it('does not send when the final consent check rejects or begin fails', async () => {
    const trace: string[] = []
    const p = ports(trace)
    p.begin = vi.fn(async () => {
      trace.push('begin')
      return null
    })
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('consent_revoked')
    p.begin = vi.fn(async () => {
      trace.push('begin')
      throw new Error('DB unavailable')
    })
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('deferred_pre_send')
    expect(trace).toEqual(['begin', 'begin'])
  })

  it('reports a failed poison-row suppression rather than implying a terminal state', async () => {
    const trace: string[] = []
    const p = ports(trace)
    p.suppress = async () => {
      trace.push('suppress')
      return false
    }
    expect(
      await dispatchLeasedTelegramAlert({ ...lease, recipientAddress: EMITTER }, EMITTER, p),
    ).toBe('suppression_failed')
    expect(trace).toEqual(['suppress'])
  })

  it('quarantines every state after begin if the destination, send, or completion is uncertain', async () => {
    const trace: string[] = []
    const p = ports(trace)
    p.begin = async () => {
      trace.push('begin')
      return '-100123456'
    }
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('uncertain')
    expect(trace).toEqual(['begin'])

    trace.length = 0
    p.begin = async () => {
      trace.push('begin')
      return '123456789'
    }
    p.send = async () => {
      trace.push('send')
      return false
    }
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('uncertain')
    expect(trace).toEqual(['begin', 'send'])

    trace.length = 0
    p.send = async () => {
      trace.push('send')
      throw new Error('network outcome unknown')
    }
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('uncertain')
    expect(trace).toEqual(['begin', 'send'])

    trace.length = 0
    p.send = async () => {
      trace.push('send')
      return true
    }
    p.complete = async () => {
      trace.push('complete')
      return false
    }
    expect(await dispatchLeasedTelegramAlert(lease, EMITTER, p)).toBe('uncertain')
    expect(trace).toEqual(['begin', 'send', 'complete'])
  })

  it('uses a factual, plain-text kept notice with no modeled savings claim', async () => {
    let text = ''
    const p = ports([])
    p.send = async (_chat, message) => {
      text = message
      return true
    }
    const result = await dispatchLeasedTelegramAlert(
      { ...lease, event: { ...EVENT, kind: 'position_kept' } },
      EMITTER,
      p,
    )
    expect(result).toBe('sent')
    expect(text).toContain('Position Kept')
    expect(text).not.toMatch(/saved \$|modeled/i)
    expect(text).toContain(EVENT.transactionHash)
  })
})
