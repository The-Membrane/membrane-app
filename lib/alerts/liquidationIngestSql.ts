import type { NeonQueryFunction } from '@neondatabase/serverless'

import {
  type LiquidationAtomicIngestPort,
  type LiquidationIngestResult,
  type VerifiedLiquidationIngestEvent,
} from './ingestLiquidationEvent'
import { chainLogIdentity, normalizeFinalizedChainLog } from './outbox'

type Sql = Pick<NeonQueryFunction<false, false>, 'query'>
const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const STATUSES = new Set<LiquidationIngestResult['status']>([
  'queued',
  'duplicate',
  'no_pre_event_consent',
  'conflicting_replay',
])

function canonical(event: VerifiedLiquidationIngestEvent): VerifiedLiquidationIngestEvent {
  const normalized = normalizeFinalizedChainLog(event)
  if (
    !normalized ||
    (event.kind !== 'delay_started' && event.kind !== 'position_kept') ||
    event.channel !== 'telegram' ||
    event.eventId !== chainLogIdentity(normalized) ||
    event.sourceAttestation.proofVersion !== 1 ||
    !HASH.test(event.sourceAttestation.runtimeCodeHash) ||
    !DECIMAL.test(event.sourceAttestation.positionId) ||
    event.positionId < 0n ||
    event.sourceAttestation.positionId !== event.positionId.toString() ||
    event.sourceAttestation.startTime !== event.startTime ||
    (event.kind === 'delay_started' &&
      (!Number.isSafeInteger(event.startTime) ||
        event.startTime === null ||
        event.startTime < 0)) ||
    (event.kind === 'position_kept' && event.startTime !== null)
  )
    throw new Error('invalid verified liquidation ingest event')
  return { ...event, ...normalized }
}

function resultRow(
  eventId: string,
  rows: readonly Record<string, unknown>[],
): LiquidationIngestResult {
  if (rows.length !== 1 || !STATUSES.has(rows[0].status as LiquidationIngestResult['status']))
    throw new Error('invalid atomic liquidation ingest result')
  const status = rows[0].status as LiquidationIngestResult['status']
  const outboxId = rows[0].outbox_id
  if (status === 'queued') {
    if (!DECIMAL.test(String(outboxId)) || BigInt(String(outboxId)) <= 0n)
      throw new Error('queued liquidation event lacks an outbox id')
  } else if (outboxId !== null && outboxId !== undefined) {
    throw new Error('nonqueued liquidation event has an outbox id')
  }
  return { status, eventId }
}

/** Inert adapter: caller supplies a parameterized SQL client and an attested event. */
export function makeLiquidationIngestSqlPort(sql: Sql): LiquidationAtomicIngestPort {
  return {
    persistAndEnqueue: async (input) => {
      const event = canonical(input)
      const params = [
        event.chainId,
        event.emitter,
        event.transactionHash,
        event.logIndex,
        event.blockNumber,
        event.blockHash,
        event.occurredAt,
        event.firstObservedAt,
        event.kind,
        event.subjectAddress,
        JSON.stringify(event.sourceAttestation),
      ]
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const rows = await sql.query(
            'SELECT * FROM ingest_verified_liquidation_event($1::integer,$2::text,$3::text,$4::integer,$5::bigint,$6::text,$7::timestamptz,$8::timestamptz,$9::text,$10::text,$11::jsonb)',
            params,
          )
          return resultRow(event.eventId, rows)
        } catch (error) {
          // PostgreSQL serialization failure/deadlock may be retried; never
          // surface a driver message because it can contain credentials.
          const code = (error as { code?: unknown } | null)?.code
          if ((code === '40001' || code === '40P01') && attempt < 2) continue
          throw new Error('atomic liquidation persistence failed')
        }
      }
      throw new Error('atomic liquidation persistence failed')
    },
  }
}
