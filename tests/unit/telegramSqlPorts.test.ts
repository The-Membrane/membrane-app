import { describe, expect, it } from 'vitest'
import { keccak256, padHex, toEventSelector, toHex } from 'viem'

import { runTelegramAlertBatch } from '@/lib/alerts/telegramBatch'
import { makeTelegramHttpSender } from '@/lib/alerts/telegramHttpSender'
import { makeTelegramSqlPorts } from '@/lib/alerts/telegramSqlPorts'
import type { LiquidationSourceReads } from '@/lib/alerts/verifyLiquidationSource'

const emitter = '0x2222222222222222222222222222222222222222'
const owner = '0x1111111111111111111111111111111111111111'
const tx = `0x${'ab'.repeat(32)}`
const hash = `0x${'cd'.repeat(32)}`
const code = '0x6001600055'
const codeHash = keccak256(code)
const time = 1_790_000_000
const token = '11111111-2222-4333-8444-555555555555'

function reads(runtime = code): LiquidationSourceReads {
  return {
    chainId: async () => 1,
    finalizedBlockNumber: async () => 26_000_010n,
    block: async () => ({ hash, timestamp: BigInt(time) }),
    receipt: async () => ({
      status: 'success',
      blockNumber: 26_000_000n,
      blockHash: hash,
      logs: [
        {
          chainId: 1,
          address: emitter,
          topics: [
            toEventSelector('LiquidationTimerStarted(uint256,address,uint64)'),
            toHex(41n, { size: 32 }),
            padHex(owner, { size: 32 }),
          ],
          data: toHex(time, { size: 32 }),
          transactionHash: tx,
          logIndex: 2,
          blockNumber: 26_000_000n,
          blockHash: hash,
        },
      ],
    }),
    code: async () => runtime,
  }
}

function fixture(
  trace: string[],
  missingClaim = false,
  sourceAttestation: unknown = {
    proofVersion: 1,
    runtimeCodeHash: codeHash,
    positionId: '41',
    startTime: time,
  },
) {
  const query = async (
    statement: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> => {
    if (statement.includes('expire_user_alert_leases')) {
      trace.push('expire')
      return []
    }
    if (statement.includes('retire_user_alert_outbox')) {
      trace.push('retire')
      return []
    }
    if (statement.includes('lease_user_alert_outbox')) {
      trace.push(`lease:${params.join(':')}`)
      return [
        {
          id: '1',
          event_id: '7',
          recipient_address: owner,
          channel: 'telegram',
          lease_token: token,
        },
      ]
    }
    if (statement.includes('FROM user_alert_chain_events')) {
      trace.push(`claim:${params[0]}`)
      return missingClaim
        ? []
        : [
            {
              chain_id: 1,
              emitter_address: emitter,
              transaction_hash: tx,
              log_index: 2,
              block_number: '26000000',
              block_hash: hash,
              occurred_at: new Date(time * 1000),
              first_observed_at: new Date((time + 1) * 1000),
              kind: 'delay_started',
              subject_address: owner,
              source_attestation: sourceAttestation,
            },
          ]
    }
    if (statement.includes('begin_user_alert_delivery')) {
      trace.push('begin')
      return [{ destination: '123456789' }]
    }
    if (statement.includes('complete_user_alert_delivery')) {
      trace.push('complete')
      return [{ ok: true }]
    }
    if (statement.includes('suppress_user_alert_before_send')) {
      trace.push('suppress')
      return [{ ok: true }]
    }
    throw new Error('unexpected SQL operation')
  }
  return { query } as unknown as Parameters<typeof makeTelegramSqlPorts>[0]
}

describe('inert SQL-to-proof-to-Telegram composition', () => {
  it('sends only after the stored claim matches finalized chain evidence', async () => {
    const trace: string[] = []
    const ports = makeTelegramSqlPorts(fixture(trace), reads(), emitter, codeHash, async () => {
      trace.push('send')
      return true
    })
    const result = await runTelegramAlertBatch(emitter, ports)
    expect(result).toMatchObject({ sent: 1, stopped: false })
    expect(trace).toEqual([
      'expire',
      'retire',
      'lease:20:120',
      'claim:7',
      'begin',
      'send',
      'complete',
    ])
  })

  it('halts without suppressing or sending when the claim is absent or runtime differs', async () => {
    for (const [missing, runtime] of [
      [true, code],
      [false, '0x6002'],
    ] as const) {
      const trace: string[] = []
      const ports = makeTelegramSqlPorts(
        fixture(trace, missing),
        reads(runtime),
        emitter,
        codeHash,
        async () => {
          trace.push('send')
          return true
        },
      )
      expect(await runTelegramAlertBatch(emitter, ports)).toMatchObject({
        sent: 0,
        processed: 0,
        stopped: true,
        reason: 'source_unavailable',
      })
      expect(trace).toEqual(['expire', 'retire', 'lease:20:120', 'claim:7'])
    }
  })

  it('never begins or sends when a stored timer anchor disagrees with the receipt', async () => {
    const trace: string[] = []
    const ports = makeTelegramSqlPorts(
      fixture(trace, false, {
        proofVersion: 1,
        runtimeCodeHash: codeHash,
        positionId: '41',
        startTime: time + 1,
      }),
      reads(),
      emitter,
      codeHash,
      async () => {
        trace.push('send')
        return true
      },
    )
    expect(await runTelegramAlertBatch(emitter, ports)).toMatchObject({
      sent: 0,
      processed: 0,
      stopped: true,
      reason: 'source_unavailable',
    })
    expect(trace).toEqual(['expire', 'retire', 'lease:20:120', 'claim:7'])
  })

  it('quarantines an ambiguous Telegram response after send-begin without completing', async () => {
    const trace: string[] = []
    const fetcher = (async () => {
      trace.push('http')
      return Response.json({ ok: false }, { status: 429 })
    }) as typeof fetch
    const send = makeTelegramHttpSender(`123456789:${'a'.repeat(35)}`, fetcher)
    const ports = makeTelegramSqlPorts(fixture(trace), reads(), emitter, codeHash, send)
    expect(await runTelegramAlertBatch(emitter, ports)).toMatchObject({
      sent: 0,
      processed: 1,
      stopped: true,
      reason: 'uncertain',
    })
    expect(trace).toEqual(['expire', 'retire', 'lease:20:120', 'claim:7', 'begin', 'http'])
  })

  it('rejects missing deployment identity before any SQL operation', () => {
    const trace: string[] = []
    expect(() =>
      makeTelegramSqlPorts(fixture(trace), reads(), emitter, '0x', async () => true),
    ).toThrow('configuration')
    expect(trace).toEqual([])
  })
})
