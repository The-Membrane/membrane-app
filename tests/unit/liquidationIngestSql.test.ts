import { describe, expect, it, vi } from 'vitest'

import { makeLiquidationIngestSqlPort } from '@/lib/alerts/liquidationIngestSql'
import type { VerifiedLiquidationIngestEvent } from '@/lib/alerts/ingestLiquidationEvent'

const emitter = `0x${'11'.repeat(20)}`
const tx = `0x${'22'.repeat(32)}`
const runtimeCodeHash = `0x${'33'.repeat(32)}`
const event: VerifiedLiquidationIngestEvent = {
  chainId: 1,
  emitter,
  transactionHash: tx,
  logIndex: 2,
  blockNumber: 100,
  blockHash: `0x${'44'.repeat(32)}`,
  occurredAt: '2026-09-27T00:00:00.000Z',
  firstObservedAt: '2026-09-27T00:00:01.000Z',
  kind: 'delay_started',
  subjectAddress: `0x${'55'.repeat(20)}`,
  eventId: `1:${emitter}:${tx}:2`,
  positionId: 41n,
  startTime: 1_790_000_000,
  channel: 'telegram',
  sourceAttestation: {
    proofVersion: 1,
    runtimeCodeHash,
    positionId: '41',
    startTime: 1_790_000_000,
  },
}

function adapter(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_statement: string, _params?: unknown[]) => rows)
  return { port: makeLiquidationIngestSqlPort({ query } as never), query }
}

describe('inert liquidation SQL adapter', () => {
  it('maps canonical identity to bigint-backed SQL without passing eventId as DB id', async () => {
    const { port, query } = adapter([{ status: 'queued', outbox_id: '7' }])
    await expect(port.persistAndEnqueue(event)).resolves.toEqual({
      status: 'queued',
      eventId: event.eventId,
    })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][0]).toContain('ingest_verified_liquidation_event')
    expect(query.mock.calls[0][1]).toEqual([
      1,
      emitter,
      tx,
      2,
      100,
      event.blockHash,
      event.occurredAt,
      event.firstObservedAt,
      event.kind,
      event.subjectAddress,
      JSON.stringify(event.sourceAttestation),
    ])
  })

  it.each(['duplicate', 'conflicting_replay', 'no_pre_event_consent'] as const)(
    'passes %s without claiming an outbox row',
    async (status) => {
      const { port } = adapter([{ status, outbox_id: null }])
      await expect(port.persistAndEnqueue(event)).resolves.toEqual({
        status,
        eventId: event.eventId,
      })
    },
  )

  it('rejects a queued result without an actual outbox id', async () => {
    const { port } = adapter([{ status: 'queued', outbox_id: null }])
    await expect(port.persistAndEnqueue(event)).rejects.toThrow(
      'atomic liquidation persistence failed',
    )
  })

  it('fails before SQL on a tampered attestation or event identity', async () => {
    const { port, query } = adapter([])
    await expect(
      port.persistAndEnqueue({
        ...event,
        sourceAttestation: { ...event.sourceAttestation, positionId: '42' },
      }),
    ).rejects.toThrow('invalid verified liquidation ingest event')
    await expect(port.persistAndEnqueue({ ...event, eventId: '7' })).rejects.toThrow(
      'invalid verified liquidation ingest event',
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('bounds serialization retries and sanitizes database errors', async () => {
    const query = vi.fn(async () => {
      throw Object.assign(new Error('secret postgres URL'), { code: '40001' })
    })
    const port = makeLiquidationIngestSqlPort({ query } as never)
    await expect(port.persistAndEnqueue(event)).rejects.toThrow(
      'atomic liquidation persistence failed',
    )
    expect(query).toHaveBeenCalledTimes(3)
  })
})
