import { describe, expect, it, vi } from 'vitest'

import {
  runTelegramAlertBatch,
  type TelegramBatchPorts,
  type TelegramLeaseRow,
} from '@/lib/alerts/telegramBatch'
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

const row = (id: string): TelegramLeaseRow => ({
  id,
  eventId: id,
  recipientAddress: OWNER,
  channel: 'telegram',
  leaseToken: TOKEN,
})

function ports(trace: string[], rows = [row('1')]): TelegramBatchPorts {
  return {
    expireLeases: async () => {
      trace.push('expire')
    },
    retireIneligible: async () => {
      trace.push('retire')
    },
    lease: async (limit, seconds) => {
      trace.push(`lease:${limit}:${seconds}`)
      return rows
    },
    loadAttestedEvent: async (id) => {
      trace.push(`load:${id}`)
      return { ...EVENT, positionId: '41', startTime: Date.parse(EVENT.occurredAt) / 1000 }
    },
    suppress: async (id) => {
      trace.push(`suppress:${id}`)
      return true
    },
    begin: async (id) => {
      trace.push(`begin:${id}`)
      return '123456789'
    },
    send: async () => {
      trace.push('send')
      return true
    },
    complete: async (id) => {
      trace.push(`complete:${id}`)
      return true
    },
  }
}

describe('inert bounded Telegram batch worker core', () => {
  it('runs maintenance but does not touch transport for an empty queue', async () => {
    const trace: string[] = []
    const result = await runTelegramAlertBatch(EMITTER, ports(trace, []))
    expect(result).toEqual({ leased: 0, processed: 0, sent: 0, stopped: false, reason: null })
    expect(trace).toEqual(['expire', 'retire', 'lease:20:120'])
  })

  it('performs maintenance, leases, verifies each source, and dispatches sequentially', async () => {
    const trace: string[] = []
    const result = await runTelegramAlertBatch(EMITTER, ports(trace, [row('1'), row('2')]))
    expect(result).toEqual({ leased: 2, processed: 2, sent: 2, stopped: false, reason: null })
    expect(trace).toEqual([
      'expire',
      'retire',
      'lease:20:120',
      'load:1',
      'begin:1',
      'send',
      'complete:1',
      'load:2',
      'begin:2',
      'send',
      'complete:2',
    ])
  })

  it('continues after a final consent rejection without sending that row', async () => {
    const trace: string[] = []
    const p = ports(trace, [row('1'), row('2')])
    p.begin = async (id) => {
      trace.push(`begin:${id}`)
      return id === '1' ? null : '123456789'
    }
    const result = await runTelegramAlertBatch(EMITTER, p)
    expect(result).toEqual({ leased: 2, processed: 2, sent: 1, stopped: false, reason: null })
    expect(trace.filter((step) => step === 'send')).toHaveLength(1)
  })

  it('stops after an ambiguous send so the rest of the leased batch remains pre-send', async () => {
    const trace: string[] = []
    const p = ports(trace, [row('1'), row('2')])
    p.send = async () => {
      trace.push('send')
      return false
    }
    const result = await runTelegramAlertBatch(EMITTER, p)
    expect(result).toEqual({ leased: 2, processed: 1, sent: 0, stopped: true, reason: 'uncertain' })
    expect(trace).not.toContain('load:2')
    expect(trace).not.toContain('complete:1')
  })

  it('suppresses an absent source and stops before any send', async () => {
    const trace: string[] = []
    const p = ports(trace, [row('1'), row('2')])
    p.loadAttestedEvent = async (id) => {
      trace.push(`load:${id}`)
      return null
    }
    const result = await runTelegramAlertBatch(EMITTER, p)
    expect(result).toEqual({
      leased: 2,
      processed: 1,
      sent: 0,
      stopped: true,
      reason: 'invalid_source',
    })
    expect(trace).toContain('suppress:1')
    expect(trace).not.toContain('begin:1')
    expect(trace).not.toContain('load:2')
  })

  it('halts on emitter disagreement without suppressing possibly valid rows', async () => {
    const trace: string[] = []
    const result = await runTelegramAlertBatch(OWNER, ports(trace, [row('1'), row('2')]))
    expect(result).toMatchObject({ stopped: true, reason: 'emitter_mismatch', processed: 1 })
    expect(trace).toContain('load:1')
    expect(trace).not.toContain('suppress:1')
    expect(trace).not.toContain('begin:1')
    expect(trace).not.toContain('load:2')
  })

  it('stops on source-loader failure or an unexpected email lease without I/O', async () => {
    const trace: string[] = []
    const p = ports(trace)
    p.loadAttestedEvent = async () => {
      throw new Error('source unavailable')
    }
    expect(await runTelegramAlertBatch(EMITTER, p)).toMatchObject({
      stopped: true,
      reason: 'source_unavailable',
      processed: 0,
    })
    expect(trace).not.toContain('begin:1')

    trace.length = 0
    const email = ports(trace, [{ ...row('1'), channel: 'email' }])
    expect(await runTelegramAlertBatch(EMITTER, email)).toMatchObject({
      stopped: true,
      reason: 'bad_lease',
      processed: 0,
    })
    expect(trace).not.toContain('load:1')
  })

  it('rejects a duplicate lease before sending either row', async () => {
    const trace: string[] = []
    const result = await runTelegramAlertBatch(EMITTER, ports(trace, [row('1'), row('1')]))
    expect(result).toMatchObject({ leased: 2, processed: 0, stopped: true, reason: 'bad_lease' })
    expect(trace).toEqual(['expire', 'retire', 'lease:20:120'])
  })

  it('rejects unbounded settings before any state change', async () => {
    const trace: string[] = []
    const p = ports(trace)
    await expect(runTelegramAlertBatch(EMITTER, p, 101)).rejects.toThrow('invalid batch limit')
    await expect(runTelegramAlertBatch(EMITTER, p, 20, 301)).rejects.toThrow(
      'invalid lease duration',
    )
    await expect(runTelegramAlertBatch('invalid', p)).rejects.toThrow(
      'unverified emitter configuration',
    )
    expect(trace).toEqual([])
  })

  it('refuses a storage adapter that returns more than the bounded lease count', async () => {
    const trace: string[] = []
    const p = ports(trace, [row('1'), row('2')])
    await expect(runTelegramAlertBatch(EMITTER, p, 1)).rejects.toThrow('invalid leased batch')
    expect(trace).toEqual(['expire', 'retire', 'lease:1:120'])
  })

  it('does not call maintenance after the first failing maintenance step', async () => {
    const trace: string[] = []
    const p = ports(trace)
    p.expireLeases = vi.fn(async () => {
      trace.push('expire')
      throw new Error('storage unavailable')
    })
    await expect(runTelegramAlertBatch(EMITTER, p)).rejects.toThrow('storage unavailable')
    expect(trace).toEqual(['expire'])
  })
})
