import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keccak256, padHex, toEventSelector, toHex } from 'viem'

import {
  ingestFinalizedLiquidationEvent,
  type LiquidationAtomicIngestPort,
  type VerifiedLiquidationIngestEvent,
} from '@/lib/alerts/ingestLiquidationEvent'
import type { RawLiquidationLog } from '@/lib/alerts/liquidationEvents'
import {
  makeVerifiedLiquidationEventLoader,
  type LiquidationSourceReads,
} from '@/lib/alerts/verifyLiquidationSource'

const emitter = '0x2222222222222222222222222222222222222222'
const owner = '0x1111111111111111111111111111111111111111'
const stranger = '0x3333333333333333333333333333333333333333'
const tx = `0x${'ab'.repeat(32)}`
const hash = `0x${'cd'.repeat(32)}`
const code = '0x6001600055'
const timestamp = 1_790_000_000
const observedAt = new Date((timestamp + 2) * 1000).toISOString()

function log(kind: 'delay_started' | 'position_kept' = 'delay_started'): RawLiquidationLog {
  return {
    chainId: 1,
    address: emitter,
    topics: [
      toEventSelector(
        kind === 'delay_started'
          ? 'LiquidationTimerStarted(uint256,address,uint64)'
          : 'LiquidationSavedByDelay(uint256,address)',
      ),
      toHex(41n, { size: 32 }),
      padHex(owner, { size: 32 }),
    ],
    data: kind === 'delay_started' ? toHex(timestamp, { size: 32 }) : '0x',
    transactionHash: tx,
    logIndex: 2,
    blockNumber: 26_000_000n,
    blockHash: hash,
  }
}

function reads(receiptLog: RawLiquidationLog = log()): LiquidationSourceReads {
  return {
    chainId: async () => 1,
    finalizedBlockNumber: async () => 26_000_010n,
    block: async () => ({ hash, timestamp: BigInt(timestamp) }),
    receipt: async () => ({
      status: 'success',
      blockNumber: 26_000_000n,
      blockHash: hash,
      logs: [receiptLog],
    }),
    code: async () => code,
  }
}

function setup(options?: {
  observedLog?: RawLiquidationLog
  source?: LiquidationSourceReads
  atomic?: LiquidationAtomicIngestPort
}) {
  const events: VerifiedLiquidationIngestEvent[] = []
  const atomic: LiquidationAtomicIngestPort = options?.atomic ?? {
    persistAndEnqueue: async (event) => {
      events.push(event)
      return { status: 'queued', eventId: event.eventId }
    },
  }
  return {
    input: {
      observedLog: options?.observedLog ?? log(),
      expectedEmitter: emitter,
      expectedRuntimeCodeHash: keccak256(code),
      reads: options?.source ?? reads(),
      atomic,
    },
    events,
  }
}

describe('inert liquidation receipt ingestion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(observedAt))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives a delay-start recipient and chain-log ID from the proved receipt', async () => {
    const { input, events } = setup()
    await expect(ingestFinalizedLiquidationEvent(input)).resolves.toEqual({
      status: 'queued',
      eventId: `1:${emitter}:${tx}:2`,
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      subjectAddress: owner,
      positionId: 41n,
      startTime: timestamp,
      kind: 'delay_started',
      firstObservedAt: observedAt,
      blockHash: hash,
      logIndex: 2,
      channel: 'telegram',
      sourceAttestation: {
        proofVersion: 1,
        runtimeCodeHash: keccak256(code),
        positionId: '41',
        startTime: timestamp,
      },
    })
  })

  it('ingests before a DB attestation exists, then requires matching stored proof on send load', async () => {
    const source = reads()
    const receipt = vi.spyOn(source, 'receipt')
    const { input, events } = setup({ source })
    await expect(ingestFinalizedLiquidationEvent(input)).resolves.toMatchObject({
      status: 'queued',
    })
    expect(receipt).toHaveBeenCalledTimes(1)
    const event = events[0]
    const goodLoader = makeVerifiedLiquidationEventLoader(
      async () => event,
      emitter,
      keccak256(code),
      source,
    )
    await expect(goodLoader('7')).resolves.toMatchObject({
      positionId: '41',
      startTime: timestamp,
    })
    const badLoader = makeVerifiedLiquidationEventLoader(
      async () => ({
        ...event,
        sourceAttestation: { ...event.sourceAttestation, startTime: timestamp + 1 },
      }),
      emitter,
      keccak256(code),
      source,
    )
    await expect(badLoader('7')).rejects.toThrow('attestation mismatch')
  })

  it('rejects a forged claimed owner before persistence', async () => {
    const forged = {
      ...log(),
      topics: [
        toEventSelector('LiquidationTimerStarted(uint256,address,uint64)'),
        toHex(41n, { size: 32 }),
        padHex(stranger, { size: 32 }),
      ],
    }
    const { input, events } = setup({ observedLog: forged })
    await expect(ingestFinalizedLiquidationEvent(input)).rejects.toThrow('provenance')
    expect(events).toHaveLength(0)
  })

  it('fails closed on unfinalized, failed receipt, and runtime mismatch', async () => {
    const base = reads()
    for (const source of [
      { ...base, finalizedBlockNumber: async () => 25_999_999n },
      {
        ...base,
        receipt: async () => ({
          status: 'reverted' as const,
          blockNumber: 26_000_000n,
          blockHash: hash,
          logs: [log()],
        }),
      },
      { ...base, code: async () => '0x6002' },
    ]) {
      const { input, events } = setup({ source })
      await expect(ingestFinalizedLiquidationEvent(input)).rejects.toThrow()
      expect(events).toHaveLength(0)
    }
  })

  it('rejects a receipt timer start inconsistent with its block timestamp before persistence', async () => {
    const shiftedTimer = { ...log(), data: toHex(timestamp + 1, { size: 32 }) }
    const { input, events } = setup({
      observedLog: shiftedTimer,
      source: reads(shiftedTimer),
    })
    await expect(ingestFinalizedLiquidationEvent(input)).rejects.toThrow('timing mismatch')
    expect(events).toHaveLength(0)
  })

  it('passes missing consent to the required atomic port without claiming an enqueue', async () => {
    const { input } = setup({
      atomic: {
        persistAndEnqueue: async (event) => ({
          status: 'no_pre_event_consent',
          eventId: event.eventId,
        }),
      },
    })
    await expect(ingestFinalizedLiquidationEvent(input)).resolves.toMatchObject({
      status: 'no_pre_event_consent',
    })
  })

  it('preserves port-level duplicate idempotence and conflicting-replay rejection', async () => {
    const seen = new Map<string, { fingerprint: string; firstObservedAt: string }>()
    const atomic: LiquidationAtomicIngestPort = {
      persistAndEnqueue: async (event) => {
        const fingerprint = JSON.stringify([
          event.chainId,
          event.emitter,
          event.transactionHash,
          event.logIndex,
          event.blockNumber,
          event.blockHash,
          event.occurredAt,
          event.kind,
          event.subjectAddress,
          event.positionId.toString(),
          event.startTime,
          event.sourceAttestation,
        ])
        const prior = seen.get(event.eventId)
        if (prior && prior.fingerprint !== fingerprint)
          return { status: 'conflicting_replay', eventId: event.eventId }
        if (prior) return { status: 'duplicate', eventId: event.eventId }
        seen.set(event.eventId, { fingerprint, firstObservedAt: event.firstObservedAt })
        return { status: 'queued', eventId: event.eventId }
      },
    }
    const { input } = setup({ atomic })
    expect((await ingestFinalizedLiquidationEvent(input)).status).toBe('queued')
    vi.setSystemTime(new Date((timestamp + 90) * 1000))
    const later = setup({ atomic })
    expect((await ingestFinalizedLiquidationEvent(later.input)).status).toBe('duplicate')
    expect(seen.get(`1:${emitter}:${tx}:2`)?.firstObservedAt).toBe(observedAt)
    const anotherHash = `0x${'ef'.repeat(32)}`
    const conflictingLog = { ...log(), blockHash: anotherHash }
    const conflictingReads = {
      ...reads(conflictingLog),
      block: async () => ({ hash: anotherHash, timestamp: BigInt(timestamp) }),
      receipt: async () => ({
        status: 'success' as const,
        blockNumber: 26_000_000n,
        blockHash: anotherHash,
        logs: [conflictingLog],
      }),
    }
    const conflicting = setup({ observedLog: conflictingLog, source: conflictingReads, atomic })
    expect((await ingestFinalizedLiquidationEvent(conflicting.input)).status).toBe(
      'conflicting_replay',
    )
  })

  it('keeps Position Kept distinct from delay-start and carries no countdown start', async () => {
    const kept = log('position_kept')
    const { input, events } = setup({ observedLog: kept, source: reads(kept) })
    await ingestFinalizedLiquidationEvent(input)
    expect(events[0]).toMatchObject({ kind: 'position_kept', startTime: null })
    expect(events[0].sourceAttestation.startTime).toBeNull()
  })

  it('captures the clock at entry and ignores a caller-supplied firstObservedAt', async () => {
    const { input, events } = setup({
      source: {
        ...reads(),
        block: async () => {
          vi.setSystemTime(new Date((timestamp + 99) * 1000))
          return { hash, timestamp: BigInt(timestamp) }
        },
      },
    })
    const forgedInput = {
      ...input,
      firstObservedAt: new Date((timestamp - 10) * 1000).toISOString(),
    }
    await ingestFinalizedLiquidationEvent(forgedInput)
    expect(events[0].firstObservedAt).toBe(observedAt)
  })
})
